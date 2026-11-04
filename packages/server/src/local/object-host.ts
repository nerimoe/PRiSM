import type { Database } from "bun:sqlite";
import { deserialize, serialize } from "bun:jsc";
import type { ObjectNamespace, ObjectStub } from "../platform/objects.js";
import type { LocalServerSocket, LocalWebSockets } from "./websockets.js";

/**
 * Durable Objects in one Bun process: the same classes the Worker exports,
 * one instance per name, their storage and alarms in SQLite.
 *
 * Calls reach an instance directly, without a queue. That is what Cloudflare
 * guarantees too: an object's events are held only while it waits on its own
 * storage, and local storage is synchronous, so no other event can run inside
 * a storage call; while the object waits on anything else (the database, Home
 * Assistant, another object) other events interleave, as they do there. A
 * whole-handler lock would be stricter than Cloudflare and would deadlock when
 * one object calls another that calls back.
 */
type ObjectClass = new (state: LocalObjectState, env: any) => any;

const schema = [
  `CREATE TABLE IF NOT EXISTS object_storage (
    namespace TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL,
    PRIMARY KEY (namespace, name, key)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS object_alarms (
    namespace TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL, retries INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (namespace, name)
  ) WITHOUT ROWID`,
];

/** setTimeout holds at most this long; a later alarm is re-armed when the timer fires. */
const MAX_TIMER = 2 ** 31 - 1;
/** Cloudflare retries a failed alarm with backoff, six times. */
const ALARM_RETRIES = 6;

export class LocalObjectHost {
  private readonly classes = new Map<string, ObjectClass>();
  private readonly instances = new Map<string, LocalObject>();
  private env: unknown = null;
  private stopped = false;
  readonly ready: Promise<void>;
  private release!: () => void;

  constructor(
    readonly db: Database,
    readonly sockets: LocalWebSockets,
  ) {
    for (const sql of schema) db.run(sql);
    this.ready = new Promise((resolve) => { this.release = resolve; });
  }

  /** The binding for one class, to put in `Env`. */
  namespace<T = unknown>(name: string, cls: ObjectClass): ObjectNamespace<T> {
    this.classes.set(name, cls);
    const host = this;
    return {
      getByName: (objectName) => host.stub<T>(name, objectName),
      idFromName: (objectName) => new LocalObjectId(objectName),
      get: (id) => host.stub<T>(name, (id as LocalObjectId).name),
    };
  }

  /** Objects are constructed with the finished `Env`, which holds the namespaces themselves. */
  start(env: unknown): void {
    this.env = env;
    this.release();
    for (const row of this.db.query<{ namespace: string; name: string; at: number }, []>(
      "SELECT namespace, name, at FROM object_alarms",
    ).all()) {
      if (this.classes.has(row.namespace)) this.instance(row.namespace, row.name).armAlarm(row.at);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const object of this.instances.values()) object.disarm();
  }

  get isStopped() {
    return this.stopped;
  }

  instance(namespace: string, name: string): LocalObject {
    const key = JSON.stringify([namespace, name]);
    let object = this.instances.get(key);
    if (!object) {
      const cls = this.classes.get(namespace);
      if (!cls) throw new Error(`Unknown object namespace ${namespace}`);
      if (this.env === null) throw new Error("Object host used before start");
      object = new LocalObject(this, namespace, name, cls, this.env);
      this.instances.set(key, object);
    }
    return object;
  }

  /**
   * A stub like Cloudflare's: `fetch` passes the request through, any other
   * property is a method call whose arguments and result are copied, as they
   * are when they cross between isolates.
   */
  private stub<T>(namespace: string, name: string): ObjectStub<T> {
    const host = this;
    return new Proxy({} as ObjectStub<T>, {
      get(_target, property) {
        // Awaiting a stub must not look like a thenable.
        if (property === "then" || typeof property === "symbol") return undefined;
        if (property === "fetch") {
          return async (request: Request) => {
            await host.ready;
            return host.instance(namespace, name).fetch(request);
          };
        }
        return async (...args: unknown[]) => {
          await host.ready;
          const result = await host.instance(namespace, name).call(String(property), structuredClone(args));
          return result === undefined ? undefined : structuredClone(result);
        };
      },
    });
  }
}

export class LocalObjectId {
  constructor(readonly name: string) {}
  toString() {
    return this.name;
  }
  equals(other: unknown) {
    return other instanceof LocalObjectId && other.name === this.name;
  }
}

export class LocalObject {
  readonly state: LocalObjectState;
  readonly instance: any;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly host: LocalObjectHost,
    readonly namespace: string,
    readonly name: string,
    cls: ObjectClass,
    env: unknown,
  ) {
    this.state = new LocalObjectState(this);
    this.instance = new cls(this.state, env);
  }

  async fetch(request: Request): Promise<Response> {
    if (typeof this.instance.fetch !== "function") throw new Error(`${this.namespace} has no fetch handler`);
    return this.instance.fetch(request);
  }

  async call(method: string, args: unknown[]): Promise<unknown> {
    const handler = this.instance[method];
    if (typeof handler !== "function" || method === "constructor" || method.startsWith("webSocket") || method === "alarm") {
      throw new TypeError(`${this.namespace}.${method} is not a method that can be called`);
    }
    return handler.apply(this.instance, args);
  }

  // --- alarms ---

  alarmAt(): number | null {
    const row = this.host.db.query<{ at: number }, [string, string]>(
      "SELECT at FROM object_alarms WHERE namespace = ? AND name = ?",
    ).get(this.namespace, this.name);
    return row?.at ?? null;
  }

  setAlarm(at: number, retries = 0): void {
    this.host.db.run(
      `INSERT INTO object_alarms (namespace, name, at, retries) VALUES (?, ?, ?, ?)
       ON CONFLICT (namespace, name) DO UPDATE SET at = excluded.at, retries = excluded.retries`,
      [this.namespace, this.name, at, retries],
    );
    this.armAlarm(at);
  }

  deleteAlarm(): void {
    this.host.db.run("DELETE FROM object_alarms WHERE namespace = ? AND name = ?", [this.namespace, this.name]);
    this.disarm();
  }

  armAlarm(at: number): void {
    this.disarm();
    if (this.host.isStopped) return;
    const wait = Math.max(0, at - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (wait > MAX_TIMER) this.armAlarm(at);
      else void this.runAlarm(at);
    }, Math.min(wait, MAX_TIMER));
  }

  disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The alarm is cleared before the handler runs, so the handler can set the next one. */
  private async runAlarm(at: number): Promise<void> {
    const row = this.host.db.query<{ at: number; retries: number }, [string, string]>(
      "SELECT at, retries FROM object_alarms WHERE namespace = ? AND name = ?",
    ).get(this.namespace, this.name);
    if (!row || row.at !== at) return;
    this.host.db.run("DELETE FROM object_alarms WHERE namespace = ? AND name = ?", [this.namespace, this.name]);
    try {
      await this.instance.alarm?.({ retryCount: row.retries, isRetry: row.retries > 0 });
    } catch (error) {
      console.error(JSON.stringify({
        event: "local_object_alarm_failed", namespace: this.namespace, name: this.name,
        retries: row.retries, message: error instanceof Error ? error.message : String(error),
      }));
      // A handler that set its own next alarm before failing keeps that one.
      if (row.retries < ALARM_RETRIES && this.alarmAt() === null) {
        this.setAlarm(Date.now() + 2000 * 2 ** row.retries, row.retries + 1);
      }
    }
  }
}

/** The `ctx` a Durable Object is constructed with. */
export class LocalObjectState {
  readonly id: LocalObjectId;
  readonly storage: LocalObjectStorage;
  /** Sockets this object accepted, with their tags. */
  readonly sockets = new Map<LocalServerSocket, string[]>();
  autoResponse: { request: string; response: string } | null = null;

  constructor(readonly object: LocalObject) {
    this.id = new LocalObjectId(object.name);
    this.storage = new LocalObjectStorage(object);
  }

  acceptWebSocket(socket: WebSocket, tags: string[] = []): void {
    this.object.host.sockets.accept(socket as unknown as LocalServerSocket, this, tags);
  }

  getWebSockets(tag?: string): WebSocket[] {
    return [...this.sockets]
      .filter(([socket, tags]) => socket.readyState !== 3 && (tag === undefined || tags.includes(tag)))
      .map(([socket]) => socket as unknown as WebSocket);
  }

  getTags(socket: WebSocket): string[] {
    return this.sockets.get(socket as unknown as LocalServerSocket) ?? [];
  }

  setWebSocketAutoResponse(pair?: { request: string; response: string }): void {
    this.autoResponse = pair ? { request: pair.request, response: pair.response } : null;
  }

  waitUntil(promise: Promise<unknown>): void {
    promise.catch((error) => console.error("[local object] waitUntil task failed", error));
  }

  async blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T> {
    return run();
  }
}

/** `ctx.storage`: values are copied in and out (structured clone), as on Cloudflare. */
export class LocalObjectStorage {
  constructor(private readonly object: LocalObject) {}

  private get db() {
    return this.object.host.db;
  }

  async get<T = unknown>(key: string | string[]): Promise<any> {
    if (Array.isArray(key)) {
      const found = new Map<string, T>();
      for (const one of key) {
        const value = this.read<T>(one);
        if (value !== undefined) found.set(one, value);
      }
      return found;
    }
    return this.read<T>(key);
  }

  private read<T>(key: string): T | undefined {
    const row = this.db.query<{ value: Uint8Array }, [string, string, string]>(
      "SELECT value FROM object_storage WHERE namespace = ? AND name = ? AND key = ?",
    ).get(this.object.namespace, this.object.name, key);
    return row ? (deserialize(row.value) as T) : undefined;
  }

  async put<T>(key: string | Record<string, T>, value?: T): Promise<void> {
    const entries = typeof key === "string" ? [[key, value] as const] : Object.entries(key);
    this.db.transaction(() => {
      for (const [one, item] of entries) {
        if (item === undefined) throw new TypeError("Cannot store undefined");
        this.db.run(
          `INSERT INTO object_storage (namespace, name, key, value) VALUES (?, ?, ?, ?)
           ON CONFLICT (namespace, name, key) DO UPDATE SET value = excluded.value`,
          [this.object.namespace, this.object.name, one, new Uint8Array(serialize(item))],
        );
      }
    })();
  }

  async delete(key: string | string[]): Promise<any> {
    const keys = Array.isArray(key) ? key : [key];
    let deleted = 0;
    for (const one of keys) {
      deleted += this.db.run(
        "DELETE FROM object_storage WHERE namespace = ? AND name = ? AND key = ?",
        [this.object.namespace, this.object.name, one],
      ).changes;
    }
    return Array.isArray(key) ? deleted : deleted > 0;
  }

  /** Storage only; the alarm stays until `deleteAlarm`, which the objects call first. */
  async deleteAll(): Promise<void> {
    this.db.run("DELETE FROM object_storage WHERE namespace = ? AND name = ?", [this.object.namespace, this.object.name]);
  }

  async list<T = unknown>(options: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const rows = this.db.query<{ key: string; value: Uint8Array }, [string, string, string, number]>(
      `SELECT key, value FROM object_storage WHERE namespace = ? AND name = ? AND key >= ? ORDER BY key LIMIT ?`,
    ).all(this.object.namespace, this.object.name, options.prefix ?? "", options.limit ?? -1);
    return new Map(rows
      .filter((row) => !options.prefix || row.key.startsWith(options.prefix))
      .map((row) => [row.key, deserialize(row.value) as T]));
  }

  async getAlarm(): Promise<number | null> {
    return this.object.alarmAt();
  }

  async setAlarm(at: number | Date): Promise<void> {
    this.object.setAlarm(typeof at === "number" ? at : at.getTime());
  }

  async deleteAlarm(): Promise<void> {
    this.object.deleteAlarm();
  }
}

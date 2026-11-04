import type { Database } from "bun:sqlite";
import { rmSync, writeFileSync } from "node:fs";
import type { Server } from "bun";
import type { Env } from "../bindings.js";
import { LiveBilling } from "../durable-objects/live-billing.js";
import { MachineRelay } from "../durable-objects/machine-relay.js";
import { ShopHub } from "../durable-objects/shop-hub.js";
import { useApnsTransport } from "../durable-objects/live-activity-push.js";
import { useWebSocketPlatform } from "../platform/websocket.js";
import { http2ApnsTransport } from "./apns.js";
import worker from "../worker.js";
import { localAssets } from "./assets.js";
import { createD1DatabaseFromSqlite, openLocalDatabase } from "./database.js";
import { LocalObjectHost } from "./object-host.js";
import { localRateLimits } from "./rate-limit.js";
import { objectsPathFor, pendingMigrations, pidPathFor } from "./upgrade.js";
import { LocalServerSocket, LocalWebSockets } from "./websockets.js";

/**
 * The platform in one Bun process, with what Cloudflare provides done here:
 * D1 is a SQLite file, the three Durable Objects run in `LocalObjectHost`
 * (their storage in a second file next to it), WebSockets go through
 * `LocalWebSockets`, APNs goes over `node:http2`, the rate-limit bindings
 * count in memory, `ASSETS` serves `prism-web/dist`, and the hourly cron runs
 * on a timer. Requests take the Worker's own path (`worker.fetch`), so
 * routing, maintenance and static files behave as they do there.
 */
export type LocalRuntimeOptions = {
  databasePath: string;
  /** An open database instead of `databasePath` (tests, `dev:local`). */
  db?: Database;
  port?: number;
  hostname?: string;
  /** Built web app; omit to serve the API only. */
  assetsDir?: string;
  /** Values Wrangler would put in `vars` and secrets. */
  env?: Partial<Env>;
  /** Run the hourly cleanup (default on). */
  cron?: boolean;
};

export type LocalRuntime = {
  server: Server<LocalServerSocket>;
  db: Database;
  env: Env;
  stop(): Promise<void>;
};

/** The `Env` keys the deployment reads from the process environment (vars and secrets). */
const envKeys = [
  "APP_ORIGIN", "SESSION_SECRET", "PRISM_BOOTSTRAP_TOKEN_HASH", "URL_ENCRYPTION_KEY",
  "MUNET_CLIENT_ID", "MUNET_CLIENT_SECRET", "APPLE_TEAM_ID", "APNS_KEY_ID", "APNS_TEAM_ID",
  "APNS_PRIVATE_KEY", "EXTRA_ALLOWED_ORIGINS", "ANDROID_CERT_FINGERPRINTS", "PRISM_DEPLOY_REVISION",
] as const;

export function envFromProcess(source: Record<string, string | undefined> = process.env): Partial<Env> {
  const env: Record<string, string> = {};
  for (const key of envKeys) if (source[key] !== undefined && source[key] !== "") env[key] = source[key]!;
  return env as Partial<Env>;
}

export function startLocalRuntime(options: LocalRuntimeOptions): LocalRuntime {
  const db = options.db ?? openLocalDatabase(options.databasePath);
  const pending = pendingMigrations(db);
  if (pending.length) {
    throw new Error(`${pending.length} migrations are not applied (first: ${pending[0]}); run bun run local:upgrade first`);
  }
  const objectsDb = openLocalDatabase(objectsPathFor(options.databasePath));
  const sockets = new LocalWebSockets();
  const previousWebSockets = useWebSocketPlatform(sockets);
  const previousApns = useApnsTransport(http2ApnsTransport());
  const objects = new LocalObjectHost(objectsDb, sockets);
  const port = options.port ?? 8787;
  const env = {
    APP_ORIGIN: `http://localhost:${port}`,
    ...options.env,
    DB: createD1DatabaseFromSqlite(db),
    ...localRateLimits(),
    LIVE_BILLING: objects.namespace("LIVE_BILLING", LiveBilling as never),
    MACHINE_RELAY: objects.namespace("MACHINE_RELAY", MachineRelay as never),
    SHOP_HUB: objects.namespace("SHOP_HUB", ShopHub as never),
    ...(options.assetsDir ? { ASSETS: localAssets(options.assetsDir) } : {}),
    PRISM_SQLITE_PATH: options.databasePath,
  } as unknown as Env;
  objects.start(env);

  const tasks = new Set<Promise<unknown>>();
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      const task = promise.catch((error) => console.error("[prism] background task failed", error));
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;

  const server = Bun.serve<LocalServerSocket, never>({
    port,
    hostname: options.hostname,
    // Long enough for a Home Assistant round trip behind a request; Workers have no idle cut-off.
    idleTimeout: 120,
    async fetch(request, server) {
      const response = await worker.fetch(request, env, ctx);
      return response.status === 101 ? sockets.complete(request, response, server) : response;
    },
    websocket: sockets.handler,
  });

  const cron = options.cron === false ? null : hourlyAt(17, () => worker.scheduled({ cron: "17 * * * *", scheduledTime: Date.now() }, env));
  const pidPath = options.databasePath === ":memory:" ? null : pidPathFor(options.databasePath);
  if (pidPath) writeFileSync(pidPath, String(process.pid));

  return {
    server,
    db,
    env,
    async stop() {
      cron?.stop();
      objects.stop();
      useWebSocketPlatform(previousWebSockets);
      useApnsTransport(previousApns);
      // Bun stops listening at once, but the promise can stay pending after a
      // WebSocket closed in this process (Bun 1.3); don't let shutdown hang on it.
      await Promise.race([server.stop(true), Bun.sleep(1000)]);
      await Promise.allSettled([...tasks]);
      if (pidPath) rmSync(pidPath, { force: true });
      objectsDb.close();
      if (!options.db) db.close();
    },
  };
}

/** Run at `minute` past every hour, like the Worker's `17 * * * *` trigger. */
function hourlyAt(minute: number, run: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    const next = new Date();
    next.setUTCSeconds(0, 0);
    next.setUTCMinutes(minute);
    if (next.getTime() <= Date.now()) next.setUTCHours(next.getUTCHours() + 1);
    timer = setTimeout(() => {
      run().catch((error) => console.error("[prism] scheduled task failed", error)).finally(arm);
    }, next.getTime() - Date.now());
  };
  arm();
  return { stop: () => timer && clearTimeout(timer) };
}

/**
 * One answer per question while building one read.
 *
 * Billing's reads call each other (a preview needs the catalog, so do the rules,
 * and the catalog needs the player's sessions), and D1 runs one query at a time
 * for every shop on it. Inside `withReadScope`, the same statement with the same
 * values reaches D1 once. Outside a scope the database behaves as ever, and any
 * write inside one forgets what was read, so a scope can never serve a stale row.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { D1DatabaseLike } from "@prism/adapter-d1";

type Answers = Map<string, Promise<unknown>>;

const scope = new AsyncLocalStorage<Answers>();

export function withReadScope<T>(read: () => Promise<T>): Promise<T> {
  return scope.run(new Map(), read);
}

/** The statements `batch` must be given are the database's own. */
const original = new WeakMap<object, unknown>();

function answered<T>(key: string, read: () => Promise<T>): Promise<T> {
  const answers = scope.getStore();
  if (!answers) return read();
  let answer = answers.get(key) as Promise<T> | undefined;
  if (!answer) {
    answer = read();
    answers.set(key, answer);
    // A failed read is not an answer: the next asker tries again.
    answer.catch(() => answers.delete(key));
  }
  // Callers sort and map what they are given: each gets its own copy.
  return answer.then((value) => structuredClone(value));
}

function scoped(statement: any, sql: string, values: unknown[]): any {
  const key = (method: string, extra: unknown) => JSON.stringify([method, sql, values, extra ?? null]);
  const wrapped = new Proxy(statement, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== "function") return value;
      if (name === "bind") return (...next: unknown[]) => scoped(value.apply(target, next), sql, next);
      if (name === "first") return (column?: string) => answered(key("first", column), () => value.call(target, column));
      if (name === "all") return () => answered(key("all", null), () => value.call(target));
      if (name === "run") return () => { scope.getStore()?.clear(); return value.call(target); };
      return value.bind(target);
    },
  });
  original.set(wrapped, statement);
  return wrapped;
}

/** The database whose reads a scope shares; the shop's services are built on it. */
export function scopedReads(db: D1DatabaseLike): D1DatabaseLike {
  return new Proxy(db as any, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== "function") return value;
      if (name === "prepare") return (sql: string) => scoped(value.call(target, sql), sql, []);
      if (name === "batch") {
        return (statements: object[]) => {
          scope.getStore()?.clear();
          return value.call(target, statements.map((statement) => original.get(statement) ?? statement));
        };
      }
      return value.bind(target);
    },
  }) as D1DatabaseLike;
}

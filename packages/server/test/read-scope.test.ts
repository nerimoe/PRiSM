import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { scopedReads, withReadScope } from "../src/read-scope.js";

/** A database counting what reaches it, with one table to read and write. */
function database() {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE t(id TEXT PRIMARY KEY, n INTEGER)");
  sqlite.run("INSERT INTO t VALUES ('a', 1), ('b', 2)");
  const count = { reads: 0 };
  const inner = createD1DatabaseFromSqlite(sqlite) as any;
  const counted = (statement: any): any => new Proxy(statement, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== "function") return value;
      if (key === "bind") return (...args: unknown[]) => counted(value.apply(target, args));
      if (key === "first" || key === "all") return (...args: unknown[]) => { count.reads++; return value.apply(target, args); };
      return value.bind(target);
    },
  });
  const counting = new Proxy(inner, {
    get(target, key) {
      const value = target[key];
      if (key === "prepare") return (sql: string) => counted(value.call(target, sql));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: scopedReads(counting), count, sqlite };
}
const read = (db: any, id: string): Promise<any> => db.prepare("SELECT n FROM t WHERE id=?").bind(id).first();

describe("one answer per question while building one read", () => {
  it("asks once for the same statement and values, in turn or at once", async () => {
    const { db, count } = database();
    await withReadScope(async () => {
      expect(await read(db, "a")).toEqual({ n: 1 });
      expect(await read(db, "a")).toEqual({ n: 1 });
      await Promise.all([read(db, "a"), read(db, "a")]);
    });
    expect(count.reads).toBe(1);
  });

  it("asks again for other values", async () => {
    const { db, count } = database();
    await withReadScope(async () => {
      expect(await read(db, "a")).toEqual({ n: 1 });
      expect(await read(db, "b")).toEqual({ n: 2 });
    });
    expect(count.reads).toBe(2);
  });

  it("does nothing outside a scope, and one scope's answers do not reach another", async () => {
    const { db, count, sqlite } = database();
    await read(db, "a");
    await read(db, "a");
    expect(count.reads).toBe(2);
    await withReadScope(() => read(db, "a"));
    sqlite.run("UPDATE t SET n = 9 WHERE id = 'a'");
    expect(await withReadScope(() => read(db, "a"))).toEqual({ n: 9 });
  });

  it("forgets what it read after a write, so a scope never serves a stale row", async () => {
    const { db } = database();
    await withReadScope(async () => {
      expect(await read(db, "a")).toEqual({ n: 1 });
      await (db as any).prepare("UPDATE t SET n = 5 WHERE id = 'a'").run();
      expect(await read(db, "a")).toEqual({ n: 5 });
      await (db as any).batch([(db as any).prepare("UPDATE t SET n = 6 WHERE id = 'a'")]);
      expect(await read(db, "a")).toEqual({ n: 6 });
    });
  });

  it("gives each asker its own copy, so sorting one answer cannot change another", async () => {
    const { db } = database();
    await withReadScope(async () => {
      const list = () => (db as any).prepare("SELECT id FROM t ORDER BY id").all();
      const first = await list();
      first.results.reverse();
      expect((await list()).results.map((row: { id: string }) => row.id)).toEqual(["a", "b"]);
    });
  });
});

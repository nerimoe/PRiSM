import { afterAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { purgeExpiredPlatformState } from "../src/retention";
import type { Env } from "../src/types";
const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["DB"], compatibilityDate: "2026-06-07" });
afterAll(() => mf.dispose());
test("retention removes bounded expired state, respects session grace and never deletes business rows", async () => {
  const db = await mf.getD1Database("DB");
  const tables = ["machine_tickets", "auth_challenges", "auth_sessions", "platform_binding_codes", "operation_locks"];
  for (const table of tables) {
    await db.prepare(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, expires_at TEXT)`).run();
    await db.batch(Array.from({ length: 505 }, (_, id) => db.prepare(`INSERT INTO ${table} VALUES (?, '2000-01-01')`).bind(id)));
    await db.prepare(`INSERT INTO ${table} VALUES (999, '2999-01-01')`).run();
  }
  await db.prepare("INSERT INTO auth_sessions VALUES (998,'2026-10-05T05:00:00.000Z')").run();
  await db.prepare("CREATE TABLE sessions(id TEXT)").run();
  await db.prepare("INSERT INTO sessions VALUES ('bill')").run();
  for (const sql of readFileSync(new URL("../../../migrations/0031_platform_retention.sql", import.meta.url), "utf8").split(";").filter(s => s.trim())) await db.prepare(sql).run();
  await purgeExpiredPlatformState({ DB: db } as Env, new Date("2026-10-05T06:00:00Z"));
  for (const table of tables) {
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE expires_at='2000-01-01'`).first("n")).toBe(5);
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id=999`).first("n")).toBe(1);
  }
  expect(await db.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE id=998").first("n")).toBe(1);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(1);
}, 30000);

import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { purgeExpiredPlatformState } from "../src/tasks/cron-handlers.js";
import type { Env } from "../src/bindings.js";

function fixture() {
  const sqlite = new Database(":memory:");
  const migrations = resolve(import.meta.dir, "../../../migrations");
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  sqlite.run("PRAGMA foreign_keys=OFF");
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','Arcade',0,0,80,'u')");
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('cab','cab-pub','shop','舞萌','')");
  const env = { DB: createD1DatabaseFromSqlite(sqlite) } as unknown as Env;
  const app = createApp();
  const report = async (body: unknown, cf?: Record<string, unknown>) => {
    const request = new Request("https://prism.test/api/v1/devices/report", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify(body) });
    if (cf) Object.defineProperty(request, "cf", { value: cf });
    return app.fetch(request, env);
  };
  return { sqlite, env, report };
}

const visit = (id: string, extra: Record<string, unknown> = {}) => ({
  id, client: "web", openMs: 1200, openFailed: false, documentMs: 800, documentConnectMs: 400, apiConnectMs: 0,
  reads: 3, readFailures: 1, readMs: 900, readMaxMs: 600, actions: 1, actionFailures: 0, actionMs: 300, actionMaxMs: 300,
  socketConnectMs: 500, socketDrops: 0, ...extra,
});
const A = "00000000-0000-4000-8000-00000000000a";

describe("what pages report of their networks", () => {
  it("keeps one row per visit, with its network, and updates it as the visit goes on", async () => {
    const { sqlite, report } = fixture();
    const network = { asn: 9808, asOrganization: "China Mobile", country: "CN", colo: "HKG" };
    expect((await report({ publicId: "cab-pub", visits: [visit(A)] }, network)).status).toBe(200);
    expect((await report({ publicId: "cab-pub", visits: [visit(A, { reads: 7 })] }, network)).status).toBe(200);
    const rows = sqlite.query("SELECT * FROM page_reports").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shop_id: "shop", client: "web", asn: 9808, as_organization: "China Mobile", country: "CN", colo: "HKG", reads: 7, open_ms: 1200, open_failed: 0 });
    sqlite.close();
  });

  it("needs no account or ticket, keeps nothing about the player, and ignores a resource that is not there", async () => {
    const { sqlite, report } = fixture();
    expect((await report({ publicId: "nope", visits: [visit(A)] })).status).toBe(200);
    expect((sqlite.query("SELECT COUNT(*) AS n FROM page_reports").get() as { n: number }).n).toBe(0);
    await report({ publicId: "cab-pub", visits: [visit(A)] });
    const columns = (sqlite.query("PRAGMA table_info(page_reports)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns.filter((name) => /user|player|ip$|card/.test(name))).toEqual([]);
    sqlite.close();
  });

  it("refuses what is not a report", async () => {
    const { sqlite, report } = fixture();
    expect((await report({ publicId: "cab-pub", visits: [visit("not-a-uuid")] })).status).toBe(422);
    expect((await report({ publicId: "cab-pub", visits: Array.from({ length: 6 }, () => visit(A)) })).status).toBe(422);
    sqlite.close();
  });

  it("forgets reports after 30 days", async () => {
    const { sqlite, env } = fixture();
    const now = new Date("2026-11-07T00:00:00.000Z");
    const insert = (id: string, at: string) => sqlite.run("INSERT INTO page_reports(id,reported_at,shop_id,client) VALUES (?,?,'shop','web')", [id, at]);
    insert("old", "2026-10-01T00:00:00.000Z");
    insert("recent", "2026-11-01T00:00:00.000Z");
    await purgeExpiredPlatformState(env as never, now);
    expect((sqlite.query("SELECT id FROM page_reports").all() as Array<{ id: string }>).map((row) => row.id)).toEqual(["recent"]);
    sqlite.close();
  });
});

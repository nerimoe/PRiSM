import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { clearShopDependenciesCache } from "../src/middleware/tenant.js";
import { sha256 } from "../src/crypto.js";
import { mintResourceTicket } from "../src/routes/platform/resource-ticket.js";
import type { Env } from "../src/bindings.js";

/**
 * D1 runs one query at a time and every shop shares one database, so what a
 * scanned page costs to read is a limit worth holding: these fail when it grows.
 */
const NOW = new Date().toISOString();
const TOKEN = "player-token";
const SECRET = "session-secret";

function plan(sqlite: Database, id: string, relations?: { requires?: string[] }) {
  sqlite.run(
    `INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
     VALUES ('shop',?,'time.priority',?,1,'active',?,?,?)`,
    [id, id, JSON.stringify({
      id, timeZone: "UTC",
      rules: [{ id: `${id}-rule`, label: "全天", priority: 0, timeRange: { start: "00:00", end: "00:00" },
        pricing: { unitMinutes: 60, unitPrice: 100, roundGraceMinutes: 0, priceCap: 100000 } }],
      ...(relations ? { relations: { requires: relations.requires ?? [], conflicts: [] } } : {}),
    }), NOW, NOW],
  );
}

async function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=OFF");
  const migrations = resolve(import.meta.dir, "../../../migrations");
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('u1','user',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('auth','u1',?,?)",
    [await sha256(TOKEN), new Date(Date.now() + 86_400_000).toISOString()]);
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','Arcade',0,0,80,'u1')");
  sqlite.run("INSERT INTO shop_billing_settings(shop_id,billing_enabled,auto_register,identity_binding_required) VALUES ('shop',1,1,0)");
  sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','p1','一号','active',?)", [NOW]);
  sqlite.run("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES ('shop','u1','p1',?)", [NOW]);
  sqlite.run("INSERT INTO resource_groups(shop_id,id,name,enabled,default_pricing_config_id,created_at,updated_at) VALUES ('shop','default','默认',1,'plan-b',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO asset_definitions(shop_id,type,code,name,stackable,status) VALUES ('shop','currency','paid','猫粮',1,'active')");
  plan(sqlite, "plan-a");
  plan(sqlite, "plan-b", { requires: ["plan-a"] });
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('cab','cab-pub','shop','舞萌','')");
  sqlite.run(
    `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
     VALUES ('shop','cab','hinata_io',?,'{}',?,?)`,
    [JSON.stringify({ transport: "embedded", coinKey: 32, coinCap: 3, channel: "m_cab" }), NOW, NOW],
  );

  let queries: string[] = [];
  const inner = createD1DatabaseFromSqlite(sqlite) as any;
  // What reaches the database: a statement counts when it runs, not when it is prepared.
  const counted = (statement: any, sql: string): any => new Proxy(statement, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== "function") return value;
      if (key === "bind") return (...args: unknown[]) => counted(value.apply(target, args), sql);
      if (key === "first" || key === "all" || key === "run") return (...args: unknown[]) => { queries.push(sql); return value.apply(target, args); };
      return value.bind(target);
    },
  });
  const DB = new Proxy(inner, {
    get(target, key) {
      const value = target[key];
      if (key === "prepare") return (sql: string) => counted(value.call(target, sql), sql);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const env = { DB, SESSION_SECRET: SECRET, URL_ENCRYPTION_KEY: "unit-test-key" } as unknown as Env;
  const app = createApp();
  const { ticket } = await mintResourceTicket(SECRET, "shop-code", "cab-pub");
  const read = async () => {
    queries = [];
    const response = await app.fetch(new Request(
      `https://prism.test/api/v1/devices/session/state?ticket=${encodeURIComponent(ticket)}&includePower=0&includeClimate=0`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    ), env);
    const json = await response.json() as any;
    return { status: response.status, state: json?.data ?? json, queries };
  };
  return { sqlite, read };
}

describe("what reading a scanned page costs", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  it("reads the confirmation page, with its rules, without reading anything twice", async () => {
    const { sqlite, read } = await fixture();
    const { status, state, queries } = await read();
    expect(status).toBe(200);
    expect(state.gate).toBe("entry");
    expect(state.billing.preview.pricingConfigId).toBe("plan-b");
    expect(state.billing.rules.plans.map((entry: any) => entry.config.id)).toEqual(["plan-b", "plan-a"]);
    expect(queries.length).toBeLessThanOrEqual(ENTRY_LIMIT);
    sqlite.close();
  });

  it("reads the page of a player already billing cheaply, without the rules it does not show", async () => {
    const { sqlite, read } = await fixture();
    sqlite.run(
      `INSERT INTO sessions(id,shop_id,player_id,status,started_at,pricing_config_ids_json,payment_status)
       VALUES ('s1','shop','p1','active',?,'["plan-b"]','unpaid')`,
      [NOW],
    );
    const { status, state, queries } = await read();
    expect(status).toBe(200);
    expect(state.gate).toBe("ready");
    expect(state.billing).toBeNull();
    expect(queries.length).toBeLessThanOrEqual(READY_LIMIT);
    sqlite.close();
  });
});

const READY_LIMIT = 11;
const ENTRY_LIMIT = 15;

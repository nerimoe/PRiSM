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
import { applyAllDuePricingChanges } from "../src/pricing-changes.js";
import type { Env } from "../src/bindings.js";

const NOW = new Date().toISOString();
const PLAYER = "player-token";
const OWNER = "owner-token";
const BASE = "/api/v1/shops/shop-code/staff/pricing-configs";

function plan(sqlite: Database, id: string, cents = 100, relations?: { requires?: string[] }) {
  sqlite.run(
    `INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
     VALUES ('shop',?,'time.priority',?,1,'active',?,?,?)`,
    [id, id, JSON.stringify({
      id, timeZone: "UTC",
      rules: [{ id: `${id}-rule`, label: "全天", priority: 0, timeRange: { start: "00:00", end: "00:00" },
        pricing: { unitMinutes: 60, unitPrice: cents, roundGraceMinutes: 0, priceCap: 0 } }],
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

  for (const [user, token] of [["player-user", PLAYER], ["owner-user", OWNER]] as const) {
    sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES (?,'user',?,?)", [user, NOW, NOW]);
    sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)",
      [`auth-${user}`, user, await sha256(token), new Date(Date.now() + 86_400_000).toISOString()]);
  }
  sqlite.run("INSERT INTO auth_identities(id,user_id,provider,provider_subject,display_name) VALUES ('i1','owner-user','qq','1','店长A')");
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','Arcade',0,0,80,'owner-user')");
  sqlite.run("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('m1','shop','owner-user','owner')");
  sqlite.run("INSERT INTO shop_billing_settings(shop_id,auto_register,identity_binding_required) VALUES ('shop',1,0)");
  sqlite.run("INSERT INTO resource_groups(shop_id,id,name,enabled,default_pricing_config_id,created_at,updated_at) VALUES ('shop','default','默认资源组',1,'base',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO resource_groups(shop_id,id,name,enabled,default_pricing_config_id,created_at,updated_at) VALUES ('shop','music','音游区',1,'base',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO asset_definitions(shop_id,type,code,name,stackable,status) VALUES ('shop','currency','paid','余额',1,'active')");
  sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','p1','P1','active',?)", [NOW]);
  sqlite.run("INSERT INTO player_identities (shop_id, subject, player_id, created_at, provider) VALUES ('shop','player-user','p1',?, 'web-account')", [NOW]);
  plan(sqlite, "base", 1200);
  plan(sqlite, "night", 800);
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,resource_group_id) VALUES ('cab','cab','shop','一号机','','music')");

  const env = { DB: createD1DatabaseFromSqlite(sqlite), SESSION_SECRET: "session-secret", URL_ENCRYPTION_KEY: "unit-test-key" } as unknown as Env;
  const app = createApp();
  const call = async (method: string, path: string, body?: unknown, token = OWNER) => {
    const response = await app.fetch(new Request(`https://prism.test${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    const json = await response.json() as any;
    return { status: response.status, body: json?.data ?? json };
  };
  const enter = async () => {
    const { ticket } = await mintResourceTicket(env.SESSION_SECRET, "shop-code", "cab");
    return call("POST", "/api/v1/shops/shop-code/player/session/start", { ticket, consent: true, operationId: crypto.randomUUID() }, PLAYER);
  };
  const activePlan = () => (sqlite.query(
    "SELECT json_extract(pricing_config_ids_json,'$[0]') AS plan FROM sessions WHERE status='active'",
  ).get() as { plan: string } | null)?.plan ?? null;
  const editable = async (id: string) => {
    const { body } = await call("GET", `${BASE}/${id}`);
    return body.pricingConfig;
  };
  /** Moves every scheduled change into the past, as if its moment had come. */
  const timePasses = () => {
    sqlite.run("UPDATE pricing_changes SET effective_at=? WHERE status='pending'", [new Date(Date.now() - 1000).toISOString()]);
    clearShopDependenciesCache();
  };
  return { sqlite, env, call, enter, activePlan, editable, timePasses };
}

const withPrice = (config: any, yuan: number) => ({
  ...config,
  provider: { ...config.provider, rules: config.provider.rules.map((rule: any) => ({ ...rule, pricing: { ...rule.pricing, unitPrice: yuan } })) },
});
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

describe("price list history", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  it("records direct edits with who made them, folding quick edits by one person into one entry", async () => {
    const { sqlite, call, editable } = await fixture();
    try {
      expect((await call("PATCH", `${BASE}/base`, withPrice(await editable("base"), 13))).status).toBe(200);
      expect((await call("PATCH", `${BASE}/night`, withPrice(await editable("night"), 9))).status).toBe(200);
      const { body } = await call("GET", `${BASE}/changes`);
      const edits = body.applied.filter((entry: any) => entry.source === "edit");
      expect(edits).toHaveLength(1);
      expect(edits[0].actorName).toBe("店长A");
      const prices = edits[0].items.filter((item: any) => item.kind === "period-changed")
        .map((item: any) => [item.planId, item.fields.find((field: any) => field.field === "unitPrice")]);
      expect(prices).toEqual([["base", { field: "unitPrice", from: 12, to: 13 }], ["night", { field: "unitPrice", from: 8, to: 9 }]]);
    } finally { sqlite.close(); }
  });

  it("records a resource group's change of plan", async () => {
    const { sqlite, call } = await fixture();
    try {
      // The first recorded entry has bindings; the second compares with it.
      await call("PATCH", `${BASE}/night`, { ...(await call("GET", `${BASE}/night`)).body.pricingConfig, name: "夜场" });
      const changed = await call("PATCH", "/api/v1/merchant/resource-groups/music", { shopId: "shop", defaultPricingConfigId: "night" });
      expect(changed.status).toBe(200);
      const { body } = await call("GET", `${BASE}/changes`);
      const items = body.applied.flatMap((entry: any) => entry.items);
      expect(items).toContainEqual({ kind: "binding-changed", target: "group", targetId: "music", from: "base", to: "night" });
      expect(body.names.groups.music).toBe("音游区");
    } finally { sqlite.close(); }
  });

  it("refuses to give a period an absolute start and end", async () => {
    const { sqlite, call, editable } = await fixture();
    try {
      const config = await editable("base");
      config.provider.rules[0].dateTimeRange = { start: "2026-12-01T00:00:00.000Z", end: "2026-12-08T00:00:00.000Z" };
      const result = await call("PATCH", `${BASE}/base`, config);
      expect(result.body.error.code).toBe("PRICING_RULE_DATE_TIME_RANGE_RETIRED");
    } finally { sqlite.close(); }
  });
});

describe("scheduled price changes", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  it("switches plans and prices at the moment, for the next player who enters", async () => {
    const { sqlite, call, enter, activePlan, editable, timePasses } = await fixture();
    try {
      const saved = await call("POST", `${BASE}/changes`, {
        effectiveAt: inAnHour(),
        plans: [withPrice(await editable("night"), 10)],
        bindings: { groups: { music: "night" } },
        note: "12 月起音游区按夜场价",
      });
      expect(saved.status).toBe(201);
      expect(saved.body.status).toBe("pending");

      const listed = await call("GET", `${BASE}/changes`);
      expect(listed.body.pending).toHaveLength(1);
      expect(listed.body.pending[0].items).toContainEqual({ kind: "binding-changed", target: "group", targetId: "music", from: "base", to: "night" });

      // Before the moment: nothing changed.
      expect((sqlite.query("SELECT default_pricing_config_id AS plan FROM resource_groups WHERE id='music'").get() as any).plan).toBe("base");

      timePasses();
      expect((await enter()).status).toBe(200);
      expect(activePlan()).toBe("night");
      const night = await editable("night");
      expect(night.provider.rules[0].pricing.unitPrice).toBe(10);
      const after = await call("GET", `${BASE}/changes`);
      expect(after.body.pending).toHaveLength(0);
      expect(after.body.applied[0]).toMatchObject({ source: "schedule", status: "applied", note: "12 月起音游区按夜场价" });
    } finally { sqlite.close(); }
  });

  it("is applied by the sweep when nobody visits", async () => {
    const { sqlite, env, call, editable, timePasses } = await fixture();
    try {
      await call("POST", `${BASE}/changes`, { effectiveAt: inAnHour(), plans: [withPrice(await editable("base"), 15)] });
      timePasses();
      await applyAllDuePricingChanges(env.DB);
      expect((sqlite.query("SELECT status FROM pricing_changes WHERE source='schedule'").get() as any).status).toBe("applied");
    } finally { sqlite.close(); }
  });

  it("refuses a change in the past or on a moment already taken", async () => {
    const { sqlite, call } = await fixture();
    try {
      const past = await call("POST", `${BASE}/changes`, { effectiveAt: new Date(Date.now() - 60_000).toISOString() });
      expect(past.body.error.code).toBe("PRICING_CHANGE_IN_PAST");
      const at = inAnHour();
      expect((await call("POST", `${BASE}/changes`, { effectiveAt: at, bindings: { groups: { music: "night" } } })).status).toBe(201);
      expect((await call("POST", `${BASE}/changes`, { effectiveAt: at })).body.error.code).toBe("PRICING_CHANGE_TIME_TAKEN");
    } finally { sqlite.close(); }
  });

  it("refuses a target that cannot bill", async () => {
    const { sqlite, call, editable } = await fixture();
    try {
      const archived = { ...(await editable("base")), status: "archived" };
      const result = await call("POST", `${BASE}/changes`, { effectiveAt: inAnHour(), plans: [archived] });
      expect(result.body.error.code).toBe("RESOURCE_PRICING_INVALID");
    } finally { sqlite.close(); }
  });

  it("carries a direct edit into a schedule that left the plan alone, and reports one that changes it", async () => {
    const { sqlite, call, editable, timePasses } = await fixture();
    try {
      await call("POST", `${BASE}/changes`, { effectiveAt: inAnHour(), plans: [withPrice(await editable("night"), 10)] });
      const base = await call("PATCH", `${BASE}/base`, withPrice(await editable("base"), 14));
      expect(base.body.pendingConflicts).toEqual([]);
      const night = await call("PATCH", `${BASE}/night`, withPrice(await editable("night"), 7));
      expect(night.body.pendingConflicts).toHaveLength(1);
      expect(night.body.pendingConflicts[0].plans).toEqual(["night"]);

      timePasses();
      await call("GET", `${BASE}`);
      // The schedule did not undo the edit it left alone, and kept its own price.
      expect((await editable("base")).provider.rules[0].pricing.unitPrice).toBe(14);
      expect((await editable("night")).provider.rules[0].pricing.unitPrice).toBe(10);
    } finally { sqlite.close(); }
  });

  it("will not archive a plan a schedule still uses", async () => {
    const { sqlite, call } = await fixture();
    try {
      sqlite.run("UPDATE resource_groups SET default_pricing_config_id=NULL WHERE id='music'");
      await call("POST", `${BASE}/changes`, { effectiveAt: inAnHour(), bindings: { groups: { music: "night" } } });
      const result = await call("POST", `${BASE}/night/archive`, {});
      expect(result.body.error.code).toBe("PRICING_CONFIG_IN_USE");
      expect(result.body.error.message).toContain("调价计划");
    } finally { sqlite.close(); }
  });

  it("leaves alone what changed since: a deleted group is skipped, a plan still in use is not archived", async () => {
    const { sqlite, call, editable, timePasses } = await fixture();
    try {
      await call("POST", `${BASE}/changes`, {
        effectiveAt: inAnHour(),
        plans: [{ ...(await editable("night")), status: "archived" }],
        bindings: { groups: { music: "base" } },
      });
      sqlite.run("DELETE FROM resource_groups WHERE id='music'");
      // A resource made after the schedule was saved bills through the plan it archives.
      sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,pricing_config_override_id) VALUES ('new','new','shop','新机','','night')");
      timePasses();
      await call("GET", `${BASE}`);
      const { body } = await call("GET", `${BASE}/changes`);
      expect(body.applied[0].status).toBe("applied");
      expect(body.applied[0].notes).toEqual([
        { kind: "binding-skipped-missing", target: "group", targetId: "music" },
        { kind: "archive-kept", planId: "night", name: "night" },
      ]);
      expect((await editable("night")).status).toBe("active");
    } finally { sqlite.close(); }
  });

  it("carries an edit of an earlier version into later ones that left the same thing alone", async () => {
    const { sqlite, call, editable } = await fixture();
    try {
      const soon = new Date(Date.now() + 3_600_000).toISOString();
      const later = new Date(Date.now() + 7_200_000).toISOString();
      const first = await call("POST", `${BASE}/changes`, { effectiveAt: soon });
      // The later version changes the night price itself, and leaves base alone.
      await call("POST", `${BASE}/changes`, { effectiveAt: later, plans: [withPrice(await editable("night"), 11)] });
      expect((await call("PATCH", `${BASE}/changes/${first.body.id}`, {
        effectiveAt: soon, plans: [withPrice(await editable("base"), 20), withPrice(await editable("night"), 5)],
      })).status).toBe(200);
      const { body } = await call("GET", `${BASE}/changes`);
      const last = await call("GET", `${BASE}/changes/${body.pending[1].id}`);
      const price = (id: string) => last.body.snapshot.configs.find((config: any) => config.id === id).provider.rules[0].pricing.unitPrice;
      expect(price("base")).toBe(20);
      expect(price("night")).toBe(11);
    } finally { sqlite.close(); }
  });

  it("cancels, and applies one right away", async () => {
    const { sqlite, call, editable } = await fixture();
    try {
      const first = await call("POST", `${BASE}/changes`, { effectiveAt: inAnHour(), plans: [withPrice(await editable("base"), 20)] });
      expect((await call("POST", `${BASE}/changes/${first.body.id}/cancel`, {})).body.status).toBe("cancelled");
      expect((await editable("base")).provider.rules[0].pricing.unitPrice).toBe(12);
      const second = await call("POST", `${BASE}/changes`, { effectiveAt: inAnHour(), plans: [withPrice(await editable("base"), 21)] });
      expect((await call("POST", `${BASE}/changes/${second.body.id}/apply-now`, {})).body.status).toBe("applied");
      expect((await editable("base")).provider.rules[0].pricing.unitPrice).toBe(21);
    } finally { sqlite.close(); }
  });

  it("restores an earlier price list", async () => {
    const { sqlite, call, editable } = await fixture();
    try {
      await call("PATCH", `${BASE}/base`, withPrice(await editable("base"), 30));
      sqlite.run("UPDATE pricing_changes SET applied_at='2000-01-01T00:00:00.000Z'");
      await call("PATCH", `${BASE}/base`, withPrice(await editable("base"), 40));
      const { body } = await call("GET", `${BASE}/changes`);
      const earlier = body.applied.find((entry: any) => entry.items.some((item: any) =>
        item.kind === "period-changed" && item.fields.some((field: any) => field.to === 30)));
      const draft = await call("GET", `${BASE}/changes/${earlier.id}/restore-draft`);
      const restoredBase = draft.body.snapshot.configs.find((config: any) => config.id === "base");
      expect(restoredBase.provider.rules[0].pricing.unitPrice).toBe(30);
      const applied = await call("POST", `${BASE}/changes`, {
        effectiveAt: null, plans: [restoredBase], bindings: draft.body.snapshot.bindings, restoredFrom: earlier.id,
      });
      expect(applied.body.status).toBe("applied");
      expect((await editable("base")).provider.rules[0].pricing.unitPrice).toBe(30);
      const after = await call("GET", `${BASE}/changes`);
      expect(after.body.applied[0]).toMatchObject({ source: "restore", restoredFrom: earlier.id });
    } finally { sqlite.close(); }
  });

  it("clears a scheduled note when null is sent and cancels a failed version", async () => {
    const { sqlite, call } = await fixture();
    try {
      const at = inAnHour();
      const created = await call("POST", `${BASE}/changes`, { effectiveAt: at, note: "初版备注" });
      expect((await call("PATCH", `${BASE}/changes/${created.body.id}`, { effectiveAt: at, note: null })).status).toBe(200);
      const listed = await call("GET", `${BASE}/changes`);
      expect(listed.body.pending[0].note).toBeNull();

      sqlite.run("UPDATE pricing_changes SET status='failed' WHERE id=?", [created.body.id]);
      expect((await call("POST", `${BASE}/changes/${created.body.id}/cancel`, {})).body.status).toBe("cancelled");
      const after = await call("GET", `${BASE}/changes`);
      expect(after.body.failed).toHaveLength(0);
    } finally { sqlite.close(); }
  });

  it("applies a batched current-version edit as one 'edit' entry and reports future conflicts", async () => {
    const { sqlite, call, editable } = await fixture();
    try {
      const later = inAnHour();
      const scheduled = await call("POST", `${BASE}/changes`, { effectiveAt: later, plans: [withPrice(await editable("night"), 11)] });
      const saved = await call("POST", `${BASE}/changes`, {
        effectiveAt: null,
        plans: [withPrice(await editable("base"), 16), withPrice(await editable("night"), 7)],
        bindings: { groups: { music: "night" } },
      });
      expect(saved.status).toBe(201);
      expect(saved.body.status).toBe("applied");
      expect(saved.body.pendingConflicts).toHaveLength(1);
      expect(saved.body.pendingConflicts[0].plans).toEqual(["night"]);

      const timeline = await call("GET", `${BASE}/changes`);
      expect(timeline.body.applied[0]).toMatchObject({ id: saved.body.id, source: "edit" });
      // Untouched plan 'base' was carried forward to the scheduled version; 'night' kept its own 11.
      const future = await call("GET", `${BASE}/changes/${scheduled.body.id}`);
      const price = (id: string) => future.body.snapshot.configs.find((config: any) => config.id === id).provider.rules[0].pricing.unitPrice;
      expect(price("base")).toBe(16);
      expect(price("night")).toBe(11);
      expect(future.body.snapshot.bindings.groups.music).toBe("night");
    } finally { sqlite.close(); }
  });

  it("does not insert a brand-new plan that was removed before the future version applied", async () => {
    const { sqlite, call, editable, timePasses } = await fixture();
    try {
      const at = inAnHour();
      const draftPlan = { ...(await editable("base")), id: "temp-future", name: "临时方案" };
      const created = await call("POST", `${BASE}/changes`, { effectiveAt: at, plans: [draftPlan] });
      expect((await call("PATCH", `${BASE}/changes/${created.body.id}`, {
        effectiveAt: at,
        plans: [{ ...draftPlan, status: "archived", enabled: false }],
      })).status).toBe(200);
      const detail = await call("GET", `${BASE}/changes/${created.body.id}`);
      expect(detail.body.entry.items).toEqual([]);
      timePasses();
      await call("GET", `${BASE}`);
      expect(sqlite.query("SELECT id FROM pricing_configs WHERE id='temp-future'").get()).toBeNull();
    } finally { sqlite.close(); }
  });

  it("simulates billing against a provided future or draft schedule without touching stored plans", async () => {
    const { sqlite, call, editable } = await fixture();
    try {
      const draftBase = withPrice(await editable("base"), 25);
      const preview = await call("POST", `${BASE}/simulate/preview`, {
        sessions: [{
          startedAt: "2026-12-01T02:00:00.000Z",
          endedAt: "2026-12-01T03:00:00.000Z",
          pricingConfigId: "base",
        }],
        pricingConfigs: [draftBase],
      });
      expect(preview.status).toBe(200);
      expect(preview.body.total).toBe(25);
      // Stored live plan remains unchanged.
      expect((await editable("base")).provider.rules[0].pricing.unitPrice).toBe(12);
    } finally { sqlite.close(); }
  });
});

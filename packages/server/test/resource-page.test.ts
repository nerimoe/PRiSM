import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { clearShopDependenciesCache } from "../src/middleware/tenant.js";
import { sha256 } from "../src/crypto.js";
import { renderPage, type PageInput } from "../src/resources/page.js";
import { mintResourceTicket } from "../src/routes/platform/resource-ticket.js";
import type { Env } from "../src/bindings.js";

const NOW = new Date().toISOString();
const TOKEN = "player-token";
const SECRET = "session-secret";
const op = () => crypto.randomUUID();

const input = (over: Partial<PageInput> = {}): PageInput => ({
  locale: "zh",
  head: { shop: "店", shopCode: "s", heroUrl: null, resource: "舞萌", publicId: "p" },
  billingActive: false,
  capabilities: { power: false, climate: false, card: false, coin: false, door: false, mahjong: false },
  billed: false, coinAfterSwipe: false, cardCapture: false,
  geo: { checkin: false, machine: false },
  signedIn: true, gate: "ready", billing: null, power: null, climate: null, coinFull: false, ioWaiting: false, mahjong: null,
  ...over,
});
const caps = (...names: Array<keyof PageInput["capabilities"]>) =>
  ({ capabilities: { ...input().capabilities, ...Object.fromEntries(names.map((name) => [name, true])) } });
const ids = (over: Partial<PageInput>) => renderPage(input(over)).blocks.map((block) => block.id);
const block = (over: Partial<PageInput>, id: string): any => renderPage(input(over)).blocks.find((entry) => entry.id === id);

describe("what the page shows", () => {
  it("says so when there is nothing here, signed in or not", () => {
    expect(ids({ signedIn: false })).toEqual(["empty"]);
    expect(ids({})).toEqual(["empty"]);
    expect(ids({ billed: true })).toEqual(["empty"]);
  });

  it("asks a stranger to sign in before anything else", () => {
    expect(ids({ ...caps("coin"), signedIn: false })).toEqual(["signin"]);
    expect(ids({ billed: true, signedIn: false })).toEqual(["signin"]);
  });

  it("shows only the gate while one stands", () => {
    expect(ids({ ...caps("coin", "card"), gate: "binding" })).toEqual(["binding"]);
    expect(ids({ ...caps("coin", "card"), gate: "disabled" })).toEqual(["disabled"]);
  });

  it("asks for confirmation with the rules and their revision", () => {
    const over = { ...caps("coin"), gate: "entry" as const, billing: { rules: { plans: [] }, preview: { revision: "r1" } } };
    expect(ids(over)).toEqual(["entry-title", "pricing", "consent", "entry"]);
    expect(block(over, "entry")).toMatchObject({ action: "entry", requires: "consent", payload: { expectedRevision: "r1" } });
  });

  it("offers no confirmation when the resource cannot bill", () => {
    const over = { ...caps("door"), gate: "entry" as const, billing: { error: { message: "没有配置计费" } } };
    expect(ids(over)).toEqual(["entry-title", "entry-error"]);
  });

  it("enters and opens the door with one button, and checks the door's location rule", () => {
    const over = { ...caps("door"), gate: "entry" as const, geo: { checkin: true, machine: false }, billing: {} };
    expect(block(over, "door")).toMatchObject({ action: "entry", payload: { openDoor: true }, requires: "consent", needsLocation: true });
    expect(block({ ...caps("door"), geo: { checkin: true, machine: false } }, "door")).toMatchObject({ action: "door.open", needsLocation: true });
    expect(block({ ...caps("coin"), geo: { checkin: true, machine: false } }, "coin").needsLocation).toBe(false);
  });

  it("turns the coin button off at the cabinet's limit, and leaves it out when a swipe coins", () => {
    expect(block({ ...caps("coin") }, "coin")).toMatchObject({ label: "投币", enabled: true });
    expect(block({ ...caps("coin"), coinFull: true }, "coin")).toMatchObject({ label: "达到机台投币上限", enabled: false });
    expect(ids({ ...caps("card", "coin"), coinAfterSwipe: true })).toEqual(["cards"]);
  });

  it("offers only turning on while the device is off, keeping what works without power", () => {
    expect(ids({ ...caps("power", "card", "coin", "door", "climate"), power: "off" })).toEqual(["door", "climate", "power-off", "power"]);
    // An unreadable switch must not lock players out.
    expect(ids({ ...caps("power", "card", "coin"), power: null })).toEqual(["cards", "coin"]);
  });

  it("waits for the IO instead of offering the card and coin, keeping everything else", () => {
    expect(ids({ ...caps("door", "climate", "card", "coin"), ioWaiting: true })).toEqual(["door", "climate", "io-waiting"]);
    expect(block({ ...caps("coin"), ioWaiting: true, locale: "en" }, "io-waiting").text).toBe("Waiting for the machine to connect");
    // Off comes first: turning on is what there is to do.
    expect(ids({ ...caps("power", "card"), power: "off", ioWaiting: true })).toEqual(["power-off", "power"]);
    // Nothing of the IO's on the page, so nothing to wait for.
    expect(ids({ ...caps("door"), ioWaiting: true })).toEqual(["door"]);
  });

  it("seats and unseats at the table, and says when it is full", () => {
    const seat = (name: string, mine = false) => ({ name, mine, playing: false });
    const table = (...seats: ReturnType<typeof seat>[]) => ({ ...caps("mahjong"), mahjong: { capacity: 2, seats } });
    expect(block(table(), "seat")).toMatchObject({ action: "mahjong.join", style: "primary" });
    expect(block(table(seat("我", true), seat("他")), "seat").action).toBe("mahjong.leave");
    expect(ids(table(seat("甲"), seat("乙")))).toEqual(["mahjong", "seat-full"]);
  });

  it("confirms at a table by sitting down, which also checks the machine's location rule", () => {
    const over = { ...caps("mahjong"), gate: "entry" as const, geo: { checkin: false, machine: true }, billing: { preview: { revision: "r" } } };
    expect(block(over, "entry")).toMatchObject({ action: "mahjong.join", requires: "consent", payload: { expectedRevision: "r" }, needsLocation: true });
  });

  it("is worded in the player's language, with no text left behind", () => {
    const over = { ...caps("coin"), locale: "en" as const, gate: "entry" as const, billing: {} };
    expect(block(over, "entry").label).toBe("Confirm");
    expect(block(over, "consent").text).not.toMatch(/[一-鿿]/);
    expect(block({ ...caps("coin"), locale: "en" }, "coin").label).toBe("Insert coin");
  });
});

async function fixture() {
  const sqlite = new Database(":memory:");
  const migrations = resolve(import.meta.dir, "../../../migrations");
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  sqlite.run("PRAGMA foreign_keys=OFF");
  sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('u1','user',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('auth','u1',?,?)",
    [await sha256(TOKEN), new Date(Date.now() + 86_400_000).toISOString()]);
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','Arcade',0,0,80,'u1')");
  sqlite.run("INSERT INTO shop_billing_settings(shop_id,billing_enabled,auto_register,identity_binding_required) VALUES ('shop',1,1,0)");
  sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','p1','一号','active',?)", [NOW]);
  sqlite.run("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES ('shop','u1','p1',?)", [NOW]);
  sqlite.run("INSERT INTO asset_definitions(shop_id,type,code,name,stackable,status) VALUES ('shop','currency','paid','猫粮',1,'active')");
  sqlite.run(
    `INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
     VALUES ('shop','plan','time.priority','畅玩',1,'active',?,?,?)`,
    [JSON.stringify({ id: "plan", timeZone: "UTC", rules: [{ id: "all", label: "全天", priority: 0, timeRange: { start: "00:00", end: "00:00" },
      pricing: { unitMinutes: 60, unitPrice: 100, roundGraceMinutes: 0, priceCap: 100000 } }] }), NOW, NOW],
  );
  sqlite.run("INSERT INTO resource_groups(shop_id,id,name,enabled,default_pricing_config_id,created_at,updated_at) VALUES ('shop','default','默认',1,'plan',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('cab','cab-pub','shop','舞萌','')");
  sqlite.run(
    `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
     VALUES ('shop','cab','hinata_io',?,'{}',?,?)`,
    [JSON.stringify({ transport: "embedded", coinKey: 32, coinCap: 3, channel: "m_cab" }), NOW, NOW],
  );
  let queries = 0;
  const inner = createD1DatabaseFromSqlite(sqlite) as any;
  const counted = (statement: any): any => new Proxy(statement, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== "function") return value;
      if (key === "bind") return (...args: unknown[]) => counted(value.apply(target, args));
      if (key === "first" || key === "all" || key === "run") return (...args: unknown[]) => { queries++; return value.apply(target, args); };
      return value.bind(target);
    },
  });
  const DB = new Proxy(inner, {
    get(target, key) {
      const value = target[key];
      if (key === "prepare") return (sql: string) => counted(value.call(target, sql));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const limiter = { limit: async () => ({ success: true }) };
  const env = { DB, SESSION_SECRET: SECRET, URL_ENCRYPTION_KEY: "unit-test-key", RATE_LIMIT_5: limiter, RATE_LIMIT_10: limiter, RATE_LIMIT_20: limiter, RATE_LIMIT_30: limiter } as unknown as Env;
  const app = createApp();
  const { ticket } = await mintResourceTicket(SECRET, "shop-code", "cab-pub");
  const headers = (signedIn = true) => ({ "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...(signedIn ? { authorization: `Bearer ${TOKEN}` } : {}) });
  const page = async (signedIn = true) => {
    queries = 0;
    const response = await app.fetch(new Request(`https://prism.test/api/v1/devices/session/page?ticket=${encodeURIComponent(ticket)}`, { headers: headers(signedIn) }), env);
    const json = await response.json() as any;
    return { status: response.status, page: json.data, queries };
  };
  const act = async (action: string, payload?: Record<string, unknown>, operationId = op(), signedIn = true) => {
    const response = await app.fetch(new Request("https://prism.test/api/v1/devices/session/action", {
      method: "POST", headers: headers(signedIn), body: JSON.stringify({ ticket, operationId, action, payload }),
    }), env);
    const json = await response.json() as any;
    return { status: response.status, data: json.data, error: json.error };
  };
  const books = (credit: number) => {
    for (const [key, value] of [["link", "online"], ["cabinet", { players: [{ credit }] }]] as const)
      sqlite.run(
        `INSERT OR REPLACE INTO device_state(shop_id,device_id,capability,key,value_json,authority,changed_at)
         VALUES ('shop','cab','hinata_io',?,?,'observed',?)`,
        [key, JSON.stringify(value), NOW],
      );
  };
  return { sqlite, page, act, books, env, app, ticket, headers };
}

const blockIds = (page: any) => page.blocks.map((entry: any) => entry.id);
const coinOf = (page: any) => page.blocks.find((entry: any) => entry.id === "coin");

describe("reading and acting on the page", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  it("goes from signing in to confirming to playing", async () => {
    const { sqlite, page, act, books } = await fixture();
    books(0);
    expect(blockIds((await page(false)).page)).toEqual(["signin"]);

    const entering = await page();
    expect(blockIds(entering.page)).toEqual(["entry-title", "pricing", "consent", "entry"]);
    expect(entering.page).toMatchObject({ shop: "Arcade", shopCode: "shop-code", resource: "舞萌", publicId: "cab-pub", billingActive: false });

    const button = entering.page.blocks.at(-1);
    const entered = await act(button.action, { ...button.payload, consent: true });
    expect(entered.status).toBe(200);
    expect(entered.data.ok).toBe(true);
    expect(entered.data.page.billingActive).toBe(true);
    expect(blockIds(entered.data.page)).toEqual(["cards", "coin"]);
    expect(entered.data.page.blocks[0]).toMatchObject({ capture: true, action: "card.swipe" });
    sqlite.close();
  });

  it("answers a repeated action once, with the page as it stands", async () => {
    const { sqlite, page, act } = await fixture();
    const button = (await page()).page.blocks.at(-1);
    const operationId = op();
    const first = await act("entry", { ...button.payload, consent: true }, operationId);
    const second = await act("entry", { ...button.payload, consent: true }, operationId);
    expect(first.data.ok).toBe(true);
    expect(second.data.ok).toBe(true);
    expect((sqlite.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(1);
    sqlite.close();
  });

  it("answers a refusal with why, and the page that explains it", async () => {
    const { sqlite, page, act, books } = await fixture();
    const button = (await page()).page.blocks.at(-1);
    await act("entry", { ...button.payload, consent: true });
    books(1);
    expect(coinOf((await page()).page)).toMatchObject({ enabled: true, label: "投币" });
    books(3);
    expect(coinOf((await page()).page)).toMatchObject({ enabled: false, label: "达到机台投币上限" });

    const refused = await act("coin");
    expect(refused.status).toBe(200);
    expect(refused.data.ok).toBe(false);
    expect(refused.data.notices[0]).toMatchObject({ code: "COIN_CABINET_FULL" });
    expect(coinOf(refused.data.page).enabled).toBe(false);
    sqlite.close();
  });

  it("refuses what is not offered, as the old route does", async () => {
    const { sqlite, page, act } = await fixture();
    const button = (await page()).page.blocks.at(-1);
    await act("entry", { ...button.payload, consent: true });
    const off = await act("power.off");
    expect(off.data.ok).toBe(false);
    expect(off.data.notices).toHaveLength(1);
    const made = await act("no.such.action");
    expect(made.data.ok).toBe(false);
    sqlite.close();
  });

  it("leaves what the page cannot answer an error", async () => {
    const { sqlite, act } = await fixture();
    const stranger = await act("coin", undefined, op(), false);
    expect(stranger.status).toBe(401);
    expect(stranger.error.notice.flow).toBe("signin");
    sqlite.close();
  });

  it("shows a disabled player the reason, and the older read still refuses them", async () => {
    const { sqlite, page, app, env, ticket, headers } = await fixture();
    sqlite.run("UPDATE players SET status='disabled' WHERE id='p1'");
    const read = await page();
    expect(read.status).toBe(200);
    expect(blockIds(read.page)).toEqual(["disabled"]);
    const old = await app.fetch(new Request(`https://prism.test/api/v1/devices/session/state?ticket=${encodeURIComponent(ticket)}`, { headers: headers() }), env);
    expect(old.status).toBe(403);
    sqlite.close();
  });

  it("sits a player down from the confirmation page, tells the table's pages, and gets them up again", async () => {
    const { sqlite, page, act, env } = await fixture();
    sqlite.run("DELETE FROM device_capabilities WHERE device_id='cab'");
    sqlite.run("UPDATE machines SET capacity=2 WHERE id='cab'");
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
       VALUES ('shop','cab','mahjong',?,'{}',?,?)`,
      [JSON.stringify({ pricingConfigIds: ["plan"] }), NOW, NOW],
    );
    const told: Array<[unknown, string]> = [];
    (env as any).SHOP_HUB = { getByName: () => new Proxy({}, {
      get: (_, name) => async (...args: unknown[]) => { if (name === "pagesChanged") told.push(args as [unknown, string]); },
    }) };
    const button = (await page()).page.blocks.at(-1);
    expect(button.action).toBe("mahjong.join");
    const seated = await act(button.action, { ...button.payload, consent: true });
    expect(seated.status).toBe(200);
    expect(seated.data.ok).toBe(true);
    expect(blockIds(seated.data.page)).toEqual(["mahjong", "seat"]);
    expect(seated.data.page.blocks[0].seats).toEqual([{ name: "一号", mine: true }]);
    expect(seated.data.page.blocks[1].action).toBe("mahjong.leave");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(told).toContainEqual([{ player: "p1" }, "seat"]);
    const left = await act("mahjong.leave");
    expect(left.data.ok).toBe(true);
    expect(left.data.page.blocks.find((block: any) => block.kind === "mahjong")?.seats ?? []).toEqual([]);
    sqlite.close();
  });

  it("waits for a direct-connected IO, and offers its actions once it connects", async () => {
    const { sqlite, page, act, books } = await fixture();
    const button = (await page()).page.blocks.at(-1);
    const entered = await act("entry", { ...button.payload, consent: true });
    expect(blockIds(entered.data.page)).toEqual(["io-waiting"]);
    books(0);
    expect(blockIds((await page()).page)).toEqual(["cards", "coin"]);
    sqlite.run("UPDATE device_state SET value_json='\"offline\"' WHERE key='link'");
    expect(blockIds((await page()).page)).toEqual(["io-waiting"]);
    sqlite.close();
  });

  it("does not wait on an IO the platform has no link to", async () => {
    const { sqlite, page, act } = await fixture();
    const button = (await page()).page.blocks.at(-1);
    await act("entry", { ...button.payload, consent: true });
    sqlite.run("UPDATE device_capabilities SET config_json=? WHERE device_id='cab'", [JSON.stringify({ transport: "external", coinKey: 32 })]);
    sqlite.run("UPDATE device_capabilities SET secret_json=? WHERE device_id='cab'", [JSON.stringify({ url: "x", password: "x" })]);
    clearShopDependenciesCache();
    expect(blockIds((await page()).page)).toEqual(["cards", "coin"]);
    sqlite.close();
  });

  it("costs about what the older read did, plus the books and whether anything is billing", async () => {
    const { sqlite, page, act, books } = await fixture();
    books(0);
    const entering = await page();
    expect(entering.queries).toBeLessThanOrEqual(15);
    const button = entering.page.blocks.at(-1);
    await act("entry", { ...button.payload, consent: true });
    clearShopDependenciesCache();
    const ready = await page();
    expect(blockIds(ready.page)).toEqual(["cards", "coin"]);
    expect(ready.queries).toBeLessThanOrEqual(13);
    sqlite.close();
  });
});

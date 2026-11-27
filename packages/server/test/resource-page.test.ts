import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { clearShopDependenciesCache } from "../src/middleware/tenant.js";
import { sha256 } from "../src/crypto.js";
import { walkPageBlocks, type PageBlock } from "@prism/page-protocol";
import { renderPage, type PageInput } from "../src/resources/page.js";
import { renderBindingPromptLines } from "../src/resources/page-text.js";
import { pageUi } from "../src/resources/page-ui.js";
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
  capabilities: { power: false, climate: false, card: false, coin: false, door: false, table: false },
  billed: false, cardCapture: false,
  geo: { checkin: false, machine: false },
  signedIn: true, gate: "ready", billing: null, power: null, climate: null, coinFull: false, ioWaiting: false, table: null,
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

  it("offers a passkey only where there is something to use", () => {
    expect(renderPage(input()).offerPasskeySetup).toBe(false);
    expect(renderPage(input({ ...caps("coin"), signedIn: false })).offerPasskeySetup).toBe(false);
    expect(renderPage(input(caps("coin"))).offerPasskeySetup).toBe(true);
    expect(renderPage(input({ ...caps("coin"), gate: "binding" })).offerPasskeySetup).toBe(false);
    expect(renderPage(input({ ...caps("coin"), gate: "disabled" })).offerPasskeySetup).toBe(false);
    expect(renderPage(input({ ...caps("coin"), needsBinding: true })).offerPasskeySetup).toBe(false);
  });

  it("asks a stranger to sign in before anything else", () => {
    expect(ids({ ...caps("coin"), signedIn: false })).toEqual(["signin"]);
    expect(ids({ billed: true, signedIn: false })).toEqual(["signin"]);
  });

  it("shows only the gate while one stands", () => {
    expect(ids({ ...caps("coin", "card"), gate: "binding" })).toEqual(["binding"]);
    expect(ids({ ...caps("coin", "card"), gate: "disabled" })).toEqual(["disabled"]);
    expect(
      renderPage(input({ ...caps("coin", "card"), gate: "binding", shopBills: true, billingActive: true })).accountMenu,
    ).toEqual({ tabs: [], logoutLabel: "退出登录" });
    expect(
      renderPage(input({ ...caps("coin", "card"), gate: "disabled", shopBills: true, billingActive: true })).accountMenu,
    ).toEqual({ tabs: [], logoutLabel: "退出登录" });
    expect(
      renderPage(input({ ...caps("card"), needsBinding: true, shopBills: true, billingActive: true })).accountMenu,
    ).toEqual({ tabs: [], logoutLabel: "退出登录" });
  });

  it("asks for confirmation with the rules and their revision", () => {
    const over = { ...caps("coin"), gate: "entry" as const, billing: { rules: { plans: [] }, preview: { revision: "r1" } } };
    expect(ids(over)).toEqual(["entry-title", "pricing", "consent", "entry"]);
    expect(block(over, "entry")).toMatchObject({ action: "entry", requires: "consent", payload: { expectedRevision: "r1" } });
  });

  it("offers no confirmation when the resource cannot bill", () => {
    const over = { ...caps("door"), gate: "entry" as const, billing: { error: { message: "没有配置计费" } } };
    expect(ids(over)).toEqual(["entry-error"]);
    expect(block(over, "entry-error")).toEqual({
      kind: "text", id: "entry-error", text: "暂时无法使用", style: "status", icon: "unavailable", detail: "没有配置计费", level: "error",
    });
  });

  it("draws page-level states as status text, so old clients still show the line", () => {
    expect(block({ ...caps("coin", "card"), gate: "disabled" }, "disabled")).toMatchObject({
      kind: "text", style: "status", icon: "blocked", level: "error", text: "玩家资格已停用", detail: "请联系店员恢复后再使用",
    });
    expect(block({ ...caps("coin"), ioWaiting: true }, "io-waiting")).toMatchObject({ style: "status", icon: "waiting" });
    expect(block({}, "empty")).toMatchObject({ style: "status", icon: "empty", level: "muted" });
  });

  it("enters and opens the door with one button, and checks the door's location rule", () => {
    const over = { ...caps("door"), gate: "entry" as const, geo: { checkin: true, machine: false }, billing: {} };
    expect(block(over, "door")).toMatchObject({ action: "entry", payload: { openDoor: true }, requires: "consent", needsLocation: true });
    expect(block({ ...caps("door"), geo: { checkin: true, machine: false } }, "door")).toMatchObject({ action: "door.open", needsLocation: true });
    expect(block({ ...caps("coin"), geo: { checkin: true, machine: false } }, "coin").needsLocation).toBe(false);
  });

  it("turns the coin button off at the cabinet's limit, and keeps it beside the cards on a cabinet that also coins after a swipe", () => {
    expect(block({ ...caps("coin") }, "coin")).toMatchObject({ label: "投币", enabled: true });
    expect(block({ ...caps("coin"), coinFull: true }, "coin")).toMatchObject({ label: "达到机台投币上限", enabled: false });
    expect(ids({ ...caps("card", "coin") })).toEqual(["cards", "coin"]);
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
    const table = (...seats: ReturnType<typeof seat>[]) => ({ ...caps("table"), table: { capacity: 2, seats } });
    expect(block(table(), "seat")).toMatchObject({ action: "table.join", style: "primary" });
    expect(block(table(seat("我", true), seat("他")), "seat").action).toBe("table.leave");
    expect(ids(table(seat("甲"), seat("乙")))).toEqual(["table", "seat-full"]);
  });

  it("confirms at a table by sitting down, which also checks the machine's location rule", () => {
    const over = { ...caps("table"), gate: "entry" as const, geo: { checkin: false, machine: true }, billing: { preview: { revision: "r" } } };
    expect(block(over, "entry")).toMatchObject({ action: "table.join", requires: "consent", payload: { expectedRevision: "r" }, needsLocation: true });
  });

  it("is worded in the player's language, with no text left behind", () => {
    const enHead = { shop: "Shop", shopCode: "s", heroUrl: null, resource: "maimai", publicId: "p" };
    const over = { ...caps("coin"), head: enHead, locale: "en" as const, gate: "entry" as const, billing: { rules: { plans: [] } } };
    expect(block(over, "entry").label).toBe("Confirm");
    expect(block(over, "consent").text).not.toMatch(/[一-鿿]/);
    expect(block({ ...caps("coin"), head: enHead, locale: "en" }, "coin").label).toBe("Insert coin");
    const enClimate = {
      mode: "cool",
      modes: ["off", "cool", "heat", "dry", "fan_only", "auto", "heat_cool"],
      temperature: 24,
      currentTemperature: 26.5,
      minTemperature: 16,
      maxTemperature: 30,
      temperatureStep: 0.5,
      fanMode: "medium",
      fanModes: ["auto", "silent", "low", "medium", "high", "turbo"],
    };
    const pages = [
      renderPage(input({ ...caps("coin"), head: enHead, locale: "en", signedIn: false })),
      renderPage(input({ ...caps("coin"), head: enHead, locale: "en", gate: "binding" })),
      renderPage(input(over)),
      renderPage(input({ ...caps("power"), head: enHead, locale: "en", power: "off" })),
      renderPage(input({ ...caps("climate", "card", "coin"), head: enHead, locale: "en", cardCapture: true, climate: enClimate })),
      renderPage(input({ ...caps("climate"), head: enHead, locale: "en", climate: null })),
      renderPage(input({ ...caps("table"), head: enHead, locale: "en", table: { capacity: 2, seats: [{ name: "Player", mine: true, playing: false }] } })),
    ];
    for (const page of pages) expect(JSON.stringify(page.blocks)).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("drives cards, climate, signin, binding, pricing, and button waits from the server without /cards links", () => {
    const withCapture = block({ ...caps("card", "coin"), cardCapture: true }, "cards");
    expect(withCapture.empty.actions.map((a: any) => a.action)).toEqual(["cards.capture", "cards.reload"]);
    // Without the cards there is only reading them again, and it is the page's one thing to do.
    expect(withCapture.loadError.actions).toEqual([{ id: "refresh", label: "刷新", action: "cards.reload", style: "primary" }]);
    expect(withCapture.captureUi).toMatchObject({
      title: "添加卡片",
      waitingText: "请把卡片放在「舞萌」的读卡器上",
      outcomes: { added: "已添加卡片" },
    });
    expect(JSON.stringify(withCapture)).not.toContain("/cards");
    expect(block({ ...caps("card", "coin"), cardCapture: true }, "coin").hideDuringCapture).toBe(true);

    const withoutCapture = block({ ...caps("card"), cardCapture: false }, "cards");
    expect(withoutCapture.empty.actions).toEqual([{ id: "refresh", label: "刷新", action: "cards.reload" }]);
    expect(withoutCapture.captureUi).toBeUndefined();
    expect(JSON.stringify(withoutCapture)).not.toContain("/cards");

    const enCards = block({ ...caps("card"), locale: "en", cardCapture: true, head: { shop: "Shop", shopCode: "s", heroUrl: null, resource: "maimai", publicId: "p" } }, "cards");
    expect(enCards.empty.actions.map((a: any) => a.label)).toEqual(["Add card", "Refresh"]);
    expect(enCards.loadError.actions.map((a: any) => a.label)).toEqual(["Refresh"]);

    const power = block({ ...caps("power"), power: "off" }, "power");
    expect(power.wait).toMatchObject({ ms: 15_000, timeoutMessage: "未检测到开机，请重试", notice: { code: "POWER_WAIT_TIMEOUT", presentation: "toast", durationMs: 5000 } });

    const signIn = block({ ...caps("coin"), signedIn: false }, "signin");
    expect(signIn.methods.map((m: any) => m.provider)).toEqual(["munet", "passkey"]);

    const binding = block({ ...caps("coin"), gate: "binding" }, "binding");
    expect(binding).toMatchObject({ title: "绑定身份", copyLabel: "复制", copiedLabel: "已复制" });

    const pricing = block({ ...caps("coin"), gate: "entry", billing: { rules: { plans: [] } } }, "pricing");
    expect(pricing.labels).toMatchObject({ title: "计费规则", listSeparator: "、" });

    const climate = block({
      ...caps("climate"),
      climate: {
        mode: "cool", modes: ["off", "cool", "heat"], temperature: 25, currentTemperature: 27.5,
        minTemperature: 16, maxTemperature: 30, temperatureStep: 0.5, fanMode: "turbo", fanModes: ["auto", "turbo"],
      },
    }, "climate");
    expect(climate).toMatchObject({
      roomText: "室温 27.5°",
      currentModeLabel: "制冷",
      modes: [{ value: "cool", label: "制冷", icon: "cool" }, { value: "heat", label: "制热", icon: "heat" }],
      fanModes: [{ value: "auto", label: "自动" }, { value: "turbo", label: "强劲" }],
      actions: { on: "climate.on", off: "climate.off", setMode: "climate.set_mode", setTemperature: "climate.set_temperature", setFanMode: "climate.set_fan_mode" },
    });

    expect(renderBindingPromptLines("zh", "", "AB12")).toEqual([
      { text: "向店铺 Bot 发送", command: false },
      { text: "bind AB12", command: true },
    ]);
    expect(renderBindingPromptLines("en", "", "AB12")).toEqual([
      { text: "Send to this shop’s bot", command: false },
      { text: "bind AB12", command: true },
    ]);
    expect(renderBindingPromptLines("zh", "加入 QQ 群", "AB12")).toEqual([
      { text: "加入 QQ 群", command: false },
      { text: "bind AB12", command: true },
    ]);
    expect(renderBindingPromptLines("zh", "私聊 Bot\n/bind {code}", "AB12")).toEqual([
      { text: "私聊 Bot", command: false },
      { text: "/bind AB12", command: true },
    ]);
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
  sqlite.run("INSERT INTO player_identities (shop_id, subject, player_id, created_at, provider) VALUES ('shop','u1','p1',?, 'web-account')", [NOW]);
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
    // That someone tried is an event of the resource: who, from where, and why not.
    const tried = sqlite.query(
      "SELECT kind, capability, origin, via, player_id IS NOT NULL AS by_player, json_extract(payload_json,'$.code') AS code FROM device_events WHERE name='coin.refused'",
    ).all();
    expect(tried).toEqual([{ kind: "signal", capability: "coin", origin: "platform", via: "page", by_player: 1, code: "COIN_CABINET_FULL" }]);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM device_operations WHERE action='coin'").get()).toEqual({ n: 0 });
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
       VALUES ('shop','cab','table',?,'{}',?,?)`,
      [JSON.stringify({ pricingConfigIds: ["plan"] }), NOW, NOW],
    );
    const told: Array<[unknown, string]> = [];
    (env as any).SHOP_HUB = { getByName: () => new Proxy({}, {
      get: (_, name) => async (...args: unknown[]) => { if (name === "pagesChanged") told.push(args as [unknown, string]); },
    }) };
    const button = (await page()).page.blocks.at(-1);
    expect(button.action).toBe("table.join");
    const seated = await act(button.action, { ...button.payload, consent: true });
    expect(seated.status).toBe(200);
    expect(seated.data.ok).toBe(true);
    expect(blockIds(seated.data.page)).toEqual(["table", "seat"]);
    expect(seated.data.page.blocks[0].seats).toEqual([{ name: "一号", mine: true }]);
    expect(seated.data.page.blocks[1].action).toBe("table.leave");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(told).toContainEqual([{ player: "p1" }, "seat"]);
    const left = await act("table.leave");
    expect(left.data.ok).toBe(true);
    expect(left.data.page.blocks.find((block: any) => block.kind === "table")?.seats ?? []).toEqual([]);
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
    // +1: whether a scheduled price change is due, checked once per shop (pricing-changes.ts).
    expect(entering.queries).toBeLessThanOrEqual(17);
    const button = entering.page.blocks.at(-1);
    await act("entry", { ...button.payload, consent: true });
    clearShopDependenciesCache();
    const ready = await page();
    expect(blockIds(ready.page)).toEqual(["cards", "coin"]);
    expect(ready.queries).toBeLessThanOrEqual(14);
    sqlite.close();
  });

  it("records one resource.visited event per valid signed-in ticket, ignores invalid or signed-out visits, and handles unlinked accounts", async () => {
    const { sqlite, app, env, ticket, headers, page } = await fixture();

    // 1. Signed-out visit and expired ticket record nothing
    await page(false);
    const invalid = await app.fetch(new Request("https://prism.test/api/v1/devices/session/page?ticket=bad-ticket", { headers: headers() }), env);
    expect(invalid.status).toBe(410);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM device_events WHERE name='resource.visited'").get()).toEqual({ n: 0 });

    // 2. Signed-in valid visit via /session/page records one event with player_id
    const first = await page(true);
    expect(first.status).toBe(200);
    const visits1 = sqlite.query("SELECT id, device_id, capability, kind, name, origin, player_id, via, payload_json FROM device_events WHERE name='resource.visited'").all() as any[];
    expect(visits1).toHaveLength(1);
    expect(visits1[0]).toMatchObject({
      device_id: "cab",
      capability: "shop",
      kind: "signal",
      name: "resource.visited",
      origin: "platform",
      player_id: "p1",
      via: "page",
      payload_json: "{}",
    });

    // 3. Repeated polls on /session/page and /session/bootstrap with the same ticket deduplicate
    await page(true);
    const boot = await app.fetch(new Request(`https://prism.test/api/v1/devices/session/bootstrap?ticket=${encodeURIComponent(ticket)}`, { headers: headers() }), env);
    expect(boot.status).toBe(200);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM device_events WHERE name='resource.visited'").get()).toEqual({ n: 1 });

    // 4. Disabled resource records nothing on a fresh ticket
    const { ticket: freshTicket } = await mintResourceTicket(SECRET, "shop-code", "cab-pub");
    sqlite.run("UPDATE machines SET enabled=0 WHERE id='cab'");
    const disabledRes = await app.fetch(new Request(`https://prism.test/api/v1/devices/session/bootstrap?ticket=${encodeURIComponent(freshTicket)}`, { headers: headers() }), env);
    expect(disabledRes.status).toBe(404);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM device_events WHERE name='resource.visited'").get()).toEqual({ n: 1 });
    sqlite.run("UPDATE machines SET enabled=1 WHERE id='cab'");

    // 5. Fresh valid ticket records a second visit; unlinked user records userId in payload
    const validRes = await app.fetch(new Request(`https://prism.test/api/v1/devices/session/bootstrap?ticket=${encodeURIComponent(freshTicket)}`, { headers: headers() }), env);
    expect(validRes.status).toBe(200);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM device_events WHERE name='resource.visited'").get()).toEqual({ n: 2 });

    sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('u_new','user',?,?)", [NOW, NOW]);
    sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('auth_new','u_new',?,?)", [await sha256("new-token"), new Date(Date.now() + 86_400_000).toISOString()]);
    const { ticket: newUserTicket } = await mintResourceTicket(SECRET, "shop-code", "cab-pub");
    const unlinkedRes = await app.fetch(new Request(`https://prism.test/api/v1/devices/session/page?ticket=${encodeURIComponent(newUserTicket)}`, { headers: { authorization: "Bearer new-token" } }), env);
    expect(unlinkedRes.status).toBe(200);
    const unlinkedVisit = sqlite.query("SELECT player_id, payload_json FROM device_events WHERE name='resource.visited' AND player_id IS NULL").get() as any;
    expect(unlinkedVisit).toEqual({ player_id: null, payload_json: JSON.stringify({ userId: "u_new" }) });
    sqlite.close();
  });

  it("returns server-rendered lines on POST /platform-binding across templates and locales", async () => {
    const { sqlite, app, env, headers } = await fixture();

    const readBinding = async (locale: "zh" | "en") => {
      const response = await app.fetch(
        new Request("https://prism.test/api/v1/shops/shop-code/platform-binding", {
          method: "POST",
          headers: { ...headers(), "accept-language": locale },
        }),
        env,
      );
      expect(response.status).toBe(200);
      const json = await response.json() as any;
      return json.data;
    };

    const zhDefault = await readBinding("zh");
    expect(zhDefault.lines).toEqual([
      { text: "向店铺 Bot 发送", command: false },
      { text: `bind ${zhDefault.code}`, command: true },
    ]);

    const enDefault = await readBinding("en");
    expect(enDefault.lines).toEqual([
      { text: "Send to this shop’s bot", command: false },
      { text: `bind ${enDefault.code}`, command: true },
    ]);

    sqlite.run("UPDATE shop_billing_settings SET bot_contact=? WHERE shop_id='shop'", ["加入群 12345"]);
    const legacyContact = await readBinding("zh");
    expect(legacyContact.lines).toEqual([
      { text: "加入群 12345", command: false },
      { text: `bind ${legacyContact.code}`, command: true },
    ]);

    sqlite.run("UPDATE shop_billing_settings SET bot_contact=? WHERE shop_id='shop'", ["私聊 Bot\n/bind {code}"]);
    const templated = await readBinding("zh");
    expect(templated.lines).toEqual([
      { text: "私聊 Bot", command: false },
      { text: `/bind ${templated.code}`, command: true },
    ]);

    sqlite.close();
  });
});

describe("declarative SDUI primitives", () => {
  it("builds nested layout, display, form inputs, and button confirm/collect payloads cleanly", () => {
    const built: PageBlock[] = [
      pageUi.banner("notice", "活动进行中，请选择时段", { title: "预约说明", level: "info" }),
      pageUi.section("booking", [
        pageUi.kv("summary", [
          { label: "机台", value: "舞萌 DX" },
          { id: "status", label: "状态", value: "空闲", tone: "success" },
        ]),
        pageUi.divider("sep"),
        pageUi.image("cover", "/assets/banner.png", { alt: "活动海报", aspectRatio: 1.5 }),
        pageUi.select("slot", [
          { value: "14:00", label: "14:00 - 15:00", detail: "余 2 位" },
          { value: "15:00", label: "15:00 - 16:00", disabled: true },
        ], { name: "slot", label: "选择时段", style: "list", defaultValue: "14:00", required: true }),
        pageUi.input("note", {
          name: "remark",
          label: "备注",
          placeholder: "选填",
          inputType: "text",
          maxLength: 20,
          helperText: "最多 20 字",
        }),
        pageUi.toggle("notify", "到号提醒", { name: "notify", defaultValue: true }),
        pageUi.row("actions", [
          pageUi.button("submit", "提交预约", "custom.reserve", {
            icon: "check",
            style: "primary",
            collect: ["slot", "note", "notify"],
            payload: { expectedVersion: 3 },
            confirm: {
              title: "确认预约",
              body: "提交后将锁定该时段",
              confirmLabel: "确认",
              cancelLabel: "取消",
            },
          }),
          pageUi.button("cancel", "取消", "custom.cancel", {
            icon: "close",
            style: "destructive",
            confirm: {
              title: "确认取消",
              body: "将释放当前名额",
              confirmLabel: "确认取消",
              cancelLabel: "返回",
              destructive: true,
            },
          }),
        ]),
      ], { title: "机台预约", subtitle: "当日有效", style: "card" }),
    ];

    const serialized = JSON.parse(JSON.stringify(built)) as PageBlock[];
    expect(serialized).toHaveLength(2);
    expect(walkPageBlocks(serialized).map((b) => b.id)).toEqual([
      "notice",
      "booking",
      "summary",
      "sep",
      "cover",
      "slot",
      "note",
      "notify",
      "actions",
      "submit",
      "cancel",
    ]);
  });

  it("caps recursive container walking at maxDepth", () => {
    const deep = (depth: number): PageBlock =>
      depth >= 12
        ? pageUi.text(`leaf-${depth}`, "leaf")
        : pageUi.section(`sec-${depth}`, [deep(depth + 1)]);
    const tree = [deep(0)];
    const flattened = walkPageBlocks(tree, 8).map((b) => b.id);
    expect(flattened).toEqual([
      "sec-0",
      "sec-1",
      "sec-2",
      "sec-3",
      "sec-4",
      "sec-5",
      "sec-6",
      "sec-7",
    ]);
  });
});

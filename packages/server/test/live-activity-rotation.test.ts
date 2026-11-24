import { expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { LiveBilling, ROTATE_AFTER_MS, ROTATE_RETRY_MS } from "../src/durable-objects/live-billing.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";

/** A player in the shop with one Live Activity, registered `age` ago by the install `iphone`. */
async function fixture(age: number, startTokens = true) {
  let now = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const sqlite = new Database(":memory:");
  const registered = new Date(now - age).toISOString();
  sqlite.exec(`
    CREATE TABLE player_identities(shop_id TEXT, player_id TEXT, provider TEXT, subject TEXT, created_at TEXT);
    CREATE TABLE shops(id TEXT, public_id TEXT, name TEXT);
    CREATE TABLE sessions(shop_id TEXT, id TEXT, player_id TEXT, started_at TEXT, ended_at TEXT, payment_status TEXT);
    CREATE TABLE live_activity_tokens(id TEXT, token TEXT, environment TEXT, bundle_id TEXT, session_id TEXT, shop_id TEXT, user_id TEXT, created_at TEXT, client_id TEXT);
    CREATE TABLE live_activity_start_tokens(id TEXT, user_id TEXT, client_id TEXT, bundle_id TEXT, environment TEXT, token TEXT);
    CREATE TABLE settlements(shop_id TEXT, session_id TEXT, checkout_id TEXT);
    CREATE TABLE player_checkouts(shop_id TEXT, id TEXT, total INTEGER, settled_at TEXT);
    INSERT INTO player_identities VALUES ('shop','player','web-account','user','2026-01-01');
    INSERT INTO shops VALUES ('shop','demo','月宫');
  `);
  sqlite.run("INSERT INTO sessions VALUES ('shop','visit','player',?,NULL,'unpaid')", [registered]);
  sqlite.run("INSERT INTO live_activity_tokens VALUES ('old',?,'production','moe.neri.hinatago','visit','shop','user',?,'iphone')", ["a".repeat(64), registered]);
  if (startTokens) {
    sqlite.run("INSERT INTO live_activity_start_tokens VALUES ('start','user','iphone','moe.neri.hinatago','production',?)", ["b".repeat(64)]);
    // Another phone of the same account keeps its own activity.
    sqlite.run("INSERT INTO live_activity_start_tokens VALUES ('other','user','ipad','moe.neri.hinatago','production',?)", ["c".repeat(64)]);
  }
  const state = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    async get<T>(key: string) { return state.get(key) as T | undefined; },
    async put(key: string, value: unknown) { state.set(key, value); },
    async delete(key: string) { return state.delete(key); },
    async getAlarm() { return alarm; },
    async setAlarm(at: number) { alarm = at; },
    async deleteAlarm() { alarm = null; },
    async deleteAll() { state.clear(); },
  };
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const encoded = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey))));
  const env = {
    DB: createD1DatabaseFromSqlite(sqlite), APP_ORIGIN: "https://link.example",
    APNS_KEY_ID: "key", APNS_TEAM_ID: "team", APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`,
  };
  const object = () => new LiveBilling({ storage } as any, env as any);
  const pushes: Array<{ url: string; payload: any }> = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url, init) => {
    pushes.push({ url: String(url), payload: JSON.parse(String(init?.body)) });
    return new Response("", { status: 200 });
  }) as typeof fetch);
  /** The running bill, as if just worked out, so the alarm does not price the visit itself. */
  const bill = () => {
    const visit = state.get("visit") as { revision: number };
    state.set("bill", { revision: visit.revision, calculatedAt: now, snapshot: {
      bill: { amountCents: 2400, planLabel: "", nextEvent: null, asOfUnix: now / 1000 },
      nextCheckAt: now + 3 * 3600_000, endedAtUnix: null, startedAtUnix: Date.parse(registered) / 1000,
    } });
  };
  return {
    sqlite, pushes, state, object, now: () => now, alarm: () => alarm,
    run: async () => { now = Math.max(now, alarm!); alarm = null; bill(); await object().alarm(); },
    close: () => { fetchSpy.mockRestore(); clock.mockRestore(); sqlite.close(); },
  };
}

it("rotates an activity at 7.5 hours: a new one to the same install, the old one dismissed at once", async () => {
  const h = await fixture(ROTATE_AFTER_MS + 1000);
  const lines: Array<Record<string, unknown>> = [];
  const info = spyOn(console, "info").mockImplementation((line: Record<string, unknown>) => { lines.push(line); });
  try {
    await h.object().refresh("shop", "player", false, true);
    await h.run();
    // The line says whose card it was, on which phone, and which visit.
    expect(lines.find((line) => line.event === "live_activity_rotated")).toMatchObject({
      message: "[live-activity] rotated the card on install iphone of player player after 7.5 h; old card dismiss: delivered",
      kind: "app", module: "live-activity", level: "info", outcome: "started",
      shopId: "shop", playerId: "player", userId: "user", sessionId: "visit", clientId: "iphone", cardId: "old",
    });
    expect(JSON.stringify(lines)).not.toContain("a".repeat(64));
    const [start, end] = h.pushes;
    expect(h.pushes).toHaveLength(2);
    // Only the install that showed it; another phone of the account is not started a second one.
    expect(start?.url).toContain(`/3/device/${"b".repeat(64)}`);
    expect(start?.payload.aps).toMatchObject({
      event: "start", attributes: { sessionId: "visit", shopCode: "demo", shopName: "月宫", origin: "https://link.example" },
      "content-state": { phase: "active", bill: { amountCents: 2400 } },
    });
    expect(end?.url).toContain(`/3/device/${"a".repeat(64)}`);
    expect(end?.payload.aps.event).toBe("end");
    expect(end?.payload.aps["dismissal-date"]).toBe(Math.floor(h.now() / 1000));
    // The new activity registers itself when it shows; the old one is gone.
    expect(h.sqlite.query("SELECT COUNT(*) AS n FROM live_activity_tokens").get()).toEqual({ n: 0 });
  } finally { info.mockRestore(); h.close(); }
});

it("wakes for the rotation, and leaves a younger activity alone until then", async () => {
  const h = await fixture(ROTATE_AFTER_MS - 3600_000);
  try {
    await h.object().refresh("shop", "player", false, true);
    await h.run();
    expect(h.pushes.every((push) => push.payload.aps.event === "update")).toBe(true);
    // Before the bill's next check in three hours: the rotation, an hour after the visit was seen.
    expect(h.alarm()).toBe(1_800_000_000_000 + 3600_000);
    await h.run();
    expect(h.pushes.at(-2)?.payload.aps.event).toBe("start");
    expect(h.pushes.at(-1)?.payload.aps.event).toBe("end");
  } finally { h.close(); }
});

it("keeps an activity it cannot rotate, and tries again later rather than on every alarm", async () => {
  const h = await fixture(ROTATE_AFTER_MS + 1000, false);
  try {
    await h.object().refresh("shop", "player", false, true);
    await h.run();
    expect(h.pushes.some((push) => push.payload.aps.event === "start" || push.payload.aps.event === "end")).toBe(false);
    expect(h.sqlite.query("SELECT COUNT(*) AS n FROM live_activity_tokens").get()).toEqual({ n: 1 });
    expect(h.state.get("rotate-failed:old")).toBe(h.now());
    expect(h.alarm()).toBe(h.now() + ROTATE_RETRY_MS);
  } finally { h.close(); }
});

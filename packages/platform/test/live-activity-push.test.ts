import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import app from "../src/index";
import type { Env as AppEnv } from "../src/types";
import {
  LiveActivityPusher,
  isKnownLiveActivityBundle,
  liveActivityConfig,
  liveActivityEndPayload,
  liveActivityHost,
  liveActivityStartPayload,
  liveActivityTopic,
  liveActivityUpdatePayload,
} from "../src/live-activity-push";
import {
  extractSessionIds,
  playerIdFromPayload,
  sessionEventForPath,
  playerIdsFromPayload,
} from "../src/live-activity-events";

// A throwaway P-256 key so the JWT path is exercised for real without APNs credentials.
const keyPair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))
  .match(/.{1,64}/g)!
  .join("\n")}\n-----END PRIVATE KEY-----\n`;
const config = { keyId: "KEYID123", teamId: "XKKMJBTHX5", privateKey: privateKeyPem };

function captureTransport(response: { status: number; body: string } = { status: 200, body: "" }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  return {
    calls,
    transport: async (request: { url: string; headers: Record<string, string>; body: string }) => {
      calls.push(request);
      return response;
    },
  };
}

test("content-state keys match the Swift ContentState exactly", () => {
  // ActivityKit silently drops any payload whose content state does not decode, so a
  // renamed key here would disable delivery with no error anywhere.
  const update = liveActivityUpdatePayload({ startedAtUnix: 1_000, now: 2_000 });
  expect(Object.keys((update.aps as Record<string, unknown>)["content-state"] as object).sort()).toEqual([
    "endedAtUnix",
    "phase",
    "startedAtUnix",
  ]);
  expect((update.aps as Record<string, unknown>)["content-state"]).toEqual({
    phase: "active",
    startedAtUnix: 1_000,
    endedAtUnix: null,
  });

  const end = liveActivityEndPayload({ startedAtUnix: 1_000, endedAtUnix: 2_000 });
  expect((end.aps as Record<string, unknown>)["content-state"]).toEqual({
    phase: "ended",
    startedAtUnix: 1_000,
    endedAtUnix: 2_000,
  });
  expect((end.aps as Record<string, unknown>).event).toBe("end");
  expect((update.aps as Record<string, unknown>).event).toBe("update");
});

test("the dismissal date gives the ended activity a visible grace period", () => {
  const end = liveActivityEndPayload({ startedAtUnix: 1_000, endedAtUnix: 2_000 });
  const aps = end.aps as Record<string, unknown>;
  expect(aps["dismissal-date"]).toBe(2_000 + 60);
  expect(aps.timestamp).toBe(2_000);
});

test("start payload matches Apple Push-to-Start spec exactly", () => {
  const start = liveActivityStartPayload({
    sessionId: "sess-123",
    shopCode: "shop-a",
    shopName: "Shop Alpha",
    origin: "https://link.neri.moe",
    startedAtUnix: 1_000,
    now: 1_005,
  });
  const aps = start.aps as Record<string, unknown>;
  expect(aps.event).toBe("start");
  expect(aps["attributes-type"]).toBe("StoreVisitAttributes");
  expect(aps.attributes).toEqual({
    sessionId: "sess-123",
    shopCode: "shop-a",
    shopName: "Shop Alpha",
    origin: "https://link.neri.moe",
  });
  expect(aps["content-state"]).toEqual({
    phase: "active",
    startedAtUnix: 1_000,
    endedAtUnix: null,
  });
  expect(aps.alert).toEqual({
    title: "Shop Alpha",
    body: "在店计费中",
  });
  expect(aps["input-push-token"]).toBe(1);
  expect(aps["relevance-score"]).toBe(100);
  expect(aps.timestamp).toBe(1_005);
  expect(aps["stale-date"]).toBe(1_005 + 3600);
});

test("APNs headers and host are correct per environment and bundle", async () => {
  const capture = captureTransport();
  const pusher = new LiveActivityPusher({ config, transport: capture.transport, now: () => 1_700_000_000_000 });
  await pusher.send(
    { token: "abc123", environment: "sandbox", bundleId: "moe.neri.hinatago.prism" },
    liveActivityUpdatePayload({ startedAtUnix: 1, now: 2 }),
  );
  const call = capture.calls[0]!;
  expect(call.url).toBe("https://api.sandbox.push.apple.com/3/device/abc123");
  expect(call.headers["apns-topic"]).toBe(
    "moe.neri.hinatago.prism.push-type.liveactivity",
  );
  expect(call.headers["apns-push-type"]).toBe("liveactivity");
  expect(call.headers["apns-priority"]).toBe("10");
  expect(liveActivityHost("production")).toBe("https://api.push.apple.com");
  expect(liveActivityTopic("moe.neri.hinatago")).toBe(
    "moe.neri.hinatago.push-type.liveactivity",
  );
});

test("the provider token is a valid ES256 JWT and is cached", async () => {
  const capture = captureTransport();
  let clock = 1_700_000_000_000;
  const pusher = new LiveActivityPusher({ config, transport: capture.transport, now: () => clock });

  await pusher.send(
    { token: "abc", environment: "production", bundleId: "moe.neri.hinatago" },
    liveActivityUpdatePayload({ startedAtUnix: 1, now: 2 }),
  );
  const jwt = capture.calls[0]!.headers.authorization!.replace("bearer ", "");
  const [header, claims, signature] = jwt.split(".");
  expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
    alg: "ES256",
    kid: "KEYID123",
  });
  expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
    iss: "XKKMJBTHX5",
    iat: 1_700_000_000,
  });
  // APNs requires the raw 64-byte R||S form, not a DER signature.
  const signatureBytes = Buffer.from(signature!, "base64url");
  expect(signatureBytes.length).toBe(64);
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.publicKey,
      signatureBytes,
      new TextEncoder().encode(`${header}.${claims}`),
    ),
  ).toBe(true);

  // Re-signing on every push gets keys rejected, so the token must be reused.
  clock += 60_000;
  await pusher.send(
    { token: "abc", environment: "production", bundleId: "moe.neri.hinatago" },
    liveActivityUpdatePayload({ startedAtUnix: 1, now: 2 }),
  );
  expect(capture.calls[1]!.headers.authorization).toBe(capture.calls[0]!.headers.authorization);

  // ...but it must be renewed well before Apple's one hour ceiling.
  clock += 51 * 60_000;
  await pusher.send(
    { token: "abc", environment: "production", bundleId: "moe.neri.hinatago" },
    liveActivityUpdatePayload({ startedAtUnix: 1, now: 2 }),
  );
  expect(capture.calls[2]!.headers.authorization).not.toBe(capture.calls[0]!.headers.authorization);
});

test("APNs outcomes are classified without throwing", async () => {
  const expired = new LiveActivityPusher({
    config,
    transport: async () => ({ status: 410, body: "Unregistered" }),
  });
  expect(await expired.send({ token: "t", environment: "sandbox", bundleId: "moe.neri.hinatago" }, {})).toEqual({
    kind: "expired",
  });

  const failing = new LiveActivityPusher({
    config,
    transport: async () => ({ status: 503, body: "ServiceUnavailable" }),
  });
  expect(await failing.send({ token: "t", environment: "sandbox", bundleId: "moe.neri.hinatago" }, {})).toMatchObject({
    kind: "failed",
    status: 503,
  });

  // A transport that throws must be absorbed: delivery never breaks the billing request.
  const throwing = new LiveActivityPusher({
    config,
    transport: async () => {
      throw new Error("network down");
    },
  });
  expect(await throwing.send({ token: "t", environment: "sandbox", bundleId: "moe.neri.hinatago" }, {})).toMatchObject({
    kind: "failed",
  });

  const unknownBundle = new LiveActivityPusher({ config, transport: captureTransport().transport });
  expect(await unknownBundle.send({ token: "t", environment: "sandbox", bundleId: "com.evil.app" }, {})).toEqual({
    kind: "skipped",
  });
  expect(isKnownLiveActivityBundle("moe.neri.hinatago")).toBe(true);
  expect(isKnownLiveActivityBundle("moe.neri.hinatago.prism")).toBe(true);
});

test("missing APNs credentials disable the feature instead of failing", () => {
  expect(liveActivityConfig({})).toBeNull();
  expect(liveActivityConfig({ APNS_KEY_ID: "k", APNS_TEAM_ID: "t" })).toBeNull();
  expect(liveActivityConfig({ APNS_KEY_ID: "k", APNS_TEAM_ID: "t", APNS_PRIVATE_KEY: "not-a-key" })).toBeNull();
  expect(liveActivityConfig({ APNS_KEY_ID: "k", APNS_TEAM_ID: "t", APNS_PRIVATE_KEY: privateKeyPem })).toMatchObject({
    keyId: "k",
    teamId: "t",
  });
  // Secrets pasted through dashboards often arrive with escaped newlines.
  const escaped = privateKeyPem.replaceAll("\n", "\\n");
  expect(liveActivityConfig({ APNS_KEY_ID: "k", APNS_TEAM_ID: "t", APNS_PRIVATE_KEY: escaped })).not.toBeNull();
});

test("session lifecycle paths are recognised across every channel", () => {
  // Player app and App Clip.
  expect(sessionEventForPath("session/start")).toBe("start");
  expect(sessionEventForPath("checkout/confirm")).toBe("end");
  // Admin console.
  expect(sessionEventForPath("players/player-1/session/start")).toBe("start");
  expect(sessionEventForPath("players/player-1/checkout/confirm")).toBe("end");
  expect(sessionEventForPath("players/player-1/checkout/override")).toBe("end");
  expect(sessionEventForPath("players/player-1/sessions/session-1/stop")).toBe("end");
  expect(sessionEventForPath("sessions/active/checkout")).toBe("end");
  // Shop bot, which identifies players by QQ rather than by account.
  expect(sessionEventForPath("players/by-identity/session/start")).toBe("start");
  expect(sessionEventForPath("players/by-identity/checkout/confirm")).toBe("end");
  expect(sessionEventForPath("players/by-identity/sessions/s1/stop")).toBe("end");
  // Reads and unrelated writes must not notify anyone.
  expect(sessionEventForPath("player/me")).toBeNull();
  expect(sessionEventForPath("players/player-1")).toBeNull();
  expect(sessionEventForPath("redeem")).toBeNull();
  expect(sessionEventForPath("wallet/adjustment")).toBeNull();
  expect(sessionEventForPath("players/by-identity/history")).toBeNull();
});

test("the player is resolved from every channel's response shape", () => {
  // A start answers with the session.
  expect(playerIdFromPayload({ session: { id: "s1", playerId: "p1" } })).toBe("p1");
  // A checkout answers with a settlement.
  expect(playerIdFromPayload({ playerSettlement: { playerId: "p2" } })).toBe("p2");
  expect(playerIdFromPayload({ playerId: "p3" })).toBe("p3");
  expect(playerIdFromPayload({})).toBeNull();
  expect(playerIdFromPayload({ session: {} })).toBeNull();
});

test("sessions are extracted from start and checkout payload shapes", () => {
  expect(extractSessionIds({ session: { id: "s1" } }, "start")).toEqual(["s1"]);
  expect(
    extractSessionIds({ sessions: [{ sessionId: "s1" }, { sessionId: "s2" }] }, "end"),
  ).toEqual(["s1", "s2"]);
  expect(
    extractSessionIds({ sessionDetails: [{ sessionId: "s3" }] }, "end"),
  ).toEqual(["s3"]);
  // Duplicates must collapse so one activity is not pushed twice.
  expect(
    extractSessionIds({ sessions: [{ sessionId: "s1" }], session: { id: "s1" } }, "end"),
  ).toEqual(["s1"]);
  expect(extractSessionIds({}, "end")).toEqual([]);
});

// --- End-to-end route coverage -------------------------------------------------------
// Exercises the real Hono app against a real D1 so the register/unregister routes and the
// `forward()` push hook are verified as wired, not just as units.

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  d1Databases: ["DB"],
  kvNamespaces: ["RATE_LIMIT"],
  compatibilityDate: "2026-06-01",
});
const origin = "https://prism.test";
const cookie = "arcadelink_session=e2e-session";
const routeEnv = {
  DB: await mf.getD1Database("DB"),
  RATE_LIMIT: await mf.getKVNamespace("RATE_LIMIT"),
  APP_ORIGIN: origin,
  SESSION_SECRET: "test-only",
  URL_ENCRYPTION_KEY: "test-only",
  MUNET_CLIENT_ID: "",
  MUNET_CLIENT_SECRET: "",
  APPLE_TEAM_ID: "TEST",
  // Credentials present, so the push path is live; the transport is stubbed below.
  APNS_KEY_ID: "KEYID123",
  APNS_TEAM_ID: "XKKMJBTHX5",
  APNS_PRIVATE_KEY: privateKeyPem,
} as unknown as AppEnv;

const e2eRequest = (path: string, body?: unknown) =>
  app.fetch(
    new Request(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    routeEnv,
  );

beforeAll(async () => {
  const db = routeEnv.DB;
  const { sqliteSchema } = await import("@prism/storage-sql");
  const { readFileSync } = await import("node:fs");
  const { sha256 } = await import("../src/crypto");
  const statements = [...sqliteSchema];
  for (const file of [
    "0017_platform_accounts.sql",
    "0018_unified_devices.sql",
    "0019_ticket_coin.sql",
    "0020_mahjong_devices.sql",
    "0021_machine_aliases.sql",
    "0023_remote_entry.sql",
    "0024_drop_remote_entry.sql",
    "0025_live_activity_push_tokens.sql",
    "0026_live_activity_start_tokens.sql",
  ]) {
    statements.push(
      ...readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), "utf8")
        // Strip `--` comments first: a leading comment would otherwise be sent to D1 as
        // part of the statement and rejected as a syntax error.
        .replace(/^\s*--.*$/gm, "")
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean),
    );
  }
  for (const sql of statements) await db.prepare(sql).run();

  await db.prepare("INSERT INTO users(id,role) VALUES ('u','user')").run();
  await db
    .prepare(
      "INSERT INTO auth_identities(id,user_id,provider,provider_subject,username,display_name) VALUES ('identity','u','munet','u','test','Test')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('session','u',?,'2999-01-01T00:00:00Z')",
    )
    .bind(await sha256("e2e-session"))
    .run();
  await db
    .prepare(
      "INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('a','a','Shop A',35,139,80,'u')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('owner-a','a','u','owner')",
    )
    .run();
  await db
    .prepare("INSERT INTO shop_billing_settings(shop_id,billing_enabled,checkin_geo) VALUES ('a',1,0)")
    .run();
  await db
    .prepare(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('a','p','Player','active','2026-01-01')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO shop_player_accounts(shop_id,user_id,player_id,qq,verified_at) VALUES ('a','u','p','123456','2026-01-01')",
    )
    .run();
}, 30000);

afterAll(async () => {
  await mf.dispose();
});

test("live bill endpoint requires the player and returns no invented bill for an empty visit", async () => {
  const response = await e2eRequest("/api/v1/shops/a/player/live-activity/bill");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { bill: null, nextCheckAtUnix: null } });
  const anonymous = await app.fetch(new Request(origin + "/api/v1/shops/a/player/live-activity/bill"), routeEnv);
  expect(anonymous.status).toBe(401);
  expect(playerIdsFromPayload({ settlements: [{ playerSettlement: { playerId: "one" } }, { playerSettlement: { playerId: "two" } }] })).toEqual(["one", "two"]);
});

test("a player registers and retires a Live Activity token", async () => {
  const registered = await e2eRequest("/api/v1/shops/a/player/live-activity/register", {
    activityId: "activity-1",
    token: "AABBCCDDEEFF00112233445566778899",
    environment: "sandbox",
    bundleId: "moe.neri.hinatago",
    attributes: { shopCode: "a", shopName: "Shop A" },
  });
  expect(registered.status).toBe(200);

  const row = await routeEnv.DB.prepare(
    "SELECT shop_id, user_id, token, environment, bundle_id FROM live_activity_tokens WHERE activity_id='activity-1'",
  ).first<Record<string, string>>();
  expect(row).toMatchObject({
    shop_id: "a",
    user_id: "u",
    // APNs requires lowercase hex.
    token: "aabbccddeeff00112233445566778899",
    environment: "sandbox",
    bundle_id: "moe.neri.hinatago",
  });

  // Re-reporting after a token rotation must update in place, not duplicate.
  await e2eRequest("/api/v1/shops/a/player/live-activity/register", {
    activityId: "activity-1",
    token: "11111111111111111111111111111111",
    environment: "production",
    bundleId: "moe.neri.hinatago",
  });
  const rows = await routeEnv.DB.prepare(
    "SELECT token, environment FROM live_activity_tokens WHERE activity_id='activity-1'",
  ).all<Record<string, string>>();
  expect(rows.results).toEqual([
    { token: "11111111111111111111111111111111", environment: "production" },
  ]);

  const removed = await e2eRequest("/api/v1/shops/a/player/live-activity/unregister", {
    activityId: "activity-1",
  });
  expect(removed.status).toBe(200);
  expect(
    await routeEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM live_activity_tokens WHERE activity_id='activity-1'",
    ).first(),
  ).toEqual({ n: 0 });
});

test("registration rejects malformed input and unknown bundles", async () => {
  const badToken = await e2eRequest("/api/v1/shops/a/player/live-activity/register", {
    activityId: "activity-bad",
    token: "not-hex!",
    environment: "sandbox",
    bundleId: "moe.neri.hinatago",
  });
  expect(badToken.status).toBe(400);

  const badBundle = await e2eRequest("/api/v1/shops/a/player/live-activity/register", {
    activityId: "activity-bad",
    token: "aabbccddeeff00112233445566778899",
    environment: "sandbox",
    bundleId: "com.example.other",
  });
  expect(badBundle.status).toBe(400);
  expect(
    await routeEnv.DB.prepare("SELECT COUNT(*) AS n FROM live_activity_tokens").first(),
  ).toEqual({ n: 0 });
});

test("settling a visit pushes an end event to the player's phone", async () => {
  // Seeds a token for the very session this test will open, then checks that the real
  // checkout route reaches APNs with a well-formed `end`.
  const pushes: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    pushes.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    await routeEnv.DB.prepare("DELETE FROM sessions").run();
    const startedAt = new Date(Date.now() - 90 * 60_000).toISOString();
    await routeEnv.DB.prepare(
      "INSERT INTO sessions(shop_id,id,player_id,started_at,status,pricing_config_ids_json,payment_status) VALUES ('a','sess-1','p',?,'active','[]','unpaid')",
    )
      .bind(startedAt)
      .run();
    await routeEnv.DB.prepare(
      "INSERT INTO live_activity_tokens(id,shop_id,user_id,activity_id,token,environment,bundle_id,session_id,attributes_json,created_at,updated_at) VALUES ('t1','a','u','act-1','aabbccddeeff00112233445566778899','sandbox','moe.neri.hinatago','sess-1','{}',?,?)",
    )
      .bind(startedAt, startedAt)
      .run();

    // Stopping without payment must remain an active, recoverable bill.
    const stoppedAt = new Date().toISOString();
    await routeEnv.DB.prepare("UPDATE sessions SET status='closed', ended_at=? WHERE id='sess-1'").bind(stoppedAt).run();
    const pending = await e2eRequest("/api/v1/shops/a/player/live-activity/bill?sessionId=sess-1");
    expect(await pending.json()).toMatchObject({ data: { phase: "active", endedAtUnix: Date.parse(stoppedAt) / 1000 } });
    const missing = await e2eRequest("/api/v1/shops/a/player/live-activity/bill?sessionId=another-players-session");
    expect(missing.status).toBe(404);

    const response = await e2eRequest("/api/v1/shops/a/player/checkout/confirm", {
      operationId: crypto.randomUUID(),
    });
    expect(response.status).toBe(200);
    // The response body must still be readable: the push hook clones rather than consumes.
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toHaveProperty("data");
    const recovered = await e2eRequest("/api/v1/shops/a/player/live-activity/bill?sessionId=sess-1");
    const finalBill = (await recovered.json() as any).data;
    expect(finalBill).toMatchObject({ phase: "ended", startedAtUnix: Date.parse(startedAt) / 1000,
      endedAtUnix: Date.parse(stoppedAt) / 1000,
      bill: { amountCents: Math.round((payload as any).data.playerSettlement.total * 100), nextEvent: null } });
    await routeEnv.DB.prepare("INSERT INTO sessions(shop_id,id,player_id,started_at,status,pricing_config_ids_json,payment_status) VALUES ('a','next-visit','p',?,'active','[]','unpaid')").bind(new Date().toISOString()).run();
    const again = await e2eRequest("/api/v1/shops/a/player/live-activity/bill?sessionId=sess-1");
    expect((await again.json() as any).data).toEqual(finalBill);



    // `waitUntil` work is not awaited by the test harness, so allow the microtask to land.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(pushes.length).toBe(1);
    const push = pushes[0]!;
    expect(push.url).toBe("https://api.sandbox.push.apple.com/3/device/aabbccddeeff00112233445566778899");
    expect(push.headers["apns-topic"]).toBe("moe.neri.hinatago.push-type.liveactivity");
    expect(push.headers["apns-push-type"]).toBe("liveactivity");
    const aps = (JSON.parse(push.body) as { aps: Record<string, unknown> }).aps;
    expect(aps.event).toBe("end");
    expect(aps["content-state"]).toMatchObject({ phase: "ended" });
    // The timer must restart from the real session start, not from "now".
    expect((aps["content-state"] as { startedAtUnix: number }).startedAtUnix).toBe(
      Math.floor(new Date(startedAt).getTime() / 1000),
    );

    // The session is settled, so the row must no longer claim it.
    expect(
      await routeEnv.DB.prepare("SELECT session_id FROM live_activity_tokens WHERE id='t1'").first(),
    ).toEqual({ session_id: null });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("settling a visit pushes end to tokens registered for the session even without direct player account mapping", async () => {
  const pushes: { url: string; headers: Record<string, string>; body: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    pushes.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    await routeEnv.DB.prepare("INSERT OR IGNORE INTO users(id) VALUES ('other-user')").run();
    const startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    await routeEnv.DB.prepare(
      "INSERT INTO sessions(shop_id,id,player_id,started_at,status,pricing_config_ids_json,payment_status) VALUES ('a','sess-unmapped','p',?,'active','[]','unpaid')",
    )
      .bind(startedAt)
      .run();
    await routeEnv.DB.prepare(
      "INSERT INTO live_activity_tokens(id,shop_id,user_id,activity_id,token,environment,bundle_id,session_id,attributes_json,created_at,updated_at) VALUES ('t-unmapped','a','other-user','act-unmapped','11223344556677889900112233445566','sandbox','moe.neri.hinatago','sess-unmapped','{}',?,?)",
    )
      .bind(startedAt, startedAt)
      .run();

    const response = await e2eRequest("/api/v1/shops/a/player/checkout/confirm", {
      operationId: crypto.randomUUID(),
    });
    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(pushes.some((p) => p.url.includes("11223344556677889900112233445566"))).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
    await routeEnv.DB.prepare("DELETE FROM live_activity_tokens WHERE id='t-unmapped'").run();
    await routeEnv.DB.prepare("UPDATE sessions SET status='closed', ended_at=? WHERE id='sess-unmapped'")
      .bind(new Date().toISOString())
      .run();
    await routeEnv.DB.prepare("DELETE FROM users WHERE id='other-user'").run();
  }
});

test("a failed checkout never notifies the phone", async () => {
  const pushes: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    pushes.push(input);
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    // Mark leftover sessions closed rather than deleting them: settlement rows reference
    // sessions, so a delete trips the foreign key. With no active session the checkout
    // cannot succeed, which is exactly what this test asserts.
    await routeEnv.DB.prepare("UPDATE sessions SET status='closed', ended_at=? WHERE status='active'")
      .bind(new Date().toISOString())
      .run();
    const response = await e2eRequest("/api/v1/shops/a/player/checkout/confirm", {
      operationId: crypto.randomUUID(),
    });
    expect(response.ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pushes).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a player registers, updates, and unregisters Push-to-Start tokens", async () => {
  // 1. Unauthenticated registration returns 401
  const unauth = await app.fetch(
    new Request(origin + "/api/v1/me/live-activity/start-token", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "client-1",
        token: "11223344556677889900112233445566",
        environment: "sandbox",
        bundleId: "moe.neri.hinatago",
      }),
    }),
    routeEnv,
  );
  expect(unauth.status).toBe(401);

  // 2. Register for main app
  const regApp = await e2eRequest("/api/v1/me/live-activity/start-token", {
    clientId: "client-main",
    token: "AABBCCDDEEFF00112233445566778899",
    environment: "sandbox",
    bundleId: "moe.neri.hinatago",
  });
  expect(regApp.status).toBe(200);

  // 3. Register for App Clip
  const regClip = await e2eRequest("/api/v1/me/live-activity/start-token", {
    clientId: "client-clip",
    token: "99887766554433221100FFEEDDCCBBAA",
    environment: "production",
    bundleId: "moe.neri.hinatago.prism",
  });
  expect(regClip.status).toBe(200);

  // Verify rows stored in database
  const rows = await routeEnv.DB.prepare(
    "SELECT client_id, token, environment, bundle_id FROM live_activity_start_tokens WHERE user_id='u' ORDER BY client_id",
  ).all<Record<string, string>>();
  expect(rows.results).toEqual([
    {
      client_id: "client-clip",
      token: "99887766554433221100ffeeddccbbaa",
      environment: "production",
      bundle_id: "moe.neri.hinatago.prism",
    },
    {
      client_id: "client-main",
      token: "aabbccddeeff00112233445566778899",
      environment: "sandbox",
      bundle_id: "moe.neri.hinatago",
    },
  ]);

  // 4. Update existing client (upsert)
  const regUpdate = await e2eRequest("/api/v1/me/live-activity/start-token", {
    clientId: "client-main",
    token: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    environment: "production",
    bundleId: "moe.neri.hinatago",
  });
  expect(regUpdate.status).toBe(200);

  const updatedRow = await routeEnv.DB.prepare(
    "SELECT token, environment FROM live_activity_start_tokens WHERE user_id='u' AND client_id='client-main'",
  ).first<Record<string, string>>();
  expect(updatedRow).toEqual({
    token: "ffffffffffffffffffffffffffffffff",
    environment: "production",
  });

  // 5. Validation failures
  const badToken = await e2eRequest("/api/v1/me/live-activity/start-token", {
    clientId: "client-bad",
    token: "not-a-hex-token",
    environment: "sandbox",
    bundleId: "moe.neri.hinatago",
  });
  expect(badToken.status).toBe(400);

  const badBundle = await e2eRequest("/api/v1/me/live-activity/start-token", {
    clientId: "client-bad",
    token: "11223344556677889900112233445566",
    environment: "sandbox",
    bundleId: "com.unauthorized.bundle",
  });
  expect(badBundle.status).toBe(400);

  // 6. Delete single client
  const deleteOne = await app.fetch(
    new Request(origin + "/api/v1/me/live-activity/start-token/client-main", {
      method: "DELETE",
      headers: { cookie, origin },
    }),
    routeEnv,
  );
  expect(deleteOne.status).toBe(200);
  const countAfterOne = await routeEnv.DB.prepare(
    "SELECT COUNT(*) AS n FROM live_activity_start_tokens WHERE user_id='u'",
  ).first<{ n: number }>();
  expect(countAfterOne?.n).toBe(1);

  // 7. Delete all clients for user
  const deleteAll = await app.fetch(
    new Request(origin + "/api/v1/me/live-activity/start-token", {
      method: "DELETE",
      headers: { cookie, origin },
    }),
    routeEnv,
  );
  expect(deleteAll.status).toBe(200);
  const countAfterAll = await routeEnv.DB.prepare(
    "SELECT COUNT(*) AS n FROM live_activity_start_tokens WHERE user_id='u'",
  ).first<{ n: number }>();
  expect(countAfterAll?.n).toBe(0);
});

test("external session start pushes APNs start event to registered start tokens", async () => {
  await e2eRequest("/api/v1/me/live-activity/start-token", {
    clientId: "client-main",
    token: "11112222333344445555666677778888",
    environment: "sandbox",
    bundleId: "moe.neri.hinatago",
  });
  await e2eRequest("/api/v1/me/live-activity/start-token", {
    clientId: "client-clip",
    token: "aaaabbbbccccddddeeeeffff00001111",
    environment: "sandbox",
    bundleId: "moe.neri.hinatago.prism",
  });

  const pushes: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    pushes.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const startResponse = await e2eRequest("/api/v1/shops/a/staff/players/p/session/start", {});
    expect(startResponse.status).toBe(200);
    const startBody = (await startResponse.json()) as { data: { session: { id: string } } };
    const sessionId = startBody.data.session.id;

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(pushes.length).toBe(2);

    const mainPush = pushes.find((p) => p.url.includes("11112222333344445555666677778888"))!;
    expect(mainPush).toBeDefined();
    expect(mainPush.headers["apns-topic"]).toBe("moe.neri.hinatago.push-type.liveactivity");
    expect(mainPush.headers["apns-push-type"]).toBe("liveactivity");
    const mainAps = (JSON.parse(mainPush.body) as { aps: Record<string, unknown> }).aps;
    expect(mainAps.event).toBe("start");
    expect(mainAps["attributes-type"]).toBe("StoreVisitAttributes");
    expect((mainAps.attributes as { sessionId: string }).sessionId).toBe(sessionId);
    expect((mainAps["content-state"] as { phase: string }).phase).toBe("active");

    const clipPush = pushes.find((p) => p.url.includes("aaaabbbbccccddddeeeeffff00001111"))!;
    expect(clipPush).toBeDefined();
    expect(clipPush.headers["apns-topic"]).toBe("moe.neri.hinatago.prism.push-type.liveactivity");

    await routeEnv.DB.prepare("UPDATE sessions SET status='closed', ended_at=? WHERE id=?")
      .bind(new Date().toISOString(), sessionId)
      .run();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("initiator client id suppresses Push-to-Start only to the originating device", async () => {
  const pushes: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    pushes.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const startResponse = await app.fetch(
      new Request(origin + "/api/v1/shops/a/staff/players/p/session/start", {
        method: "POST",
        headers: {
          cookie,
          origin,
          "content-type": "application/json",
          "x-prism-client-id": "client-main",
        },
        body: JSON.stringify({}),
      }),
      routeEnv,
    );
    expect(startResponse.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(pushes.length).toBe(1);
    expect(pushes[0]!.url).toContain("aaaabbbbccccddddeeeeffff00001111");
    expect(pushes[0]!.headers["apns-topic"]).toBe("moe.neri.hinatago.prism.push-type.liveactivity");
  } finally {
    globalThis.fetch = realFetch;
  }
});

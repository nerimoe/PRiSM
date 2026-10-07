import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { sqliteSchema, splitD1MigrationStatements } from "@prism/storage-sql";
import app from "../src/index";
import { encryptSecret, decryptSecret, sha256 } from "../src/crypto";
import { utcWriteGuards } from "../src/deployment-gate";
import { createTestRateLimits } from "./rate-limit-fixture";
import { uploadShopBackup, downloadShopBackup } from "../../prism-web/src/shop-data-transfer";
import { exportMonth } from "../src/shop-data-export";
import type { Env } from "../src/types";

const rateLimits = createTestRateLimits();
beforeEach(rateLimits.reset);
const mf = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  d1Databases: ["DB", "RESTORE_DB"],
  compatibilityDate: "2026-06-07",
});
let sourceEnv: Env, targetEnv: Env;
const origin = "https://full-backup.test",
  op = () => crypto.randomUUID();
async function initialize(db: D1Database, prefix = ""): Promise<Env> {
  const env = {
    DB: db,
    ...rateLimits.bindings,
    APP_ORIGIN: origin,
    SESSION_SECRET: "test-only",
    URL_ENCRYPTION_KEY: prefix + "encryption-test-only",
    MUNET_CLIENT_ID: "",
    MUNET_CLIENT_SECRET: "",
    APPLE_TEAM_ID: "TEST",
  } as Env;
  for (const sql of sqliteSchema) await db.prepare(sql).run();
  for (const name of [
    "0017_platform_accounts",
    "0018_unified_devices",
    "0019_ticket_coin",
    "0020_mahjong_devices",
    "0021_machine_aliases",
    "0023_remote_entry",
    "0024_drop_remote_entry",
    "0030_platform_identity_bindings",
    "0025_live_activity_push_tokens", "0026_live_activity_start_tokens", "0031_shop_data_transfer", "0032_read_only_shop_export",
  ]) {
    const sql = readFileSync(new URL(`../../../migrations/${name}.sql`, import.meta.url), "utf8").replace(
      /^\s*--.*$/gm,
      "",
    );
    for (const part of splitD1MigrationStatements(sql)) await db.prepare(part).run();
  }
  for (const name of ["owner", "player", "other", "admin"]) {
    await db
      .prepare("INSERT INTO users(id,role) VALUES (?,'user')")
      .bind(prefix + name)
      .run();
    if (name === "admin") await db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(prefix + name).run();
    await db
      .prepare(
        "INSERT INTO auth_identities(id,user_id,provider,provider_subject,display_name) VALUES (?,?,'munet',?,?)",
      )
      .bind(prefix + name, prefix + name, name, name)
      .run();
    await db
      .prepare(
        "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,'2999-01-01T00:00:00Z')",
      )
      .bind(prefix + name, prefix + name, await sha256(`${name}-session`))
      .run();
  }
  for (const sql of utcWriteGuards) await db.prepare(sql).run();
  return env;
}
beforeAll(async () => {
  sourceEnv = await initialize(await mf.getD1Database("DB"));
  targetEnv = await initialize(await mf.getD1Database("RESTORE_DB"), "restore-");
}, 30000);
afterAll(() => mf.dispose());
async function request(
  env: Env,
  path: string,
  body?: unknown,
  session = "owner-session",
  method = body === undefined ? "GET" : "POST",
) {
  const response = await app.fetch(
    new Request(origin + path, {
      method,
      headers: { origin, cookie: `arcadelink_session=${session}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
  const payload = (await response.json()) as any;
  return { status: response.status, data: payload.data, error: payload.error, backup: payload };
}
async function store(env = sourceEnv, configured = false) {
  const result = await request(env, "/api/v1/merchant/shops", {
    name: configured ? "来源店" : "目标店",
    latitude: 31.23,
    longitude: 121.47,
    ...(configured
      ? {
          billingSetup: {
            paidName: "余额",
            freeName: "赠送",
            hourlyPrice: 18,
            graceMinutes: 10,
            dailyCap: 90,
            autoRegister: true,
          },
        }
      : {}),
  });
  expect(result.status).toBe(201);
  const shop = result.data.shop as { id: string; publicId: string };
  await env.DB.prepare("INSERT INTO shop_data_export_allowances(shop_id,month,extra,import_extra,updated_at) VALUES (?,?,100,100,?)")
    .bind(shop.id, exportMonth("Asia/Shanghai"), new Date().toISOString()).run();
  return shop;
}
const base = (shop: { publicId: string }) => `/api/v1/shops/${shop.publicId}/data`;
const rows = async (env: Env, table: string, id: string) =>
  (await env.DB.prepare(`SELECT * FROM ${table} WHERE shop_id=? ORDER BY rowid`).bind(id).all()).results;
async function download(env: Env, shop: { publicId: string }, scope = "business") {
  const response = await request(env, base(shop) + `/export?scope=${scope}`);
  expect(response.status).toBe(200);
  return response.backup;
}
async function upload(env: Env, shop: { publicId: string }, backup: any) {
  const { tables, ...header } = backup;
  const started = await request(env, base(shop) + "/imports", header);
  expect(started.status).toBe(200);
  let part = 0;
  for (const [table, values] of Object.entries(tables) as [string, any[]][]) {
    let chunk: any[] = [],
      size = 0;
    const flush = async () => {
      if (!chunk.length) return;
      const result = await request(env, base(shop) + `/imports/${started.data.jobId}/parts`, {
        table,
        part: part++,
        rows: chunk,
      });
      if (result.status !== 200)
        throw new Error(JSON.stringify({ table, status: result.status, error: result.error }));
      chunk = [];
      size = 0;
    };
    for (const row of values) {
      const bytes = new TextEncoder().encode(JSON.stringify(row)).length;
      if (chunk.length && (size + bytes > 256 * 1024 || chunk.length >= 1000)) await flush();
      chunk.push(row);
      size += bytes;
    }
    await flush();
  }
  return {
    jobId: started.data.jobId,
    manifest: {
      counts: Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, (r as any[]).length])),
      parts: part,
    },
  };
}
async function preview(env: Env, shop: { publicId: string }, upload: { jobId: string; manifest: any }) {
  return request(env, base(shop) + `/imports/${upload.jobId}/preview`, upload.manifest);
}
async function apply(
  env: Env,
  shop: { publicId: string },
  jobId: string,
  fingerprint: string,
  operationId = op(),
) {
  return request(env, base(shop) + `/imports/${jobId}/apply`, { fingerprint, operationId });
}

test("pure cashier players and paid bills are exported without platform identities and restored in another database", async () => {
  const shop = await store(sourceEnv, true),
    target = await store(targetEnv);
  const settings = (await request(sourceEnv, `/api/v1/shops/${shop.publicId}/settings`)).data;
  expect(
    (
      await request(
        sourceEnv,
        `/api/v1/shops/${shop.publicId}/settings`,
        { ...settings, cashierEnabled: true },
        "owner-session",
        "PUT",
      )
    ).status,
  ).toBe(200);
  const cashier = `/api/v1/shops/${shop.publicId}/cashier`;
  const registration = await request(sourceEnv, cashier + "/register", {
    card: { kind: "type-a", uid: "AABBCCDD" },
    displayName: "纯前台玩家",
    operationId: op(),
  });
  expect(registration.status).toBe(201);
  const id = registration.data.profile.id;
  const entered = await request(sourceEnv, `${cashier}/profiles/${id}/entry`, { operationId: op() });
  expect(entered.status).toBe(200);
  await sourceEnv.DB.prepare("UPDATE sessions SET started_at=? WHERE shop_id=? AND id=?")
    .bind(new Date(Date.now() - 15 * 60000).toISOString(), shop.id, entered.data.session.id)
    .run();
  const check = await request(sourceEnv, `${cashier}/profiles/${id}/checkout/preview`, {});
  expect(check.status).toBe(200);
  const paid = await request(sourceEnv, `${cashier}/profiles/${id}/checkout/confirm`, {
    operationId: op(),
    method: "wechat",
    collected: true,
    expectedTotal: check.data.settlementPreview.total,
    previewedAt: check.data.settlementPreview.previewedAt,
    sessionIds: check.data.settlementPreview.sessionIds,
  });
  expect(paid.status).toBe(200);
  const backup = await download(sourceEnv, shop);
  expect(backup.version).toBe(2);
  expect(backup.source.origin).toBe(origin);
  expect(backup.tables.players).toHaveLength(1);
  expect(backup.tables.player_identities).toHaveLength(0);
  expect(backup.tables.cashier_profiles).toHaveLength(1);
  expect(backup.tables.sessions).toHaveLength(1);
  expect(backup.tables.cashier_payments).toHaveLength(1);
  const staged = await upload(targetEnv, target, backup),
    preflight = await preview(targetEnv, target, staged);
  expect(preflight.data.errors).toEqual([]);
  expect((await apply(targetEnv, target, staged.jobId, preflight.data.fingerprint)).status).toBe(200);
  const targetBackup = await download(targetEnv, target);
  for (const table of [
    "players",
    "cashier_profiles",
    "sessions",
    "player_checkouts",
    "settlements",
    "cashier_payments",
    "checkout_timelines",
  ])
    expect(targetBackup.tables[table]).toEqual(backup.tables[table]);
}, 30000);

test("cashier identities and verified accounts survive backup and cross-database restore without gaining assets", async () => {
  const shop = await store(sourceEnv, true), target = await store(targetEnv);
  const settings = (await request(sourceEnv, `/api/v1/shops/${shop.publicId}/settings`)).data;
  expect((await request(sourceEnv, `/api/v1/shops/${shop.publicId}/settings`, { ...settings, cashierEnabled: true }, "owner-session", "PUT")).status).toBe(200);
  const cashier = `/api/v1/shops/${shop.publicId}/cashier`;
  const registration = await request(sourceEnv, cashier + "/register", {
    card: { kind: "type-a", uid: "CCDDEEFF" }, displayName: "绑定身份的前台玩家", operationId: op(),
  });
  expect(registration.status).toBe(201);
  const id = registration.data.profile.id, identity = { provider: "onebot", subject: "114514" };
  expect((await request(sourceEnv, `/api/v1/shops/${shop.publicId}/staff/players/${id}/identities`, identity)).status).toBe(200);
  const code = (await request(sourceEnv, `/api/v1/shops/${shop.publicId}/platform-binding`, {}, "player-session")).data.code;
  expect((await request(sourceEnv, `/api/v1/shops/${shop.publicId}/staff/platform-binding/confirm`, { code, ...identity })).status).toBe(200);
  expect((await request(sourceEnv, `${cashier}/profiles/${id}/entry`, { operationId: op() })).status).toBe(200);
  const backup = await download(sourceEnv, shop);
  expect(backup.tables.cashier_profiles).toHaveLength(1);
  expect(backup.tables.player_identities).toEqual([expect.objectContaining(identity)]);
  expect(backup.tables.account_links.find((r: any) => r.source_user_id === "player").player_id).toBe(id);
  expect(backup.tables.asset_holdings).toHaveLength(0);
  const staged = await upload(targetEnv, target, backup), check = await preview(targetEnv, target, staged);
  expect(check.data.errors).toEqual([]);
  expect((await apply(targetEnv, target, staged.jobId, check.data.fingerprint)).status).toBe(200);
  expect((await request(targetEnv, `/api/v1/shops/${target.publicId}/player/me`, undefined, "player-session")).status).toBe(200);
  const player = (await request(targetEnv, `/api/v1/shops/${target.publicId}/staff/live-players`)).data.players.find((p: any) => p.playerId === id);
  expect(player.paymentMode).toBe("cashier");
  expect(player.identities).toEqual(expect.arrayContaining([
    expect.objectContaining(identity), { provider: "web-account", subject: "restore-player", displayName: "player" },
  ]));
  expect((await rows(targetEnv, "cashier_profiles", target.id))[0]!.player_id).toBe(id);
  expect((await rows(targetEnv, "asset_holdings", target.id))).toHaveLength(0);
  // The in-memory validation path must also continue to reject cashier balances.
  const { validateBackup, businessTables } = await import("../src/shop-data-format");
  const legacy = { ...backup, version: 1, tables: Object.fromEntries(businessTables.map(table => [table, backup.tables[table]])) };
  expect(validateBackup(legacy)).toEqual([]);
  legacy.tables.asset_holdings.push({ id: "forbidden", player_id: id, asset_type: "currency", asset_code: "paid", quantity: 1, active_at: null, expires_at: null });
  expect(validateBackup(legacy)).toContain("前台玩家不可拥有余额资产");
}, 30000);

async function deviceSource() {
  const shop = await store(sourceEnv, true),
    now = "2026-10-02T02:08:00.000Z",
    machineId = op(),
    publicId = op();
  const config = (await rows(sourceEnv, "pricing_configs", shop.id))[0]!;
  await sourceEnv.DB.batch([
    sourceEnv.DB.prepare(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'p','已绑定玩家','active',?)",
    ).bind(shop.id, now),
    sourceEnv.DB.prepare(
      "INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES (?,'p','onebot','114514',?),(?,'p','web-account','player',?)",
    ).bind(shop.id, now, shop.id, now),
    sourceEnv.DB.prepare(
      "INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES (?,'player','p',?)",
    ).bind(shop.id, now),
    sourceEnv.DB.prepare(
      "INSERT INTO shop_platform_bindings(shop_id,user_id,provider,subject,verified_at) VALUES (?,'player','onebot','114514',?)",
    ).bind(shop.id, now),
    sourceEnv.DB.prepare(
      "INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES (?,'balance','p','currency','paid',114514)",
    ).bind(shop.id),
    sourceEnv.DB.prepare(
      "INSERT INTO sessions(shop_id,id,player_id,started_at,status,pricing_config_ids_json,payment_status,metadata_json) VALUES (?,'s','p',?,'active',?,'unpaid',?)",
    ).bind(shop.id, now, JSON.stringify([config.id]), JSON.stringify({ mahjongDeviceId: machineId })),
    sourceEnv.DB.prepare(
      "INSERT INTO machines(shop_id,id,public_id,name,hinata_url_encrypted,hinata_password_encrypted,ha_binding_encrypted,mahjong_config_json,aliases_json) VALUES (?,?,?,'测试设备',?,?,?,?,'[\"alias\"]')",
    ).bind(
      shop.id,
      machineId,
      publicId,
      await encryptSecret("https://hinata.invalid", sourceEnv.URL_ENCRYPTION_KEY),
      await encryptSecret("test-device-password", sourceEnv.URL_ENCRYPTION_KEY),
      await encryptSecret(
        JSON.stringify({ url: "https://ha.invalid", token: "test-ha-token", entityId: "switch.machine" }),
        sourceEnv.URL_ENCRYPTION_KEY,
      ),
      JSON.stringify({ capacity: 4, pricingConfigIds: [config.id] }),
    ),
    sourceEnv.DB.prepare(
      "INSERT INTO mahjong_seats(shop_id,player_id,machine_id,session_id,entry_session_id,joined_at) VALUES (?,'p',?,'s',NULL,?)",
    ).bind(shop.id, machineId, now),
    sourceEnv.DB.prepare(
      "INSERT INTO machine_connections(shop_id,machine_id,status,capabilities_json,connected_at,last_seen_at) VALUES (?,?,'online','[\"coin\"]',?,?)",
    ).bind(shop.id, machineId, now, now),
    sourceEnv.DB.prepare(
      "INSERT INTO device_states(shop_id,device_id,type,target_kind,executor_kind,label,status,state,reported_at,reported_by) VALUES (?,?,'power.on','game_machine','hinata_io','机台','online','on',?,'machine')",
    ).bind(shop.id, machineId, now),
    sourceEnv.DB.prepare(
      "INSERT INTO device_commands(shop_id,id,type,device_id,target_kind,executor_kind,player_id,status,requested_at) VALUES (?,'cmd','coin',?,'game_machine','hinata_io','p','pending',?)",
    ).bind(shop.id, machineId, now),
    sourceEnv.DB.prepare(
      "INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at) VALUES (?,'bot','Bot','integration','test',?,'active',?)",
    ).bind(shop.id, await sha256("test-bot-token"), now),
    sourceEnv.DB.prepare(
      "INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,'devices.homeassistant_connection',?,?)",
    ).bind(shop.id, JSON.stringify({ url: "https://ha.invalid", token: "test-ha-token" }), now),
    sourceEnv.DB.prepare(
      "UPDATE shops SET hero_data='data:image/png;base64,TEST_ONLY',radius_meters=123 WHERE id=?",
    ).bind(shop.id),
  ]);
  return { shop, machineId, publicId };
}
test("full backup restores profiles, settings, device secrets with a different key and verified account links without installing login secrets", async () => {
  const source = await deviceSource(),
    target = await store(targetEnv),
    backup = await download(sourceEnv, source.shop);
  expect(backup.shopProfile.heroData).toBe("data:image/png;base64,TEST_ONLY");
  expect(
    backup.tables.app_settings.find((r: any) => r.key === "devices.homeassistant_connection"),
  ).toBeDefined();
  expect(backup.tables.machines[0].hinata_password).toBe("test-device-password");
  expect(backup.tables.machines[0].ha_binding_json).toContain("test-ha-token");
  expect(backup.tables.api_tokens).toHaveLength(1);
  expect(backup.tables.account_links.find((r: any) => r.source_user_id === "player").player_id).toBe("p");
  expect(backup.tables.player_identities.some((r: any) => r.provider === "web-account")).toBe(true);
  const staged = await upload(targetEnv, target, backup),
    check = await preview(targetEnv, target, staged);
  expect(check.data.errors).toEqual([]);
  const id = op(),
    result = await apply(targetEnv, target, staged.jobId, check.data.fingerprint, id);
  expect(result.status).toBe(200);
  expect((await apply(targetEnv, target, staged.jobId, check.data.fingerprint, id)).data).toEqual(
    result.data,
  );
  expect((await apply(targetEnv, target, staged.jobId, check.data.fingerprint, op())).error?.code).toBe(
    "OPERATION_CONFLICT",
  );
  const device = (await rows(targetEnv, "machines", target.id))[0]!;
  expect(device.id).toBe(source.machineId);
  expect(device.public_id).toBe(source.publicId);
  expect(await decryptSecret(String(device.hinata_password_encrypted), targetEnv.URL_ENCRYPTION_KEY)).toBe(
    "test-device-password",
  );
  expect((await rows(targetEnv, "mahjong_seats", target.id))[0]!.machine_id).toBe(source.machineId);
  expect((await rows(targetEnv, "device_commands", target.id))[0]!.status).toBe("expired");
  expect((await rows(targetEnv, "machine_connections", target.id))[0]!.status).toBe("offline");
  expect(
    await targetEnv.DB.prepare("SELECT name,radius_meters FROM shops WHERE id=?").bind(target.id).first(),
  ).toEqual({ name: "来源店", radius_meters: 123 });
  expect(
    await targetEnv.DB.prepare("SELECT COUNT(*) AS n FROM shop_player_accounts WHERE shop_id=?")
      .bind(target.id)
      .first("n"),
  ).toBe(0);
  expect(
    (await request(targetEnv, `/api/v1/shops/${target.publicId}/player/me`, undefined, "player-session"))
      .status,
  ).toBe(200);
  expect(
    await targetEnv.DB.prepare("SELECT user_id,player_id FROM shop_player_accounts WHERE shop_id=?")
      .bind(target.id)
      .first(),
  ).toEqual({ user_id: "restore-player", player_id: "p" });
  expect(
    await targetEnv.DB.prepare(
      "SELECT subject FROM player_identities WHERE shop_id=? AND provider='web-account'",
    )
      .bind(target.id)
      .first("subject"),
  ).toBe("restore-player");
  expect(await targetEnv.DB.prepare("SELECT COUNT(*) AS n FROM passkeys").first("n")).toBe(0);
  expect(await targetEnv.DB.prepare("SELECT COUNT(*) AS n FROM oauth_credentials").first("n")).toBe(0);
  expect(
    await targetEnv.DB.prepare("SELECT COUNT(*) AS n FROM shop_data_rows WHERE job_id=?")
      .bind(staged.jobId)
      .first("n"),
  ).toBe(0);
}, 30000);

test("same-database copying remaps all machine references before foreign-key insertion and preserves monetary/UTC values", async () => {
  const source = await deviceSource(),
    target = await store(),
    backup = await download(sourceEnv, source.shop),
    staged = await upload(sourceEnv, target, backup),
    check = await preview(sourceEnv, target, staged);
  expect(check.data.errors).toEqual([]);
  expect((await apply(sourceEnv, target, staged.jobId, check.data.fingerprint)).status).toBe(200);
  const machine = (await rows(sourceEnv, "machines", target.id))[0]!;
  expect(machine.id).not.toBe(source.machineId);
  expect(machine.public_id).not.toBe(source.publicId);
  for (const [table, column] of [
    ["mahjong_seats", "machine_id"],
    ["machine_connections", "machine_id"],
    ["device_states", "device_id"],
    ["device_commands", "device_id"],
  ])
    expect((await rows(sourceEnv, table!, target.id))[0]![column!]).toBe(machine.id);
  expect(
    JSON.parse(String((await rows(sourceEnv, "sessions", target.id))[0]!.metadata_json)).mahjongDeviceId,
  ).toBe(machine.id);
  expect((await rows(sourceEnv, "asset_holdings", target.id))[0]!.quantity).toBe(114514);
  expect((await rows(sourceEnv, "sessions", target.id))[0]!.started_at).toBe("2026-10-02T02:08:00.000Z");
}, 30000);

async function withBrowserFetch<T>(env: Env, work: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input !== "string" || !input.startsWith("/api/")) return original(input, init);
    const headers = new Headers(init?.headers);
    headers.set("origin", origin);
    headers.set("cookie", "arcadelink_session=owner-session");
    return app.fetch(new Request(origin + input, { ...init, headers }), env);
  }) as typeof fetch;
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}
test("the browser job protocol round-trips a backup above 10 MiB with 350 KiB invoice rows", async () => {
  const source = await store(sourceEnv, true),
    target = await store(targetEnv),
    now = "2026-10-02T02:08:00.000Z";
  await sourceEnv.DB.prepare(
    "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'p','大账单玩家','active',?)",
  )
    .bind(source.id, now)
    .run();
  const timeline = JSON.stringify({
    events: [{ startedAt: now, label: "invoice:" + "x".repeat(350 * 1024) }],
  });
  const statements = [];
  for (let i = 0; i < 32; i++)
    statements.push(
      sourceEnv.DB.prepare(
        "INSERT INTO player_checkouts(shop_id,id,player_id,subtotal,total,status,settled_at) VALUES (?,?,'p',114514,114514,'settled',?)",
      ).bind(source.id, `c${i}`, now),
      sourceEnv.DB.prepare(
        "INSERT INTO checkout_timelines(shop_id,checkout_id,timeline_json) VALUES (?,?,?)",
      ).bind(source.id, `c${i}`, timeline),
    );
  await sourceEnv.DB.batch(statements);
  const downloaded = await withBrowserFetch(sourceEnv, () =>
    downloadShopBackup(base(source), "business", () => {}),
  );
  expect(downloaded.blob.size).toBeGreaterThan(10 * 1024 * 1024);
  expect(downloaded.info.counts.checkout_timelines).toBe(32);
  expect(
    await sourceEnv.DB.prepare("SELECT COUNT(*) AS n FROM shop_data_jobs WHERE id=?")
      .bind(downloaded.info.jobId)
      .first("n"),
  ).toBe(0);
  const staged = await withBrowserFetch(targetEnv, () =>
    uploadShopBackup(base(target), downloaded.blob, () => {}),
  );
  const checked = await request(targetEnv, base(target) + `/imports/${staged.jobId}/preview`, {
    counts: staged.counts,
    parts: staged.parts,
  });
  expect(checked.data.errors).toEqual([]);
  const result = await apply(targetEnv, target, staged.jobId, checked.data.fingerprint);
  expect(result.status).toBe(200);
  expect((await rows(targetEnv, "checkout_timelines", target.id)).map((r) => r.timeline_json)).toEqual(
    Array(32).fill(timeline),
  );
  expect(
    (await rows(targetEnv, "player_checkouts", target.id)).every(
      (r) => r.total === 114514 && r.settled_at === now,
    ),
  ).toBe(true);
}, 60000);

test("paged exports lock writes and enforce job owner/shop isolation", async () => {
  const source = await store(sourceEnv, true),
    other = await store(),
    now = "2026-10-02T02:08:00.000Z";
  await sourceEnv.DB.prepare(
    "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'p','原玩家','active',?)",
  )
    .bind(source.id, now)
    .run();
  const job = await request(sourceEnv, base(source) + "/exports", { scope: "business" });
  expect(job.status).toBe(200);
  await expect(sourceEnv.DB.prepare("UPDATE players SET display_name='新名字' WHERE shop_id=? AND id='p'")
    .bind(source.id).run()).rejects.toThrow("SHOP_EXPORT_LOCKED");
  await expect(sourceEnv.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'new','新增','active',?)")
    .bind(source.id, now).run()).rejects.toThrow("SHOP_EXPORT_LOCKED");
  await sourceEnv.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'other','其他店','active',?)")
    .bind(other.id, now).run();
  expect((await sourceEnv.DB.prepare("SELECT COUNT(*) AS n FROM shop_data_rows").first<{ n: number }>())!.n).toBe(0);
  let cursor = 0;
  const collected: any[] = [];
  for (;;) {
    const result = await request(sourceEnv, base(source) + `/exports/${job.data.jobId}/page?after=${cursor}`);
    expect(result.status).toBe(200);
    if (result.data.done) break;
    cursor = result.data.cursor;
    collected.push(
      ...result.data.rows
        .filter((r: any) => r.table_name === "players")
        .map((r: any) => JSON.parse(r.payload_json)),
    );
  }
  expect(job.data.counts.players).toBe(1);
  expect(collected).toHaveLength(1);
  expect(collected[0].display_name).toBe("原玩家");
  expect((await request(sourceEnv, base(other) + `/exports/${job.data.jobId}/page`)).status).toBe(404);
  expect(
    (await request(sourceEnv, base(source) + `/exports/${job.data.jobId}/page`, undefined, "other-session"))
      .status,
  ).toBe(403);
  expect(
    (
      await request(
        sourceEnv,
        base(source) + `/exports/${job.data.jobId}`,
        undefined,
        "owner-session",
        "DELETE",
      )
    ).status,
  ).toBe(200);
  expect((await request(sourceEnv, base(source) + `/exports/${job.data.jobId}/page`)).status).toBe(404);
  await sourceEnv.DB.prepare("UPDATE players SET display_name='新名字' WHERE shop_id=? AND id='p'").bind(source.id).run();
}, 30000);

test("staged import accepts identical part retries, rejects changed/late parts and validates the complete manifest", async () => {
  const source = await store(sourceEnv, true),
    target = await store(targetEnv),
    backup = await download(sourceEnv, source),
    { tables, ...header } = backup;
  const started = await request(targetEnv, base(target) + "/imports", header),
    jobId = started.data.jobId;
  const input = { table: "asset_definitions", part: 0, rows: tables.asset_definitions };
  expect((await request(targetEnv, base(target) + `/imports/${jobId}/parts`, input)).status).toBe(200);
  expect((await request(targetEnv, base(target) + `/imports/${jobId}/parts`, input)).status).toBe(200);
  expect(
    (await request(targetEnv, base(target) + `/imports/${jobId}/parts`, { ...input, rows: [] })).error?.code,
  ).toBe("OPERATION_CONFLICT");
  const incomplete = await preview(targetEnv, target, {
    jobId,
    manifest: { counts: Object.fromEntries(Object.keys(tables).map((t) => [t, tables[t].length])), parts: 1 },
  });
  expect(incomplete.data.canImport).toBe(false);
  expect(incomplete.data.errors).toContain("备份文件未完整上传或数据表不完整");
  const missingTable = await preview(targetEnv, target, {
    jobId,
    manifest: { counts: { asset_definitions: 2 }, parts: 1 },
  });
  expect(missingTable.data.canImport).toBe(false);
  const staged = await upload(targetEnv, target, backup),
    check = await preview(targetEnv, target, staged);
  expect(check.data.errors).toEqual([]);
  expect(
    (
      await request(targetEnv, base(target) + `/imports/${staged.jobId}/parts`, {
        table: "players",
        part: 999,
        rows: [],
      })
    ).error?.code,
  ).toBe("TRANSFER_LOCKED");
  expect(
    await targetEnv.DB.prepare("SELECT COUNT(*) AS n FROM asset_definitions WHERE shop_id=?")
      .bind(target.id)
      .first("n"),
  ).toBe(0);
}, 30000);

test("failed restore rolls back all rows and triggers, then safely retries the same job and operation", async () => {
  const source = await store(sourceEnv, true),
    target = await store(targetEnv),
    backup = await download(sourceEnv, source),
    staged = await upload(targetEnv, target, backup),
    check = await preview(targetEnv, target, staged),
    id = op();
  expect(check.data.canImport).toBe(true);
  await targetEnv.DB.prepare(
    `CREATE TRIGGER test_import_failure BEFORE UPDATE ON shops WHEN NEW.id='${target.id}' BEGIN SELECT RAISE(ABORT,'test restore failure'); END`,
  ).run();
  const failed = await apply(targetEnv, target, staged.jobId, check.data.fingerprint, id);
  expect(failed.status).toBe(500);
  expect(
    await targetEnv.DB.prepare("SELECT COUNT(*) AS n FROM asset_definitions WHERE shop_id=?")
      .bind(target.id)
      .first("n"),
  ).toBe(0);
  expect(
    await targetEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('pricing_config_version_insert','session_pricing_bind')",
    ).first("n"),
  ).toBe(2);
  expect(
    await targetEnv.DB.prepare("SELECT COUNT(*) AS n FROM player_operations WHERE shop_id=? AND id=?")
      .bind(target.id, id)
      .first("n"),
  ).toBe(0);
  expect(
    await targetEnv.DB.prepare("SELECT COUNT(*) AS n FROM shop_data_rows WHERE job_id=?")
      .bind(staged.jobId)
      .first("n"),
  ).toBeGreaterThan(0);
  await targetEnv.DB.prepare("DROP TRIGGER test_import_failure").run();
  expect((await apply(targetEnv, target, staged.jobId, check.data.fingerprint, id)).status).toBe(200);
  expect((await apply(targetEnv, target, staged.jobId, check.data.fingerprint, id)).status).toBe(200);
}, 30000);

test("v1 files remain importable through bounded staging and target profile changes invalidate preflight", async () => {
  const source = await store(sourceEnv, true),
    target = await store(targetEnv),
    old = (await request(sourceEnv, base(source) + "/export?version=1")).backup;
  expect(old.version).toBe(1);
  const staged = await upload(targetEnv, target, old),
    check = await preview(targetEnv, target, staged);
  expect(check.data.errors).toEqual([]);
  await targetEnv.DB.prepare("UPDATE shops SET latitude=35,longitude=139 WHERE id=?").bind(target.id).run();
  expect((await apply(targetEnv, target, staged.jobId, check.data.fingerprint)).error?.code).toBe(
    "IMPORT_TARGET_CHANGED",
  );
  const next = await preview(targetEnv, target, staged);
  expect(next.data.canImport).toBe(true);
  expect((await apply(targetEnv, target, staged.jobId, next.data.fingerprint)).status).toBe(200);
  expect(await targetEnv.DB.prepare("SELECT name FROM shops WHERE id=?").bind(target.id).first("name")).toBe(
    "目标店",
  );
}, 30000);

test("v2 configuration copies profile, settings and devices while excluding players and publishing new UTC versions", async () => {
  const source = await deviceSource(),
    target = await store(targetEnv),
    backup = await download(sourceEnv, source.shop, "configuration");
  expect(backup.tables.players).toBeUndefined();
  expect(backup.tables.staff_users).toBeUndefined();
  expect(backup.tables.machines).toHaveLength(1);
  const staged = await upload(targetEnv, target, backup),
    check = await preview(targetEnv, target, staged);
  expect(check.data.errors).toEqual([]);
  expect((await apply(targetEnv, target, staged.jobId, check.data.fingerprint)).status).toBe(200);
  expect((await rows(targetEnv, "players", target.id)).length).toBe(0);
  expect((await rows(targetEnv, "pricing_releases", target.id)).length).toBeGreaterThan(0);
  expect((await rows(targetEnv, "machines", target.id))[0]!.public_id).toBe(source.publicId);
  expect(
    JSON.parse(String((await rows(targetEnv, "pricing_configs", target.id))[0]!.provider_json)).timeZone,
  ).toBe("UTC");
}, 30000);

test("legacy web identities without a membership row are preserved as portable account links", async () => {
  const source = await store(sourceEnv, true),
    target = await store(targetEnv),
    now = "2026-10-02T02:08:00.000Z";
  await sourceEnv.DB.batch([
    sourceEnv.DB.prepare(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'old','旧玩家','active',?)",
    ).bind(source.id, now),
    sourceEnv.DB.prepare(
      "INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES (?,'old','web-account','player',?)",
    ).bind(source.id, now),
  ]);
  const backup = await download(sourceEnv, source),
    link = backup.tables.account_links.find((r: any) => r.source_user_id === "player");
  expect(link.player_id).toBe("old");
  expect(link.identities_json).toContain("munet");
  const staged = await upload(targetEnv, target, backup),
    check = await preview(targetEnv, target, staged);
  expect(check.data.errors).toEqual([]);
  expect((await apply(targetEnv, target, staged.jobId, check.data.fingerprint)).status).toBe(200);
  expect(
    (await request(targetEnv, `/api/v1/shops/${target.publicId}/player/me`, undefined, "player-session"))
      .status,
  ).toBe(200);
  expect(
    await targetEnv.DB.prepare("SELECT player_id FROM shop_player_accounts WHERE shop_id=?")
      .bind(target.id)
      .first("player_id"),
  ).toBe("old");
}, 30000);

async function defaultAllowance(env: Env, shop: { id: string }) {
  await env.DB.prepare("DELETE FROM shop_data_export_allowances WHERE shop_id=?").bind(shop.id).run();
}
test("monthly export quota is atomic, cancellation consumes it, and only admins can grant independent allowances", async () => {
  const shop = await store(sourceEnv, true);
  await defaultAllowance(sourceEnv, shop);
  const status = await request(sourceEnv, base(shop) + "/export-status");
  expect(status.data.remaining).toBe(1);
  expect(status.data.importRemaining).toBe(1);
  const started = await Promise.all([request(sourceEnv, base(shop) + "/exports", { scope: "business" }),
    request(sourceEnv, base(shop) + "/exports", { scope: "configuration" })]);
  expect(started.map(r => r.status).sort()).toEqual([200, 423]);
  const id = started.find(r => r.status === 200)!.data.jobId;
  const blocked = await request(sourceEnv, `/api/v1/merchant/shops/${shop.id}`, { name: "改名", latitude: 31.23, longitude: 121.47, radiusMeters: 80 }, "owner-session", "PATCH");
  expect(blocked.status).toBe(423);
  expect(blocked.error.code).toBe("SHOP_EXPORT_LOCKED");
  await request(sourceEnv, base(shop) + `/exports/${id}`, undefined, "owner-session", "DELETE");
  const limited = await request(sourceEnv, base(shop) + "/exports", { scope: "configuration" });
  expect(limited.status).toBe(429);
  expect(limited.error.code).toBe("EXPORT_MONTHLY_LIMIT");
  expect((await request(sourceEnv, base(shop) + "/export?version=1")).status).toBe(429);
  const adminPath = `/api/v1/admin/shops/${shop.publicId}/transfer-allowance`;
  expect((await request(sourceEnv, adminPath, { extra: 1, importExtra: 2 }, "owner-session", "PUT")).status).toBe(403);
  for (let i = 0; i < 2; i++) {
    const granted = await request(sourceEnv, adminPath, { extra: 1, importExtra: 2 }, "admin-session", "PUT");
    expect(granted.status).toBe(200);
    expect(granted.data.allowance).toBe(2);
    expect(granted.data.remaining).toBe(1);
    expect(granted.data.importRemaining).toBe(3);
  }
  const job = await request(sourceEnv, base(shop) + "/exports", { scope: "configuration" });
  expect(job.status).toBe(200);
  await request(sourceEnv, base(shop) + `/exports/${job.data.jobId}`, undefined, "owner-session", "DELETE");
  expect((await request(sourceEnv, base(shop) + "/exports", { scope: "business" })).status).toBe(429);
}, 30000);

test("import creation consumes one independent monthly slot and retries within the job do not consume another", async () => {
  const source = await store(sourceEnv, true), target = await store(targetEnv), backup = await download(sourceEnv, source);
  await defaultAllowance(targetEnv, target);
  const { tables, ...header } = backup;
  expect((await request(targetEnv, base(target) + "/imports", { ...header, version: 99 })).status).toBe(400);
  const job = await upload(targetEnv, target, backup);
  const checked = await preview(targetEnv, target, job);
  expect(checked.data.canImport).toBe(true);
  const over = await request(targetEnv, base(target) + "/imports", header);
  expect(over.status).toBe(429);
  expect(over.error.code).toBe("IMPORT_MONTHLY_LIMIT");
  const id = op();
  for (let i = 0; i < 2; i++) expect((await apply(targetEnv, target, job.jobId, checked.data.fingerprint, id)).status).toBe(200);
  const status = (await request(targetEnv, base(target) + "/export-status")).data;
  expect(status.importUsed).toBe(1);
  expect(status.importRemaining).toBe(0);
  expect(status.remaining).toBe(1);
}, 30000);

test("expired exports unlock without a cleanup write and cannot resume or produce an empty success", async () => {
  const shop = await store(sourceEnv, true);
  const started = await request(sourceEnv, base(shop) + "/exports", { scope: "business" });
  await sourceEnv.DB.prepare("UPDATE shop_data_exports SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?")
    .bind(started.data.jobId).run();
  const before = (await request(sourceEnv, base(shop) + "/export-status")).data;
  expect(before.locked).toBe(false);
  await sourceEnv.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'after-expiry','解锁后','active','2026-10-06T00:00:00.000Z')").bind(shop.id).run();
  const page = await request(sourceEnv, base(shop) + `/exports/${started.data.jobId}/page`);
  expect(page.status).toBe(410);
  expect(page.error.code).toBe("EXPORT_EXPIRED");
  expect((await sourceEnv.DB.prepare("SELECT status FROM shop_data_exports WHERE id=?").bind(started.data.jobId).first())!.status).toBe("active");
}, 30000);

test("export waits for live operation leases and database fences roll back multi-table and cross-shop writes", async () => {
  const shop = await store(sourceEnv, true), other = await store(sourceEnv, true), now = new Date().toISOString();
  await sourceEnv.DB.prepare("INSERT INTO operation_locks(shop_id,scope,resource_id,lock_id,acquired_at,expires_at) VALUES (?,'player.assets','p','lease',?,?)")
    .bind(shop.id, now, new Date(Date.now() + 60_000).toISOString()).run();
  const busy = await request(sourceEnv, base(shop) + "/exports", { scope: "business" });
  expect(busy.status).toBe(409);
  expect(busy.error.code).toBe("SHOP_EXPORT_BUSY");
  expect((await request(sourceEnv, base(shop) + "/export-status")).data.used).toBe(0);
  await sourceEnv.DB.prepare("DELETE FROM operation_locks WHERE shop_id=?").bind(shop.id).run();
  await sourceEnv.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'move','不能移走','active','2026-10-06T00:00:00.000Z')").bind(shop.id).run();
  const started = await request(sourceEnv, base(shop) + "/exports", { scope: "business" });
  expect(started.status).toBe(200);
  await expect(sourceEnv.DB.batch([
    sourceEnv.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'rollback','其他店','active','2026-10-06T00:00:00.000Z')").bind(other.id),
    sourceEnv.DB.prepare("UPDATE app_settings SET value_json='{}' WHERE shop_id=?").bind(shop.id),
  ])).rejects.toThrow("SHOP_EXPORT_LOCKED");
  expect((await sourceEnv.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE shop_id=? AND id='rollback'").bind(other.id).first())!.n).toBe(0);
  await expect(sourceEnv.DB.prepare("UPDATE players SET shop_id=? WHERE shop_id=?").bind(other.id, shop.id).run()).rejects.toThrow("SHOP_EXPORT_LOCKED");
  await expect(sourceEnv.DB.prepare("UPDATE auth_identities SET provider_subject='改身份' WHERE user_id='owner'").run()).rejects.toThrow("SHOP_EXPORT_LOCKED");
  const staged = await sourceEnv.DB.prepare("SELECT COUNT(*) AS n FROM shop_data_rows").first<{ n: number }>();
  expect(staged!.n).toBe(0);
  let cursor = 0;
  const parallel = await Promise.all([request(sourceEnv, base(shop) + `/exports/${started.data.jobId}/page?after=0`),
    request(sourceEnv, base(shop) + `/exports/${started.data.jobId}/page?after=0`)]);
  expect(parallel.map(r => r.status).sort()).toEqual([200, 409]);
  const first = parallel.find(r => r.status === 200)!;
  cursor = first.data.cursor;
  expect((await request(sourceEnv, base(shop) + `/exports/${started.data.jobId}/page?after=0`)).status).toBe(409);
  for (;;) {
    const result = await request(sourceEnv, base(shop) + `/exports/${started.data.jobId}/page?after=${cursor}`);
    expect(result.status).toBe(200);
    if (result.data.done) break;
    cursor = result.data.cursor;
  }
  expect((await request(sourceEnv, base(shop) + "/export-status")).data.locked).toBe(false);
}, 30000);

test("monthly periods use store calendar dates, including year boundaries and DST zones", () => {
  expect(exportMonth("Asia/Shanghai", new Date("2026-10-31T16:00:00Z"))).toBe("2026-11");
  expect(exportMonth("UTC", new Date("2026-10-31T16:00:00Z"))).toBe("2026-10");
  expect(exportMonth("Asia/Tokyo", new Date("2026-12-31T15:00:00Z"))).toBe("2027-01");
  expect(exportMonth("America/New_York", new Date("2026-11-01T03:30:00Z"))).toBe("2026-10");
});

test("legacy import applies are quota-limited but completed operation retries remain idempotent", async () => {
  const source = await store(sourceEnv), target = await store(targetEnv);
  await defaultAllowance(targetEnv, target);
  const backup = (await request(sourceEnv, base(source) + "/export?version=1&scope=configuration")).backup;
  const inspected = await request(targetEnv, base(target) + "/import/preview", { backup });
  expect(inspected.data.canImport).toBe(true);
  const id = op(), body = { backup, fingerprint: inspected.data.fingerprint, operationId: id };
  for (let i = 0; i < 2; i++) expect((await request(targetEnv, base(target) + "/import/apply", body)).status).toBe(200);
  const next = await request(targetEnv, base(target) + "/import/preview", { backup });
  expect(next.data.canImport).toBe(true);
  const limited = await request(targetEnv, base(target) + "/import/apply", { backup, fingerprint: next.data.fingerprint, operationId: op() });
  expect(limited.status).toBe(429);
  expect(limited.error.code).toBe("IMPORT_MONTHLY_LIMIT");
  expect((await request(targetEnv, base(target) + "/export-status")).data.importUsed).toBe(1);
}, 30000);

test("indexed export pages handle composite keys, escaped IDs and more than one page of account links", async () => {
  const shop = await store(sourceEnv, true), values = Array.from({ length: 1100 }, (_, i) => ({
    id: `bulk-${String(i).padStart(3, '0')}${i === 1099 ? '"末尾' : ''}`, player: `p-${String(i).padStart(3, '0')}`,
  })), input = JSON.stringify(values), now = new Date().toISOString();
  await sourceEnv.DB.batch([
    sourceEnv.DB.prepare("INSERT INTO users(id,role) SELECT json_extract(value,'$.id'),'user' FROM json_each(?)").bind(input),
    sourceEnv.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) SELECT ?,json_extract(value,'$.player'),json_extract(value,'$.id'),'active',? FROM json_each(?)").bind(shop.id, now, input),
    sourceEnv.DB.prepare("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) SELECT ?,json_extract(value,'$.player'),'web-account',json_extract(value,'$.id'),? FROM json_each(?)").bind(shop.id, now, input),
    sourceEnv.DB.prepare("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.player'),? FROM json_each(?)").bind(shop.id, now, input),
  ]);
  const backup = await download(sourceEnv, shop);
  expect(backup.tables.players).toHaveLength(1100);
  expect(backup.tables.account_links).toHaveLength(1101);
  expect(backup.tables.account_links.filter((row: any) => row.player_id).map((row: any) => row.source_user_id).sort()).toEqual(values.map(row => row.id).sort());
  expect(backup.tables.player_identities).toHaveLength(1100);
  expect(backup.tables.asset_definitions.map((row: any) => row.code).sort()).toEqual(['free', 'paid']);
  expect(backup.tables.shop_billing_settings).toHaveLength(1);
  expect(backup.tables.pricing_release_heads).toHaveLength(1);
}, 30000);

test("export recovery exposes only live leases and any current owner can cancel without opening another user's pages", async () => {
  const shop = await store(sourceEnv, true), otherShop = await store(sourceEnv);
  await defaultAllowance(sourceEnv, shop);
  await sourceEnv.DB.prepare("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES (?,?,?,'owner')")
    .bind(op(), shop.id, "other").run();
  const started = await request(sourceEnv, base(shop) + "/exports", { scope: "business" });
  const id = started.data.jobId;
  const status = (await request(sourceEnv, base(shop) + "/export-status", undefined, "other-session")).data;
  expect(status.activeExport.jobId).toBe(id);
  expect(status.activeExport.scope).toBe("business");
  expect(Date.parse(status.activeExport.expiresAt)).toBeGreaterThan(Date.now());
  expect((await request(sourceEnv, base(shop) + `/exports/${id}/page`, undefined, "other-session")).status).toBe(404);
  expect((await request(sourceEnv, base(shop) + `/exports/${id}/cancel`, {}, "player-session")).status).toBe(403);
  expect((await request(sourceEnv, base(otherShop) + `/exports/${id}/cancel`, {})).status).toBe(404);
  // Recovery must work even for the old stuck reading=1 state.
  await sourceEnv.DB.prepare("UPDATE shop_data_exports SET reading=1 WHERE id=?").bind(id).run();
  for (let i = 0; i < 2; i++)
    expect((await request(sourceEnv, base(shop) + `/exports/${id}/cancel`, undefined, "other-session", "POST")).status).toBe(200);
  const recovered = (await request(sourceEnv, base(shop) + "/export-status")).data;
  expect(recovered.locked).toBe(false);
  expect(recovered.activeExport).toBeNull();
  expect(recovered.used).toBe(1);
  expect(recovered.remaining).toBe(0);
  expect((await request(sourceEnv, base(shop) + `/exports/${id}/page`)).status).toBe(404);
  await sourceEnv.DB.prepare("UPDATE shops SET name='恢复营业' WHERE id=?").bind(shop.id).run();
  // Cancellation is also idempotent using the original DELETE route.
  expect((await request(sourceEnv, base(shop) + `/exports/${id}`, undefined, "owner-session", "DELETE")).status).toBe(200);
  const stale = await request(sourceEnv, base(otherShop) + "/exports", { scope: "business" });
  await sourceEnv.DB.prepare("UPDATE shop_data_exports SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(stale.data.jobId).run();
  const expired = (await request(sourceEnv, base(otherShop) + "/export-status")).data;
  expect(expired.locked).toBe(false);
  expect(expired.activeExport).toBeNull();
}, 30000);

test("a page failure after claiming its read releases the shop immediately", async () => {
  const shop = await store(sourceEnv, true);
  const started = await request(sourceEnv, base(shop) + "/exports", { scope: "business" });
  const id = started.data.jobId;
  // Inject invalid count metadata, representing an exception after the atomic page claim.
  await sourceEnv.DB.prepare("UPDATE shop_data_exports SET counts_json='invalid-json' WHERE id=?").bind(id).run();
  const failed = await request(sourceEnv, base(shop) + `/exports/${id}/page`);
  expect(failed.status).toBe(500);
  expect(await sourceEnv.DB.prepare("SELECT status FROM shop_data_exports WHERE id=?").bind(id).first("status")).toBe("failed");
  expect((await request(sourceEnv, base(shop) + "/export-status")).data.locked).toBe(false);
  await sourceEnv.DB.prepare("UPDATE shops SET name='分页失败后恢复' WHERE id=?").bind(shop.id).run();
}, 30000);


test("cancelling an in-flight page rejects its result before business writes resume", async () => {
  const shop = await store(sourceEnv, true), db = sourceEnv.DB;
  const started = await request(sourceEnv, base(shop) + "/exports", { scope: "business" });
  const id = started.data.jobId;
  let pause = false, entered!: () => void, resume!: () => void;
  const claimed = new Promise<void>(resolve => { entered = resolve; });
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  const env = { ...sourceEnv, DB: {
    prepare(sql: string) {
      if (sql.startsWith("SELECT 1 AS valid FROM shop_data_exports")) pause = true;
      return db.prepare(sql);
    },
    async batch(statements: D1PreparedStatement[]) {
      if (pause) { pause = false; entered(); await resumed; }
      return db.batch(statements);
    },
  } as D1Database };
  const pending = request(env, base(shop) + `/exports/${id}/page`);
  try {
    await claimed;
    expect(await db.prepare("SELECT reading FROM shop_data_exports WHERE id=?").bind(id).first("reading")).toBe(1);
    expect((await request(sourceEnv, base(shop) + `/exports/${id}/cancel`, undefined, "owner-session", "POST")).status).toBe(200);
    await db.prepare("UPDATE shops SET name='取消在途分页后营业' WHERE id=?").bind(shop.id).run();
  } finally { resume(); }
  expect((await pending).status).toBe(410);
  expect(await db.prepare("SELECT status FROM shop_data_exports WHERE id=?").bind(id).first("status")).toBe("cancelled");
}, 30000);

test("export throughput fixture preserves ten thousand ledger records", async () => {
  const shop = await store(sourceEnv, true);
  await sourceEnv.DB.batch([
    sourceEnv.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'throughput','速度测试','active','2026-10-07T00:00:00.000Z')").bind(shop.id),
    sourceEnv.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO asset_transactions(shop_id,id,player_id,kind,ref_id,created_at,metadata_json)
      SELECT ?,printf('tx-%08d',x),'throughput','test','historical','2026-10-07T00:00:00.000Z',json_object('amount',x) FROM n`).bind(shop.id),
  ]);
  const start = performance.now();
  const started = await request(sourceEnv, base(shop) + "/exports", { scope: "business" });
  expect(started.status).toBe(200);
  let cursor = 0, pages = 0, total = 0;
  const ids = new Set<string>();
  for (;;) {
    const page = await request(sourceEnv, base(shop) + `/exports/${started.data.jobId}/page?after=${cursor}`);
    expect(page.status).toBe(200);
    pages++;
    if (page.data.done) break;
    for (const row of page.data.rows) {
      total++;
      if (row.table_name === "asset_transactions") ids.add(JSON.parse(row.payload_json).id);
    }
    cursor = page.data.cursor;
  }
  expect(ids.size).toBe(10000);
  expect(pages).toBeLessThanOrEqual(12);
  expect(total).toBe(Object.values(started.data.counts).reduce((sum: number, n) => sum + Number(n), 0));
  console.log(JSON.stringify({ benchmark: "10000 asset transactions", pages, records: total, elapsedMs: Math.round(performance.now() - start) }));
}, 120000);

test("large escaped rows after small rows stay complete and bounded across combined-table pages", async () => {
  const shop = await store(sourceEnv, true), encoder = new TextEncoder();
  const wide = JSON.stringify({ note: '"\\\n'.repeat(150000) });
  const medium = JSON.stringify({ note: '"\\\n'.repeat(30000) });
  const expected = new Map<string, string>([['b-wide', wide], ['c-medium', medium], ['d-medium', medium], ['e-medium', medium]]);
  await sourceEnv.DB.batch([
    sourceEnv.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'mixed','大小混合','active','2026-10-07T00:00:00.000Z')").bind(shop.id),
    sourceEnv.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<270)
      INSERT INTO asset_transactions(shop_id,id,player_id,kind,ref_id,created_at,metadata_json)
      SELECT ?,printf('a-%04d',x),'mixed','test','small','2026-10-07T00:00:00.000Z','{}' FROM n`).bind(shop.id),
    ...[...expected].map(([id, metadata]) => sourceEnv.DB.prepare(
      "INSERT INTO asset_transactions(shop_id,id,player_id,kind,ref_id,created_at,metadata_json) VALUES (?,?,'mixed','test','large','2026-10-07T00:00:00.000Z',?)"
    ).bind(shop.id, id, metadata)),
  ]);
  const started = await request(sourceEnv, base(shop) + "/exports", { scope: "business" });
  let cursor = 0, rows = 0, oversized = 0, combined = false;
  const seen = new Set<string>();
  for (;;) {
    const response = await request(sourceEnv, base(shop) + `/exports/${started.data.jobId}/page?after=${cursor}`);
    expect(response.status).toBe(200);
    if (response.data.done) break;
    const page = response.data.rows as { seq: number; table_name: string; payload_json: string }[];
    expect(page.length).toBeLessThanOrEqual(4096);
    const bytes = page.reduce((sum, row) => sum + encoder.encode(row.payload_json).length, 0);
    if (bytes > 1024 * 1024) { expect(page).toHaveLength(1); oversized++; }
    combined ||= new Set(page.map(row => row.table_name)).size > 1;
    for (const row of page) {
      rows++;
      expect(row.seq).toBeGreaterThan(cursor);
      if (row.table_name === "asset_transactions") {
        const value = JSON.parse(row.payload_json);
        expect(seen.has(value.id)).toBe(false);
        seen.add(value.id);
        if (expected.has(value.id)) expect(value.metadata_json).toBe(expected.get(value.id));
      }
    }
    cursor = response.data.cursor;
  }
  expect(oversized).toBe(1);
  expect(combined).toBe(true);
  expect(seen.size).toBe(274);
  expect(rows).toBe(Object.values(started.data.counts).reduce((sum: number, n) => sum + Number(n), 0));
  expect((await request(sourceEnv, base(shop) + "/export-status")).data.locked).toBe(false);
}, 30000);

test("batched export permissions preserve the existing owner and active staff mapping rules", async () => {
  const shop = await store(sourceEnv);
  await sourceEnv.DB.prepare(`INSERT INTO staff_users(shop_id,id,username,display_name,password_hash,password_salt,role,status,created_at,updated_at)
    VALUES (?,'permission','permission','权限测试','test','test','owner','active','2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z')`).bind(shop.id).run();
  for (const [membership, mappedRole, status, allowed] of [
    ['owner', null, 'active', true], ['staff', null, 'active', false],
    ['owner', 'manager', 'active', false], ['staff', 'owner', 'active', true],
    ['owner', 'viewer', 'disabled', true], ['staff', 'owner', 'disabled', false],
    [null, 'owner', 'active', false],
  ] as const) {
    await sourceEnv.DB.batch([
      sourceEnv.DB.prepare("DELETE FROM shop_members WHERE shop_id=? AND user_id='other'").bind(shop.id),
      sourceEnv.DB.prepare("DELETE FROM shop_staff_accounts WHERE shop_id=? AND user_id='other'").bind(shop.id),
      sourceEnv.DB.prepare("UPDATE staff_users SET role=?,status=? WHERE shop_id=? AND id='permission'").bind(mappedRole ?? 'owner', status, shop.id),
      ...(membership ? [sourceEnv.DB.prepare("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES (?,?,'other',?)").bind(op(), shop.id, membership)] : []),
      ...(mappedRole ? [sourceEnv.DB.prepare("INSERT INTO shop_staff_accounts(shop_id,user_id,staff_id) VALUES (?,'other','permission')").bind(shop.id)] : []),
    ]);
    // export-status still uses the shared owner() implementation; cancel uses the new batched query.
    expect((await request(sourceEnv, base(shop) + "/export-status", undefined, "other-session")).status).toBe(allowed ? 200 : 403);
    expect((await request(sourceEnv, base(shop) + "/exports/not-a-job", undefined, "other-session", "DELETE")).status).toBe(allowed ? 404 : 403);
  }
}, 30000);

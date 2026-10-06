import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { sqliteSchema, splitD1MigrationStatements } from "@prism/storage-sql";
import app from "../src/index";
import { encryptSecret, decryptSecret, sha256 } from "../src/crypto";
import { utcWriteGuards } from "../src/deployment-gate";
import { createTestRateLimits } from "./rate-limit-fixture";
import { uploadShopBackup, downloadShopBackup } from "../../prism-web/src/shop-data-transfer";
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
    "0031_shop_data_transfer",
  ]) {
    const sql = readFileSync(new URL(`../../../migrations/${name}.sql`, import.meta.url), "utf8").replace(
      /^\s*--.*$/gm,
      "",
    );
    for (const part of splitD1MigrationStatements(sql)) await db.prepare(part).run();
  }
  for (const name of ["owner", "player", "other"]) {
    await db
      .prepare("INSERT INTO users(id,role) VALUES (?,'user')")
      .bind(prefix + name)
      .run();
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
  return result.data.shop as { id: string; publicId: string };
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

test("paged exports use a consistent snapshot and enforce job owner/shop isolation", async () => {
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
  await sourceEnv.DB.prepare("UPDATE players SET display_name='新名字' WHERE shop_id=? AND id='p'")
    .bind(source.id)
    .run();
  await sourceEnv.DB.prepare(
    "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'new','快照后新增','active',?)",
  )
    .bind(source.id, now)
    .run();
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

// Local-only UI fixture. No production bindings and no device URLs.
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { sqliteSchema } from "@prism/storage-sql";
import { createPrismWorkerDependencies } from "@prism/runtime";
import app from "../src/index";
import { sha256, encryptSecret } from "../src/crypto";
import { decryptE2EE } from "../src/e2ee";
import type { Env } from "../src/types";
const origin = "http://127.0.0.1:8790";
const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() {return new Response('fixture')} }",
  d1Databases: ["DB"],
  kvNamespaces: ["RATE_LIMIT"],
  compatibilityDate: "2026-06-07",
});
const DB = await mf.getD1Database("DB");
const env = {
  DB,
  RATE_LIMIT: await mf.getKVNamespace("RATE_LIMIT"),
  APP_ORIGIN: origin,
  EXTRA_ALLOWED_ORIGINS: origin,
  SESSION_SECRET: "local-fixture",
  URL_ENCRYPTION_KEY: "local-fixture",
  MUNET_CLIENT_ID: "",
  MUNET_CLIENT_SECRET: "",
  APPLE_TEAM_ID: "LOCAL",
} as Env;
for (const sql of [
  ...sqliteSchema,
  ...readFileSync(
    new URL("../../../migrations/0017_platform_accounts.sql", import.meta.url),
    "utf8",
  )
    .split(";")
    .filter((s) => s.trim()),
])
  await DB.prepare(sql).run();
for (const sql of readFileSync(
  new URL("../../../migrations/0018_unified_devices.sql", import.meta.url),
  "utf8",
)
  .split(";")
  .filter((s) => s.trim()))
  await DB.prepare(sql).run();
for (const sql of readFileSync(
  new URL("../../../migrations/0019_ticket_coin.sql", import.meta.url),
  "utf8",
)
  .split(";")
  .filter((s) => s.trim()))
  await DB.prepare(sql).run();
for (const sql of readFileSync(new URL("../../../migrations/0020_mahjong_devices.sql", import.meta.url), "utf8").split(";").filter(s=>s.trim())) await DB.prepare(sql).run();
await DB.prepare(
  "INSERT INTO users(id,role) VALUES ('demo-owner','user')",
).run();
await DB.prepare(
  "INSERT INTO auth_identities(id,user_id,provider,provider_subject,username,display_name) VALUES ('demo','demo-owner','munet','local-demo','demo','店主')",
).run();
await DB.prepare(
  "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('local','demo-owner',?,'2999-01-01')",
)
  .bind(await sha256("local-preview-session"))
  .run();
await DB.prepare(
  "INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('demo','demo','演示店铺',35,139,80,'demo-owner')",
).run();
await DB.prepare(
  "INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('owner','demo','demo-owner','owner')",
).run();
const deps = createPrismWorkerDependencies({ DB: env.DB }, { shopId: "demo" });
await deps.staffAssetDefinitionCommands!.saveAssetDefinition({
  type: "currency",
  code: "paid",
  name: "余额",
  stackable: true,
  status: "active",
  metadata: null,
});
await deps.staffAssetDefinitionCommands!.saveAssetDefinition({
  type: "currency",
  code: "free",
  name: "赠送余额",
  stackable: true,
  status: "active",
  metadata: null,
});
const rule = await deps.staffPricingCommands!.createPricingConfig({
  kind: "time.priority",
  name: "标准入场",
  enabled: true,
  provider: {
    id: "standard",
    timeZone: "Asia/Shanghai",
    rules: [
      {
        id: "day",
        label: "日场",
        priority: 1,
        timeRange: { start: "10:00", end: "22:00" },
        pricing: {
          unitMinutes: 30,
          unitPrice: 6,
          roundGraceMinutes: 2,
          priceCap: 69,
        },
      },
      {
        id: "night",
        label: "夜场",
        priority: 1,
        timeRange: { start: "22:00", end: "10:00" },
        pricing: {
          unitMinutes: 30,
          unitPrice: 7.5,
          roundGraceMinutes: 2,
          priceCap: 79,
        },
      },
      {
        id: "weekday",
        label: "工作日日场",
        priority: 2,
        weekdays: [1, 2, 3, 4, 5],
        timeRange: { start: "10:00", end: "22:00" },
        pricing: {
          unitMinutes: 30,
          unitPrice: 4,
          roundGraceMinutes: 5,
          priceCap: 40,
        },
      },
      {
        id: "holiday",
        label: "跨年活动",
        priority: 3,
        specificDates: ["2026-12-31"],
        timeRange: { start: "22:30", end: "01:30" },
        pricing: {
          unitMinutes: 30,
          unitPrice: 0,
          roundGraceMinutes: 0,
          priceCap: 0,
        },
      },
    ],
  },
});
await deps.staffApiTokenCommands!.createApiToken({
  label: "演示 Bot",
  role: "integration",
});
await DB.prepare(
  "INSERT INTO shop_billing_settings(shop_id,billing_enabled,entry_pricing_ids_json,bot_contact) VALUES ('demo',1,?,'演示环境')",
)
  .bind(JSON.stringify([rule.id]))
  .run();
let first = "";
for (const [i, name] of ["小林", "阿澄", "凛"].entries()) {
  const player = await deps.staffPlayerCommands!.createPlayer({
    displayName: name,
  });
  if (!i) first = player.id;
  await deps.staffPlayerCommands!.bindPlayerIdentity({
    playerId: player.id,
    provider: "qq",
    subject: String(100000 + i),
  });
  await deps.staffAssetCommands!.grantAssets({
    staffId: "fixture",
    playerId: player.id,
    reason: "演示余额",
    grants: [
      {
        assetType: "currency",
        assetCode: "paid",
        amount: 100 + i * 20,
        mergeStrategy: "stack",
        activeAt: null,
        expiresAt: null,
      },
    ],
  });
  if (i === 1)
    await deps.playerCommands.startSession({
      playerId: player.id,
      pricingConfigIds: [rule.id],
      label: "entry",
    });
}
await DB.prepare(
  "INSERT INTO shop_player_accounts(shop_id,user_id,player_id,qq,verified_at) VALUES ('demo','demo-owner',?,'100000',?)",
)
  .bind(first, new Date().toISOString())
  .run();
await DB.prepare(
  "INSERT INTO cards(id,user_id,label,card_type,access_code,source) VALUES ('demo-card','demo-owner','我的 Aime','aime','01234567890123456789','manual')",
).run();
await DB.prepare(
  "INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES ('demo','devices.ttlock_connection',?,?)",
)
  .bind(
    JSON.stringify({
      baseUrl: "https://lock.preview.invalid",
      clientId: "demo",
      accessToken: "demo",
      clientSecret: "",
      appAccount: "",
      appPwd: "",
      refreshToken: "",
      accessTokenExpiresAt: null,
    }),
    new Date().toISOString(),
  )
  .run();
await DB.batch([
  DB.prepare(
    "INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('lite','lite','轻量演示店',35,139,80,'demo-owner')",
  ),
  DB.prepare(
    "INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('lite-owner','lite','demo-owner','owner')",
  ),
  DB.prepare(
    "INSERT INTO shop_billing_settings(shop_id,billing_enabled,bot_contact) VALUES ('lite',0,'演示环境')",
  ),
  DB.prepare(
    "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('lite','lite-player','小林','active',?)",
  ).bind(new Date().toISOString()),
  DB.prepare(
    "INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES ('lite','lite-player','qq','100000',?)",
  ).bind(new Date().toISOString()),
  DB.prepare(
    "INSERT INTO shop_player_accounts(shop_id,user_id,player_id,qq,verified_at) VALUES ('lite','demo-owner','lite-player','100000',?)",
  ).bind(new Date().toISOString()),
  DB.prepare(
    "INSERT INTO app_settings(shop_id,key,value_json,updated_at) SELECT 'lite',key,value_json,updated_at FROM app_settings WHERE shop_id='demo' AND key='devices.ttlock_connection'",
  ),
]);
for (const device of [
  { id: "entrance", name: "入口", lock: 101, ha: false, io: false },
  { id: "maimai", name: "maimai DX", ha: true, io: true },
  { id: "chunithm", name: "CHUNITHM", ha: true, io: true, auto: true },
  { id: "card-only", name: "刷卡设备", ha: false, io: true },
  { id: "empty", name: "待配置设备", ha: false, io: false },
  {
    id: "lite-auto",
    shop: "lite",
    name: "CHUNITHM",
    ha: false,
    io: true,
    auto: true,
  },
  {
    id: "lite-manual",
    shop: "lite",
    name: "手动投币机台",
    ha: false,
    io: true,
  },
  { id: "lite-power", shop: "lite", name: "maimai DX", ha: true, io: true },
  {
    id: "lite-unknown",
    shop: "lite",
    name: "电源状态未知的机台",
    ha: true,
    io: true,
    auto: true,
  },
  {
    id: "lite-entrance",
    shop: "lite",
    name: "入口",
    lock: 102,
    ha: false,
    io: false,
  },
  { id: "lite-empty", shop: "lite", name: "待配置设备", ha: false, io: false },
])
  await DB.prepare(
    "INSERT INTO machines(id,public_id,shop_id,name,kind,hinata_url_encrypted,ha_binding_encrypted,ttlock_lock_id,hinata_password_encrypted,coin_after_swipe) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      device.id,
      device.id,
      device.shop ?? "demo",
      device.name,
      device.lock ? "door" : "machine",
      device.io
        ? await encryptSecret(
            `https://${device.id}.preview.invalid`,
            env.URL_ENCRYPTION_KEY,
          )
        : "",
      device.ha
        ? await encryptSecret(
            JSON.stringify({
              url: "https://ha.preview.invalid",
              token: "demo",
              entityId: `switch.${device.id}`,
            }),
            env.URL_ENCRYPTION_KEY,
          )
        : null,
      device.lock ?? null,
      device.io ? await encryptSecret("demo", env.URL_ENCRYPTION_KEY) : null,
      device.auto ? 1 : 0,
    )
    .run();
const powerStates: Record<string, string> = {
  "switch.maimai": "off",
  "switch.chunithm": "on",
  "switch.lite-power": "off",
};
// Simulation is deliberately local-only: even pasted device URLs cannot reach real hardware.
globalThis.fetch = (async (url, init) => {
  const target = new URL(
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
  );
  if (!target.hostname.endsWith(".preview.invalid"))
    throw new Error("Local preview does not contact external devices");
  if (target.pathname.startsWith("/api/states/"))
    return Response.json({
      state:
        powerStates[decodeURIComponent(target.pathname.split("/").at(-1)!)] ??
        "unavailable",
    });
  if (target.pathname.startsWith("/api/services/")) {
    const body = JSON.parse(String(init?.body));
    powerStates[body.entity_id] = target.pathname.endsWith("/turn_on")
      ? "on"
      : "off";
    return Response.json([]);
  }
  if (target.pathname === "/v3/keyboardPwd/add")
    return Response.json({ keyboardPwdId: 101 });
  const envelope = JSON.parse(String(init?.body));
  const command = (await decryptE2EE("demo", envelope)) as {
    action: string;
    body: { count?: number };
  };
  if (
    !["SET_CARD", "KEY_PRESS"].includes(command.action) ||
    (command.action === "KEY_PRESS" && command.body.count !== 1)
  )
    return Response.json({ error: "Invalid device command" }, { status: 400 });
  return Response.json({ ok: true });
}) as typeof fetch;
const root = resolve(import.meta.dir, "../../prism-web/dist");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 8790,
  async fetch(req) {
    const url = new URL(req.url);
    if (
      url.pathname.startsWith("/api/") ||
      /^\/t\/[^/]+\/[^/]+$/.test(url.pathname)
    ) {
      const headers = new Headers(req.headers);
      headers.set("cookie", "arcadelink_session=local-preview-session");
      return app.fetch(new Request(req, { headers }), env);
    }
    const path = resolve(root, "." + decodeURIComponent(url.pathname));
    if (!path.startsWith(root + "/"))
      return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (await file.exists()) return new Response(file);
    return extname(path)
      ? new Response("Not found", { status: 404 })
      : new Response(Bun.file(resolve(root, "index.html")));
  },
});
console.log(`${origin}/merchant/demo`);
process.on("SIGINT", async () => {
  server.stop();
  await mf.dispose();
  process.exit();
});

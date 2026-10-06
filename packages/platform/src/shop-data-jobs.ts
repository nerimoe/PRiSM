import type { Context, Hono } from "hono";
import { z } from "zod";
import { validatePricingConfig, resolveLocationTimeZone } from "@prism/core";
import { toPricingConfig, type PricingConfigRow } from "@prism/storage-sql";
import { createD1Repositories } from "@prism/adapter-d1";
import { withOperationLease } from "@prism/application";
import { requireUser } from "./auth";
import { type BillingShop } from "./billing";
import { decryptSecret, encryptSecret, sha256 } from "./crypto";
import { jsonError } from "./http";
import { owner, targetState, snapshotSql, snapshotBindings, snapshotKey } from "./shop-data";
import {
  fullHeaderSchema,
  fullTables,
  schemas,
  transferPageBytes,
  uploadBytes,
  validateRows,
  type FullHeader,
  type FullTable,
} from "./shop-data-v2-format";
import type { DataRow } from "./shop-data-format";
import type { AppBindings } from "./types";

type C = Context<AppBindings>;
type Job = {
  id: string;
  kind: string;
  status: string;
  header_json: string;
  target_state: string | null;
  fingerprint: string | null;
  result_json: string | null;
  operation_id: string | null;
};
const base = "/api/v1/shops/:shopCode/data";
const primitive = z.union([z.string(), z.number().finite(), z.null()]);
const q = (key: string) => `json_extract(value,'$.${key}')`;
const sourceColumns = (table: FullTable) =>
  table === "machines"
    ? schemas[table].columns.map(
        (c) =>
          ({
            hinata_url: "hinata_url_encrypted",
            hinata_password: "hinata_password_encrypted",
            ha_binding_json: "ha_binding_encrypted",
          })[c.name] ?? c.name,
      )
    : schemas[table].columns.map((c) => c.name);
const objectSql = (table: FullTable, alias = "") =>
  `json_object(${schemas[table].columns.map((c, i) => `'${c.name}',${alias}${sourceColumns(table)[i]}`).join(",")})`;
const expiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
async function body(c: C): Promise<unknown> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) jsonError(400, "请选择有效的 JSON 备份文件", "INVALID_BACKUP");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.length;
    if (bytes > uploadBytes + 8192) {
      await reader.cancel();
      jsonError(413, "单次传输分片过大，请缩小分片后重试", "TRANSFER_PART_TOO_LARGE");
    }
    chunks.push(next.value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    jsonError(400, "请选择有效的 JSON 备份文件", "INVALID_BACKUP");
  }
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) jsonError(400, "备份格式或版本不受支持", "INVALID_BACKUP", r.error.flatten());
  return r.data;
}
async function getJob(c: C, kind?: string) {
  const shop = await owner(c, false),
    user = requireUser(c);
  const job = await c.env.DB.prepare(
    "SELECT * FROM shop_data_jobs WHERE id=? AND shop_id=? AND user_id=? AND expires_at>?",
  )
    .bind(c.req.param("jobId"), shop.id, user.id, new Date().toISOString())
    .first<Job>();
  if (!job || (kind && job.kind !== kind)) jsonError(404, "备份任务不存在或已过期", "TRANSFER_NOT_FOUND");
  return { shop, job, header: parse(fullHeaderSchema, JSON.parse(job.header_json)) };
}
const counts = async (db: D1Database, id: string, tables: readonly FullTable[]) => {
  const rows = (
    await db
      .prepare("SELECT table_name,COUNT(*) AS n FROM shop_data_rows WHERE job_id=? GROUP BY table_name")
      .bind(id)
      .all<{ table_name: string; n: number }>()
  ).results;
  return Object.fromEntries(tables.map((table) => [table, rows.find((r) => r.table_name === table)?.n ?? 0]));
};
async function cleanup(db: D1Database) {
  await db.prepare("DELETE FROM shop_data_jobs WHERE expires_at<?").bind(new Date().toISOString()).run();
}

async function makeSnapshot(c: C, shop: BillingShop, scope: "business" | "configuration") {
  await cleanup(c.env.DB);
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  const header: FullHeader = {
    format: "prism-shop-data",
    version: 2,
    scope,
    exportedAt: now,
    source: {
      publicId: shop.public_id,
      name: shop.name,
      timeZone: shop.time_zone,
      origin: new URL(c.req.url).origin,
      location: { latitude: shop.latitude, longitude: shop.longitude, radiusMeters: shop.radius_meters },
    },
    storage: { timeZone: "UTC", money: "minor-units" },
    settings: {
      billingEnabled: !!shop.billing_enabled,
      cashierEnabled: !!shop.cashier_enabled,
      autoRegister: !!shop.auto_register,
      identityBindingRequired: !!shop.identity_binding_required,
      checkinGeo: !!shop.checkin_geo,
      checkoutGeo: !!shop.checkout_geo,
      machineGeo: !!shop.machine_geo,
      entryPricingIds: JSON.parse(shop.entry_pricing_ids_json),
      botContact: shop.bot_contact,
      coinCooldownMs: 60000,
      defaultPresentId: null,
    },
  };
  const tables = fullTables(header);
  const statements = [
    c.env.DB.prepare(
      "INSERT INTO shop_data_jobs(id,shop_id,user_id,kind,status,header_json,created_at,expires_at) VALUES (?,?,?,'export','ready',?,?,?)",
    ).bind(id, shop.id, requireUser(c).id, JSON.stringify(header), now, expiry()),
  ];
  const storedTables = tables.filter((table) => table !== "account_links");
  // Keep compound SELECTs below D1's term limit while capturing every page in one transaction.
  for (let offset = 0; offset < storedTables.length; offset += 5) {
    const group = storedTables.slice(offset, offset + 5);
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO shop_data_rows(job_id,seq,table_name,payload_json)
      SELECT ?,seq,table_name,payload_json FROM (${group
        .map(
          (table) => `SELECT
        ${tables.indexOf(table) * 1000000000}+ROW_NUMBER() OVER(ORDER BY rowid) AS seq,
        '${table}' AS table_name,${objectSql(table)} AS payload_json FROM ${table} WHERE shop_id=?`,
        )
        .join(" UNION ALL ")})`,
      ).bind(id, ...group.map(() => shop.id)),
    );
  }
  for (const table of tables) {
    if (table === "account_links") {
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO shop_data_rows(job_id,seq,table_name,payload_json)
        SELECT ?,COALESCE((SELECT MAX(seq) FROM shop_data_rows WHERE job_id=?),0)+ROW_NUMBER() OVER(ORDER BY u.id),'account_links',
        json_object('source_user_id',u.id,'player_id',COALESCE(a.player_id,h.player_id,w.player_id),'staff_id',COALESCE(f.staff_id,h.staff_id),'member_role',COALESCE(m.role,h.member_role),'verified_at',COALESCE(a.verified_at,h.verified_at,w.created_at),
          'identities_json',(SELECT json_group_array(json_object('provider',i.provider,'subject',i.provider_subject)) FROM auth_identities i WHERE i.user_id=u.id)||'',
          'platform_bindings_json',COALESCE(NULLIF((SELECT json_group_array(json_object('provider',b.provider,'subject',b.subject,'verified_at',b.verified_at)) FROM shop_platform_bindings b WHERE b.shop_id=? AND b.user_id=u.id)||'','[]'),h.platform_bindings_json,'[]'))
        FROM users u LEFT JOIN shop_player_accounts a ON a.user_id=u.id AND a.shop_id=?
        LEFT JOIN shop_staff_accounts f ON f.user_id=u.id AND f.shop_id=? LEFT JOIN shop_members m ON m.user_id=u.id AND m.shop_id=?
        LEFT JOIN player_identities w ON w.subject=u.id AND w.provider='web-account' AND w.shop_id=?
        LEFT JOIN shop_imported_accounts h ON h.source_user_id=u.id AND h.shop_id=? AND h.matched_user_id IS NULL
        WHERE a.user_id IS NOT NULL OR f.user_id IS NOT NULL OR m.user_id IS NOT NULL OR w.subject IS NOT NULL`,
        ).bind(id, id, shop.id, shop.id, shop.id, shop.id, shop.id, shop.id),
      );
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO shop_data_rows(job_id,seq,table_name,payload_json)
        SELECT ?,COALESCE((SELECT MAX(seq) FROM shop_data_rows WHERE job_id=?),0)+ROW_NUMBER() OVER(ORDER BY source_user_id),'account_links',
        json_object('source_user_id',source_user_id,'player_id',player_id,'staff_id',staff_id,'member_role',member_role,'verified_at',verified_at,
        'identities_json',identities_json,'platform_bindings_json',platform_bindings_json)
        FROM shop_imported_accounts h WHERE shop_id=? AND matched_user_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM shop_data_rows r WHERE r.job_id=? AND r.table_name='account_links' AND json_extract(r.payload_json,'$.source_user_id')=h.source_user_id)`,
        ).bind(id, id, shop.id, id),
      );
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO shop_data_rows(job_id,seq,table_name,payload_json)
        SELECT ?,COALESCE((SELECT MAX(seq) FROM shop_data_rows WHERE job_id=?),0)+ROW_NUMBER() OVER(ORDER BY i.subject),'account_links',
        json_object('source_user_id',i.subject,'player_id',i.player_id,'staff_id',NULL,'member_role',NULL,'verified_at',i.created_at,
          'identities_json','[]','platform_bindings_json','[]') FROM player_identities i WHERE i.shop_id=? AND i.provider='web-account'
        AND NOT EXISTS(SELECT 1 FROM shop_data_rows r WHERE r.job_id=? AND r.table_name='account_links' AND json_extract(r.payload_json,'$.source_user_id')=i.subject)`,
        ).bind(id, id, shop.id, id),
      );
    }
  }
  // Metadata and all records are read in the same transaction; downloading can take any amount of time.
  statements.push(
    c.env.DB.prepare(
      `UPDATE shop_data_jobs SET header_json=json_set(header_json,
    '$.source.name',(SELECT name FROM shops WHERE id=?),
    '$.source.location',(SELECT json_object('latitude',latitude,'longitude',longitude,'radiusMeters',radius_meters) FROM shops WHERE id=?),
    '$.source.timeZone',COALESCE((SELECT json_extract(value_json,'$.timeZone') FROM app_settings WHERE shop_id=? AND key='store.profile'),'Asia/Shanghai'),
    '$.shopProfile',(SELECT json_object('name',name,'latitude',latitude,'longitude',longitude,'radiusMeters',radius_meters,'heroData',hero_data) FROM shops WHERE id=?),
    '$.settings',(SELECT json_object(
      'billingEnabled',json(CASE WHEN COALESCE(b.billing_enabled,0) THEN 'true' ELSE 'false' END),
      'autoRegister',json(CASE WHEN COALESCE(b.auto_register,0) THEN 'true' ELSE 'false' END),
      'identityBindingRequired',json(CASE WHEN COALESCE(b.identity_binding_required,1) THEN 'true' ELSE 'false' END),
      'checkinGeo',json(CASE WHEN COALESCE(b.checkin_geo,0) THEN 'true' ELSE 'false' END),
      'checkoutGeo',json(CASE WHEN COALESCE(b.checkout_geo,0) THEN 'true' ELSE 'false' END),
      'machineGeo',json(CASE WHEN COALESCE(b.machine_geo,0) THEN 'true' ELSE 'false' END),
      'entryPricingIds',json(COALESCE(b.entry_pricing_ids_json,'[]')),'botContact',COALESCE(b.bot_contact,''),
      'cashierEnabled',json(CASE WHEN COALESCE((SELECT json_extract(value_json,'$.enabled') FROM app_settings WHERE shop_id=s.id AND key='cashier.settings'),0) THEN 'true' ELSE 'false' END),
      'coinCooldownMs',COALESCE((SELECT json_extract(value_json,'$.coinCooldownMs') FROM app_settings WHERE shop_id=s.id AND key='venue.operations'),60000),
      'defaultPresentId',(SELECT json_extract(value_json,'$.defaultPresentId') FROM app_settings WHERE shop_id=s.id AND key='player.registration'))
      FROM shops s LEFT JOIN shop_billing_settings b ON b.shop_id=s.id WHERE s.id=?)) WHERE id=?`,
    ).bind(shop.id, shop.id, shop.id, shop.id, shop.id, id),
  );
  await c.env.DB.batch(statements);
  const job = (await c.env.DB.prepare("SELECT header_json FROM shop_data_jobs WHERE id=?")
    .bind(id)
    .first<{ header_json: string }>())!;
  return {
    jobId: id,
    headerJson: job.header_json,
    tables,
    counts: await counts(c.env.DB, id, tables),
    filename: `prism-${shop.public_id}-${scope}-${now.slice(0, 10)}.json`,
  };
}
async function page(c: C, id: string, after: number) {
  const rows = (
    await c.env.DB.prepare(
      `WITH candidates AS (
    SELECT seq,table_name,payload_json FROM shop_data_rows WHERE job_id=? AND seq>? ORDER BY seq LIMIT 1000),
    sized AS (SELECT *,SUM(length(CAST(payload_json AS BLOB))) OVER(ORDER BY seq) AS bytes FROM candidates)
    SELECT seq,table_name,payload_json FROM sized WHERE bytes<=? OR seq=(SELECT MIN(seq) FROM candidates) ORDER BY seq`,
    )
      .bind(id, after, transferPageBytes)
      .all<{ seq: number; table_name: FullTable; payload_json: string }>()
  ).results;
  for (const row of rows)
    if (row.table_name === "machines") {
      const value = JSON.parse(row.payload_json) as DataRow;
      for (const key of ["hinata_url", "hinata_password", "ha_binding_json"])
        if (value[key]) value[key] = await decryptSecret(String(value[key]), c.env.URL_ENCRYPTION_KEY);
      row.payload_json = JSON.stringify(value);
    }
  return { rows, cursor: rows.at(-1)?.seq ?? after, done: rows.length === 0 };
}
async function* filePieces(c: C, id: string, headerJson: string, tables: readonly FullTable[]) {
  yield headerJson.slice(0, -1) + ',"tables":{';
  let cursor = 0,
    index = 0,
    open = false,
    hasRows = false;
  for (;;) {
    const next = await page(c, id, cursor);
    if (next.done) break;
    cursor = next.cursor;
    for (const row of next.rows) {
      while (tables[index] !== row.table_name) {
        if (open) yield "]";
        else yield `${JSON.stringify(tables[index])}:[]`;
        yield ",";
        open = false;
        hasRows = false;
        index++;
        if (index >= tables.length) throw new Error("Invalid snapshot table sequence");
      }
      if (!open) {
        yield `${JSON.stringify(tables[index])}:[`;
        open = true;
      }
      if (hasRows) yield ",";
      yield row.payload_json;
      hasRows = true;
    }
  }
  if (open) {
    yield "]";
    index++;
  }
  while (index < tables.length) {
    if (index > 0) yield ",";
    yield `${JSON.stringify(tables[index++])}:[]`;
  }
  yield "}}";
}

async function stage(
  c: C,
  job: Job,
  header: FullHeader,
  input: { table: string; part: number; rows: DataRow[] },
) {
  const table = input.table as FullTable;
  if (!fullTables(header).includes(table)) jsonError(400, "备份包含不支持的数据表", "INVALID_BACKUP");
  const hash = await sha256(JSON.stringify(input)),
    previous = await c.env.DB.prepare("SELECT request_hash FROM shop_data_parts WHERE job_id=? AND part=?")
      .bind(job.id, input.part)
      .first<{ request_hash: string }>();
  if (previous) {
    if (previous.request_hash !== hash) jsonError(409, "分片编号对应的数据已变化", "OPERATION_CONFLICT");
    return;
  }
  if (job.status !== "uploading") jsonError(409, "任务已经完成预检，不能继续修改文件", "TRANSFER_LOCKED");
  const errors = validateRows(table, input.rows);
  if (
    header.version === 1 &&
    table === "player_identities" &&
    input.rows.some((row) => row.provider === "web-account")
  )
    errors.push("旧版本备份不支持网页登录账号身份");
  if (table === "pricing_configs" || table === "pricing_config_versions")
    for (const row of input.rows) {
      try {
        validatePricingConfig(
          toPricingConfig({ ...row, id: row.id ?? row.config_id } as unknown as PricingConfigRow),
        );
        if (
          table === "pricing_configs" &&
          row.kind !== "charge.fixed" &&
          JSON.parse(String(row.provider_json)).timeZone !== "UTC"
        )
          errors.push("计费方案必须使用 UTC");
      } catch {
        errors.push("计费方案内容无效");
      }
    }
  if (errors.length) jsonError(400, "分片数据校验失败", "INVALID_BACKUP", { errors });
  // Store portable connections under the destination key before writing any real machine record.
  if (table === "machines")
    for (const row of input.rows)
      for (const key of ["hinata_url", "hinata_password", "ha_binding_json"])
        if (row[key]) row[key] = await encryptSecret(String(row[key]), c.env.URL_ENCRYPTION_KEY);
  const json = JSON.stringify(input.rows),
    schema = schemas[table],
    seq = input.part * 100000;
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO shop_data_parts(job_id,part,request_hash)
    SELECT CASE WHEN status='uploading' THEN id ELSE NULL END,?,? FROM shop_data_jobs WHERE id=?`,
    ).bind(input.part, hash, job.id),
    c.env.DB.prepare(
      `INSERT INTO shop_data_rows(job_id,seq,table_name,payload_json)
      SELECT ?,?+CAST(key AS INTEGER)+1,?,value FROM json_each(?)`,
    ).bind(job.id, seq, table, json),
  ];
  schema.keys.forEach((key, index) =>
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO shop_data_keys(job_id,table_name,key_kind,key_json)
    SELECT ?,?,?,json_array(${key.map(q).join(",")}) FROM json_each(?) ${key.length ? `WHERE ${key.map((k) => `${q(k)} IS NOT NULL`).join(" AND ")}` : ""}`,
      ).bind(job.id, table, index, json),
    ),
  );
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    if (String(error).includes("constraint failed"))
      jsonError(409, "备份中存在重复标识或分片状态发生变化", "INVALID_BACKUP");
    throw error;
  }
}

async function previewJob(
  c: C,
  shop: BillingShop,
  job: Job,
  header: FullHeader,
  manifest: { counts: Record<string, number>; parts: number },
) {
  if (!["uploading", "ready"].includes(job.status)) jsonError(409, "任务状态不允许预检", "TRANSFER_LOCKED");
  const errors: string[] = [],
    tables = fullTables(header),
    actual = await counts(c.env.DB, job.id, tables);
  if (
    Object.keys(manifest.counts).sort().join(",") !== [...tables].sort().join(",") ||
    tables.some((t) => manifest.counts[t] !== actual[t])
  )
    errors.push("备份文件未完整上传或数据表不完整");
  const partState = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n,MAX(part) AS last FROM shop_data_parts WHERE job_id=?",
  )
    .bind(job.id)
    .first<{ n: number; last: number | null }>();
  if (partState?.n !== manifest.parts || (manifest.parts && partState.last !== manifest.parts - 1))
    errors.push("备份分片不完整");
  if (header.version === 2 && actual.shop_billing_settings! > 1) errors.push("计费设置记录重复");
  // Indexed staged keys validate relationships without loading the backup into Worker memory.
  const checks: string[] = [],
    messages: string[] = [];
  for (const table of tables)
    for (const fk of schemas[table].foreignKeys) {
      if (!tables.includes(fk.table as FullTable)) {
        errors.push(`${table} 缺少关联表 ${fk.table}`);
        continue;
      }
      const target = schemas[fk.table as FullTable],
        kind = target.keys.findIndex((key) => key.join(",") === fk.referenced.join(","));
      if (kind < 0) throw new Error("Backup reference has no unique key");
      if (!actual[table]) continue;
      checks.push(`SELECT ${messages.length} AS check_index WHERE EXISTS(SELECT 1 FROM shop_data_rows r
        WHERE r.job_id=(SELECT id FROM job) AND r.table_name='${table}'
        AND ${fk.columns.map((k) => `json_extract(r.payload_json,'$.${k}') IS NOT NULL`).join(" AND ")}
        AND NOT EXISTS(SELECT 1 FROM shop_data_keys k WHERE k.job_id=r.job_id AND k.table_name='${fk.table}' AND k.key_kind=${kind}
          AND k.key_json=json_array(${fk.columns.map((k) => `json_extract(r.payload_json,'$.${k}')`).join(",")})))`);
      messages.push(`${table} 存在失效的 ${fk.table} 关联`);
    }
  if (checks.length) {
    const statements: D1PreparedStatement[] = [];
    for (let offset = 0; offset < checks.length; offset += 5)
      statements.push(
        c.env.DB.prepare(
          `WITH job(id) AS(SELECT ?) ${checks.slice(offset, offset + 5).join(" UNION ALL ")}`,
        ).bind(job.id),
      );
    const results = await c.env.DB.batch<{ check_index: number }>(statements);
    for (const result of results) for (const row of result.results) errors.push(messages[row.check_index]!);
  }
  // Check all release version IDs and unpaid session bindings in SQL as well.
  if (header.scope === "business") {
    const result = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT 1 FROM shop_data_rows r JOIN json_each(json_extract(r.payload_json,'$.version_ids_json')) v
        WHERE r.job_id=? AND r.table_name='pricing_releases' AND NOT EXISTS(
        SELECT 1 FROM shop_data_keys k WHERE k.job_id=r.job_id AND k.table_name='pricing_config_versions' AND k.key_kind=0 AND k.key_json=json_array(v.value)) LIMIT 1`,
      ).bind(job.id),
      c.env.DB.prepare(
        `SELECT 1 FROM shop_data_rows r WHERE r.job_id=? AND r.table_name='sessions' AND json_extract(r.payload_json,'$.payment_status')='unpaid'
        AND NOT EXISTS(SELECT 1 FROM shop_data_keys k WHERE k.job_id=r.job_id AND k.table_name='session_pricing_releases' AND k.key_kind=0
        AND k.key_json=json_array(json_extract(r.payload_json,'$.id'))) LIMIT 1`,
      ).bind(job.id),
    ]);
    if (result[0]!.results.length) errors.push("计费发布版本引用了不存在的规则版本");
    if (result[1]!.results.length) errors.push("未结会话缺少计费版本绑定");
  }
  const configRows = (
    await c.env.DB.prepare(
      `SELECT json_extract(payload_json,'$.id') AS id,json_extract(payload_json,'$.kind') AS kind,
    json_extract(payload_json,'$.enabled') AS enabled,json_extract(payload_json,'$.status') AS status
    FROM shop_data_rows WHERE job_id=? AND table_name='pricing_configs'
    AND json_extract(payload_json,'$.id') IN (SELECT value FROM json_each(?))`,
    )
      .bind(job.id, JSON.stringify(header.settings.entryPricingIds))
      .all<DataRow>()
  ).results;
  const configs = new Map(configRows.map((r) => [r.id, r] as const));
  const settings = header.settings;
  if (settings.entryPricingIds.some((id) => !configs.has(id))) errors.push("入场规则引用了不存在的计费方案");
  if (settings.billingEnabled) {
    const assets = (
      await c.env.DB.prepare(
        `SELECT json_extract(payload_json,'$.type') AS type,json_extract(payload_json,'$.code') AS code,json_extract(payload_json,'$.status') AS status
      FROM shop_data_rows WHERE job_id=? AND table_name='asset_definitions' AND json_extract(payload_json,'$.code') IN ('paid','free')`,
      )
        .bind(job.id)
        .all<DataRow>()
    ).results;
    if (
      ["paid", "free"].some(
        (code) => !assets.some((a) => a.type === "currency" && a.code === code && a.status === "active"),
      )
    )
      errors.push("已启用计费但缺少有效余额资产");
    if (
      !settings.entryPricingIds.length ||
      settings.entryPricingIds.some((id) => {
        const row = configs.get(id);
        return !row || row.enabled !== 1 || row.status !== "active" || row.kind === "time.cap";
      })
    )
      errors.push("已启用计费但入场规则不可用");
  }
  if (settings.cashierEnabled && !settings.billingEnabled) errors.push("前台收银要求启用入场计费");
  if (
    settings.defaultPresentId &&
    !(await c.env.DB.prepare(
      "SELECT 1 FROM shop_data_keys WHERE job_id=? AND table_name='presents' AND key_kind=0 AND key_json=json_array(?)",
    )
      .bind(job.id, settings.defaultPresentId)
      .first())
  )
    errors.push("新玩家礼物不存在");
  if (header.scope === "business") {
    if (actual.pricing_configs && actual.pricing_release_heads !== 1)
      errors.push("缺少唯一的当前计费发布版本");
    if (
      await c.env.DB.prepare(
        `SELECT 1 FROM shop_data_rows c JOIN shop_data_rows r ON r.job_id=c.job_id
      AND r.table_name IN ('player_identities','asset_holdings','account_links') AND json_extract(r.payload_json,'$.player_id')=json_extract(c.payload_json,'$.player_id')
      WHERE c.job_id=? AND c.table_name='cashier_profiles' LIMIT 1`,
      )
        .bind(job.id)
        .first()
    )
      errors.push("前台玩家不可同时拥有平台身份或余额资产");
  }
  if (header.version === 2) {
    const billing = await c.env.DB.prepare(
      "SELECT payload_json FROM shop_data_rows WHERE job_id=? AND table_name='shop_billing_settings'",
    )
      .bind(job.id)
      .first<{ payload_json: string }>();
    const raw = billing ? (JSON.parse(billing.payload_json) as DataRow) : {};
    const settingRows = (
      await c.env.DB.prepare(
        `SELECT json_extract(payload_json,'$.key') AS key,
      json_extract(json_extract(payload_json,'$.value_json'),'$.enabled') AS enabled,
      json_extract(json_extract(payload_json,'$.value_json'),'$.coinCooldownMs') AS cooldown,
      json_extract(json_extract(payload_json,'$.value_json'),'$.defaultPresentId') AS present
      FROM shop_data_rows WHERE job_id=? AND table_name='app_settings'
      AND json_extract(payload_json,'$.key') IN ('cashier.settings','venue.operations','player.registration')`,
      )
        .bind(job.id)
        .all<DataRow>()
    ).results;
    const expected = {
      billingEnabled: !!raw.billing_enabled,
      autoRegister: !!raw.auto_register,
      identityBindingRequired:
        raw.identity_binding_required === undefined ? true : !!raw.identity_binding_required,
      checkinGeo: !!raw.checkin_geo,
      checkoutGeo: !!raw.checkout_geo,
      machineGeo: !!raw.machine_geo,
      entryPricingIds: JSON.parse(String(raw.entry_pricing_ids_json ?? "[]")) as string[],
      botContact: raw.bot_contact ?? "",
      cashierEnabled: !!settingRows.find((r) => r.key === "cashier.settings")?.enabled,
      coinCooldownMs: settingRows.find((r) => r.key === "venue.operations")?.cooldown ?? 60000,
      defaultPresentId: settingRows.find((r) => r.key === "player.registration")?.present ?? null,
    };
    if (
      Object.entries(expected).some(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(settings[key as keyof typeof settings]),
      )
    )
      errors.push("计费设置与文件摘要不一致");
    if (tables.includes("account_links")) {
      if (
        await c.env.DB.prepare(
          `SELECT 1 FROM shop_data_rows i WHERE i.job_id=? AND i.table_name='player_identities'
        AND json_extract(i.payload_json,'$.provider')='web-account' AND NOT EXISTS(SELECT 1 FROM shop_data_rows a WHERE a.job_id=i.job_id AND a.table_name='account_links'
        AND json_extract(a.payload_json,'$.source_user_id')=json_extract(i.payload_json,'$.subject') AND json_extract(a.payload_json,'$.player_id')=json_extract(i.payload_json,'$.player_id')) LIMIT 1`,
        )
          .bind(job.id)
          .first()
      )
        errors.push("网页登录身份缺少对应的账号关联");
      if (
        await c.env.DB.prepare(
          `SELECT 1 FROM shop_data_rows r JOIN json_each(json_extract(r.payload_json,'$.identities_json')) i
        WHERE r.job_id=? AND r.table_name='account_links'
        GROUP BY json_extract(i.value,'$.provider'),json_extract(i.value,'$.subject') HAVING COUNT(*)>1 LIMIT 1`,
        )
          .bind(job.id)
          .first()
      )
        errors.push("多个账号关联使用了同一登录身份");
      if (
        await c.env.DB.prepare(
          `SELECT 1 FROM shop_data_rows r JOIN json_each(json_extract(r.payload_json,'$.platform_bindings_json')) b
        WHERE r.job_id=? AND r.table_name='account_links' AND NOT EXISTS(SELECT 1 FROM shop_data_rows i WHERE i.job_id=r.job_id AND i.table_name='player_identities'
          AND json_extract(i.payload_json,'$.player_id')=json_extract(r.payload_json,'$.player_id') AND json_extract(i.payload_json,'$.provider')=json_extract(b.value,'$.provider')
          AND json_extract(i.payload_json,'$.subject')=json_extract(b.value,'$.subject')) LIMIT 1`,
        )
          .bind(job.id)
          .first()
      )
        errors.push("平台绑定与玩家身份不一致");
    }
  }
  const state = await targetState(c, shop.id);
  if (state.rows) errors.push("目标店铺已有玩家、账单、配置或设备，请选择空店铺导入");
  const parts = (
    await c.env.DB.prepare("SELECT part,request_hash FROM shop_data_parts WHERE job_id=? ORDER BY part")
      .bind(job.id)
      .all()
  ).results;
  const fingerprint = await sha256(JSON.stringify({ jobId: job.id, header, parts, state }));
  if (!errors.length) {
    const statements = [
      c.env.DB.prepare(
        `UPDATE shop_data_jobs SET status=CASE WHEN
      (SELECT COUNT(*) FROM shop_data_parts WHERE job_id=shop_data_jobs.id)=? AND
      (SELECT COUNT(*) FROM shop_data_rows WHERE job_id=shop_data_jobs.id)=? THEN 'ready' ELSE NULL END,
      target_state=?,fingerprint=? WHERE id=? AND status IN ('uploading','ready')`,
      ).bind(
        manifest.parts,
        Object.values(actual).reduce((a, b) => a + b, 0),
        snapshotKey(state),
        fingerprint,
        job.id,
      ),
      c.env.DB.prepare("DELETE FROM shop_data_device_ids WHERE job_id=?").bind(job.id),
      c.env.DB.prepare(
        `INSERT INTO shop_data_device_ids(job_id,source_id,id,public_id)
        SELECT ?,json_extract(r.payload_json,'$.id'),
        CASE WHEN EXISTS(SELECT 1 FROM machines m WHERE m.id=json_extract(r.payload_json,'$.id') OR m.public_id=json_extract(r.payload_json,'$.public_id'))
          THEN lower(hex(randomblob(16))) ELSE json_extract(r.payload_json,'$.id') END,
        CASE WHEN EXISTS(SELECT 1 FROM machines m WHERE m.id=json_extract(r.payload_json,'$.id') OR m.public_id=json_extract(r.payload_json,'$.public_id'))
          THEN lower(hex(randomblob(16))) ELSE json_extract(r.payload_json,'$.public_id') END
        FROM shop_data_rows r WHERE r.job_id=? AND r.table_name='machines'`,
      ).bind(job.id, job.id),
    ];
    try {
      await c.env.DB.batch(statements);
    } catch (error) {
      if (String(error).includes("constraint failed"))
        jsonError(409, "预检时上传状态发生变化，请重试", "TRANSFER_CHANGED");
      throw error;
    }
  }
  return {
    canImport: !errors.length,
    errors: errors.slice(0, 30),
    fingerprint,
    scope: header.scope,
    source: header.source,
    counts: actual,
    warnings: [
      header.version === 2
        ? "将恢复完整店铺资料、设置、设备连接及业务记录。目标店铺编号和当前管理员保留。"
        : "此为 v1 备份，仅恢复文件已有内容，目标店铺资料保留。",
      "备份包含连接密钥、平台身份、卡片和财务数据，请妥善保管。",
      "账号按同一账号 ID 或已验证登录身份恢复关联；无法匹配的关联保留，需重新绑定。",
    ],
  };
}

async function applyJob(
  c: C,
  shop: BillingShop,
  job: Job,
  header: FullHeader,
  fingerprint: string,
  operationId: string,
) {
  if (job.result_json) {
    if (job.fingerprint !== fingerprint || job.operation_id !== operationId)
      jsonError(409, "请求编号已用于其他操作", "OPERATION_CONFLICT");
    return JSON.parse(job.result_json);
  }
  const previous = await c.env.DB.prepare(
    "SELECT 1 FROM player_operations WHERE shop_id=? AND user_id=? AND id=?",
  )
    .bind(shop.id, requireUser(c).id, operationId)
    .first();
  if (previous) jsonError(409, "请求编号已用于其他操作", "OPERATION_CONFLICT");
  if (job.status !== "ready" || fingerprint !== job.fingerprint)
    jsonError(409, "请先完成备份预检", "IMPORT_NOT_READY");
  const state = await targetState(c, shop.id);
  if (snapshotKey(state) !== job.target_state)
    jsonError(409, "预检后店铺数据或文件已变化，请重新预检", "IMPORT_TARGET_CHANGED");
  const db = c.env.DB,
    tables = fullTables(header),
    now = new Date().toISOString();
  const rowsCount = await counts(db, job.id, tables),
    result = { imported: true, scope: header.scope, counts: rowsCount };
  const statements = [
    db
      .prepare(
        `INSERT INTO player_operations(shop_id,user_id,id,kind,status,request_hash,result_json,created_at)
    SELECT ?,?,CASE WHEN json_array(rows,settings,billing)=? AND EXISTS(SELECT 1 FROM shop_data_jobs WHERE id=? AND status='ready' AND fingerprint=?) THEN ? ELSE NULL END,'data/import','completed',?,?,?
    FROM (${snapshotSql})`,
      )
      .bind(
        shop.id,
        requireUser(c).id,
        job.target_state,
        job.id,
        fingerprint,
        operationId,
        fingerprint,
        JSON.stringify(result),
        now,
        ...snapshotBindings(shop.id),
      ),
  ];
  const triggers =
    header.scope === "business"
      ? (
          await db
            .prepare(
              "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('pricing_config_version_insert','session_pricing_bind')",
            )
            .all<{ name: string; sql: string }>()
        ).results
      : [];
  if (header.scope === "business" && triggers.length !== 2)
    jsonError(409, "计费数据库结构不完整，无法恢复历史版本", "IMPORT_SCHEMA_MISMATCH");
  statements.push(...triggers.map((t) => db.prepare(`DROP TRIGGER ${t.name}`)));
  // Machines have global IDs. The preflight stores collision mappings in D1, not Worker memory.
  if (rowsCount.machines) {
    const cols = sourceColumns("machines"),
      expressions = schemas.machines.columns.map((col) =>
        col.name === "id"
          ? "d.id"
          : col.name === "public_id"
            ? "d.public_id"
            : `json_extract(r.payload_json,'$.${col.name}')`,
      );
    statements.push(
      db
        .prepare(
          `INSERT INTO machines(shop_id,${cols.join(",")}) SELECT ?,${expressions.join(",")}
      FROM shop_data_rows r JOIN shop_data_device_ids d ON d.job_id=r.job_id AND d.source_id=json_extract(r.payload_json,'$.id')
      WHERE r.job_id=? AND r.table_name='machines'`,
        )
        .bind(shop.id, job.id),
    );
  }
  for (const table of tables) {
    if (table === "machines" || table === "account_links" || !rowsCount[table]) continue;
    const cols = schemas[table].columns.map((c) => c.name),
      expressions = cols.map((col) => `json_extract(payload_json,'$.${col}')`);
    let filter = "";
    if (table === "player_identities") filter = " AND json_extract(payload_json,'$.provider')!='web-account'";
    if (table === "staff_users")
      filter +=
        " AND NOT EXISTS(SELECT 1 FROM staff_users s WHERE s.shop_id=? AND s.id=json_extract(payload_json,'$.id'))";
    if (table === "app_settings")
      filter += " AND json_extract(payload_json,'$.key')!='backup.importedAccounts'";
    const deviceCol =
      table === "mahjong_seats" || table === "machine_connections"
        ? "machine_id"
        : table === "device_states" || table === "device_commands"
          ? "device_id"
          : null;
    if (deviceCol)
      expressions[cols.indexOf(deviceCol)] =
        `COALESCE((SELECT id FROM shop_data_device_ids d WHERE d.job_id=shop_data_rows.job_id
      AND d.source_id=json_extract(payload_json,'$.${deviceCol}')),json_extract(payload_json,'$.${deviceCol}'))`;
    if (table === "sessions")
      expressions[cols.indexOf("metadata_json")] =
        `CASE WHEN EXISTS(SELECT 1 FROM shop_data_device_ids d WHERE d.job_id=shop_data_rows.job_id AND d.source_id=json_extract(json_extract(payload_json,'$.metadata_json'),'$.mahjongDeviceId'))
      THEN json_set(json_extract(payload_json,'$.metadata_json'),'$.mahjongDeviceId',(SELECT id FROM shop_data_device_ids d WHERE d.job_id=shop_data_rows.job_id AND d.source_id=json_extract(json_extract(payload_json,'$.metadata_json'),'$.mahjongDeviceId')))
      ELSE json_extract(payload_json,'$.metadata_json') END`;
    if (table === "device_commands") {
      expressions[cols.indexOf("status")] =
        `CASE WHEN json_extract(payload_json,'$.status')='pending' THEN 'expired' ELSE json_extract(payload_json,'$.status') END`;
      expressions[cols.indexOf("expired_at")] =
        `CASE WHEN json_extract(payload_json,'$.status')='pending' THEN '${now}' ELSE json_extract(payload_json,'$.expired_at') END`;
    }
    if (table === "device_states" || table === "machine_connections")
      expressions[cols.indexOf("status")] = "'offline'";
    let conflict = "";
    if (table === "app_settings")
      conflict =
        " ON CONFLICT(shop_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at";
    if (table === "shop_billing_settings")
      conflict =
        " ON CONFLICT(shop_id) DO UPDATE SET " + cols.map((col) => `${col}=excluded.${col}`).join(",");
    const params: (string | number)[] = [shop.id, job.id, table];
    if (table === "staff_users") params.push(shop.id);
    statements.push(
      db
        .prepare(
          `INSERT INTO ${table}(shop_id,${cols.join(",")}) SELECT ?,${expressions.join(",")}
      FROM shop_data_rows WHERE job_id=? AND table_name=?${filter}${conflict}`,
        )
        .bind(...params),
    );
  }
  const profile = header.shopProfile;
  const timeZone = profile ? resolveLocationTimeZone(profile.latitude, profile.longitude) : shop.time_zone;
  if (profile)
    statements.push(
      db
        .prepare(
          "UPDATE shops SET name=?,latitude=?,longitude=?,radius_meters=?,hero_data=?,hero_hash=?,updated_at=? WHERE id=?",
        )
        .bind(
          profile.name,
          profile.latitude,
          profile.longitude,
          profile.radiusMeters,
          profile.heroData,
          profile.heroData ? await sha256(profile.heroData) : null,
          now,
          shop.id,
        ),
    );
  statements.push(
    db
      .prepare(
        `INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,'store.profile',?,?)
    ON CONFLICT(shop_id,key) DO UPDATE SET value_json=json_set(app_settings.value_json,'$.name',json_extract(excluded.value_json,'$.name'),'$.timeZone',json_extract(excluded.value_json,'$.timeZone')),updated_at=excluded.updated_at`,
      )
      .bind(shop.id, JSON.stringify({ name: profile?.name ?? shop.name, timeZone }), now),
  );
  // v1 files contain only the original settings subset.
  if (header.version === 1) {
    const s = header.settings;
    statements.push(
      db
        .prepare(
          `INSERT INTO shop_billing_settings(shop_id,billing_enabled,auto_register,checkin_geo,checkout_geo,machine_geo,entry_pricing_ids_json,bot_contact,identity_binding_required)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(shop_id) DO UPDATE SET billing_enabled=excluded.billing_enabled,auto_register=excluded.auto_register,checkin_geo=excluded.checkin_geo,
      checkout_geo=excluded.checkout_geo,machine_geo=excluded.machine_geo,entry_pricing_ids_json=excluded.entry_pricing_ids_json,bot_contact=excluded.bot_contact,identity_binding_required=excluded.identity_binding_required`,
        )
        .bind(
          shop.id,
          +s.billingEnabled,
          +s.autoRegister,
          +s.checkinGeo,
          +s.checkoutGeo,
          +s.machineGeo,
          JSON.stringify(s.entryPricingIds),
          s.botContact,
          +s.identityBindingRequired,
        ),
    );
    for (const [key, value] of [
      ["cashier.settings", { enabled: s.cashierEnabled }],
      ["venue.operations", { timeZone: "UTC", coinCooldownMs: s.coinCooldownMs }],
      ["player.registration", { defaultPresentId: s.defaultPresentId }],
    ] as const)
      statements.push(
        db
          .prepare(
            `INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(shop_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
          )
          .bind(shop.id, key, JSON.stringify(value), now),
      );
  }
  if (rowsCount.account_links) {
    const cols = schemas.account_links.columns.map((c) => c.name);
    statements.push(
      db
        .prepare(
          `INSERT INTO shop_imported_accounts(shop_id,${cols.join(",")}) SELECT ?,${cols.map((col) => `json_extract(payload_json,'$.${col}')`).join(",")}
      FROM shop_data_rows WHERE job_id=? AND table_name='account_links'`,
        )
        .bind(shop.id, job.id),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO app_settings(shop_id,key,value_json,updated_at) SELECT ?,'backup.importedAccounts','true',?
      WHERE EXISTS(SELECT 1 FROM shop_data_rows WHERE job_id=? AND table_name='account_links') ON CONFLICT(shop_id,key) DO NOTHING`,
        )
        .bind(shop.id, now, job.id),
    );
  }
  statements.push(...triggers.map((t) => db.prepare(t.sql)));
  statements.push(
    db
      .prepare("UPDATE shop_data_jobs SET status='completed',result_json=?,operation_id=? WHERE id=?")
      .bind(JSON.stringify(result), operationId, job.id),
  );
  for (const table of ["shop_data_rows", "shop_data_parts", "shop_data_keys", "shop_data_device_ids"])
    statements.push(db.prepare(`DELETE FROM ${table} WHERE job_id=?`).bind(job.id));
  try {
    await db.batch(statements);
  } catch (error) {
    if (String(error).includes("NOT NULL constraint failed: player_operations.id"))
      jsonError(409, "预检后店铺数据或文件已变化，请重新预检", "IMPORT_TARGET_CHANGED");
    if (String(error).includes("constraint failed") || String(error).includes("CASHIER_PROFILE_RESTRICTED"))
      jsonError(409, "导入约束校验失败，数据已全部回滚，请重新预检", "IMPORT_CONSTRAINT_FAILED");
    throw error;
  }
  return result;
}

export function registerShopDataJobRoutes(app: Hono<AppBindings>) {
  app.post(base + "/exports", async (c) => {
    const shop = await owner(c);
    const input = parse(
      z.object({ scope: z.enum(["business", "configuration"]).default("business") }).strict(),
      await body(c),
    );
    return c.json(await makeSnapshot(c, shop, input.scope ?? "business"));
  });
  app.get(base + "/exports/:jobId/page", async (c) => {
    const { job } = await getJob(c, "export");
    const after = parse(z.coerce.number().int().nonnegative(), c.req.query("after") ?? 0);
    return c.json(await page(c, job.id, after));
  });
  app.delete(base + "/exports/:jobId", async (c) => {
    const { job } = await getJob(c, "export");
    await c.env.DB.prepare("DELETE FROM shop_data_jobs WHERE id=?").bind(job.id).run();
    return c.json({ deleted: true });
  });
  app.delete(base + "/imports/:jobId", async (c) => {
    const { job } = await getJob(c, "import");
    if (job.status === "completed") jsonError(409, "已完成导入不能撤销", "TRANSFER_LOCKED");
    await c.env.DB.prepare("DELETE FROM shop_data_jobs WHERE id=? AND status IN ('uploading','ready')")
      .bind(job.id)
      .run();
    return c.json({ deleted: true });
  });
  app.get(base + "/export", async (c, next) => {
    if (c.req.query("version") === "1") return next();
    const shop = await owner(c);
    const scope = parse(z.enum(["business", "configuration"]), c.req.query("scope") ?? "business");
    const snapshot = await makeSnapshot(c, shop, scope),
      iterator = filePieces(c, snapshot.jobId, snapshot.headerJson, snapshot.tables),
      encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            await c.env.DB.prepare("DELETE FROM shop_data_jobs WHERE id=?").bind(snapshot.jobId).run();
          } else controller.enqueue(encoder.encode(next.value));
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return(undefined);
        await c.env.DB.prepare("DELETE FROM shop_data_jobs WHERE id=?").bind(snapshot.jobId).run();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${snapshot.filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
  app.post(base + "/imports", async (c) => {
    const shop = await owner(c);
    await cleanup(c.env.DB);
    const header = parse(fullHeaderSchema, await body(c));
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO shop_data_jobs(id,shop_id,user_id,kind,status,header_json,created_at,expires_at) VALUES (?,?,?,'import','uploading',?,?,?)",
    )
      .bind(id, shop.id, requireUser(c).id, JSON.stringify(header), new Date().toISOString(), expiry())
      .run();
    return c.json({ jobId: id, tables: fullTables(header) });
  });
  app.post(base + "/imports/:jobId/parts", async (c) => {
    const { job, header } = await getJob(c, "import");
    const input = parse(
      z
        .object({
          table: z.string(),
          part: z.number().int().nonnegative().max(10000000),
          rows: z.array(z.record(primitive)).max(1000),
        })
        .strict(),
      await body(c),
    );
    await stage(c, job, header, input);
    return c.json({ accepted: true, part: input.part });
  });
  app.post(base + "/imports/:jobId/preview", async (c) => {
    const { shop, job, header } = await getJob(c, "import");
    const manifest = parse(
      z
        .object({ counts: z.record(z.number().int().nonnegative()), parts: z.number().int().nonnegative() })
        .strict(),
      await body(c),
    );
    return c.json(await previewJob(c, shop, job, header, manifest));
  });
  app.post(base + "/imports/:jobId/apply", async (c) => {
    const { shop, job, header } = await getJob(c, "import");
    const input = parse(
      z.object({ fingerprint: z.string(), operationId: z.string().uuid() }).strict(),
      await body(c),
    );
    const repos = createD1Repositories({
      db: c.env.DB,
      shopId: shop.id,
      id: crypto.randomUUID,
      now: () => new Date(),
    });
    return withOperationLease(
      { repository: repos.operationLocks, scope: "shop.cashier", resourceId: shop.id, now: () => new Date() },
      async () => c.json(await applyJob(c, shop, job, header, input.fingerprint, input.operationId)),
    );
  });
}

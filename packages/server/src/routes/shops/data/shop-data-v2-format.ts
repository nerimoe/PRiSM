import { z } from "zod";
import { sqliteSchema } from "@prism/storage-sql";
import {
  backupSchema,
  businessTables,
  configurationTables,
  tableSchemas,
  type DataRow,
} from "./shop-data-format.js";

export const extraSchema = [
  `CREATE TABLE IF NOT EXISTS shop_billing_settings (
 shop_id TEXT NOT NULL,billing_enabled INTEGER NOT NULL CHECK(billing_enabled IN (0,1)),auto_register INTEGER NOT NULL CHECK(auto_register IN (0,1)),checkin_geo INTEGER NOT NULL CHECK(checkin_geo IN (0,1)),checkout_geo INTEGER NOT NULL CHECK(checkout_geo IN (0,1)),
 machine_geo INTEGER NOT NULL CHECK(machine_geo IN (0,1)),entry_pricing_ids_json TEXT NOT NULL,bot_contact TEXT NOT NULL,identity_binding_required INTEGER NOT NULL CHECK(identity_binding_required IN (0,1)),PRIMARY KEY(shop_id))`,
  `CREATE TABLE IF NOT EXISTS machines (
 shop_id TEXT NOT NULL,id TEXT NOT NULL,public_id TEXT NOT NULL,name TEXT NOT NULL,
 hinata_url TEXT NOT NULL,hinata_password TEXT,ha_binding_json TEXT,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('machine','door')),ttlock_lock_id INTEGER,
 coin_key INTEGER NOT NULL,coin_after_swipe INTEGER NOT NULL CHECK(coin_after_swipe IN (0,1)),mahjong_config_json TEXT,
 aliases_json TEXT NOT NULL,PRIMARY KEY(shop_id,id),UNIQUE(shop_id,public_id))`,
  `CREATE TABLE IF NOT EXISTS mahjong_seats (
 shop_id TEXT NOT NULL,player_id TEXT NOT NULL,machine_id TEXT NOT NULL,session_id TEXT NOT NULL,
 entry_session_id TEXT,joined_at TEXT NOT NULL,PRIMARY KEY(shop_id,player_id),UNIQUE(shop_id,session_id),
 FOREIGN KEY(shop_id,player_id) REFERENCES players(shop_id,id),
 FOREIGN KEY(shop_id,machine_id) REFERENCES machines(shop_id,id),
 FOREIGN KEY(shop_id,session_id) REFERENCES sessions(shop_id,id),
 FOREIGN KEY(shop_id,entry_session_id) REFERENCES sessions(shop_id,id))`,
  `CREATE TABLE IF NOT EXISTS account_links (
 shop_id TEXT NOT NULL,source_user_id TEXT NOT NULL,player_id TEXT,staff_id TEXT,member_role TEXT CHECK(member_role IN ('owner','staff')),
 verified_at TEXT,identities_json TEXT NOT NULL,platform_bindings_json TEXT NOT NULL,
 PRIMARY KEY(shop_id,source_user_id),UNIQUE(shop_id,player_id),UNIQUE(shop_id,staff_id),
 FOREIGN KEY(shop_id,player_id) REFERENCES players(shop_id,id),
 FOREIGN KEY(shop_id,staff_id) REFERENCES staff_users(shop_id,id))`,
] as const;
export const fullConfigurationTables = [
  ...configurationTables,
  "app_settings",
  "shop_billing_settings",
  "api_tokens",
  "machines",
] as const;
export const fullBusinessTables = [
  "staff_users",
  ...businessTables,
  "app_settings",
  "shop_billing_settings",
  "api_tokens",
  "machines",
  "mahjong_seats",
  "device_commands",
  "device_states",
  "machine_connections",
  "account_links",
  "checkout_report_states",
] as const;
export type FullTable = (typeof fullBusinessTables)[number];
export const v2TablesFor = (scope: "business" | "configuration"): readonly FullTable[] =>
  scope === "business" ? fullBusinessTables : fullConfigurationTables;
export const schemas = { ...tableSchemas } as Record<
  FullTable,
  (typeof tableSchemas)[(typeof businessTables)[number]]
>;
for (const table of fullBusinessTables) {
  if (schemas[table]) continue;
  const sql = [...sqliteSchema, ...extraSchema].find((sql) =>
    sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`),
  );
  if (!sql) throw new Error(`Missing shop backup schema ${table}`);
  schemas[table] = {
    columns: [...sql.matchAll(/\b([a-z_]+)\s+(TEXT|INTEGER|REAL)\b(\s+NOT NULL)?/g)]
      .filter((m) => m[1] !== "shop_id")
      .map((m) => ({ name: m[1]!, type: m[2]!, required: !!m[3] })),
    keys: [...sql.matchAll(/(?:PRIMARY KEY|UNIQUE)\s*\(([^)]+)\)/g)].map((m) =>
      m[1]!
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "shop_id"),
    ),
    foreignKeys: [...sql.matchAll(/FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES\s*(\w+)\s*\(([^)]+)\)/g)].map(
      (m) => ({
        table: m[2]!,
        columns: m[1]!
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "shop_id"),
        referenced: m[3]!
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "shop_id"),
      }),
    ),
    enums: [...sql.matchAll(/CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]+)\)\)/g)].map((m) => ({
      column: m[1]!,
      values: m[2]!
        .split(",")
        .map((s) => s.trim())
        .map((s) => (s.startsWith("'") ? s.slice(1, -1) : Number(s))),
    })),
  };
}
export const fullHeaderSchema = backupSchema
  .omit({ tables: true, version: true })
  .extend({
    version: z.union([z.literal(1), z.literal(2)]),
    shopProfile: z
      .object({
        name: z.string().min(1).max(80),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        radiusMeters: z.number().min(30).max(1000),
        heroData: z.string().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => value.version === 1 || !!value.shopProfile, "v2 requires shopProfile");
export type FullHeader = z.infer<typeof fullHeaderSchema>;
export const uploadBytes = 2 * 1024 * 1024 - 8192;
export function fullTables(header: FullHeader): readonly FullTable[] {
  return header.version === 1
    ? header.scope === "business"
      ? businessTables
      : configurationTables
    : v2TablesFor(header.scope);
}
export function validateRows(table: FullTable, rows: DataRow[]): string[] {
  const errors: string[] = [],
    schema = schemas[table];
  const columns = schema.columns
    .map((c) => c.name)
    .sort()
    .join(",");
  for (const [index, row] of rows.entries()) {
    if (Object.keys(row).sort().join(",") !== columns) {
      errors.push(`${table} 第 ${index + 1} 行字段不完整或含未知字段`);
      continue;
    }
    for (const c of schema.columns) {
      const v = row[c.name];
      if (v === null && !c.required) continue;
      if (
        (c.type === "TEXT" && typeof v !== "string") ||
        (c.type === "INTEGER" && (typeof v !== "number" || !Number.isSafeInteger(v))) ||
        (c.type === "REAL" && (typeof v !== "number" || !Number.isFinite(v)))
      )
        errors.push(`${table}.${c.name} 类型错误`);
      if (c.name.endsWith("_at") && typeof v === "string" && !Number.isFinite(Date.parse(v)))
        errors.push(`${table}.${c.name} 时间无效`);
      if (c.name.endsWith("_json") && typeof v === "string") {
        try {
          JSON.parse(v);
        } catch {
          errors.push(`${table}.${c.name} 不是有效 JSON`);
        }
      }
    }
    for (const rule of schema.enums)
      if (row[rule.column] !== null && !rule.values.includes(row[rule.column] as string | number))
        errors.push(`${table}.${rule.column} 值无效`);
    if (table === "account_links") {
      const identity = z.object({ provider: z.string().min(1), subject: z.string().min(1) }).strict();
      const binding = identity.extend({
        verified_at: z.string().refine((v) => Number.isFinite(Date.parse(v))),
      });
      try {
        if (
          !z.array(identity).safeParse(JSON.parse(String(row.identities_json))).success ||
          !z.array(binding).safeParse(JSON.parse(String(row.platform_bindings_json))).success
        )
          errors.push("账号关联格式无效");
      } catch {
        errors.push("账号关联格式无效");
      }
    }
    if (table === "pricing_releases") {
      try {
        if (!z.array(z.string().min(1)).safeParse(JSON.parse(String(row.version_ids_json))).success)
          errors.push("计费发布版本列表无效");
        new Intl.DateTimeFormat("en", { timeZone: String(row.time_zone) });
      } catch {
        errors.push("历史计费发布版本的时区或版本列表无效");
      }
    }
    if (table === "shop_billing_settings") {
      try {
        if (
          !z
            .array(z.string().min(1))
            .max(30)
            .safeParse(JSON.parse(String(row.entry_pricing_ids_json))).success
        )
          errors.push("入场方案列表无效");
      } catch {
        errors.push("入场方案列表无效");
      }
    }
    if (errors.length > 20) break;
  }
  return errors.slice(0, 20);
}

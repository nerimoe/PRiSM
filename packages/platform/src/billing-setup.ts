import { serializePricingProviderConfig } from "@prism/storage-sql";
import type { z } from "zod";
import type { billingSetupSchema } from "./validators";

/** Base billing configuration shared by new stores and existing-store setup. */
export function billingSetupStatements(db: D1Database, shopId: string, setup: z.infer<typeof billingSetupSchema>) {
  const ruleId = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements = [
    ...([["paid", setup.paidName], ["free", setup.freeName]] as const).map(([code, name]) =>
      db.prepare(`INSERT INTO asset_definitions(shop_id,type,code,name,stackable,status)
        VALUES (?,'currency',?,?,1,'active') ON CONFLICT(shop_id,type,code) DO NOTHING`).bind(shopId, code, name)),
    db.prepare(`INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
      VALUES (?,?,'time.priority','标准入场',1,'active',?,?,?)`).bind(shopId, ruleId, JSON.stringify(serializePricingProviderConfig({
        id: ruleId,
        rules: [{ id: crypto.randomUUID(), label: "全天", priority: 0, timeRange: { start: "00:00", end: "00:00" },
          pricing: { unitMinutes: 60, unitPrice: setup.hourlyPrice, roundGraceMinutes: setup.graceMinutes, priceCap: setup.dailyCap } }],
      })), now, now),
    db.prepare(`INSERT INTO shop_billing_settings(shop_id,billing_enabled,auto_register,entry_pricing_ids_json,bot_contact)
      VALUES (?,1,?,?,?) ON CONFLICT(shop_id) DO UPDATE SET billing_enabled=1,auto_register=excluded.auto_register,
      entry_pricing_ids_json=excluded.entry_pricing_ids_json,bot_contact=excluded.bot_contact`)
      .bind(shopId, +setup.autoRegister, JSON.stringify([ruleId]), setup.botContact),
  ];
  return { ruleId, statements };
}

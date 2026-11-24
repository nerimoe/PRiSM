/**
 * Shop-level location verification policy and per-resource overrides.
 *
 * Stored in `app_settings` (`key = 'location.settings'`) alongside the legacy
 * boolean flags in `shop_billing_settings` (`checkin_geo` / `checkout_geo` /
 * `machine_geo`):
 * - Shop level: when location verification is enabled, the shop picks whether
 *   players verify via GPS geofence (`gps`), in-shop BLE beacons (`ble`), or
 *   either (`any`), plus a shop-wide default RSSI threshold.
 * - Resource level: each resource may override location verification to
 *   `inherit` (follow shop), `gps` (GPS only), `ble` (BLE beacon only,
 *   optionally pinned to one specific IoT controller), or `none` (skip check).
 */
import type { D1BoundStatementLike, D1DatabaseLike } from "@prism/adapter-d1";
import { z } from "zod";
import type { TenantShop } from "../bindings.js";

export const LOCATION_SETTINGS_KEY = "location.settings";

export const shopLocationModeSchema = z.enum(["gps", "ble", "any"]);
export type ShopLocationMode = z.infer<typeof shopLocationModeSchema>;

export const resourceLocationModeSchema = z.enum(["inherit", "gps", "ble", "none"]);
export type ResourceLocationMode = z.infer<typeof resourceLocationModeSchema>;

export const resourceLocationOverrideSchema = z.object({
  mode: resourceLocationModeSchema.default("inherit"),
  /** Optional specific IoT node id (`shop_nodes.id`) when `mode === 'ble'`; null = any shop beacon. */
  beaconNodeId: z.string().min(1).nullable().default(null),
  /** Optional RSSI threshold override (dBm) when `mode === 'ble'`. */
  rssiThreshold: z.number().int().min(-100).max(-20).nullable().default(null),
});
export type ResourceLocationOverride = z.infer<typeof resourceLocationOverrideSchema>;

export const DEFAULT_RESOURCE_LOCATION_OVERRIDE: ResourceLocationOverride = {
  mode: "inherit",
  beaconNodeId: null,
  rssiThreshold: null,
};

export const shopLocationSettingsSchema = z.object({
  mode: shopLocationModeSchema.default("gps"),
  rssiThreshold: z.number().int().min(-100).max(-20).default(-75),
  resources: z.record(z.string(), resourceLocationOverrideSchema).default({}),
});
export type ShopLocationSettings = z.infer<typeof shopLocationSettingsSchema>;

export const DEFAULT_SHOP_LOCATION_SETTINGS: ShopLocationSettings = {
  mode: "gps",
  rssiThreshold: -75,
  resources: {},
};

export function parseShopLocationSettings(raw: string | null | undefined): ShopLocationSettings {
  if (!raw) return { ...DEFAULT_SHOP_LOCATION_SETTINGS, resources: {} };
  try {
    const parsed = shopLocationSettingsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Fall back to defaults on malformed JSON.
  }
  return { ...DEFAULT_SHOP_LOCATION_SETTINGS, resources: {} };
}

export async function readShopLocationSettings(
  db: D1DatabaseLike,
  shopId: string,
): Promise<ShopLocationSettings> {
  const row = await db
    .prepare("SELECT value_json FROM app_settings WHERE shop_id = ? AND key = ?")
    .bind(shopId, LOCATION_SETTINGS_KEY)
    .first<{ value_json: string }>();
  return parseShopLocationSettings(row?.value_json);
}

export function writeShopLocationSettingsStatement(
  db: D1DatabaseLike,
  shopId: string,
  settings: ShopLocationSettings,
  now = new Date(),
): D1BoundStatementLike {
  return db
    .prepare(
      `INSERT INTO app_settings (shop_id, key, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(shop_id, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .bind(shopId, LOCATION_SETTINGS_KEY, JSON.stringify(settings), now.toISOString());
}

export function resourceLocationOverrideOf(
  settings: ShopLocationSettings,
  deviceId: string,
): ResourceLocationOverride {
  const found = settings.resources[deviceId];
  return found ?? { ...DEFAULT_RESOURCE_LOCATION_OVERRIDE };
}

export function withResourceLocationOverride(
  settings: ShopLocationSettings,
  deviceId: string,
  override: ResourceLocationOverride | null,
): ShopLocationSettings {
  const nextResources = { ...settings.resources };
  if (!override || (override.mode === "inherit" && !override.beaconNodeId && override.rssiThreshold == null)) {
    delete nextResources[deviceId];
  } else {
    nextResources[deviceId] = {
      mode: override.mode,
      beaconNodeId: override.mode === "ble" ? (override.beaconNodeId ?? null) : null,
      rssiThreshold: override.mode === "ble" ? (override.rssiThreshold ?? null) : null,
    };
  }
  return { ...settings, resources: nextResources };
}

export type EffectiveLocationPolicy = {
  mode: "none" | "gps" | "ble" | "any";
  /** Specific IoT node id to match when `mode === 'ble'`; null means any enabled shop beacon. */
  beaconNodeId: string | null;
  /** Minimum RSSI (dBm) for BLE matching; null falls back to beacon/shop default. */
  rssiThreshold: number | null;
};

/** Resolve the effective location policy for a shop-level or resource-level action. */
export function resolveEffectiveLocationPolicy(input: {
  shop: Pick<TenantShop, "checkin_geo" | "checkout_geo" | "machine_geo">;
  action: "checkin" | "checkout" | "machine";
  settings: ShopLocationSettings;
  deviceId?: string | null;
}): EffectiveLocationPolicy {
  const { shop, action, settings, deviceId } = input;
  if (deviceId) {
    const override = resourceLocationOverrideOf(settings, deviceId);
    if (override.mode === "none") {
      return { mode: "none", beaconNodeId: null, rssiThreshold: null };
    }
    if (override.mode === "gps") {
      return { mode: "gps", beaconNodeId: null, rssiThreshold: null };
    }
    if (override.mode === "ble") {
      return {
        mode: "ble",
        beaconNodeId: override.beaconNodeId ?? null,
        rssiThreshold: override.rssiThreshold ?? settings.rssiThreshold,
      };
    }
  }
  const shopEnabled =
    action === "checkin"
      ? !!shop.checkin_geo
      : action === "checkout"
        ? !!shop.checkout_geo
        : !!shop.machine_geo;
  if (!shopEnabled) {
    return { mode: "none", beaconNodeId: null, rssiThreshold: null };
  }
  return {
    mode: settings.mode,
    beaconNodeId: null,
    rssiThreshold: settings.rssiThreshold,
  };
}

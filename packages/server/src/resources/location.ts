/**
 * Shop-level location verification policy and per-resource overrides.
 *
 * Stored in `app_settings` (`key = 'location.settings'`) alongside the three
 * independent action switches in `shop_billing_settings` (`checkin_geo`,
 * `checkout_geo`, `machine_geo`):
 * - Shop level: each action (`checkin`, `checkout`, `machine`) independently
 *   enables or disables location verification.
 * - Resource level: each resource may override verification across all actions
 *   on that resource to `inherit` (follow shop), `require` (always verify,
 *   optionally pinned to a specific IoT beacon node & RSSI threshold), or
 *   `none` (skip check).
 * - Transport selection is automatic — BLE beacons take strict priority whenever
 *   an eligible beacon is online, and GPS geofencing is used only as an
 *   automatic fallback when no online BLE beacon is available:
 *     pinned online beacon -> any online shop beacon -> shop GPS geofence.
 */
import type { D1BoundStatementLike, D1DatabaseLike } from "@prism/adapter-d1";
import { z } from "zod";
import type { TenantShop } from "../bindings.js";
import type { ShopBeaconEntry } from "./nodes.js";

export const LOCATION_SETTINGS_KEY = "location.settings";

/** Legacy schema kept for request compatibility; transport is now auto-resolved. */
export const shopLocationModeSchema = z.enum(["gps", "ble", "any"]);
export type ShopLocationMode = z.infer<typeof shopLocationModeSchema>;

export const resourceLocationModeSchema = z.preprocess(
  (value) => (value === "ble" || value === "gps" ? "require" : value),
  z.enum(["inherit", "require", "none"]),
);
export type ResourceLocationMode = z.infer<typeof resourceLocationModeSchema>;

export const resourceLocationOverrideSchema = z.object({
  mode: resourceLocationModeSchema.default("inherit"),
  /** Optional specific IoT node id (`shop_nodes.id`) when `mode === 'require'`; null = any online shop beacon. */
  beaconNodeId: z.string().min(1).nullable().default(null),
  /** Optional RSSI threshold override (dBm) when `mode === 'require'`. */
  rssiThreshold: z.number().int().min(-100).max(-20).nullable().default(null),
});
export type ResourceLocationOverride = z.infer<typeof resourceLocationOverrideSchema>;

export const DEFAULT_RESOURCE_LOCATION_OVERRIDE: ResourceLocationOverride = {
  mode: "inherit",
  beaconNodeId: null,
  rssiThreshold: null,
};

export const shopLocationSettingsSchema = z.object({
  rssiThreshold: z.number().int().min(-100).max(-20).default(-75),
  resources: z.record(z.string(), resourceLocationOverrideSchema).default({}),
});
export type ShopLocationSettings = z.infer<typeof shopLocationSettingsSchema>;

export const DEFAULT_SHOP_LOCATION_SETTINGS: ShopLocationSettings = {
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
    .bind(
      shopId,
      LOCATION_SETTINGS_KEY,
      JSON.stringify({
        rssiThreshold: settings.rssiThreshold,
        resources: settings.resources,
      }),
      now.toISOString(),
    );
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
      beaconNodeId: override.mode === "require" ? (override.beaconNodeId ?? null) : null,
      rssiThreshold: override.mode === "require" ? (override.rssiThreshold ?? null) : null,
    };
  }
  return { ...settings, resources: nextResources };
}

export type EffectiveLocationPolicy = {
  mode: "none" | "gps" | "ble";
  /** Specific IoT node id to match when `mode === 'ble'`; null means any online shop beacon. */
  beaconNodeId: string | null;
  /** Minimum RSSI (dBm) for BLE matching; null falls back to beacon/shop default. */
  rssiThreshold: number | null;
};

/** Fast pre-check so read routes skip querying beacons when location is definitely off. */
export function isLocationCheckRequired(input: {
  shop: Pick<TenantShop, "checkin_geo" | "checkout_geo" | "machine_geo">;
  action: "checkin" | "checkout" | "machine";
  settings: ShopLocationSettings;
  deviceId?: string | null;
}): boolean {
  const { shop, action, settings, deviceId } = input;
  if (deviceId) {
    const override = resourceLocationOverrideOf(settings, deviceId);
    if (override.mode === "none") return false;
    if (override.mode === "require") return true;
  }
  return action === "checkin"
    ? !!shop.checkin_geo
    : action === "checkout"
      ? !!shop.checkout_geo
      : !!shop.machine_geo;
}

/**
 * Resolve the effective location policy for a shop-level or resource-level action.
 *
 * When verification is required:
 * 1. If the resource pins a beacon node that is currently online -> BLE (pinned node).
 * 2. Else if any enabled shop beacon is currently online -> BLE (any online shop beacon).
 * 3. Else -> GPS geofence fallback.
 */
export function resolveEffectiveLocationPolicy(input: {
  shop: Pick<TenantShop, "checkin_geo" | "checkout_geo" | "machine_geo">;
  action: "checkin" | "checkout" | "machine";
  settings: ShopLocationSettings;
  beacons?: ReadonlyArray<Pick<ShopBeaconEntry, "nodeId" | "online" | "rssiThreshold">>;
  deviceId?: string | null;
}): EffectiveLocationPolicy {
  const { shop, action, settings, beacons, deviceId } = input;
  if (!isLocationCheckRequired({ shop, action, settings, deviceId })) {
    return { mode: "none", beaconNodeId: null, rssiThreshold: null };
  }

  const override = deviceId ? resourceLocationOverrideOf(settings, deviceId) : null;
  const pinnedNodeId = override?.mode === "require" ? (override.beaconNodeId ?? null) : null;
  const rssiThreshold =
    override?.mode === "require"
      ? (override.rssiThreshold ?? settings.rssiThreshold)
      : settings.rssiThreshold;

  const onlineBeacons = (beacons ?? []).filter((b) => b.online);
  if (pinnedNodeId && onlineBeacons.some((b) => b.nodeId === pinnedNodeId)) {
    return { mode: "ble", beaconNodeId: pinnedNodeId, rssiThreshold };
  }
  if (onlineBeacons.length > 0) {
    return { mode: "ble", beaconNodeId: null, rssiThreshold };
  }
  return { mode: "gps", beaconNodeId: null, rssiThreshold: null };
}

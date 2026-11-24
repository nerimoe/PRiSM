import { z } from "zod";
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { TenantShop } from "../bindings.js";
import { jsonError } from "../http.js";
import {
  readShopLocationSettings,
  resolveEffectiveLocationPolicy,
  type EffectiveLocationPolicy,
} from "../resources/location.js";
import { listShopBeacons, type ShopBeaconEntry } from "../resources/nodes.js";

export type LocationCheck = {
  allowed: boolean;
  distanceMeters: number;
  allowedMeters: number;
  reason: "ok" | "low_accuracy" | "out_of_range";
};

export const coordinatesSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().min(0).max(10000),
});

export const beaconSightingSchema = z.object({
  beaconId: z.number().int().min(1).max(65535),
  rssi: z.number().finite().min(-127).max(20),
});

export const bleLocationSchema = z.object({
  beacons: z.array(beaconSightingSchema).max(64),
});

export function clampShopRadius(radius: number): number {
  if (!Number.isFinite(radius)) return 80;
  return Math.min(1000, Math.max(30, Math.round(radius)));
}

export function haversineMeters(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  const earthRadius = 6_371_000;
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const lat1 = toRadians(fromLat);
  const lat2 = toRadians(toLat);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function checkLocation(input: {
  userLat: number;
  userLng: number;
  accuracy: number;
  shopLat: number;
  shopLng: number;
  radiusMeters: number;
}): LocationCheck {
  if (input.accuracy > 250) {
    return {
      allowed: false,
      distanceMeters: Number.POSITIVE_INFINITY,
      allowedMeters: input.radiusMeters,
      reason: "low_accuracy",
    };
  }

  const distanceMeters = haversineMeters(
    input.userLat,
    input.userLng,
    input.shopLat,
    input.shopLng,
  );
  const allowedMeters =
    clampShopRadius(input.radiusMeters) + Math.min(input.accuracy, 200) + 30;

  return {
    allowed: distanceMeters <= allowedMeters,
    distanceMeters,
    allowedMeters,
    reason: distanceMeters <= allowedMeters ? "ok" : "out_of_range",
  };
}

export function checkBleBeacons(input: {
  sightings: ReadonlyArray<{ beaconId: number; rssi: number }>;
  beacons: ReadonlyArray<ShopBeaconEntry>;
  beaconNodeId: string | null;
  rssiThreshold: number | null;
}): { matched: boolean; configured: boolean } {
  const eligible = input.beaconNodeId
    ? input.beacons.filter((b) => b.nodeId === input.beaconNodeId)
    : input.beacons;
  if (!eligible.length) return { matched: false, configured: false };
  const matched = eligible.some((beacon) => {
    const threshold = input.rssiThreshold ?? beacon.rssiThreshold;
    return input.sightings.some((s) => s.beaconId === beacon.beaconId && s.rssi >= threshold);
  });
  return { matched, configured: true };
}

/**
 * Verify a player's location against an already-resolved effective policy
 * (`none`, `gps`, `ble`, or `any`).
 */
export function enforceLocationPolicy(input: {
  shop: TenantShop;
  action: "checkin" | "checkout" | "machine";
  policy: EffectiveLocationPolicy;
  beacons?: ReadonlyArray<ShopBeaconEntry>;
  location: unknown;
}): void {
  const { shop, action, policy, location } = input;
  if (policy.mode === "none") return;

  const gpsParsed = coordinatesSchema.safeParse(location);
  const bleParsed = bleLocationSchema.safeParse(location);

  if (policy.mode === "gps") {
    if (!gpsParsed.success) {
      jsonError(403, "此操作需要获取当前位置", "LOCATION_REQUIRED");
    }
    const coords = gpsParsed.data;
    const check = checkLocation({
      userLat: coords.lat,
      userLng: coords.lng,
      accuracy: coords.accuracy,
      shopLat: shop.latitude,
      shopLng: shop.longitude,
      radiusMeters: shop.radius_meters,
    });
    if (check.reason === "low_accuracy") {
      jsonError(403, "定位精度不足，请重试", "LOCATION_LOW_ACCURACY");
    }
    if (action === "checkout") {
      if (check.allowed) {
        jsonError(403, "请离开店铺定位范围后再结账", "LOCATION_STILL_INSIDE");
      }
    } else if (!check.allowed) {
      jsonError(403, "请到店后再操作", "LOCATION_OUT_OF_RANGE");
    }
    return;
  }

  if (policy.mode === "ble") {
    if (!bleParsed.success) {
      jsonError(403, "此操作需要扫描店内蓝牙信标", "LOCATION_REQUIRED");
    }
    const ble = checkBleBeacons({
      sightings: bleParsed.data.beacons,
      beacons: input.beacons ?? [],
      beaconNodeId: policy.beaconNodeId,
      rssiThreshold: policy.rssiThreshold,
    });
    if (action === "checkout") {
      if (ble.matched) {
        jsonError(403, "请离开店铺范围后再结账", "LOCATION_STILL_INSIDE");
      }
    } else if (!ble.matched) {
      jsonError(403, "未检测到附近的店铺蓝牙信标，请到店后再操作", "LOCATION_OUT_OF_RANGE");
    }
    return;
  }

  // `any`: GPS OR BLE beacon may satisfy the location check.
  if (!gpsParsed.success && !bleParsed.success) {
    jsonError(403, "此操作需要获取当前位置或扫描店内蓝牙信标", "LOCATION_REQUIRED");
  }

  const bleMatched = bleParsed.success
    ? checkBleBeacons({
        sightings: bleParsed.data.beacons,
        beacons: input.beacons ?? [],
        beaconNodeId: policy.beaconNodeId,
        rssiThreshold: policy.rssiThreshold,
      }).matched
    : null;

  const gpsCheck = gpsParsed.success
    ? checkLocation({
        userLat: gpsParsed.data.lat,
        userLng: gpsParsed.data.lng,
        accuracy: gpsParsed.data.accuracy,
        shopLat: shop.latitude,
        shopLng: shop.longitude,
        radiusMeters: shop.radius_meters,
      })
    : null;

  if (action === "checkout") {
    // Inside if either GPS says inside or BLE still sees a shop beacon.
    if (bleMatched === true) {
      jsonError(403, "请离开店铺范围后再结账", "LOCATION_STILL_INSIDE");
    }
    if (gpsCheck) {
      if (gpsCheck.reason === "low_accuracy" && bleMatched !== false) {
        jsonError(403, "定位精度不足，请重试", "LOCATION_LOW_ACCURACY");
      }
      if (gpsCheck.allowed) {
        jsonError(403, "请离开店铺定位范围后再结账", "LOCATION_STILL_INSIDE");
      }
    }
    return;
  }

  // checkin / machine: inside if EITHER BLE matches OR GPS is inside.
  if (bleMatched === true || gpsCheck?.allowed) return;
  if (gpsCheck?.reason === "low_accuracy" && !bleParsed.success) {
    jsonError(403, "定位精度不足，请重试", "LOCATION_LOW_ACCURACY");
  }
  jsonError(403, "请到店后再操作", "LOCATION_OUT_OF_RANGE");
}

/**
 * Synchronous GPS-only shop location check kept for callers without DB access
 * or unit tests exercising pure GPS geofencing.
 */
export function checkShopLocation(
  shop: TenantShop,
  action: "checkin" | "checkout" | "machine",
  location: unknown,
): void {
  const enabled = action === "checkin" ? shop.checkin_geo
    : action === "checkout" ? shop.checkout_geo
    : shop.machine_geo;
  if (!enabled) return;

  enforceLocationPolicy({
    shop,
    action,
    policy: { mode: "gps", beaconNodeId: null, rssiThreshold: null },
    location,
  });
}

/**
 * Full async location check that honors both shop-level GPS/BLE mode and
 * per-resource location overrides (`inherit` / `gps` / `ble` / `none`).
 */
export async function checkResourceLocation(input: {
  db: D1DatabaseLike;
  shop: TenantShop;
  action: "checkin" | "checkout" | "machine";
  deviceId?: string | null;
  location: unknown;
}): Promise<void> {
  const settings = await readShopLocationSettings(input.db, input.shop.id);
  const policy = resolveEffectiveLocationPolicy({
    shop: input.shop,
    action: input.action,
    settings,
    deviceId: input.deviceId,
  });
  if (policy.mode === "none") return;
  const beacons =
    policy.mode === "ble" || policy.mode === "any"
      ? await listShopBeacons(input.db, input.shop.id)
      : undefined;
  enforceLocationPolicy({
    shop: input.shop,
    action: input.action,
    policy,
    beacons,
    location: input.location,
  });
}

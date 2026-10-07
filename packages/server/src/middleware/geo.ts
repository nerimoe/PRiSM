import { z } from "zod";
import type { TenantShop } from "../bindings.js";
import { jsonError } from "../http.js";

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

export function checkShopLocation(
  shop: TenantShop,
  action: "checkin" | "checkout" | "machine",
  location: unknown,
): void {
  if (!(shop.checkin_geo || shop.checkout_geo || shop.machine_geo)) return;

  const result = coordinatesSchema.safeParse(location);
  if (!result.success) {
    jsonError(403, "此操作需要获取当前位置", "LOCATION_REQUIRED");
  }

  const coords = result.data;
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
}

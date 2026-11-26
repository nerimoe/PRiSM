import { createD1Executor, type D1DatabaseLike } from "@prism/adapter-d1";
import type { DeviceEvent, DeviceEventScope } from "@prism/core";
import { createDeviceEventRepository } from "@prism/storage-sql";
import { jsonError } from "../http.js";

export type OperationHistoryCategory = "all" | "checkout" | "session" | "wallet" | "redeem" | "device" | "shop";

const CATEGORY_NAMES: Record<Exclude<OperationHistoryCategory, "all" | "device">, readonly string[]> = {
  checkout: ["checkout.settled", "checkout.refused"],
  session: ["session.started", "session.stopped", "entry.refused", "seat.changed", "occupancy.started"],
  wallet: ["wallet.adjusted", "wallet.adjust.refused", "assets.adjusted"],
  redeem: ["gift.redeemed", "redeem.refused", "order.changed"],
  shop: ["player.changed", "shop.changed", "idle.settings.changed"],
};

const VALID_SCOPES = new Set<string>(["all", "non_resource", "resource"]);
const VALID_CATEGORIES = new Set<string>(["all", "checkout", "session", "wallet", "redeem", "device", "shop"]);

export type ShopOperationEventsQuery = {
  scope?: string;
  resourceId?: string;
  category?: string;
  capability?: string;
  playerId?: string;
  limit?: string | number;
  before?: string;
};

/** Clamp event page size query parameter to `[1, 200]`, defaulting to `50`. */
export function clampEventLimit(raw: string | number | undefined): number {
  const parsed = Number(raw ?? 50);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(Math.min(Math.max(parsed, 1), 200)) : 50;
}

/** Query shop-wide operation history with validated scope, category, resource, player, and cursor filters. */
export async function listShopOperationEvents(
  db: D1DatabaseLike,
  shopId: string,
  query: ShopOperationEventsQuery,
) {
  const scope = (query.scope?.trim() || "all") as DeviceEventScope;
  if (!VALID_SCOPES.has(scope)) {
    jsonError(400, "无效的记录范围筛选", "INVALID_FILTER");
  }
  const category = (query.category?.trim() || "all") as OperationHistoryCategory;
  if (!VALID_CATEGORIES.has(category)) {
    jsonError(400, "无效的记录分类筛选", "INVALID_FILTER");
  }
  const resourceId = query.resourceId?.trim() || undefined;
  if (scope === "non_resource" && resourceId) {
    jsonError(400, "非资源筛选不能同时指定资源", "INVALID_FILTER");
  }
  const before = query.before?.trim() || undefined;
  if (before && before.length > 200) {
    jsonError(400, "无效的记录游标", "INVALID_CURSOR");
  }
  const limit = clampEventLimit(query.limit);
  const capability = query.capability?.trim() || undefined;
  const playerId = query.playerId?.trim() || undefined;

  const events = await createDeviceEventRepository(createD1Executor(db, shopId)).listShopEvents!({
    scope,
    ...(resourceId ? { deviceId: resourceId } : {}),
    ...(capability ? { capability } : {}),
    ...(playerId ? { playerId } : {}),
    ...(category === "device"
      ? { excludeCapabilities: ["shop", "occupancy"] }
      : category !== "all"
        ? { names: CATEGORY_NAMES[category] }
        : {}),
    limit: limit + 1,
    ...(before ? { before } : {}),
  });

  return presentOperationEvents(db, shopId, events, limit);
}

/**
 * Format events for merchant UI/API: resolve resource, player, and staff names
 * in batch. When `currentDeviceId` is provided (per-resource history), events
 * targeting that resource omit `device` to keep the historical contract.
 */
export async function presentOperationEvents(
  db: D1DatabaseLike,
  shopId: string,
  events: readonly DeviceEvent[],
  limit: number,
  currentDeviceId?: string,
) {
  const page = events.slice(0, limit);
  const resourceIds = [...new Set(
    page
      .flatMap((event) => [event.deviceId, event.via?.resourceId ?? null])
      .filter((id): id is string => !!id && id !== currentDeviceId),
  )];
  const names = new Map(
    resourceIds.length
      ? (await db
          .prepare("SELECT id, name FROM machines WHERE shop_id=? AND id IN (SELECT value FROM json_each(?))")
          .bind(shopId, JSON.stringify(resourceIds))
          .all<{ id: string; name: string }>())
          .results.map((row) => [row.id, row.name])
      : [],
  );
  const named = (id: string | null | undefined) =>
    id && id !== currentDeviceId ? { id, name: names.get(id) ?? null } : null;

  const playerOf = (event: DeviceEvent) =>
    event.playerId ?? (typeof event.payload.forPlayerId === "string" ? event.payload.forPlayerId : null);
  const playerIds = [...new Set(page.map(playerOf).filter((id): id is string => !!id))];
  const players = new Map(
    playerIds.length
      ? (await db
          .prepare("SELECT id, display_name FROM players WHERE shop_id=? AND id IN (SELECT value FROM json_each(?))")
          .bind(shopId, JSON.stringify(playerIds))
          .all<{ id: string; display_name: string | null }>())
          .results.map((row) => [row.id, row.display_name])
      : [],
  );

  const staffIds = [...new Set(page.map((event) => event.staffId).filter((id): id is string => !!id))];
  const staffNames = new Map<string, string | null>();
  if (staffIds.length) {
    // Device actions recorded by web staff use `user:<userId>` while shop facts use `staffId`
    // (often `account:<userId>` or a staff_users.id). Resolve both gracefully.
    const lookupIds = [
      ...new Set(
        staffIds.flatMap((id) => (id.startsWith("user:") ? [id, `account:${id.slice(5)}`] : [id])),
      ),
    ];
    const staffRows = await db
      .prepare("SELECT id, display_name FROM staff_users WHERE shop_id=? AND id IN (SELECT value FROM json_each(?))")
      .bind(shopId, JSON.stringify(lookupIds))
      .all<{ id: string; display_name: string | null }>()
      .catch(() => ({ results: [] as { id: string; display_name: string | null }[] }));
    const byLookup = new Map(staffRows.results.map((row) => [row.id, row.display_name]));
    for (const id of staffIds) {
      const resolved = byLookup.get(id) ?? (id.startsWith("user:") ? byLookup.get(`account:${id.slice(5)}`) : undefined);
      if (resolved !== undefined) staffNames.set(id, resolved);
    }
  }

  return {
    nextCursor: events.length > limit ? page.at(-1)!.id : null,
    events: page.map((event) => {
      const playerId = playerOf(event);
      return {
        id: event.id,
        device: named(event.deviceId),
        player: playerId ? { id: playerId, name: players.get(playerId) ?? null } : null,
        staff: event.staffId ? { id: event.staffId, name: staffNames.get(event.staffId) ?? null } : null,
        via: event.via ? { channel: event.via.channel, resource: named(event.via.resourceId) } : null,
        capability: event.capability,
        kind: event.kind,
        name: event.name,
        origin: event.origin,
        operationId: event.operationId,
        parentOperationId: event.parentOperationId,
        at: event.occurredAt.toISOString(),
        payload: event.payload,
      };
    }),
  };
}

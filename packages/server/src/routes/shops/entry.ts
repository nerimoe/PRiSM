import { withOperationLease } from "@prism/application";
import type { PrismAppDependencies, TenantShop } from "../../bindings.js";
import { isEntry } from "../../middleware/tenant.js";

/** Preserve the original entry operation and its per-player idempotent lease.
 * Every channel creating an ordinary visit must use the same shop pricing rules.
 * Integration requests containing specialist rule ids can still start a specialist
 * session without changing entry behaviour.
 */
export async function startEntrySession(
  shop: TenantShop,
  deps: PrismAppDependencies,
  playerId: string,
  metadata?: Record<string, unknown>,
) {
  const rules = JSON.parse(shop.entry_pricing_ids_json || "[]") as string[];
  return withOperationLease(
    {
      repository: deps.repositories.operationLocks,
      scope: "player.entry",
      resourceId: playerId,
      now: () => new Date(),
    },
    async () => {
      const active = (await deps.repositories.sessions.findActiveByPlayerId(playerId))
        .find((session) => isEntry(session, shop));
      if (active) return { ...active, status: "active" as const };
      return deps.playerCommands.startSession({
        playerId,
        pricingConfigIds: rules,
        label: "entry",
        ...(metadata ? { metadata } : {}),
      });
    },
  );
}

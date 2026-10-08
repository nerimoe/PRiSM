import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";
import { playerRouter } from "../../routes/shops/player.js";

export const legacyPlayerRouter = new Hono<AppBindings>();

// Compatibility layer: If legacy caller sends X-PRiSM-Player-Id without user auth session,
// resolve or synthesize the user context so requireShopPlayer can authorize.
legacyPlayerRouter.use("*", async (c, next) => {
  if (!c.get("user")) {
    const playerId = c.req.header("X-PRiSM-Player-Id");
    if (playerId) {
      const shop = c.get("shop");
      if (shop) {
        const account = await c.env.DB.prepare(
          "SELECT user_id FROM shop_player_accounts WHERE shop_id = ? AND player_id = ?",
        )
          .bind(shop.id, playerId)
          .first<{ user_id: string }>();

        const userId = account?.user_id ?? `legacy_${playerId}`;
        c.set("user", {
          id: userId,
          username: playerId,
          displayName: playerId,
          role: "user",
          bannedAt: null,
        });
      }
    }
  }
  await next();
});

// Mount the canonical player router for all player endpoints
legacyPlayerRouter.route("/", playerRouter);

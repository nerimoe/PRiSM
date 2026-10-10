import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { sha256Hex } from "../../crypto.js";
import { jsonError } from "../../http.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import { toPlayerManagementView } from "../../routes/shops/views.js";

/** The standalone bot identity lookup requires an integration token, not a platform user session. */
export const legacyBotRouter = new Hono<AppBindings>();

legacyBotRouter.post("/identities/resolve", async (c) => {
  const shop = getShop(c);
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) jsonError(403, "Bot principal required.", "FORBIDDEN");
  const credential = await c.env.DB.prepare(
    "SELECT id FROM api_tokens WHERE shop_id=? AND token_hash=? AND role='integration' AND status='active'",
  ).bind(shop.id, await sha256Hex(bearer)).first();
  if (!credential) jsonError(403, "Bot principal required.", "FORBIDDEN");
  const body = z.object({
    provider: z.string().trim().min(1),
    subject: z.string().trim().min(1),
  }).parse(await c.req.json());
  const player = await getShopDeps(c).staffPlayerCommands.resolvePlayerIdentity(body);
  if (!player) jsonError(404, "Player identity was not found.", "PLAYER_IDENTITY_NOT_FOUND");
  return c.json({ player: toPlayerManagementView(player) });
});

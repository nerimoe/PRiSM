import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { sha256 } from "../../crypto.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";

export const legacyAdminRouter = new Hono<AppBindings>();
export const legacyPlayerAuthRouter = new Hono<AppBindings>();

legacyAdminRouter.post("/login", async (c) => {
  const body = z.object({ username: z.string(), password: z.string() }).parse(await c.req.json());
  const result = await getShopDeps(c).setupCommands.login(body);
  return c.json({ session: { token: result.token }, staff: result.staff });
});

legacyAdminRouter.post("/logout", async (c) => {
  const token = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) jsonError(403, "Staff principal required.", "FORBIDDEN");
  const system = getShopDeps(c).repositories.system;
  const session = await system.findAdminSessionByTokenHash(await sha256(token));
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    jsonError(403, "Staff principal required.", "FORBIDDEN");
  }
  await system.revokeAdminSession(session.id);
  return c.body(null, 204);
});

legacyPlayerAuthRouter.post("/login/by-identity", async (c) => {
  const token = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const system = getShopDeps(c).repositories.system;
  const integration = token && (await system.findActiveApiTokenByHash(await sha256(token)))?.role === "integration";
  if (!integration) {
    const principal = await staffPrincipal(c, getShop(c));
    if (principal.staffRole === "viewer") jsonError(403, "Trusted identity verification required.", "FORBIDDEN");
  }
  const body = z.object({
    identity: z.object({ provider: z.string(), subject: z.string() }).optional(),
    identityKey: z.string().optional(),
  }).parse(await c.req.json());
  const result = await getShopDeps(c).playerAuthCommands.loginByIdentity(body);
  return c.json({
    session: { token: result.token },
    player: { id: result.player.id, displayName: result.player.displayName, status: result.player.status },
  });
});

import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, AuthUser } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { passkeyNameSchema } from "./passkeys.js";

export function publicUser(user: AuthUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  };
}

export const userRouter = new Hono<AppBindings>();

// User profile and store ownership flag
userRouter.get("/me", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ user: null });
  const hasShops =
    user.role === "admin" ||
    Boolean(
      await c.env.DB.prepare(
        "SELECT 1 FROM shop_members WHERE user_id = ? LIMIT 1",
      )
        .bind(user.id)
        .first(),
    );
  return c.json({ user: { ...publicUser(user), hasShops } });
});

userRouter.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ user: null });
  const hasShops =
    user.role === "admin" ||
    Boolean(
      await c.env.DB.prepare(
        "SELECT 1 FROM shop_members WHERE user_id = ? LIMIT 1",
      )
        .bind(user.id)
        .first(),
    );
  return c.json({ user: { ...publicUser(user), hasShops } });
});

// Identities and passkeys overview
userRouter.get("/account", async (c) => {
  const user = requireUser(c);
  const [identities, passkeys] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, provider, username, display_name AS displayName, created_at AS createdAt,
              last_login_at AS lastLoginAt
       FROM auth_identities WHERE user_id = ? ORDER BY created_at ASC`,
    )
      .bind(user.id)
      .all(),
    c.env.DB.prepare(
      `SELECT id, name, device_type AS deviceType, backed_up AS backedUp,
              provider_name AS providerName, created_at AS createdAt, last_used_at AS lastUsedAt
       FROM passkeys WHERE user_id = ? ORDER BY created_at DESC`,
    )
      .bind(user.id)
      .all(),
  ]);
  return c.json({ identities: identities.results, passkeys: passkeys.results });
});

// Passkey removal
userRouter.delete("/account/passkeys/:id", async (c) => {
  const user = requireUser(c);
  await c.env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), user.id)
    .run();
  return c.json({ ok: true });
});

userRouter.delete("/passkeys/:id", async (c) => {
  const user = requireUser(c);
  await c.env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), user.id)
    .run();
  return c.json({ ok: true });
});

// Passkey renaming
userRouter.patch("/account/passkeys/:id", async (c) => {
  const user = requireUser(c);
  const body = passkeyNameSchema.parse(await c.req.json());
  const result = (await c.env.DB.prepare(
    "UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?",
  )
    .bind(body.name, c.req.param("id"), user.id)
    .run()) as { meta?: { changes?: number } } | undefined;
  if (result?.meta?.changes === 0) {
    jsonError(404, "没有找到这个 Passkey", "PASSKEY_NOT_FOUND");
  }
  return c.json({ ok: true });
});

userRouter.patch("/passkeys/:id", async (c) => {
  const user = requireUser(c);
  const body = passkeyNameSchema.parse(await c.req.json());
  const result = (await c.env.DB.prepare(
    "UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?",
  )
    .bind(body.name, c.req.param("id"), user.id)
    .run()) as { meta?: { changes?: number } } | undefined;
  if (result?.meta?.changes === 0) {
    jsonError(404, "没有找到这个 Passkey", "PASSKEY_NOT_FOUND");
  }
  return c.json({ ok: true });
});


// Store memberships and Live Activity start-token registration are platform-user routes.
userRouter.get("/me/shops", async (c) => {
  const user = requireUser(c);
  const shops = await c.env.DB.prepare(
    `SELECT s.public_id AS publicId,s.name,COUNT(active.id) AS activeSessions
    FROM shop_player_accounts a JOIN shops s ON s.id=a.shop_id
    LEFT JOIN sessions active ON active.shop_id=a.shop_id AND active.player_id=a.player_id AND active.status='active'
    WHERE a.user_id=? GROUP BY s.id ORDER BY activeSessions DESC,s.name`,
  ).bind(user.id).all();
  return c.json({ shops: shops.results });
});

const knownLiveActivityBundles = new Set(["moe.neri.hinatago", "moe.neri.hinatago.prism"]);

userRouter.post("/me/live-activity/start-token", async (c) => {
  const user = requireUser(c);
  const body = z.object({
    clientId: z.string().min(1).max(200),
    token: z.string().regex(/^[0-9a-fA-F]{32,200}$/),
    environment: z.enum(["sandbox", "production"]),
    bundleId: z.string().min(1).max(200),
  }).parse(await c.req.json());
  if (!knownLiveActivityBundles.has(body.bundleId)) {
    jsonError(400, "未知的应用标识", "INVALID_BUNDLE_ID");
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO live_activity_start_tokens
      (id, user_id, client_id, bundle_id, environment, token, created_at, updated_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, client_id) DO UPDATE SET
       token=excluded.token, environment=excluded.environment, bundle_id=excluded.bundle_id,
       updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at`,
  ).bind(crypto.randomUUID(), user.id, body.clientId, body.bundleId, body.environment,
    body.token.toLowerCase(), now, now, now).run();
  return c.json({ ok: true });
});

userRouter.delete("/me/live-activity/start-token/:clientId?", async (c) => {
  const user = requireUser(c);
  const body = await c.req.json<{ clientId?: string }>().catch(() => ({}));
  const clientId = (c.req.param("clientId") ?? body.clientId ?? c.req.query("clientId"))?.trim();
  if (clientId) {
    await c.env.DB.prepare(
      "DELETE FROM live_activity_start_tokens WHERE user_id=? AND client_id=?",
    ).bind(user.id, clientId).run();
  } else {
    await c.env.DB.prepare(
      "DELETE FROM live_activity_start_tokens WHERE user_id=?",
    ).bind(user.id).run();
  }
  return c.json({ ok: true });
});

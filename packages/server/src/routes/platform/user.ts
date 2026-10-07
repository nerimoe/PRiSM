import { Hono } from "hono";
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

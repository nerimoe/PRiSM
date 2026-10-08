import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, AuthUser } from "../../bindings.js";
import { jsonError, nowIso } from "../../http.js";
import { createSession, destroySession } from "../../middleware/auth.js";
import { passkeysRouter } from "./passkeys.js";

export const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1, "用户名不能为空")
    .max(64, "用户名最长64个字符"),
  displayName: z
    .string()
    .trim()
    .max(64, "昵称最长64个字符")
    .optional(),
});

export const loginSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1, "用户名不能为空")
    .max(64, "用户名最长64个字符"),
});

export const authRouter = new Hono<AppBindings>();

// Mount passkey sub-router under /passkey
authRouter.route("/passkey", passkeysRouter);

// Session termination
authRouter.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

// Standard user registration
authRouter.post("/register", async (c) => {
  const body = registerSchema.parse(await c.req.json());
  const existing = await c.env.DB.prepare(
    "SELECT id FROM auth_identities WHERE provider = 'local' AND provider_subject = ?",
  )
    .bind(body.username)
    .first<{ id: string }>();

  if (existing) {
    jsonError(409, "该用户名已被注册", "USER_ALREADY_EXISTS");
  }

  const userId = crypto.randomUUID();
  const identityId = crypto.randomUUID();
  const displayName = body.displayName || body.username;
  const now = nowIso();

  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', ?, ?)",
    ).bind(userId, now, now),
    c.env.DB.prepare(
      `INSERT INTO auth_identities
         (id, user_id, provider, provider_subject, username, display_name, created_at, updated_at, last_login_at)
       VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?)`,
    ).bind(identityId, userId, body.username, body.username, displayName, now, now, now),
  ]);

  await createSession(c, userId);
  return c.json(
    {
      ok: true,
      user: {
        id: userId,
        username: body.username,
        displayName,
        role: "user" as const,
      },
    },
    201,
  );
});

// Standard user login
authRouter.post("/login", async (c) => {
  const body = loginSchema.parse(await c.req.json());
  const row = await c.env.DB.prepare(
    `SELECT users.id, identities.username, identities.display_name, users.role, users.banned_at
     FROM auth_identities AS identities
     JOIN users ON users.id = identities.user_id
     WHERE identities.provider = 'local' AND identities.provider_subject = ?`,
  )
    .bind(body.username)
    .first<{
      id: string;
      username: string;
      display_name: string;
      role: AuthUser["role"];
      banned_at: string | null;
    }>();

  if (!row) {
    jsonError(401, "用户不存在或用户名错误", "USER_NOT_FOUND");
  }

  if (row.banned_at) {
    jsonError(403, "这个账号暂时无法使用", "FORBIDDEN");
  }

  await c.env.DB.prepare(
    "UPDATE auth_identities SET last_login_at = ? WHERE provider = 'local' AND provider_subject = ?",
  )
    .bind(nowIso(), body.username)
    .run();

  await createSession(c, row.id);
  return c.json({
    ok: true,
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
    },
  });
});

// Current user inspection
authRouter.get("/me", async (c) => {
  const user = c.get("user");
  return c.json({ user });
});

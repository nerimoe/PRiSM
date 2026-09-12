import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings, AuthUser } from "./types";
import { addDays, jsonError, nowIso } from "./http";
import { randomToken, sha256 } from "./crypto";

const cookieName = "arcadelink_session";
const sessionDays = 30;

export const attachUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const token = getCookie(c, cookieName);
  if (!token) {
    c.set("user", null);
    c.set("sessionId", null);
    await next();
    return;
  }

  const tokenHash = await sha256(token);
  const row = await c.env.DB.prepare(
    `SELECT sessions.id AS session_id, users.id, identities.username, identities.display_name,
            users.role, users.banned_at
     FROM auth_sessions AS sessions
     JOIN users ON users.id = sessions.user_id
     JOIN auth_identities AS identities ON identities.user_id = users.id AND identities.provider = 'munet'
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  )
    .bind(tokenHash, nowIso())
    .first<{
      session_id: string;
      id: string;
      username: string;
      display_name: string;
      role: AuthUser["role"];
      banned_at: string | null;
    }>();

  if (!row) {
    deleteSessionCookie(c);
    c.set("user", null);
    c.set("sessionId", null);
    await next();
    return;
  }

  c.set("sessionId", row.session_id);
  c.set("user", {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    bannedAt: row.banned_at,
  });
  await next();
};

export function requireUser(c: Context<AppBindings>): AuthUser {
  const user = c.get("user");
  if (!user) jsonError(401, "请先登录");
  if (user.bannedAt) jsonError(403, "这个账号暂时无法使用");
  return user;
}

export function requireAdmin(c: Context<AppBindings>): AuthUser {
  const user = requireUser(c);
  if (user.role !== "admin") jsonError(403, "你没有管理权限");
  return user;
}

export async function createSession(c: Context<AppBindings>, userId: string): Promise<void> {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = addDays(new Date(), sessionDays).toISOString();
  await c.env.DB.prepare("INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, tokenHash, expiresAt)
    .run();
  setCookie(c, cookieName, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: sessionDays * 24 * 60 * 60,
  });
}

export async function destroySession(c: Context<AppBindings>): Promise<void> {
  const sessionId = c.get("sessionId");
  if (sessionId) await c.env.DB.prepare("DELETE FROM auth_sessions WHERE id = ?").bind(sessionId).run();
  deleteSessionCookie(c);
}

function deleteSessionCookie(c: Context<AppBindings>): void {
  deleteCookie(c, cookieName, { path: "/" });
}

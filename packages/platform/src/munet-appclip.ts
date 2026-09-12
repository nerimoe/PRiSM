import type { Context } from "hono";
import { randomToken } from "./crypto";
import { jsonError, nowIso } from "./http";
import { munetCardStatements, munetCredentialStatement } from "./oauth";
import type { MunetCard, MunetTokens } from "./munet";
import type { AppBindings } from "./types";

export const appClipAuthCallbackScheme = "hinata-arcadelink-auth";
export const appClipAuthCallbackURL = `${appClipAuthCallbackScheme}://callback`;
export const appClipAuthStatePurpose = "appclip-munet-state";
export const appClipAuthCodePurpose = "appclip-munet-code";
export const appClipAuthStateTtlSeconds = 600;
export const appClipAuthCodeTtlSeconds = 60;

export type MunetProfile = {
  subject: string;
  name: string;
  username: string;
  cards: MunetCard[];
  tokens: MunetTokens;
};

export type ProvisionedMunetUser = {
  userId: string;
  isNewUser: boolean;
};

export function appClipAuthCallbackURLWithParams(params: Record<string, string>): string {
  const url = new URL(appClipAuthCallbackURL);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

export async function createAppClipAuthState(c: Context<AppBindings>, state: string): Promise<void> {
  await saveChallenge(c, state, null, appClipAuthStatePurpose, "native-munet", appClipAuthStateTtlSeconds);
}

export async function consumeAppClipAuthState(c: Context<AppBindings>, state: string): Promise<boolean> {
  const row = await c.env.DB.prepare(
    "DELETE FROM auth_challenges WHERE id = ? AND purpose = ? AND expires_at > ? RETURNING id",
  )
    .bind(state, appClipAuthStatePurpose, nowIso())
    .first<{ id: string }>();
  return Boolean(row);
}

export async function createAppClipAuthCode(c: Context<AppBindings>, userId: string): Promise<string> {
  const code = randomToken(24);
  await saveChallenge(c, code, userId, appClipAuthCodePurpose, "native-munet", appClipAuthCodeTtlSeconds);
  return code;
}

export async function consumeAppClipAuthCode(c: Context<AppBindings>, code: string): Promise<string> {
  const row = await c.env.DB.prepare(
    "DELETE FROM auth_challenges WHERE id = ? AND purpose = ? AND expires_at > ? RETURNING user_id",
  )
    .bind(code, appClipAuthCodePurpose, nowIso())
    .first<{ user_id: string }>();
  if (!row?.user_id) jsonError(400, "授权码已失效，请重新登录");
  return row.user_id;
}

export async function provisionMunetUser(
  c: Context<AppBindings>,
  munet: MunetProfile,
): Promise<ProvisionedMunetUser> {
  const identity = await c.env.DB.prepare(
    `SELECT users.id, users.banned_at AS bannedAt, identities.id AS identityId
     FROM auth_identities AS identities
     JOIN users ON users.id = identities.user_id
     WHERE identities.provider = 'munet' AND identities.provider_subject = ?`,
  )
    .bind(munet.subject)
    .first<{ id: string; bannedAt: string | null; identityId: string }>();
  if (identity?.bannedAt) throw new Error("这个账号暂时无法使用");

  const userId = identity?.id ?? crypto.randomUUID();
  const identityId = identity?.identityId ?? crypto.randomUUID();
  const isNewUser = !identity;
  const statements: D1PreparedStatement[] = [];
  if (identity) {
    statements.push(
      c.env.DB.prepare(
        `UPDATE auth_identities SET username = ?, display_name = ?, last_login_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
         WHERE provider = 'munet' AND provider_subject = ?`,
      ).bind(munet.username, munet.name, munet.subject),
    );
  } else {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO users (id, role)
         SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'user' ELSE 'admin' END`,
      ).bind(userId),
      c.env.DB.prepare(
        `INSERT INTO auth_identities
           (id, user_id, provider, provider_subject, username, display_name, last_login_at)
         VALUES (?, ?, 'munet', ?, ?, ?, CURRENT_TIMESTAMP)`,
      ).bind(identityId, userId, munet.subject, munet.username, munet.name),
    );
  }
  statements.push(
    await munetCredentialStatement(c, identityId, munet.tokens),
    ...(isNewUser ? munetCardStatements(c.env.DB, userId, munet.cards) : []),
  );
  await c.env.DB.batch(statements);
  return { userId, isNewUser };
}

async function saveChallenge(
  c: Context<AppBindings>,
  id: string,
  userId: string | null,
  purpose: string,
  challenge: string,
  ttlSeconds: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(nowIso()),
    c.env.DB.prepare(
      "INSERT INTO auth_challenges (id, user_id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, userId, purpose, challenge, expiresAt),
  ]);
}

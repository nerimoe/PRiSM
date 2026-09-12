import type { Context } from "hono";
import { decryptSecret, encryptSecret } from "./crypto";
import {
  fetchMunetCards,
  MunetAuthorizationExpiredError,
  refreshMunetTokens,
  type MunetCard,
  type MunetTokens,
} from "./munet";
import type { AppBindings } from "./types";

type CredentialRow = {
  identity_id: string;
  access_token_encrypted: string;
  access_token_expires_at: string;
  refresh_token_encrypted: string;
};

export type MunetSyncResult = {
  authorizationRequired: boolean;
  synced: boolean;
};

export async function munetCredentialStatement(
  c: Context<AppBindings>,
  identityId: string,
  tokens: MunetTokens,
  cardsSynced = true,
): Promise<D1PreparedStatement> {
  const secret = oauthSecret(c);
  const [accessToken, refreshToken] = await Promise.all([
    encryptSecret(tokens.accessToken, secret),
    encryptSecret(tokens.refreshToken, secret),
  ]);
  return c.env.DB.prepare(
    `INSERT INTO oauth_credentials
       (identity_id, access_token_encrypted, access_token_expires_at, refresh_token_encrypted, last_cards_sync_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(identity_id) DO UPDATE SET
       access_token_encrypted = excluded.access_token_encrypted,
       access_token_expires_at = excluded.access_token_expires_at,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       last_cards_sync_at = COALESCE(excluded.last_cards_sync_at, oauth_credentials.last_cards_sync_at),
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(
    identityId,
    accessToken,
    expiresAt(tokens.expiresIn),
    refreshToken,
    cardsSynced ? new Date().toISOString() : null,
  );
}

export function munetCardStatements(
  db: D1Database,
  userId: string,
  cards: MunetCard[],
): D1PreparedStatement[] {
  const statements = [
    db.prepare(
      "UPDATE cards SET disabled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND source = 'munet'",
    ).bind(userId),
  ];
  for (const card of cards) {
    statements.push(
      db.prepare(
        `INSERT INTO cards (id, user_id, label, card_type, access_code, source)
         VALUES (?, ?, ?, 'aime', ?, 'munet')
         ON CONFLICT(user_id, access_code) DO UPDATE SET
           label = excluded.label, source = 'munet', disabled_at = NULL, updated_at = CURRENT_TIMESTAMP`,
      ).bind(crypto.randomUUID(), userId, card.remark?.trim() || "MuNET 卡片", card.luid),
    );
  }
  return statements;
}

export async function syncMunetCards(
  c: Context<AppBindings>,
  userId: string,
  retryAfterRotation = true,
): Promise<MunetSyncResult> {
  const credential = await c.env.DB.prepare(
    `SELECT credentials.identity_id, credentials.access_token_encrypted,
            credentials.access_token_expires_at, credentials.refresh_token_encrypted
     FROM oauth_credentials AS credentials
     JOIN auth_identities AS identities ON identities.id = credentials.identity_id
     WHERE identities.user_id = ? AND identities.provider = 'munet'`,
  ).bind(userId).first<CredentialRow>();
  if (!credential) return { authorizationRequired: true, synced: false };

  try {
    const secret = oauthSecret(c);
    let accessToken = await decryptSecret(credential.access_token_encrypted, secret);
    let refreshedAccessToken = false;

    if (Date.parse(credential.access_token_expires_at) <= Date.now() + 30_000) {
      const refreshToken = await decryptSecret(credential.refresh_token_encrypted, secret);
      const refreshed = await refreshMunetTokens({
        clientId: c.env.MUNET_CLIENT_ID,
        clientSecret: c.env.MUNET_CLIENT_SECRET,
        refreshToken,
      });
      accessToken = refreshed.accessToken;
      await (await munetCredentialStatement(c, credential.identity_id, {
        accessToken,
        expiresIn: refreshed.expiresIn,
        refreshToken: refreshed.refreshToken ?? refreshToken,
      }, false)).run();
      refreshedAccessToken = true;
    }

    let cards: MunetCard[];
    try {
      cards = await fetchMunetCards(accessToken);
    } catch (error) {
      if (!(error instanceof MunetAuthorizationExpiredError) || refreshedAccessToken) throw error;
      const refreshToken = await decryptSecret(credential.refresh_token_encrypted, secret);
      const refreshed = await refreshMunetTokens({
        clientId: c.env.MUNET_CLIENT_ID,
        clientSecret: c.env.MUNET_CLIENT_SECRET,
        refreshToken,
      });
      accessToken = refreshed.accessToken;
      await (await munetCredentialStatement(c, credential.identity_id, {
        accessToken,
        expiresIn: refreshed.expiresIn,
        refreshToken: refreshed.refreshToken ?? refreshToken,
      }, false)).run();
      cards = await fetchMunetCards(accessToken);
    }

    await c.env.DB.batch([
      ...munetCardStatements(c.env.DB, userId, cards),
      c.env.DB.prepare(
        "UPDATE oauth_credentials SET last_cards_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE identity_id = ?",
      ).bind(credential.identity_id),
    ]);
    return { authorizationRequired: false, synced: true };
  } catch (error) {
    if (!(error instanceof MunetAuthorizationExpiredError)) throw error;
    const deleted = await c.env.DB.prepare(
      "DELETE FROM oauth_credentials WHERE identity_id = ? AND refresh_token_encrypted = ?",
    )
      .bind(credential.identity_id, credential.refresh_token_encrypted)
      .run();
    if (deleted.meta.changes === 0 && retryAfterRotation) {
      return syncMunetCards(c, userId, false);
    }
    return { authorizationRequired: true, synced: false };
  }
}

function oauthSecret(c: Context<AppBindings>): string {
  return `${c.env.URL_ENCRYPTION_KEY}:oauth-token`;
}

function expiresAt(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

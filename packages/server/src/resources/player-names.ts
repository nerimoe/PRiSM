/**
 * What chat platforms call a shop's players.
 *
 * Each platform's name stays on its own identity (`player_identities.display_name`),
 * so a player bound on two platforms is never renamed back and forth: a bot
 * speaks of them by the name on its own platform. The player's own name is
 * filled from an identity only while it is still a stand-in (an imported
 * "Player 75", `isPlaceholderPlayerName`); after that it is the shop's or the
 * player's, and no chat changes it.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { chatName } from "@prism/core";
import { logger } from "../log.js";

const log = logger("player-names");

export type ChatName = { provider: string; subject: string; name: string };

/** At most this many names are taken from one report; a bot sends a large group in several. */
export const CHAT_NAMES_PER_REPORT = 500;

/** The names in a bot's report that can be kept: well formed, one per identity. */
export function chatNames(value: unknown): ChatName[] {
  if (!Array.isArray(value)) return [];
  const seen = new Map<string, ChatName>();
  for (const raw of value.slice(0, CHAT_NAMES_PER_REPORT)) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const provider = typeof record.provider === "string" ? record.provider.trim().toLowerCase() : "";
    const subject = typeof record.subject === "string" ? record.subject.trim() : "";
    const name = chatName(record.name);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider) || !subject || subject.length > 256 || !name) continue;
    seen.set(`${provider}\u0000${subject}`, { provider, subject, name });
  }
  return [...seen.values()];
}

/**
 * Keep what the chat calls these people, on the shop's identities that are
 * theirs (anyone the shop does not know is left out), and give a player with
 * a stand-in name the name of their earliest bound identity that has one.
 * Returns how many identities' names changed.
 */
export async function recordChatNames(db: D1DatabaseLike, shopId: string, names: readonly ChatName[]): Promise<number> {
  if (!names.length) return 0;
  const list = JSON.stringify(names);
  const named = `(SELECT json_extract(n.value, '$.name') FROM json_each(?) n
    WHERE json_extract(n.value, '$.provider') = player_identities.provider
      AND json_extract(n.value, '$.subject') = player_identities.subject)`;
  const results = (await db.batch([
    db.prepare(
      `UPDATE player_identities SET display_name = ${named}
       WHERE shop_id = ? AND ${named} IS NOT NULL
         AND display_name IS NOT ${named}`,
    ).bind(list, shopId, list, list),
    // A stand-in name: empty, generic, an imported "Player 75", or the chat id it was registered under.
    db.prepare(
      `UPDATE players SET display_name = (
         SELECT i.display_name FROM player_identities i
         WHERE i.shop_id = players.shop_id AND i.player_id = players.id AND i.display_name IS NOT NULL
         ORDER BY i.created_at, i.provider, i.subject LIMIT 1)
       WHERE shop_id = ?
         AND EXISTS (SELECT 1 FROM player_identities i WHERE i.shop_id = players.shop_id AND i.player_id = players.id AND i.display_name IS NOT NULL)
         AND (COALESCE(TRIM(display_name), '') IN ('', '玩家', '用户')
           OR display_name GLOB 'Player [0-9]*'
           OR EXISTS (SELECT 1 FROM player_identities i WHERE i.shop_id = players.shop_id AND i.player_id = players.id
             AND players.display_name IN (i.subject, i.provider || ':' || i.subject, i.provider || ' ' || i.subject)))`,
    ).bind(shopId),
  ])) as Array<{ meta?: { changes?: number } }>;
  const changed = results[0]?.meta?.changes ?? 0;
  if (changed) log.info(`kept ${changed} chat name(s) of ${names.length} reported`, { shopId, reported: names.length, changed });
  return changed;
}

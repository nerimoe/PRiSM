import type { D1DatabaseLike } from "@prism/adapter-d1";

type PlayerWithIdentities = {
  id?: string;
  playerId?: string;
  identities?: Array<{
    provider: string;
    subject: string;
    displayName?: string;
  }>;
};

/** Account membership is authoritative; older bindings need no backfill to appear. */
export async function withPrismAccountIdentities(
  db: D1DatabaseLike,
  shopId: string,
  data: unknown,
): Promise<unknown> {
  if (
    !data ||
    typeof data !== "object" ||
    !("players" in data) ||
    !Array.isArray(data.players)
  )
    return data;
  const players = data.players as PlayerWithIdentities[];
  const ids = players
    .map((player) => player.id ?? player.playerId)
    .filter((id): id is string => !!id);
  if (!ids.length) return data;
  const accounts = await db
    .prepare(
      `SELECT a.player_id, a.user_id, i.display_name, i.username
     FROM shop_player_accounts a
     LEFT JOIN auth_identities i ON i.user_id=a.user_id AND i.provider='munet'
     WHERE a.shop_id=? AND a.player_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(shopId, JSON.stringify(ids))
    .all<{
      player_id: string;
      user_id: string;
      display_name: string | null;
      username: string | null;
    }>();
  const byPlayer = new Map(
    accounts.results.map((account) => [account.player_id, account]),
  );
  return {
    ...data,
    players: players.map((player) => {
      const account = byPlayer.get(player.id ?? player.playerId ?? "");
      if (!account) return player;
      const identity = {
        provider: "web-account",
        subject: account.user_id,
        displayName: account.display_name || account.username || undefined,
      };
      return {
        ...player,
        identities: [
          ...(player.identities ?? []).filter(
            (existing) => existing.provider !== "web-account",
          ),
          identity,
        ],
      };
    }),
  };
}

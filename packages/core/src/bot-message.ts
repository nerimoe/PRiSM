/**
 * What a bot says, written by the platform. A message is a list of segments:
 * plain text, and players, whom the bot names as the chat it is on knows them
 * (a group nickname the platform never sees). A bot only maps segments to its
 * chat's elements, so new wording needs no bot release.
 */
/**
 * A player in a bot's message. `displayName` is the player's own name;
 * `name` on an identity is what that identity's platform calls them, which a
 * bot on that platform says instead.
 */
export type BotMessagePlayer = {
  playerId: string;
  displayName: string | null;
  identities: Array<{ provider: string; subject: string; name?: string }>;
};

export type BotMessageSegment = { text: string } | { player: BotMessagePlayer };

export type BotMessage = BotMessageSegment[];

/** The label shown when a player's name and identity are hidden by privacy mode. */
export const ANONYMOUS_PLAYER_LABEL = "匿名玩家";

/** Builds a message, merging neighbouring text: `message("a", player, "b")`. */
export function botMessage(...parts: Array<string | BotMessagePlayer | BotMessage>): BotMessage {
  const out: BotMessage = [];
  const push = (segment: BotMessageSegment) => {
    const last = out.at(-1);
    if ("text" in segment && last && "text" in last) last.text += segment.text;
    else if (!("text" in segment) || segment.text) out.push("text" in segment ? { text: segment.text } : segment);
  };
  for (const part of parts) {
    if (typeof part === "string") push({ text: part });
    else if (Array.isArray(part)) part.forEach(push);
    else push({ player: part });
  }
  return out;
}

/** Replaces matching player segments with an anonymous text label, merging neighbouring text. */
export function maskBotMessagePlayers(
  message: BotMessage,
  shouldMask: (player: BotMessagePlayer) => boolean,
  replacement = ANONYMOUS_PLAYER_LABEL,
): BotMessage {
  return botMessage(
    ...message.map((segment) =>
      "player" in segment
        ? (shouldMask(segment.player) ? replacement : segment.player)
        : segment.text,
    ),
  );
}

/** The message as plain text, players by their platform names; for logs and tests. */
export function botMessageText(message: BotMessage): string {
  return message.map((segment) => ("text" in segment ? segment.text : segment.player.displayName ?? segment.player.playerId)).join("");
}

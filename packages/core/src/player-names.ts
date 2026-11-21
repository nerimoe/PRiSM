/**
 * Whether a player's own name is only a stand-in, waiting for a real one: an
 * imported "Player 75", a generic "玩家", nothing at all, or the chat id it
 * was registered under ("onebot:12345", "onebot 12345", "12345"). Such a name
 * is filled from a chat platform; any other is the shop's or the player's
 * and stays.
 */
export function isPlaceholderPlayerName(
  name: string | null | undefined,
  identity?: { provider: string; subject: string },
): boolean {
  const text = (name ?? "").trim();
  if (!text || text === "玩家" || text === "用户" || /^Player \d+$/.test(text)) return true;
  if (!identity) return false;
  return text === identity.subject
    || text === `${identity.provider}:${identity.subject}`
    || text === `${identity.provider} ${identity.subject}`;
}

/** A name a chat platform reported, trimmed to what is kept; null when it says nothing. */
export function chatName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const text = name.replace(/\s+/g, " ").trim().slice(0, 80);
  return text || null;
}

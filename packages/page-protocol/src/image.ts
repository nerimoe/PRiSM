/** Allows relative `/...` paths (excluding `//`), `https://`, or same-origin `http://` (local dev). */
export function resolvePageImageUrl(raw: string, origin: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("//")) return null;
  try {
    const base = new URL(origin);
    const resolved = new URL(trimmed, base);
    if (resolved.protocol === "https:") return resolved.toString();
    if (resolved.protocol === "http:" && resolved.origin === base.origin) return resolved.toString();
    return null;
  } catch {
    return null;
  }
}

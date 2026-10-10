/** Venue authentication returns to the existing surface, preserving ticket/query/hash. */
export function isVenueReturn(next: string): boolean {
  const path = next.split(/[?#]/, 1)[0]!;
  return path !== "/m/expired" && (/^\/m(?:\/[^/]+)?\/?$/.test(path)
    || /^\/t\/[^/]+(?:\/[^/]+)?\/?$/.test(path));
}

function withQuery(next: string, key: string, value: string): string {
  const url = new URL(next, "https://prism.invalid");
  url.searchParams.set(key, value);
  return url.pathname + url.search + url.hash;
}

export function munetSuccessReturn(next: string, isNewUser: boolean): string {
  if (!isNewUser) return next;
  return isVenueReturn(next) ? withQuery(next, "setup", "passkey")
    : `/settings?setup=passkey&next=${encodeURIComponent(next)}`;
}

export function munetFailureReturn(next: string, message: string): string {
  return isVenueReturn(next) ? withQuery(next, "error", message)
    : `/login?error=${encodeURIComponent(message)}&next=${encodeURIComponent(next)}`;
}

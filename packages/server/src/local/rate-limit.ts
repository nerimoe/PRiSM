/**
 * The Workers rate-limit binding (`limit({ key })`), counted in this process.
 * One binding per limit, each a fixed 60-second window per key, as the
 * `ratelimits` entries in wrangler.jsonc declare. Routes that refuse to run
 * without a binding (machine login, device actions, shop imports) get one.
 */
export function localRateLimit(limit: number, periodSeconds = 60) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let sweepAt = 0;
  return {
    async limit({ key }: { key: string }): Promise<{ success: boolean }> {
      const now = Date.now();
      if (now >= sweepAt) {
        for (const [one, window] of windows) if (now >= window.resetAt) windows.delete(one);
        sweepAt = now + periodSeconds * 1000;
      }
      const window = windows.get(key);
      if (!window || now >= window.resetAt) {
        windows.set(key, { count: 1, resetAt: now + periodSeconds * 1000 });
        return { success: true };
      }
      window.count += 1;
      return { success: window.count <= limit };
    },
  };
}

/** The bindings wrangler.jsonc declares: RATE_LIMIT_3 … RATE_LIMIT_60. */
export function localRateLimits() {
  return Object.fromEntries([3, 5, 10, 20, 30, 60].map((limit) => [`RATE_LIMIT_${limit}`, localRateLimit(limit)]));
}

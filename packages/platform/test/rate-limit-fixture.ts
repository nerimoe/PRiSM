export function createTestRateLimits() {
  const counts = new Map<string, number>();
  const bindings = Object.fromEntries([3, 5, 10, 20, 30, 60].map(limit => [`RATE_LIMIT_${limit}`, {
    async limit({ key }: { key: string }) {
      const scoped = `${limit}:${key}`;
      const count = (counts.get(scoped) ?? 0) + 1;
      counts.set(scoped, count);
      return { success: count <= limit };
    },
  }]));
  return { bindings, reset: () => counts.clear() };
}

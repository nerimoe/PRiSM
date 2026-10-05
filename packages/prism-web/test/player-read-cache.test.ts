import { expect, test } from "bun:test";
import { PlayerReadCache, subscribeRead } from "../src/player-read-cache";
import { parseRetryAfter } from "../src/api";

test("metadata is shared per identity, invalidated on mutation and not poisoned by an aborted subscriber", async () => {
  const cache = new PlayerReadCache();
  let reads = 0, release!: (value: string) => void;
  const fetcher = () => { reads++; return new Promise<string>(resolve => { release = resolve; }); };
  const one = cache.read("u:shop", 30_000, fetcher);
  const two = cache.read("u:shop", 30_000, fetcher);
  expect(one).toBe(two);
  const controller = new AbortController();
  const subscriber = subscribeRead(one, controller.signal);
  controller.abort();
  await expect(subscriber).rejects.toBeDefined();
  await Promise.resolve(); release("shop");
  expect(await two).toBe("shop");
  expect(await cache.read("u:shop", 30_000, fetcher)).toBe("shop");
  expect(reads).toBe(1);
  cache.clear();
  expect(await cache.read("u:shop", 30_000, async () => "fresh")).toBe("fresh");
  expect(await cache.read("other-user:shop", 30_000, async () => "other")).toBe("other");
});
test("expired or failed reads are refetched", async () => {
  const cache = new PlayerReadCache();
  await expect(cache.read("shop", 0, async () => { throw new Error("503"); })).rejects.toThrow("503");
  expect(await cache.read("shop", 0, async () => "ok")).toBe("ok");
  expect(await cache.read("shop", 0, async () => "fresh", Date.now() + 1)).toBe("fresh");
});
test("Retry-After accepts seconds and HTTP dates", () => {
  expect(parseRetryAfter("120")).toBe(120_000);
  expect(parseRetryAfter("Mon, 05 Oct 2026 06:02:00 GMT", Date.parse("2026-10-05T06:00:00Z"))).toBe(120_000);
  expect(parseRetryAfter("invalid")).toBeUndefined();
});

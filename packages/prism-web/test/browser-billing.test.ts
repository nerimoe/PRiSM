import { afterEach, beforeEach, expect, test } from "bun:test";
import { browserCheckoutPreview } from "../src/browser-billing";
import { api, invalidatePlayerReads } from "../src/api";

const originalFetch = globalThis.fetch;
const originalWorker = globalThis.Worker;
const workers: FakeWorker[] = [];
const requests: { path: string; method: string }[] = [];
const quote = { settlementPreview: { total: 12 } };
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  stopped = false;
  messages: unknown[] = [];
  constructor() {
    workers.push(this);
  }
  postMessage(message: unknown) {
    this.messages.push(message);
  }
  terminate() {
    this.stopped = true;
  }
}
beforeEach(() => {
  invalidatePlayerReads();
  workers.length = 0;
  requests.length = 0;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  globalThis.fetch = (async (path, options) => {
    requests.push({ path: String(path), method: options?.method ?? "GET" });
    return Response.json({
      data: { playerId: "p", billingSnapshot: { version: 1 } },
    });
  }) as typeof fetch;
});

test("raw shop metadata stays shared while billing inputs are always fresh", async () => {
  await Promise.all([
    api("/api/v1/shops/demo?pricing=raw"),
    api("/api/v1/shops/demo?pricing=raw"),
  ]);
  expect(requests).toHaveLength(1);
  await api("/api/v1/shops/demo?pricing=raw");
  expect(requests).toHaveLength(1);
  await api("/inputs");
  await api("/inputs");
  expect(requests).toHaveLength(3);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.Worker = originalWorker;
});
const started = async () => {
  for (let i = 0; i < 20 && !workers.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(workers).toHaveLength(1);
  return workers[0]!;
};

test("a fresh read starts a worker quote and completion terminates the worker", async () => {
  const result = browserCheckoutPreview("/inputs", "/legacy");
  const worker = await started();
  expect(worker.messages).toEqual([
    { type: "init", snapshot: { version: 1 }, players: [] },
    { type: "preview", playerId: "p" },
  ]);
  worker.onmessage!({ data: { preview: quote } } as MessageEvent);
  expect(await result).toEqual(quote);
  expect(worker.stopped).toBe(true);
  expect(requests).toEqual([{ path: "/inputs", method: "GET" }]);
});

test("leaving the page cancels calculation and late worker messages cannot revive it", async () => {
  const controller = new AbortController();
  const result = browserCheckoutPreview(
    "/inputs",
    "/legacy",
    controller.signal,
  );
  const worker = await started();
  const rejected = result.catch((error) => error);
  controller.abort();
  expect(await rejected).toMatchObject({ name: "AbortError" });
  expect(worker.stopped).toBe(true);
  worker.onmessage!({ data: { preview: quote } } as MessageEvent);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

test("a worker failure is visible without retrying expensive quotes on the server", async () => {
  const result = browserCheckoutPreview("/inputs", "/legacy");
  const worker = await started();
  const rejected = result.catch((error) => error);
  worker.onerror!();
  expect((await rejected).message).toContain("账单预估失败");
  expect(worker.stopped).toBe(true);
  expect(requests).toHaveLength(1);
});

test("only an explicit unsupported-plugin response uses the compatibility quote", async () => {
  globalThis.fetch = (async (path, options) => {
    requests.push({ path: String(path), method: options?.method ?? "GET" });
    return path === "/inputs"
      ? Response.json(
          {
            error: {
              code: "CLIENT_BILLING_UNAVAILABLE",
              message: "Custom plugin",
            },
          },
          { status: 503 },
        )
      : Response.json({ data: quote });
  }) as typeof fetch;
  expect(await browserCheckoutPreview("/inputs", "/legacy")).toEqual(quote);
  expect(requests).toEqual([
    { path: "/inputs", method: "GET" },
    { path: "/legacy", method: "POST" },
  ]);
  expect(workers).toHaveLength(0);
});

test("permission and resource errors never fall back to a server quote", async () => {
  for (const status of [401, 403, 503]) {
    globalThis.fetch = (async (path, options) => {
      requests.push({ path: String(path), method: options?.method ?? "GET" });
      return Response.json(
        { error: { code: "READ_FAILED", message: "Unavailable" } },
        { status },
      );
    }) as typeof fetch;
    await expect(
      browserCheckoutPreview("/inputs", "/legacy"),
    ).rejects.toMatchObject({ status });
  }
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect(workers).toHaveLength(0);
});

test("failed worker initialization terminates the worker immediately", async () => {
  globalThis.Worker = class extends FakeWorker {
    postMessage() {
      throw new DOMException("Cannot clone inputs", "DataCloneError");
    }
  } as unknown as typeof Worker;
  await expect(
    browserCheckoutPreview("/inputs", "/legacy"),
  ).rejects.toMatchObject({ name: "DataCloneError" });
  expect(workers[0]!.stopped).toBe(true);
});

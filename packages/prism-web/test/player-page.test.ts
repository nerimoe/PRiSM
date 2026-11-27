import { noticeDuration } from "../src/ui/page-blocks/notices";
import { notice } from "../../server/src/notices";
import { describe, expect, test } from "bun:test";
import {
  isPageChanged,
  openPageChannel,
  pageChannelUrl,
  pendingOperations,
  StillRunning,
  withRetries,
} from "../src/ui/player-page";
import type { PageBlock } from "@prism/page-protocol";
import { mergeListBlocks } from "../src/ui/page-blocks/merge-list";
import { TEMPERATURE_SETTLE_MS } from "../src/ui/ClimateControls";
import { isShopAccountMenuPath } from "../src/ui/PlayerAccountMenu";

const quick = { timeoutMs: 20, attempts: 3, waitMs: 1 };

describe("asking over a line that may stall", () => {
  test("uses the server lifetime for transient and button feedback", () => {
    const result = { ...notice("COIN_SENT", "zh"), durationMs: 731, controlDurationMs: 947 };
    expect(noticeDuration(result)).toBe(731);
    expect(noticeDuration(result, true)).toBe(947);
    expect(noticeDuration(notice("INVALID_REDEEM_CODE", "zh"))).toBeNull();
  });

  test("preserves a server pending notice when retries are exhausted", async () => {
    const pending = notice("OPERATION_PENDING", "zh");
    await expect(withRetries(async () => { throw new StillRunning(pending); }, quick)).rejects.toMatchObject({
      code: "OPERATION_PENDING", notice: pending,
    });
  });

  test("gives up on an attempt that hangs and tries again", async () => {
    const retries: number[] = [];
    let calls = 0;
    const answer = await withRetries(
      (signal) => {
        calls++;
        if (calls < 3) return new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
        return Promise.resolve("page");
      },
      { ...quick, onRetry: () => retries.push(calls) },
    );
    expect(answer).toBe("page");
    expect(retries).toEqual([1, 2]);
  });

  test("tries again when nothing answered, and says so once it runs out", async () => {
    let calls = 0;
    await expect(withRetries(() => { calls++; throw new TypeError("Failed to fetch"); }, quick)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(3);
  });

  test("takes any answer as final", async () => {
    let calls = 0;
    const refused = new Error("refused");
    await expect(withRetries(() => { calls++; throw refused; }, quick)).rejects.toBe(refused);
    expect(calls).toBe(1);
  });

  test("keeps asking while the operation is still running", async () => {
    let calls = 0;
    const answer = await withRetries(async () => {
      if (++calls < 2) throw new StillRunning();
      return "done";
    }, quick);
    expect(answer).toBe("done");
  });

  test("stops when the page has gone", async () => {
    const controller = new AbortController();
    let calls = 0;
    const running = withRetries(
      (signal) => { calls++; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))); },
      { ...quick, timeoutMs: 1000, signal: controller.signal },
    );
    controller.abort();
    await expect(running).rejects.toBeDefined();
    expect(calls).toBe(1);
  });
});

class FakeSocket {
  static made: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.made.push(this); }
  send(frame: string) { this.sent.push(frame); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

describe("the page's channel", () => {
  const open = () => {
    FakeSocket.made = [];
    const log: string[] = [];
    const channel = openPageChannel("ws://x", {
      onChanged: () => log.push("changed"),
      onOpen: (first) => log.push(first ? "first" : "again"),
    }, (url) => new FakeSocket(url) as unknown as WebSocket);
    return { channel, log, socket: () => FakeSocket.made.at(-1)! };
  };

  test("asks for the page format that only says it changed", () => {
    expect(pageChannelUrl("a b", "https://prism.test/m")).toBe("wss://prism.test/api/v1/devices/session/ws?ticket=a%20b&v=2");
  });

  test("hears only that the page changed", () => {
    expect(isPageChanged('{"method":"event.pageChanged","params":{"reason":"billing"}}')).toBe(true);
    for (const other of ["pong", '{"method":"event.other"}', "not json", "null", new ArrayBuffer(1)]) expect(isPageChanged(other)).toBe(false);
  });

  test("passes changes on, and tells a first connection from a later one", async () => {
    const { channel, log, socket } = open();
    socket().open();
    socket().onmessage?.({ data: '{"method":"event.pageChanged","params":{}}' });
    socket().onmessage?.({ data: "pong" });
    expect(log).toEqual(["first", "changed"]);
    socket().drop();
    await Bun.sleep(1050);
    expect(FakeSocket.made).toHaveLength(2);
    socket().open();
    expect(log).toEqual(["first", "changed", "again"]);
    channel.close();
  });

  test("on waking, tests a connection it has and reconnects at once if it has none", () => {
    const { channel, socket } = open();
    socket().open();
    channel.wake();
    expect(socket().sent).toEqual(["ping"]);
    // A second wake while the first ping is unanswered sends nothing more.
    channel.wake();
    expect(socket().sent).toEqual(["ping"]);
    socket().onmessage?.({ data: "pong" });
    socket().drop();
    expect(FakeSocket.made).toHaveLength(1);
    channel.wake();
    expect(FakeSocket.made).toHaveLength(2);
    channel.close();
  });

  test("does not keep reconnecting from the background, and connects again on coming back", async () => {
    FakeSocket.made = [];
    let hidden = true;
    const channel = openPageChannel("ws://x", { onChanged() {}, onOpen() {} }, (url) => new FakeSocket(url) as unknown as WebSocket, () => hidden);
    FakeSocket.made[0]!.open();
    FakeSocket.made[0]!.drop();
    await Bun.sleep(1050);
    expect(FakeSocket.made).toHaveLength(1);
    hidden = false;
    channel.wake();
    expect(FakeSocket.made).toHaveLength(2);
    channel.close();
  });

  test("closes for good", async () => {
    const { channel, socket } = open();
    socket().open();
    const first = socket();
    channel.close();
    expect(first.closed).toBe(true);
    channel.wake();
    expect(FakeSocket.made).toHaveLength(1);
  });
});

describe("air conditioner controls", () => {
  test("gather taps on the temperature buttons for a second", () => {
    expect(TEMPERATURE_SETTLE_MS).toBe(1000);
  });
});

describe("mergeListBlocks", () => {
  const listBlock = (id: string, itemIds: string[]): PageBlock => ({
    kind: "list",
    id,
    items: itemIds.map((itemId) => ({ id: itemId, title: itemId })),
    moreLabel: "更多",
    moreTarget: { view: "history", cursor: "next" },
  });

  test("appends deduplicated items for top-level and nested lists and stops at MAX_PAGE_DEPTH", () => {
    const current: PageBlock[] = [
      listBlock("top", ["a", "b"]),
      {
        kind: "section",
        id: "sec",
        blocks: [
          { kind: "row", id: "row", blocks: [listBlock("nested", ["n1", "n2"])] },
        ],
      },
    ];
    const incomingTop = mergeListBlocks(current, [listBlock("top", ["b", "c"])], "top");
    expect((incomingTop[0] as Extract<PageBlock, { kind: "list" }>).items.map((item) => item.id)).toEqual(["a", "b", "c"]);

    const incomingNested = mergeListBlocks(
      current,
      [{ kind: "section", id: "sec", blocks: [listBlock("nested", ["n2", "n3"])] }],
      "nested",
    );
    const section = incomingNested[1] as Extract<PageBlock, { kind: "section" }>;
    const row = section.blocks[0] as Extract<PageBlock, { kind: "row" }>;
    const mergedNested = row.blocks[0] as Extract<PageBlock, { kind: "list" }>;
    expect(mergedNested.items.map((item) => item.id)).toEqual(["n1", "n2", "n3"]);

    let deep: PageBlock = listBlock("too-deep", ["d1"]);
    for (let i = 0; i < 8; i += 1) deep = { kind: "section", id: `s${i}`, blocks: [deep] };
    const unchanged = mergeListBlocks([deep], [listBlock("too-deep", ["d2"])], "too-deep");
    let cursor = unchanged[0] as Extract<PageBlock, { kind: "section" }>;
    for (let i = 0; i < 7; i += 1) cursor = cursor.blocks[0] as Extract<PageBlock, { kind: "section" }>;
    expect((cursor.blocks[0] as Extract<PageBlock, { kind: "list" }>).items.map((item) => item.id)).toEqual(["d1"]);
  });
});

describe("isShopAccountMenuPath", () => {
  test("enables shop account menu only on shop-context player routes", () => {
    for (const path of ["/t/demo", "/t/demo/", "/m", "/m/", "/m/ticket-123"]) {
      expect(isShopAccountMenuPath(path)).toBe(true);
    }
    for (const path of [
      "/cards",
      "/settings",
      "/merchant",
      "/merchant/demo",
      "/merchant/demo/billing",
      "/admin",
      "/login",
      "/m/expired",
      "/m/expired/",
      "/t/demo/extra",
    ]) {
      expect(isShopAccountMenuPath(path)).toBe(false);
    }
  });
});

describe("pendingOperations", () => {
  test("keeps one id per unanswered action until it is answered, across instances", () => {
    const store = new Map<string, string>();
    const previous = (globalThis as { sessionStorage?: unknown }).sessionStorage;
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    try {
      const first = pendingOperations("shop:demo").take("checkout.confirm:null");
      expect(pendingOperations("shop:demo").take("checkout.confirm:null")).toBe(first);
      expect(pendingOperations("shop:other").take("checkout.confirm:null")).not.toBe(first);
      const ops = pendingOperations("shop:demo");
      ops.settle("checkout.confirm:null");
      expect(ops.take("checkout.confirm:null")).not.toBe(first);
    } finally {
      (globalThis as { sessionStorage?: unknown }).sessionStorage = previous;
    }
  });
});

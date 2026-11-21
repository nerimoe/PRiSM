import { describe, expect, test } from "bun:test";
import { isPageChanged, openPageChannel, pageChannelUrl, StillRunning, withRetries } from "../src/ui/player-page";
import { TEMPERATURE_SETTLE_MS } from "../src/ui/ClimateControls";

const quick = { timeoutMs: 20, attempts: 3, waitMs: 1 };

describe("asking over a line that may stall", () => {
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

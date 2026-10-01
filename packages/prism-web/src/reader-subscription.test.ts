import { expect, test } from "bun:test";
import { ReportSubscription, type UnsubscribePolicy } from "./reader-subscription";

test("one-shot subscriptions retain an early response after automatically closing", async () => {
  const subscription = new ReportSubscription({ type: "count", count: 1 });
  const events: number[] = [];
  subscription.listen(frame => events.push(frame[0]!));
  expect(subscription.push(Uint8Array.of(0x32, 1))).toBe(true);
  expect([...await subscription.receive()]).toEqual([0x32, 1]);
  expect(events).toEqual([0x32]);
  await expect(subscription.receive()).rejects.toThrow("已断开");
});

test("queued receivers consume reports in order while all stream listeners receive each report", async () => {
  const subscription = new ReportSubscription();
  const streamed: number[] = [];
  const unsubscribe = subscription.listen(frame => streamed.push(frame[0]!));
  const first = subscription.receive();
  const second = subscription.receive();
  expect(subscription.push(Uint8Array.of(1))).toBe(false);
  expect(subscription.push(Uint8Array.of(2))).toBe(false);
  expect([...await first]).toEqual([1]);
  expect([...await second]).toEqual([2]);
  expect(streamed).toEqual([1, 2]);
  subscription.push(Uint8Array.of(3));
  unsubscribe();
  subscription.close();
  expect([...await subscription.receive()]).toEqual([3]);
  expect(streamed).toEqual([1, 2]);
});

test.each([
  [{ type: "count", count: 2 }, [7], [8]],
  [{ type: "specificIsOn", index: 1, byte: 8 }, [7, 7], [7, 8]],
  [{ type: "specificNotOn", index: 1, byte: 8 }, [7, 8], [7, 9]],
] as [UnsubscribePolicy, number[], number[]][])("Go policy %j closes after the matching report", async (policy, first, last) => {
  const subscription = new ReportSubscription(policy);
  expect(subscription.push(Uint8Array.from(first))).toBe(false);
  expect(subscription.push(Uint8Array.from(last))).toBe(true);
  expect([...await subscription.receive()]).toEqual(first);
  expect([...await subscription.receive()]).toEqual(last);
  await expect(subscription.receive()).rejects.toThrow("已断开");
});

test("a short policy frame closes the channel and closing rejects every pending receiver", async () => {
  const short = new ReportSubscription({ type: "specificIsOn", index: 3, byte: 1 });
  expect(short.push(Uint8Array.of(1))).toBe(true);
  expect([...await short.receive()]).toEqual([1]);
  const subscription = new ReportSubscription();
  const disconnected = (error: Error) => { expect(error.message).toContain("已断开"); };
  const unexpected = () => { throw new Error("Expected subscription cancellation"); };
  const first = subscription.receive().then(unexpected, disconnected);
  const second = subscription.receive().then(unexpected, disconnected);
  subscription.close(); subscription.close();
  await Promise.all([first, second]);
});

test("a timed-out receiver cannot consume the next receiver's report", async () => {
  const subscription = new ReportSubscription();
  await expect(subscription.receive(() => new Error("timeout"))).rejects.toThrow("timeout");
  const next = subscription.receive();
  subscription.push(Uint8Array.of(9));
  expect([...await next]).toEqual([9]);
  subscription.close();
});

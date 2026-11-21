import { describe, expect, it } from "bun:test";
import type { DeviceEvent } from "@prism/core";
import { cameOf, createEventDispatcher, type EventSubscriber, type SubscriberFailure } from "../src/events/dispatcher.js";

let seq = 0;
function event(overrides: Partial<DeviceEvent>): DeviceEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    deviceId: "m1",
    capability: "power",
    kind: "request",
    name: "power.on",
    operationId: "op1",
    parentOperationId: null,
    origin: "platform",
    playerId: null,
    staffId: null,
    payload: {},
    occurredAt: new Date(Date.UTC(2026, 1, 1, 10, 0, seq)),
    via: null,
    ...overrides,
  };
}

const requested = () => event({});
const sent = () => event({ kind: "result", payload: { outcome: "ok" } });
const changed = () => event({ kind: "change", name: "power", operationId: null, origin: "observer", payload: { to: "on" } });

type Context = { shopId: string };

function listener(name: string, when: "inline" | "after", wants: readonly string[] | "*", log: string[]): EventSubscriber<Context> {
  if (when === "inline") return { name, when, wants, async run(context, heard) { log.push(`${name}@${context.shopId}:${heard.type}`); } };
  // An after subscriber hears everything of one dispatch together.
  return { name, when, wants, async run(context, heard) { log.push(`${name}@${context.shopId}:${heard.map((one) => one.type).join("+")}`); } };
}

describe("event dispatcher", () => {
  it("hands each event to the subscribers that asked for its name", async () => {
    const log: string[] = [];
    const dispatch = createEventDispatcher<Context>({
      context: { shopId: "shop" },
      subscribers: [
        listener("requests", "inline", ["power.on.requested"], log),
        listener("changes", "inline", ["power.changed"], log),
        listener("all", "inline", "*", log),
      ],
    });
    await dispatch([requested(), sent(), changed()]);
    expect(log).toEqual([
      "requests@shop:power.on.requested", "all@shop:power.on.requested",
      "all@shop:power.on.sent",
      "changes@shop:power.changed", "all@shop:power.changed",
    ]);
  });

  it("finishes inline subscribers before returning and leaves the rest to defer", async () => {
    const log: string[] = [];
    const deferred: Promise<unknown>[] = [];
    const dispatch = createEventDispatcher<Context>({
      context: { shopId: "shop" },
      subscribers: [listener("later", "after", "*", log), listener("now", "inline", "*", log)],
      defer: (work) => { deferred.push(work); },
    });
    await dispatch([requested(), sent()]);
    expect(log.filter((line) => line.startsWith("now"))).toEqual(["now@shop:power.on.requested", "now@shop:power.on.sent"]);
    expect(deferred).toHaveLength(1);
    await deferred[0];
    // Together, in the order the events happened.
    expect(log.filter((line) => line.startsWith("later"))).toEqual(["later@shop:power.on.requested+power.on.sent"]);
  });

  it("awaits after subscribers when there is nothing to defer to", async () => {
    const log: string[] = [];
    const dispatch = createEventDispatcher<Context>({
      context: { shopId: "shop" },
      subscribers: [listener("later", "after", "*", log)],
    });
    await dispatch([requested()]);
    expect(log).toEqual(["later@shop:power.on.requested"]);
  });

  it("keeps a failing subscriber from the others and from the caller", async () => {
    const log: string[] = [];
    const failures: SubscriberFailure[] = [];
    const dispatch = createEventDispatcher<Context>({
      context: { shopId: "shop" },
      subscribers: [
        { name: "broken", when: "inline", wants: "*", async run() { throw new Error("no"); } },
        listener("fine", "inline", "*", log),
        { name: "broken-later", when: "after", wants: "*", async run() { throw new Error("later"); } },
        listener("fine-later", "after", "*", log),
      ],
      report: (failure) => { failures.push(failure); },
    });
    const first = requested();
    await dispatch([first]);
    expect(log).toEqual(["fine@shop:power.on.requested", "fine-later@shop:power.on.requested"]);
    expect(failures.map((failure) => [failure.subscriber, failure.types, failure.eventIds])).toEqual([
      ["broken", ["power.on.requested"], [first.id]],
      ["broken-later", ["power.on.requested"], [first.id]],
    ]);
  });

  it("hears what an inline subscriber concluded next, before what was still waiting", async () => {
    const log: string[] = [];
    const dispatch = createEventDispatcher<Context>({
      context: { shopId: "shop" },
      subscribers: [
        {
          name: "concludes", when: "inline", wants: ["power.on.sent"],
          async run(_context, heard, emit) { emit(cameOf(heard, { capability: "occupancy", name: "occupancy.started", playerId: "p1" })); },
        },
        listener("now", "inline", "*", log),
        listener("later", "after", ["power.on.sent", "occupancy.started"], log),
      ],
    });
    const result = sent();
    await dispatch([result, changed()]);
    expect(log).toEqual([
      "now@shop:power.on.sent", "now@shop:occupancy.started", "now@shop:power.changed",
      "later@shop:power.on.sent+occupancy.started",
    ]);
  });

  it("says what an event came of, and keeps its device, operation and way", () => {
    const cause = { event: event({ kind: "signal", name: "card.consumed", capability: "hinata_io", via: { channel: "relay", resourceId: null } }), type: "card.consumed" };
    expect(cameOf(cause, { capability: "occupancy", name: "occupancy.seen", playerId: "p1" })).toMatchObject({
      deviceId: "m1", operationId: "op1", playerId: "p1", name: "occupancy.seen", kind: "signal",
      payload: { cause: cause.event.id, causeType: "card.consumed" }, via: { channel: "relay", resourceId: null },
    });
  });

  it("stops a subscriber whose events keep coming of each other", async () => {
    const failures: SubscriberFailure[] = [];
    let heard = 0;
    const dispatch = createEventDispatcher<Context>({
      context: { shopId: "shop" },
      subscribers: [{
        name: "loop", when: "inline", wants: "*",
        async run(_context, one, emit) { heard += 1; emit(cameOf(one, { capability: "occupancy", name: "occupancy.seen" })); },
      }],
      report: (failure) => { failures.push(failure); },
    });
    await dispatch([requested()]);
    expect(heard).toBe(33);
    expect(failures.map((failure) => failure.subscriber)).toEqual(["loop"]);
  });

  it("does nothing when nobody listens", async () => {
    let deferred = 0;
    const dispatch = createEventDispatcher<Context>({ context: { shopId: "shop" }, subscribers: [], defer: () => { deferred += 1; } });
    await dispatch([requested(), changed()]);
    expect(deferred).toBe(0);
  });
});

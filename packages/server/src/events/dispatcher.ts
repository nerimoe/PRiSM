/**
 * Telling whoever listens what happened.
 *
 * Events are facts already written (`resources/capabilities/bus.ts`). Each one
 * is handed, by its one name (`deviceEventType`), to the subscribers that asked
 * for that name. A subscriber reacts to what happened; it never decides whether
 * it happened, so a subscriber that fails is logged and nothing else is undone.
 *
 * There is no event loop to register with: a Worker lives for one request. The
 * subscribers are a list fixed in code (`subscribers.ts`) and dispatching is a
 * function call made right after the write.
 *
 * - `inline` subscribers hear each event as it comes, one at a time, and finish
 *   before the caller is answered. Only for what the answer, or billing,
 *   depends on. What an inline subscriber concludes is itself something that
 *   happened: it says so with `emit`, and that event is heard next, by
 *   everyone, before the events that were still waiting.
 * - `after` subscribers hear everything of one dispatch together, in order,
 *   once the inline ones are done; handed to `defer` (a request's `waitUntil`)
 *   when there is one, so they never delay an answer.
 */
import { deviceEventType, type DeviceEvent } from "@prism/core";

/** An event as a subscriber hears it: what happened, and its name. */
export type Heard = { event: DeviceEvent; type: string };

type Wants = readonly string[] | "*";

export type InlineSubscriber<Context> = {
  /** Named in logs when it fails. */
  name: string;
  when: "inline";
  /** The event names it hears, or `"*"` for every one. */
  wants: Wants;
  run(context: Context, heard: Heard, emit: (event: DeviceEvent) => void): Promise<void>;
};

export type AfterSubscriber<Context> = {
  name: string;
  when: "after";
  wants: Wants;
  /** Everything of one dispatch it asked for, in the order it happened. Never empty. */
  run(context: Context, heard: readonly Heard[]): Promise<void>;
};

export type EventSubscriber<Context> = InlineSubscriber<Context> | AfterSubscriber<Context>;

export type EventDispatch = (events: readonly DeviceEvent[]) => Promise<void>;

export type SubscriberFailure = { subscriber: string; types: string[]; eventIds: string[]; error: unknown };

/** Events that came of other events, in one dispatch. Past this something is feeding itself. */
const MAX_EMITTED = 32;

const wanted = (wants: Wants, type: string) => wants === "*" || wants.includes(type);

export function createEventDispatcher<Context>(input: {
  subscribers: readonly EventSubscriber<Context>[];
  context: Context;
  /** Runs work after the caller is answered. Without it, `after` subscribers are awaited too. */
  defer?: (work: Promise<unknown>) => void;
  report?: (failure: SubscriberFailure) => void;
}): EventDispatch {
  const report = input.report ?? ((failure: SubscriberFailure) =>
    console.error(JSON.stringify({
      event: "event_subscriber_failed",
      subscriber: failure.subscriber,
      types: failure.types,
      eventIds: failure.eventIds,
      message: failure.error instanceof Error ? failure.error.message : String(failure.error),
    })));
  const failed = (subscriber: string, heard: readonly Heard[], error: unknown) =>
    report({ subscriber, types: heard.map((one) => one.type), eventIds: heard.map((one) => one.event.id), error });

  const inline = input.subscribers.filter((subscriber): subscriber is InlineSubscriber<Context> => subscriber.when === "inline");
  const after = input.subscribers.filter((subscriber): subscriber is AfterSubscriber<Context> => subscriber.when === "after");

  return async (events) => {
    const waiting: DeviceEvent[] = [...events];
    const heard: Heard[] = [];
    let emitted = 0;
    while (waiting.length) {
      const event = waiting.shift()!;
      const one: Heard = { event, type: deviceEventType(event) };
      heard.push(one);
      // What came of this event is heard before whatever happened after it.
      const came: DeviceEvent[] = [];
      for (const subscriber of inline) {
        if (!wanted(subscriber.wants, one.type)) continue;
        try {
          await subscriber.run(input.context, one, (next) => {
            if (emitted >= MAX_EMITTED) throw new Error("Too many events came of one dispatch.");
            emitted += 1;
            came.push(next);
          });
        } catch (error) {
          failed(subscriber.name, [one], error);
        }
      }
      waiting.unshift(...came);
    }
    if (!after.length || !heard.length) return;
    const work = (async () => {
      for (const subscriber of after) {
        const mine = heard.filter((one) => wanted(subscriber.wants, one.type));
        if (!mine.length) continue;
        try {
          await subscriber.run(input.context, mine);
        } catch (error) {
          failed(subscriber.name, mine, error);
        }
      }
    })();
    if (input.defer) input.defer(work);
    else await work;
  };
}

/**
 * An event that came of another: what a subscriber concluded from it. It is
 * heard like any event but not written to the device log; whoever concluded it
 * keeps its own record (a stay is a row of `resource_occupancies`).
 */
export function cameOf(
  cause: Heard,
  input: { capability: string; name: string; playerId?: string | null; payload?: Record<string, unknown> },
): DeviceEvent {
  return {
    id: crypto.randomUUID(),
    deviceId: cause.event.deviceId,
    capability: input.capability,
    kind: "signal",
    name: input.name,
    operationId: cause.event.operationId,
    parentOperationId: cause.event.parentOperationId,
    origin: "platform",
    playerId: input.playerId ?? null,
    staffId: null,
    payload: { ...(input.payload ?? {}), cause: cause.event.id, causeType: cause.type },
    occurredAt: cause.event.occurredAt,
    via: cause.event.via ?? null,
  };
}

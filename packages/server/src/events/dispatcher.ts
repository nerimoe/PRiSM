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
 * - `inline` subscribers finish before the caller is answered. Only for what
 *   the answer, or billing, depends on.
 * - `after` subscribers run once the inline ones are done, handed to `defer`
 *   (a request's `waitUntil`) when there is one, so they never delay an answer.
 */
import { deviceEventType, type DeviceEvent } from "@prism/core";

export type EventSubscriber<Context> = {
  /** Named in logs when it fails. */
  name: string;
  when: "inline" | "after";
  /** The event names it hears, or `"*"` for every one. */
  wants: readonly string[] | "*";
  run(context: Context, event: DeviceEvent, type: string): Promise<void>;
};

export type EventDispatch = (events: readonly DeviceEvent[]) => Promise<void>;

export type SubscriberFailure = { subscriber: string; type: string; eventId: string; error: unknown };

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
      type: failure.type,
      eventId: failure.eventId,
      message: failure.error instanceof Error ? failure.error.message : String(failure.error),
    })));

  const run = async (subscriber: EventSubscriber<Context>, event: DeviceEvent, type: string) => {
    try {
      await subscriber.run(input.context, event, type);
    } catch (error) {
      report({ subscriber: subscriber.name, type, eventId: event.id, error });
    }
  };

  return async (events) => {
    const later: Array<() => Promise<void>> = [];
    for (const event of events) {
      const type = deviceEventType(event);
      for (const subscriber of input.subscribers) {
        if (subscriber.wants !== "*" && !subscriber.wants.includes(type)) continue;
        if (subscriber.when === "inline") await run(subscriber, event, type);
        else later.push(() => run(subscriber, event, type));
      }
    }
    if (!later.length) return;
    // In the order the events happened, one at a time: a subscriber hears a
    // request before its result.
    const work = (async () => {
      for (const job of later) await job();
    })();
    if (input.defer) input.defer(work);
    else await work;
  };
}

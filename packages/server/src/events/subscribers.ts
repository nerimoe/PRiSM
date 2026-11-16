/**
 * Who listens to what happens at a shop's devices.
 *
 * Every event the device bus writes passes this list (`dispatcher.ts`). A
 * module that reacts to events is added here once, saying which event names it
 * hears and whether it must finish before the caller is answered.
 *
 * The list is empty for now: what reacts to events today (occupancy, the bots'
 * announcements, open pages, Live Activities, the idle rules) is still called
 * by hand where each event is produced, and moves here one at a time.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { Env } from "../bindings.js";
import type { EventSubscriber } from "./dispatcher.js";

/** What a subscriber is handed besides the event: the shop it happened at. */
export type EventContext = { db: D1DatabaseLike; env: Env; shopId: string };

export const eventSubscribers: readonly EventSubscriber<EventContext>[] = [];

/**
 * Device event model.
 *
 * A device carries capabilities (power, HINATA IO, door, mahjong). Everything
 * that happens to a device is recorded as an immutable event; state and
 * operation outcomes are derived from events, never written independently.
 *
 * - `request`  the platform asked a capability to perform an action
 * - `result`   how that request ended (ok / failed / unknown)
 * - `signal`   a one-off fact reported by the device or an observer
 * - `change`   a state moved from one value to another
 *
 * Kinds and names are validated by the capability catalog in code rather than
 * by SQL CHECK constraints, so adding a capability never rebuilds a table.
 */
import { PrismDomainError } from "./errors";

export type DeviceEventKind = "request" | "result" | "signal" | "change";
export type DeviceEventOrigin = "platform" | "device" | "observer";
export type DeviceOperationStatus = "pending" | "succeeded" | "failed";
export type DeviceStateAuthority = "owned" | "observed" | "derived";

export type DeviceEventActor =
  | { type: "player"; playerId: string }
  | { type: "staff"; staffId: string }
  | { type: "system" };

/**
 * Where an event came into the platform: a scanned page, the merchant board, a
 * bot, the HTTP API, a HINATA IO's own channel, a Home Assistant watcher, or a
 * rule of the platform's own.
 */
export type DeviceEventChannel = "page" | "merchant" | "bot" | "api" | "relay" | "ha" | "system";

/**
 * The way an event took. `resourceId` names the resource it came through when
 * that is one of the shop's own, such as the bot a command was said to; the
 * event then belongs to that resource's history as well as its device's.
 */
export type DeviceEventVia = { channel: DeviceEventChannel; resourceId: string | null };

export type DeviceEvent = {
  id: string;
  /** Null only for a request aimed at several devices at once ("all"). */
  deviceId: string | null;
  capability: string;
  kind: DeviceEventKind;
  name: string;
  operationId: string | null;
  parentOperationId: string | null;
  origin: DeviceEventOrigin;
  playerId: string | null;
  staffId: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
  /** Null or absent for an event recorded before events said where they came from. */
  via?: DeviceEventVia | null;
};

/**
 * The one name an event is known by to whoever listens for it. A listener
 * matches this and nothing else:
 *
 * - a request is `<action>.requested`
 * - its result is `<action>.sent` when the hardware took it, `<action>.failed`
 *   when it refused, `<action>.unanswered` when nobody can say
 * - a request turned away before it was made is `<action>.refused`
 * - a signal is its own name (`card.consumed`)
 * - a change is `<capability>.<key>.changed`, or `<key>.changed` when the
 *   capability has one state of its own name (`power.changed`)
 *
 * `sent` and not `succeeded`: the result says the hardware accepted the call,
 * never that the device did what was asked. What the device then did is a
 * change or a signal of its own.
 */
export function deviceEventType(event: Pick<DeviceEvent, "kind" | "name" | "capability" | "payload">): string {
  if (event.kind === "request") return `${event.name}.requested`;
  if (event.kind === "result") {
    const outcome = event.payload.outcome;
    return `${event.name}.${outcome === "ok" ? "sent" : outcome === "failed" ? "failed" : "unanswered"}`;
  }
  if (event.kind === "signal") return event.name;
  return event.capability === event.name ? `${event.name}.changed` : `${event.capability}.${event.name}.changed`;
}

/** The outcome of one requested action, derived from its request and result events. */
export type DeviceOperation = {
  id: string;
  deviceId: string | null;
  capability: string;
  action: string;
  parentId: string | null;
  playerId: string | null;
  staffId: string | null;
  status: DeviceOperationStatus;
  /** Whether a player is considered to have used the device for billing. */
  countsAsPlay: boolean;
  failure: string | null;
  payload: Record<string, unknown>;
  requestedAt: Date;
  settledAt: Date | null;
};

export type DeviceStateValue = {
  deviceId: string;
  capability: string;
  key: string;
  value: unknown;
  authority: DeviceStateAuthority;
  eventId: string | null;
  changedAt: Date;
  observedAt: Date;
};

export type DeviceResultOutcome = "ok" | "failed" | "unknown";

export function deviceActorFields(actor: DeviceEventActor): {
  playerId: string | null;
  staffId: string | null;
} {
  return {
    playerId: actor.type === "player" ? actor.playerId : null,
    staffId: actor.type === "staff" ? actor.staffId : null,
  };
}

export function resultOutcome(event: Pick<DeviceEvent, "kind" | "payload">): DeviceResultOutcome {
  if (event.kind !== "result") {
    throw new PrismDomainError("Only result events carry an outcome.", "DEVICE_EVENT_NOT_RESULT");
  }
  const outcome = event.payload.outcome;
  return outcome === "ok" || outcome === "failed" ? outcome : "unknown";
}

/**
 * Apply a result to the operation it settles.
 *
 * `unknown` leaves the operation pending: the platform does not know whether
 * the device acted, and billing has always counted an unsettled request as use.
 */
export function settleOperation(
  operation: DeviceOperation,
  result: Pick<DeviceEvent, "kind" | "payload" | "occurredAt">,
): DeviceOperation {
  const outcome = resultOutcome(result);
  if (outcome === "unknown") return operation;
  return {
    ...operation,
    status: outcome === "ok" ? "succeeded" : "failed",
    failure:
      outcome === "failed"
        ? typeof result.payload.message === "string"
          ? result.payload.message
          : "设备执行失败"
        : null,
    settledAt: result.occurredAt,
  };
}

/** A player used the device during [from, to] if any non-failed play operation falls inside it. */
export function operatedWithin(
  operations: readonly Pick<DeviceOperation, "playerId" | "status" | "countsAsPlay" | "requestedAt">[],
  playerId: string,
  from: Date,
  to: Date,
): boolean {
  const start = from.getTime();
  const end = to.getTime();
  return operations.some(
    (operation) =>
      operation.playerId === playerId &&
      operation.countsAsPlay &&
      operation.status !== "failed" &&
      operation.requestedAt.getTime() >= start &&
      operation.requestedAt.getTime() <= end,
  );
}

/** Legacy `device_commands.status` vocabulary, kept for compatibility views. */
export type LegacyCommandStatus = "pending" | "acked" | "expired" | "rejected";

export function legacyStatusOf(status: DeviceOperationStatus): LegacyCommandStatus {
  return status === "succeeded" ? "acked" : status === "failed" ? "expired" : "pending";
}

/** Mapping used by both the history migration and import of old backups. */
export function operationStatusFromLegacy(status: string): DeviceOperationStatus {
  if (status === "acked") return "succeeded";
  if (status === "expired" || status === "rejected") return "failed";
  // A historic pending stays pending: billing counted it as use, and rewriting
  // it to failed would change already-issued bills on recalculation.
  return "pending";
}

/**
 * Which capability a legacy command belonged to. Must agree with the SQL in
 * migration 0037, which applies the same rule to stored history. Coins from the
 * retired machine WebSocket were game-machine coins, so they land on hinata_io.
 */
export function capabilityForLegacyCommand(type: string): string {
  if (type === "door.open") return "door";
  if (type === "power.on" || type === "power.off" || type === "ac.set_temperature") return "power";
  return "hinata_io";
}

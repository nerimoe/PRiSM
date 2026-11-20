/**
 * The single write path for devices.
 *
 * Every occurrence on a device becomes events, recorded atomically together
 * with whatever operation or state it changes:
 *
 *   perform(action)  request event + operation, run the capability, then the
 *                    result event that settles it; then re-observe any external
 *                    state the action touches instead of assuming its effect
 *   signal(...)      a fact the device reported
 *   setOwned(...)    an owned state value, with a change event when it differs
 *   observe(...)     an external state read live, recorded only when it moved
 *
 * Callers never write device tables directly.
 *
 * Every event says where it came from (`via`), and every event that was
 * written is handed to `published`: the one place whoever listens hears it.
 */
import type {
  DeviceEvent,
  DeviceRecord,
  DeviceEventActor,
  DeviceEventRepository,
  DeviceEventVia,
  DeviceOperation,
  DeviceOperationStatus,
} from "@prism/core";
import { deviceActorFields, PrismDomainError } from "@prism/core";
import {
  actionSpec,
  capabilityForAction,
  capabilitySpec,
  type ActionName,
  type CapabilityId,
} from "./catalog.js";
import { can, type Resource } from "../resource.js";

export type ActionContext = {
  device: Resource;
  operationId: string;
  payload: Record<string, unknown>;
  /** Set when the caller waits: the runner hands it to whatever receives the device's signals. */
  awaits?: AwaitSpec;
};

export type AwaitSpec = { signal: string; timeoutMs: number };

/** The signal a caller waited for, as the device reported it; null when none came in time. */
export type Awaited = { name: string; payload: Record<string, unknown> } | null;

/** Runs an action against real hardware. Throwing means the outcome is unknown. */
export type ActionRunner = (context: ActionContext) => Promise<RunOutcome>;

export type RunOutcome =
  | { outcome: "ok"; result?: Record<string, unknown>; awaited?: Awaited }
  /** `httpStatus` is what the hardware's HTTP endpoint answered, when it answered. */
  | { outcome: "failed"; message: string; httpStatus?: number }
  /** The request may or may not have reached the device (e.g. a network timeout). */
  | { outcome: "unknown"; message: string };

/**
 * Reads an external state. Returns null when the source cannot be reached.
 */
export type StateReader = (device: Resource) => Promise<unknown | null>;

export type DeviceBusDependencies = {
  events: DeviceEventRepository;
  now: () => Date;
  id: () => string;
  runners: Partial<Record<ActionName, ActionRunner>>;
  readers: Partial<Record<string, StateReader>>;
  /** Where this bus's events come from, unless an action says otherwise. */
  via?: DeviceEventVia;
  /**
   * Told every event once it is written, in order. A change whose state did
   * not move was not written and is not told. Must not throw: what happened
   * has happened, whoever fails to hear it.
   */
  published?: (events: readonly DeviceEvent[]) => Promise<void>;
};

export type PerformInput = {
  device: Resource;
  action: ActionName;
  actor: DeviceEventActor;
  operationId?: string;
  parentOperationId?: string;
  payload?: Record<string, unknown>;
  /** Values that reach the runner but are never persisted, such as a card number. */
  transient?: Record<string, unknown>;
  /** The player a staff member acted for, when it was not the player themselves. */
  forPlayerId?: string;
  /** Where this request came from, when it is not where the bus's events usually do. */
  via?: DeviceEventVia;
  /**
   * Why the platform made this request itself, when nobody asked for it:
   * `card`, the coin a cabinet adds after the game took a player's card.
   * Kept on the request and its result.
   */
  cause?: "card";
  /** Wait for what the action's spec `awaits`, before returning. */
  wait?: boolean;
};

export type PerformResult = {
  operation: DeviceOperation;
  /** Data the caller shows once and that is never stored (a door code, etc.). */
  result: Record<string, unknown>;
  httpStatus: number | null;
  /**
   * Only when the caller waited and the device can report back: the signal, or
   * null when it did not come in time. Absent when there was nothing to wait on.
   */
  awaited?: Awaited;
};

export type DeviceBus = ReturnType<typeof createDeviceBus>;

export function createDeviceBus(deps: DeviceBusDependencies) {
  const event = (
    input: Omit<DeviceEvent, "id" | "occurredAt" | "parentOperationId" | "playerId" | "staffId" | "via"> &
      Partial<Pick<DeviceEvent, "parentOperationId" | "playerId" | "staffId" | "via">>,
  ): DeviceEvent => ({
    id: deps.id(),
    occurredAt: deps.now(),
    parentOperationId: null,
    playerId: null,
    staffId: null,
    via: deps.via ?? null,
    ...input,
  });

  /** Write, then tell whoever listens what was written. */
  const record = async (input: DeviceRecord): Promise<void> => {
    const written = await deps.events.record(input);
    if (deps.published && written.length) await deps.published(written);
  };

  async function observe(
    device: Resource,
    capability: CapabilityId,
    key: string,
  ): Promise<unknown | null> {
    const reader = deps.readers[`${capability}.${key}`];
    if (!reader) return null;
    const value = await reader(device);
    if (value === null || value === undefined) return null;
    await record({
      events: [],
      states: [
        {
          write: { deviceId: device.id, capability, key, value, authority: "observed" },
          event: event({
            deviceId: device.id,
            capability,
            kind: "change",
            name: key,
            operationId: null,
            origin: "observer",
            payload: { to: value },
          }),
        },
      ],
    });
    return value;
  }

  return {
    /**
     * Ask a device to do something. The request is recorded before the runner is
     * called, so a crash or timeout always leaves an auditable pending operation.
     */
    async perform(input: PerformInput): Promise<PerformResult> {
      const spec = capabilityForAction(input.action);
      const action = actionSpec(input.action);
      if (!spec || !action) {
        throw new PrismDomainError("Unknown device action.", "DEVICE_ACTION_UNSUPPORTED");
      }
      if (!input.device.enabled) {
        throw new PrismDomainError("Device is disabled.", "DEVICE_DISABLED");
      }
      if (!can(input.device, input.action)) {
        throw new PrismDomainError("Device does not support this action.", "DEVICE_ACTION_UNSUPPORTED");
      }
      const runner = deps.runners[input.action];
      if (!runner) {
        throw new PrismDomainError("Device action is not available.", "DEVICE_ACTION_UNSUPPORTED");
      }

      const operationId = input.operationId ?? deps.id();
      const actorFields = deviceActorFields(input.actor);
      // Whom staff acted for is kept with the request: a later card report names it.
      const payload = {
        ...(input.payload ?? {}),
        ...(input.forPlayerId ? { forPlayerId: input.forPlayerId } : {}),
        ...(input.cause ? { cause: input.cause } : {}),
      };
      const requestedAt = deps.now();
      const operation: DeviceOperation = {
        id: operationId,
        deviceId: input.device.id,
        capability: spec.id,
        action: input.action,
        parentId: input.parentOperationId ?? null,
        ...actorFields,
        status: "pending",
        countsAsPlay: action.countsAsPlay,
        failure: null,
        payload,
        requestedAt,
        settledAt: null,
      };
      await record({
        events: [
          {
            ...event({
              deviceId: input.device.id,
              capability: spec.id,
              kind: "request",
              name: input.action,
              operationId,
              parentOperationId: input.parentOperationId ?? null,
              origin: "platform",
              payload,
              ...actorFields,
              ...(input.via ? { via: input.via } : {}),
            }),
            occurredAt: requestedAt,
          },
        ],
        operation,
      });

      let outcome: RunOutcome;
      try {
        outcome = await runner({
          device: input.device,
          operationId,
          payload: { ...payload, ...(input.transient ?? {}) },
          ...(input.wait && action.awaits ? { awaits: action.awaits } : {}),
        });
      } catch (error) {
        outcome = { outcome: "unknown", message: error instanceof Error ? error.message : "设备未响应" };
      }

      const status: DeviceOperationStatus =
        outcome.outcome === "ok" ? "succeeded" : outcome.outcome === "failed" ? "failed" : "pending";
      const failure = outcome.outcome === "ok" ? null : outcome.message;
      const httpStatus = outcome.outcome === "failed" ? outcome.httpStatus ?? null : null;
      const settledAt = deps.now();
      const persisted =
        outcome.outcome === "ok" && !action.sensitiveResult ? (outcome.result ?? {}) : {};
      await record({
        events: [
          event({
            deviceId: input.device.id,
            capability: spec.id,
            kind: "result",
            name: input.action,
            operationId,
            parentOperationId: input.parentOperationId ?? null,
            origin: "platform",
            payload: {
              outcome: outcome.outcome,
              ...(failure ? { message: failure } : {}),
              ...(httpStatus ? { httpStatus } : {}),
              ...persisted,
              // Whom staff acted for, and why, as the request said: a listener hears the result alone.
              ...(input.forPlayerId ? { forPlayerId: input.forPlayerId } : {}),
              ...(input.cause ? { cause: input.cause } : {}),
            },
            ...actorFields,
            ...(input.via ? { via: input.via } : {}),
          }),
        ],
        // Unknown leaves the operation pending: the device may still have acted,
        // and billing has always counted an unsettled request as use.
        ...(status === "pending" ? {} : { settle: { operationId, status, failure, settledAt } }),
      });

      return {
        operation: { ...operation, status, failure, settledAt: status === "pending" ? null : settledAt },
        result: outcome.outcome === "ok" ? (outcome.result ?? {}) : {},
        httpStatus,
        ...(outcome.outcome === "ok" && outcome.awaited !== undefined ? { awaited: outcome.awaited } : {}),
      };
    },

    /**
     * A request that was turned away before it was made: the player had not
     * entered, the cabinet was full, the device does not do this. Nothing was
     * asked of the hardware and no operation exists; that someone tried is an
     * event of its own (`<action>.refused`). `device` is null when the request
     * named none that exists.
     */
    async refuse(input: {
      device: Pick<Resource, "id"> | null;
      action: ActionName;
      actor: DeviceEventActor;
      /** Why, as the platform names it. */
      code: string;
      /** Why, in words a shop can read, when there are any. */
      message?: string;
      forPlayerId?: string;
      via?: DeviceEventVia;
    }): Promise<void> {
      const spec = capabilityForAction(input.action);
      if (!spec) return;
      await record({
        events: [event({
          deviceId: input.device?.id ?? null,
          capability: spec.id,
          kind: "signal",
          name: `${input.action}.refused`,
          operationId: null,
          origin: "platform",
          payload: {
            code: input.code,
            ...(input.message ? { message: input.message } : {}),
            ...(input.forPlayerId ? { forPlayerId: input.forPlayerId } : {}),
          },
          ...deviceActorFields(input.actor),
          ...(input.via ? { via: input.via } : {}),
        })],
      });
    },

    /**
     * Record something the device reported. It is a fact of its own: naming an
     * operation (`operationId`) says which request it answered, and changes
     * nothing about that request.
     */
    async signal(input: {
      device: Pick<Resource, "id">;
      capability: CapabilityId;
      name: string;
      operationId?: string | null;
      payload?: Record<string, unknown>;
      /** The player the signal is about, such as the owner of the card it carried. */
      playerId?: string | null;
    }): Promise<boolean> {
      const spec = capabilitySpec(input.capability);
      const signal = spec?.signals[input.name];
      if (!spec || !signal || !signal.store) return false;
      const occurred = event({
        deviceId: input.device.id,
        capability: spec.id,
        kind: "signal",
        name: input.name,
        operationId: input.operationId ?? null,
        origin: "device",
        payload: input.payload ?? {},
        playerId: input.playerId ?? null,
      });
      await record({ events: [occurred] });
      return true;
    },

    /** Set a state the platform owns. A change event is written only when the value differs. */
    async setOwned(input: {
      device: Pick<Resource, "id">;
      capability: CapabilityId;
      key: string;
      value: unknown;
    }): Promise<void> {
      const spec = capabilitySpec(input.capability);
      if (spec?.state[input.key]?.authority !== "owned") {
        throw new PrismDomainError("State is not owned by the platform.", "DEVICE_STATE_NOT_OWNED");
      }
      await record({
        events: [],
        states: [
          {
            write: {
              deviceId: input.device.id,
              capability: input.capability,
              key: input.key,
              value: input.value,
              authority: "owned",
            },
            event: event({
              deviceId: input.device.id,
              capability: input.capability,
              kind: "change",
              name: input.key,
              operationId: null,
              origin: "device",
              payload: { to: input.value },
            }),
          },
        ],
      });
    },

    /**
     * Read an external state live. The value returned is the current fact;
     * storage only gains a change event when it differs from the last
     * observation. Null means the source could not be reached right now.
     */
    observe,

    /**
     * Record external states a watcher reported instead of ones read now, in one
     * batch. `at` is when each changed at the source (Home Assistant's
     * `last_changed`), so a switch turned on outside the platform keeps its real
     * time. A value of `null` means the source cannot say (`unavailable`). With
     * `quiet` the state is stored without a change event.
     */
    async reportMany(
      items: ReadonlyArray<{
        device: Pick<Resource, "id">;
        capability: CapabilityId;
        key: string;
        value: unknown;
        at?: Date;
        quiet?: boolean;
        /** What the reporter knows of the change besides the value, such as that it was a live switch. */
        payload?: Record<string, unknown>;
      }>,
    ): Promise<void> {
      if (!items.length) return;
      await record({
        events: [],
        states: items.map((item) => {
          const write = {
            deviceId: item.device.id,
            capability: item.capability,
            key: item.key,
            value: item.value,
            authority: "observed" as const,
            ...(item.at ? { at: item.at } : {}),
          };
          if (item.quiet) return { write };
          return {
            write,
            event: {
              ...event({
                deviceId: item.device.id,
                capability: item.capability,
                kind: "change",
                name: item.key,
                operationId: null,
                origin: "observer",
                payload: { to: item.value, ...item.payload },
              }),
              ...(item.at ? { occurredAt: item.at } : {}),
            },
          };
        }),
      });
    },
  };
}

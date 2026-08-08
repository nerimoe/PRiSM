import { PrismDomainError } from "./errors";
import type { Session } from "./session";

export type DeviceTargetKind = "facility" | "game_machine";

export type DeviceExecutorKind = "home_assistant" | "machine_ws";

export type DeviceActionType =
  | "power.on"
  | "power.off"
  | "ac.set_temperature"
  | "coin"
  | "aime.scan"
  | "door.open";

export type DeviceCommandType = DeviceActionType;

export type DeviceTarget =
  | {
      kind: "facility";
      id: string;
      all?: never;
    }
  | {
      kind: "facility";
      all: true;
      id?: never;
    }
  | {
      kind: "game_machine";
      id: string;
      all?: never;
    };

export type DeviceReferenceTarget =
  | {
      kind: "facility";
      ref: string;
      id?: never;
    }
  | {
      kind: "game_machine";
      id: string;
      ref?: never;
    };

export type DeviceCommandActor =
  | {
      type: "player";
      playerId: string;
    }
  | {
      type: "staff";
      staffId: string;
    };

export type DeviceCommandRequest = {
  type: DeviceCommandType;
  target: DeviceTarget;
  payload?: Record<string, unknown>;
};

export type DeviceCommand = {
  id: string;
  type: DeviceCommandType;
  deviceId: string | null;
  targetKind: DeviceTargetKind;
  executorKind: DeviceExecutorKind;
  playerId?: string;
  staffId?: string;
  status: "pending" | "acked" | "expired" | "rejected";
  payload?: Record<string, unknown>;
  requestedAt: Date;
  ackedAt?: Date;
  expiredAt?: Date;
};

export type DeviceState = {
  deviceId: string;
  type: DeviceCommandType;
  targetKind?: DeviceTargetKind;
  executorKind?: DeviceExecutorKind;
  label: string;
  status: "online" | "offline" | "degraded";
  state: string;
  metadata: Record<string, unknown> | null;
  reportedAt: Date;
  reportedBy: string;
};

export type RequestDeviceCommandInput = {
  actor: DeviceCommandActor;
  command: DeviceCommandRequest;
  activeSessions: readonly Session[];
  previousCommands: readonly DeviceCommand[];
  coinCooldownMs?: number;
  now: Date;
  id: string;
};

export type AckDeviceCommandInput = {
  command: DeviceCommand;
  now: Date;
};

export type ExpireDeviceCommandInput = {
  command: DeviceCommand;
  now: Date;
};

export function requestDeviceCommand(input: RequestDeviceCommandInput): DeviceCommand {
  const executorKind = resolveDeviceExecutor(input.command);

  if (input.actor.type === "player") {
    const playerId = input.actor.playerId;
    if (requiresActiveSession(input.command.type) && !hasActiveSession(input.activeSessions, playerId)) {
      throw new PrismDomainError(
        "Player device command requires an active session.",
        "DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION",
      );
    }

    if (input.command.type === "coin" && input.coinCooldownMs) {
      const latestCoinCommand = input.previousCommands
        .filter((command) => command.type === "coin" && command.playerId === playerId)
        .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0];

      if (latestCoinCommand && input.now.getTime() - latestCoinCommand.requestedAt.getTime() < input.coinCooldownMs) {
        throw new PrismDomainError("Coin command cooldown is active.", "COIN_COMMAND_COOLDOWN_ACTIVE");
      }
    }
  }

  return {
    id: input.id,
    type: input.command.type,
    deviceId: input.command.target.kind === "facility" && input.command.target.all
      ? null
      : input.command.target.id,
    targetKind: input.command.target.kind,
    executorKind,
    playerId: input.actor.type === "player" ? input.actor.playerId : undefined,
    staffId: input.actor.type === "staff" ? input.actor.staffId : undefined,
    status: "pending",
    payload: input.command.payload,
    requestedAt: input.now,
  };
}

export function resolveDeviceExecutor(command: DeviceCommandRequest): DeviceExecutorKind {
  if (isFacilityAction(command.type)) {
    if (command.target.kind !== "facility") {
      throw new PrismDomainError("Facility action requires a facility target.", "DEVICE_ACTION_TARGET_MISMATCH");
    }
    if ("all" in command.target && command.target.all && command.type !== "power.on" && command.type !== "power.off") {
      throw new PrismDomainError(
        "All-facility targets only support power actions.",
        "DEVICE_ACTION_TARGET_MISMATCH",
      );
    }
    return "home_assistant";
  }

  if (command.target.kind !== "game_machine") {
    throw new PrismDomainError("Game-machine action requires a game machine target.", "DEVICE_ACTION_TARGET_MISMATCH");
  }
  return "machine_ws";
}

function requiresActiveSession(type: DeviceCommandType): boolean {
  return type === "coin" || type === "aime.scan" || type === "power.on" || type === "power.off";
}

function isFacilityAction(type: DeviceCommandType): boolean {
  return type === "power.on" || type === "power.off" || type === "ac.set_temperature" || type === "door.open";
}

function hasActiveSession(activeSessions: readonly Session[], playerId: string): boolean {
  return activeSessions.some((session) => session.playerId === playerId && session.status === "active");
}

export function ackDeviceCommand(input: AckDeviceCommandInput): DeviceCommand & { status: "acked"; ackedAt: Date } {
  assertPendingDeviceCommand(input.command);

  return {
    ...input.command,
    status: "acked",
    ackedAt: input.now,
  };
}

export function expireDeviceCommand(
  input: ExpireDeviceCommandInput,
): DeviceCommand & { status: "expired"; expiredAt: Date } {
  assertPendingDeviceCommand(input.command);

  return {
    ...input.command,
    status: "expired",
    expiredAt: input.now,
  };
}

function assertPendingDeviceCommand(command: DeviceCommand): void {
  if (command.status !== "pending") {
    throw new PrismDomainError("Device command is not pending.", "DEVICE_COMMAND_NOT_PENDING");
  }
}

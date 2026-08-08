import type {
  DeviceCommand,
  DeviceCommandActor,
  DeviceCommandRepository,
  DeviceCommandType,
  DeviceExecutorKind,
  DeviceReferenceTarget,
  DeviceTarget,
  PlayerIdentityRepository,
  SessionRepository,
} from "@prism/core";
import { ackDeviceCommand, expireDeviceCommand, PrismDomainError, requestDeviceCommand } from "@prism/core";

export type DeviceActionExecutionInput = {
  command: DeviceCommand;
};

export type DeviceActionExecutionResult =
  | {
      status: "success";
    }
  | {
      status: "failed";
      message: string;
    };

export type DeviceActionExecutor = {
  execute(input: DeviceActionExecutionInput): Promise<DeviceActionExecutionResult>;
};

export type DeviceActionServiceDependencies = {
  sessions: SessionRepository;
  deviceCommands: DeviceCommandRepository;
  playerIdentities?: PlayerIdentityRepository;
  now: () => Date;
  id: () => string;
  coinCooldownMs: number;
  getCoinCooldownMs?: () => Promise<number>;
  resolveFacilityTarget?: (deviceRef: string) => Promise<{
    target: Extract<DeviceTarget, { kind: "facility" }>;
    deviceLabel: string;
  }>;
  executors?: Partial<Record<DeviceExecutorKind, DeviceActionExecutor>>;
};

export type RequestDeviceActionInput = {
  actor: DeviceCommandActor;
  target: DeviceReferenceTarget;
  type: DeviceCommandType;
  payload?: Record<string, unknown>;
};

export type DeviceActionService = {
  requestDeviceAction(input: RequestDeviceActionInput): Promise<DeviceCommand>;
};

export function createDeviceActionService(dependencies: DeviceActionServiceDependencies): DeviceActionService {
  return {
    async requestDeviceAction(input) {
      if (input.actor.type === "player" && input.type === "aime.scan") {
        await assertScanIdentityBelongsToPlayer(dependencies.playerIdentities, input.actor.playerId, input.payload);
      }

      const playerId = input.actor.type === "player" ? input.actor.playerId : null;
      const [activeSessions, previousCommands] = await Promise.all([
        playerId ? dependencies.sessions.findActiveByPlayerId(playerId) : Promise.resolve([]),
        playerId ? dependencies.deviceCommands.listByPlayerId(playerId) : Promise.resolve([]),
      ]);
      const coinCooldownMs =
        input.type === "coin" && dependencies.getCoinCooldownMs
          ? await dependencies.getCoinCooldownMs()
          : dependencies.coinCooldownMs;
      const resolvedTarget: { target: DeviceTarget; deviceLabel?: string } = input.target.kind === "facility"
        ? await resolveFacilityTarget(input.target.ref, dependencies.resolveFacilityTarget)
        : { target: input.target };
      const command = requestDeviceCommand({
        actor: input.actor,
        command: {
          type: input.type,
          target: resolvedTarget.target,
          payload: resolvedTarget.deviceLabel
            ? {
                ...(input.payload ?? {}),
                deviceLabel: resolvedTarget.deviceLabel,
              }
            : input.payload,
        },
        activeSessions,
        previousCommands,
        coinCooldownMs,
        now: dependencies.now(),
        id: dependencies.id(),
      });

      const executor = dependencies.executors?.[command.executorKind];
      if (!executor) {
        await dependencies.deviceCommands.enqueueDeviceCommand(command);
        return command;
      }

      const result = await executor.execute({ command });
      let updated: DeviceCommand = result.status === "success"
        ? ackDeviceCommand({ command, now: dependencies.now() })
        : {
            ...expireDeviceCommand({ command, now: dependencies.now() }),
            payload: {
              ...(command.payload ?? {}),
              executorFailure: {
                executorKind: command.executorKind,
                message: result.message,
              },
            },
          };

      await dependencies.deviceCommands.enqueueDeviceCommand(updated);
      return updated;
    },
  };
}

async function resolveFacilityTarget(
  deviceRef: string,
  resolver: DeviceActionServiceDependencies["resolveFacilityTarget"],
): Promise<{
  target: Extract<DeviceTarget, { kind: "facility" }>;
  deviceLabel: string;
}> {
  if (!resolver) {
    throw new PrismDomainError(
      "Facility device reference resolver is not configured.",
      "FACILITY_DEVICE_RESOLVER_NOT_CONFIGURED",
    );
  }
  return resolver(deviceRef);
}

async function assertScanIdentityBelongsToPlayer(
  playerIdentities: PlayerIdentityRepository | undefined,
  playerId: string,
  payload: Record<string, unknown> | undefined,
): Promise<void> {
  if (!playerIdentities) {
    throw new PrismDomainError("Player identity repository is required for Aime scan actions.", "PLAYER_IDENTITY_REPOSITORY_NOT_CONFIGURED");
  }

  const provider = typeof payload?.provider === "string" ? payload.provider : "";
  const subject = typeof payload?.subject === "string" ? payload.subject : "";
  if (!provider || !subject) {
    throw new PrismDomainError("Aime scan action requires provider and subject.", "INVALID_SCAN_IDENTITY_PAYLOAD");
  }

  const player = await playerIdentities.findPlayerByIdentity(provider, subject);
  if (!player || player.id !== playerId) {
    throw new PrismDomainError("Scan identity is not bound to the player.", "SCAN_IDENTITY_NOT_BOUND_TO_PLAYER");
  }
}

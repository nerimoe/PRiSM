import type {
  DeviceCommand,
  DeviceCommandRepository,
  DeviceCommandType,
  DeviceReferenceTarget,
  PlayerIdentityRepository,
  PricingConfigRepository,
  Session,
  SessionRepository,
} from "@prism/core";
import { PrismDomainError, startSession } from "@prism/core";
import { createDeviceActionService, type DeviceActionServiceDependencies } from "./device-actions";

export type PlayerCommandServiceDependencies = {
  sessions: SessionRepository;
  deviceCommands: DeviceCommandRepository;
  pricingConfigs?: PricingConfigRepository;
  playerIdentities?: PlayerIdentityRepository;
  now: () => Date;
  id: () => string;
  coinCooldownMs: number;
  getCoinCooldownMs?: () => Promise<number>;
  resolveFacilityTarget?: DeviceActionServiceDependencies["resolveFacilityTarget"];
  canStartSessionAt?: (input: { playerId: string; at: Date }) => Promise<boolean>;
};

export type StartPlayerSessionCommand = {
  playerId: string;
  pricingConfigIds?: string[];
  label?: string;
  metadata?: Record<string, unknown>;
};

export type RequestPlayerDeviceCommand = {
  playerId: string;
  type: DeviceCommandType;
  target: DeviceReferenceTarget;
  payload?: Record<string, unknown>;
};

export type PlayerCommandService = {
  startSession(input: StartPlayerSessionCommand): Promise<Session & { status: "active" }>;
  requestDeviceCommand(input: RequestPlayerDeviceCommand): Promise<DeviceCommand>;
};

export function createPlayerCommandService(dependencies: PlayerCommandServiceDependencies): PlayerCommandService {
  const deviceActions = createDeviceActionService(dependencies);

  return {
    async startSession(input) {
      const now = dependencies.now();
      if (dependencies.canStartSessionAt && !(await dependencies.canStartSessionAt({ playerId: input.playerId, at: now }))) {
        throw new PrismDomainError(
          "Player cannot start a billing session outside billable business intervals.",
          "PLAYER_SESSION_OUTSIDE_BILLABLE_TIME",
        );
      }

      let pricingConfigIds = input.pricingConfigIds ?? [];
      if (pricingConfigIds.length === 0 && dependencies.pricingConfigs) {
        const enabled = await dependencies.pricingConfigs.listEnabled();
        pricingConfigIds = enabled.filter((c) => c.kind === "time.priority").map((c) => c.id);
      }
      if (pricingConfigIds.length === 0) {
        pricingConfigIds = ["default"];
      }

      if (input.label) {
        const active = await dependencies.sessions.findActiveByPlayerId(input.playerId);
        const hasDuplicate = active.some((s) => s.label === input.label);
        if (hasDuplicate) {
          throw new PrismDomainError(
            `Player already has an active session with label '${input.label}'.`,
            "DUPLICATE_SESSION_LABEL",
          );
        }
      }

      const session = startSession({
        playerId: input.playerId,
        now,
        id: dependencies.id(),
        pricingConfigIds,
        label: input.label,
        metadata: input.metadata,
      });

      await dependencies.sessions.save(session);
      return session;
    },

    async requestDeviceCommand(input) {
      return deviceActions.requestDeviceAction({
        actor: {
          type: "player",
          playerId: input.playerId,
        },
        type: input.type,
        target: input.target,
        payload: input.payload,
      });
    },
  };
}

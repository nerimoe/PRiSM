import { describe, expect, it } from "bun:test";
import type {
  DeviceCommand,
  DeviceCommandRepository,
  PlayerIdentityRepository,
  Session,
  SessionRepository,
} from "@prism/core";
import { createDeviceActionService } from "../src/index";

class MemorySessionRepository implements SessionRepository {
  constructor(private readonly sessions: Session[] = []) {}

  async findActiveByPlayerId(playerId: string): Promise<Session[]> {
    return this.sessions.filter((session) => session.playerId === playerId && session.status === "active");
  }

  async findById(sessionId: string): Promise<Session | null> {
    return this.sessions.find((session) => session.id === sessionId) ?? null;
  }

  async findUnpaidClosedByPlayerId(playerId: string): Promise<Session[]> {
    return this.sessions.filter((session) => session.playerId === playerId && session.status === "closed" && session.paymentStatus === "unpaid");
  }

  async save(): Promise<void> {}
}

class MemoryDeviceCommandRepository implements DeviceCommandRepository {
  queued: DeviceCommand[] = [];

  constructor(private readonly previous: DeviceCommand[] = []) {}

  async enqueueDeviceCommand(command: DeviceCommand): Promise<void> {
    this.queued.push(command);
  }

  async getDeviceCommand(commandId: string): Promise<DeviceCommand | null> {
    return this.queued.find((command) => command.id === commandId) ?? null;
  }

  async listByPlayerId(playerId: string): Promise<DeviceCommand[]> {
    return this.previous.filter((command) => command.playerId === playerId);
  }

  async listPending(limit: number): Promise<DeviceCommand[]> {
    return this.queued.filter((command) => command.status === "pending").slice(0, limit);
  }
}

describe("createDeviceActionService", () => {
  it("routes facility actions to the Home Assistant executor", async () => {
    const deviceCommands = new MemoryDeviceCommandRepository();
    const service = createDeviceActionService({
      sessions: new MemorySessionRepository(),
      deviceCommands,
      now: () => new Date("2026-07-07T10:00:00.000Z"),
      id: () => "command-1",
      coinCooldownMs: 60_000,
      resolveFacilityTarget: resolveTestFacilityTarget,
    });

    const command = await service.requestDeviceAction({
      actor: {
        type: "staff",
        staffId: "staff-1",
      },
      type: "power.on",
      target: {
        kind: "facility",
        ref: "maimai",
      },
    });

    expect(command).toMatchObject({
      id: "command-1",
      type: "power.on",
      deviceId: "switch.maimai",
      targetKind: "facility",
      executorKind: "home_assistant",
      staffId: "staff-1",
      status: "pending",
      payload: {
        deviceLabel: "Maimai Switch",
      },
    });
    expect(deviceCommands.queued).toEqual([command]);
  });

  it("requires an active session for player power commands", async () => {
    const deviceCommands = new MemoryDeviceCommandRepository();
    const service = createDeviceActionService({
      sessions: new MemorySessionRepository(),
      deviceCommands,
      now: () => new Date("2026-07-07T10:00:00.000Z"),
      id: () => "command-1",
      coinCooldownMs: 60_000,
      resolveFacilityTarget: resolveTestFacilityTarget,
    });
    const actor = { type: "player" as const, playerId: "player-1" };
    const target = { kind: "facility" as const, ref: "maimai" };

    for (const type of ["power.on", "power.off"] as const) {
      await expect(service.requestDeviceAction({
        actor,
        type,
        target,
      })).rejects.toMatchObject({
        code: "DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION",
      });
    }
  });

  it("routes game-machine actions to the machine WebSocket executor", async () => {
    const deviceCommands = new MemoryDeviceCommandRepository();
    const service = createDeviceActionService({
      sessions: new MemorySessionRepository([
        {
          id: "session-1",
          playerId: "player-1",
          startedAt: new Date("2026-07-07T09:30:00.000Z"),
          status: "active",
          pricingConfigIds: ["music"],
          paymentStatus: "unpaid",
        },
      ]),
      deviceCommands,
      now: () => new Date("2026-07-07T10:00:00.000Z"),
      id: () => "command-1",
      coinCooldownMs: 60_000,
    });

    const command = await service.requestDeviceAction({
      actor: {
        type: "player",
        playerId: "player-1",
      },
      type: "coin",
      target: {
        kind: "game_machine",
        id: "maimai-dx-1",
      },
      payload: {
        count: 1,
      },
    });

    expect(command).toMatchObject({
      id: "command-1",
      type: "coin",
      deviceId: "maimai-dx-1",
      targetKind: "game_machine",
      executorKind: "machine_ws",
      playerId: "player-1",
      status: "pending",
      payload: {
        count: 1,
      },
    });
    expect(deviceCommands.queued).toEqual([command]);
  });

  it("resolves a player-facing game machine reference before direct execution", async () => {
    const deviceCommands = new MemoryDeviceCommandRepository();
    const service = createDeviceActionService({
      sessions: new MemorySessionRepository([activeSession()]),
      deviceCommands,
      now: () => new Date("2026-08-15T10:00:00.000Z"),
      id: () => "command-remote",
      coinCooldownMs: 60_000,
      resolveGameMachineTarget: async (deviceRef) => {
        expect(deviceRef).toBe("舞萌左机");
        return {
          target: { kind: "game_machine", id: "maimai-left", executorKind: "hinata_io" },
          deviceLabel: "舞萌 DX 左机",
        };
      },
      executors: {
        hinata_io: {
          async execute() {
            return { status: "success" };
          },
        },
      },
    });

    const command = await service.requestDeviceAction({
      actor: { type: "player", playerId: "player-1" },
      type: "coin",
      target: { kind: "game_machine", ref: "舞萌左机" },
      payload: { count: 2 },
    });

    expect(command).toMatchObject({
      deviceId: "maimai-left",
      executorKind: "hinata_io",
      status: "acked",
      payload: { count: 2, deviceLabel: "舞萌 DX 左机" },
    });
  });

  it("loads the player's bound Aime identity when a scan omits the card number", async () => {
    const deviceCommands = new MemoryDeviceCommandRepository();
    const playerIdentities: PlayerIdentityRepository = {
      async save() {},
      async delete() {},
      async findPlayerByIdentity() { return null; },
      async listByPlayerId(playerId) {
        expect(playerId).toBe("player-1");
        return [{
          playerId,
          provider: "aime",
          subject: "01234567890123456789",
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
        }];
      },
    };
    const service = createDeviceActionService({
      sessions: new MemorySessionRepository([activeSession()]),
      deviceCommands,
      playerIdentities,
      now: () => new Date("2026-08-15T10:00:00.000Z"),
      id: () => "command-scan",
      coinCooldownMs: 60_000,
      resolveGameMachineTarget: async () => ({
        target: { kind: "game_machine", id: "maimai-left", executorKind: "hinata_io" },
        deviceLabel: "舞萌 DX 左机",
      }),
      executors: {
        hinata_io: {
          async execute({ command }) {
            expect(command.payload?.subject).toBe("01234567890123456789");
            return { status: "success" };
          },
        },
      },
    });

    const command = await service.requestDeviceAction({
      actor: { type: "player", playerId: "player-1" },
      type: "aime.scan",
      target: { kind: "game_machine", ref: "舞萌左机" },
      payload: { provider: "aime" },
    });

    expect(command.payload).toEqual({
      provider: "aime",
      deviceLabel: "舞萌 DX 左机",
    });
  });

  it("persists facility executor failures as backend-visible command payloads", async () => {
    const deviceCommands = new MemoryDeviceCommandRepository();
    const service = createDeviceActionService({
      sessions: new MemorySessionRepository(),
      deviceCommands,
      now: () => new Date("2026-07-07T10:00:00.000Z"),
      id: () => "command-1",
      coinCooldownMs: 60_000,
      resolveFacilityTarget: resolveTestFacilityTarget,
      executors: {
        home_assistant: {
          async execute() {
            return {
              status: "failed",
              message: "Home Assistant service switch.turn_on failed with 503.",
            };
          },
        },
      },
    });

    const command = await service.requestDeviceAction({
      actor: {
        type: "staff",
        staffId: "staff-1",
      },
      type: "power.on",
      target: {
        kind: "facility",
        ref: "maimai",
      },
    });

    expect(command).toMatchObject({
      id: "command-1",
      status: "expired",
      expiredAt: new Date("2026-07-07T10:00:00.000Z"),
      payload: {
        deviceLabel: "Maimai Switch",
        executorFailure: {
          executorKind: "home_assistant",
          message: "Home Assistant service switch.turn_on failed with 503.",
        },
      },
    });
    expect(deviceCommands.queued).toEqual([command]);
  });

  it("resolves a facility reference before creating and executing the command", async () => {
    const deviceCommands = new MemoryDeviceCommandRepository();
    const service = createDeviceActionService({
      sessions: new MemorySessionRepository(),
      deviceCommands,
      now: () => new Date("2026-07-07T10:00:00.000Z"),
      id: () => "command-1",
      coinCooldownMs: 60_000,
      resolveFacilityTarget: resolveTestFacilityTarget,
      executors: {
        home_assistant: {
          async execute() {
            return {
              status: "success",
            };
          },
        },
      },
    });

    const command = await service.requestDeviceAction({
      actor: {
        type: "staff",
        staffId: "staff-1",
      },
      type: "power.on",
      target: {
        kind: "facility",
        ref: "maimai",
      },
      payload: {
        existingField: "test",
      },
    });

    expect(command).toMatchObject({
      id: "command-1",
      deviceId: "switch.maimai",
      status: "acked",
      payload: {
        existingField: "test",
        deviceLabel: "Maimai Switch",
      },
    });
    expect(deviceCommands.queued).toEqual([command]);
  });

  it("represents all facilities without storing all as a device id", async () => {
    const deviceCommands = new MemoryDeviceCommandRepository();
    const service = createDeviceActionService({
      sessions: new MemorySessionRepository(),
      deviceCommands,
      now: () => new Date("2026-07-07T10:00:00.000Z"),
      id: () => "command-1",
      coinCooldownMs: 60_000,
      resolveFacilityTarget: async (deviceRef) => {
        expect(deviceRef).toBe("all");
        return {
          target: { kind: "facility", all: true },
          deviceLabel: "所有设备",
        };
      },
    });

    const command = await service.requestDeviceAction({
      actor: { type: "staff", staffId: "staff-1" },
      type: "power.off",
      target: { kind: "facility", ref: "all" },
    });

    expect(command).toMatchObject({
      deviceId: null,
      targetKind: "facility",
      payload: { deviceLabel: "所有设备" },
    });
  });
});

async function resolveTestFacilityTarget(deviceRef: string) {
  expect(deviceRef).toBe("maimai");
  return {
    target: { kind: "facility", id: "switch.maimai" } as const,
    deviceLabel: "Maimai Switch",
  };
}

function activeSession(): Session {
  return {
    id: "session-1",
    playerId: "player-1",
    startedAt: new Date("2026-08-15T09:00:00.000Z"),
    status: "active",
    pricingConfigIds: ["music"],
    paymentStatus: "unpaid",
  };
}

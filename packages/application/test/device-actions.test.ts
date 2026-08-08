import { describe, expect, it } from "bun:test";
import type {
  DeviceCommand,
  DeviceCommandRepository,
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

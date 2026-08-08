import { describe, expect, it } from "bun:test";
import type {
  DeviceCommand,
  DeviceCommandRepository,
  MachineConnection,
  MachineConnectionRepository,
} from "@prism/core";
import { createMachineConnectionService } from "../src/index";

class MemoryMachineConnectionRepository implements MachineConnectionRepository {
  connections = new Map<string, MachineConnection>();

  async save(connection: MachineConnection): Promise<void> {
    this.connections.set(connection.machineId, connection);
  }

  async findByMachineId(machineId: string): Promise<MachineConnection | null> {
    return this.connections.get(machineId) ?? null;
  }

  async listAll(): Promise<MachineConnection[]> {
    return [...this.connections.values()];
  }
}

class MemoryDeviceCommandRepository implements DeviceCommandRepository {
  commands = new Map<string, DeviceCommand>();

  constructor(commands: DeviceCommand[] = []) {
    for (const command of commands) this.commands.set(command.id, command);
  }

  async enqueueDeviceCommand(command: DeviceCommand): Promise<void> {
    this.commands.set(command.id, command);
  }

  async getDeviceCommand(commandId: string): Promise<DeviceCommand | null> {
    return this.commands.get(commandId) ?? null;
  }

  async listByPlayerId(playerId: string): Promise<DeviceCommand[]> {
    return [...this.commands.values()].filter((command) => command.playerId === playerId);
  }

  async listPending(limit: number): Promise<DeviceCommand[]> {
    return [...this.commands.values()]
      .filter((command) => command.status === "pending")
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit);
  }
}

describe("createMachineConnectionService", () => {
  it("records hello capabilities and delivers matching pending commands", async () => {
    const machineConnections = new MemoryMachineConnectionRepository();
    const deviceCommands = new MemoryDeviceCommandRepository([
      pendingCommand({
        id: "command-1",
        type: "coin",
        deviceId: "maimai-dx-1",
        requestedAt: new Date("2026-07-07T10:00:00.000Z"),
      }),
      pendingCommand({
        id: "command-2",
        type: "aime.scan",
        deviceId: "maimai-dx-2",
        requestedAt: new Date("2026-07-07T10:01:00.000Z"),
      }),
      pendingCommand({
        id: "command-3",
        type: "aime.scan",
        deviceId: "maimai-dx-1",
        requestedAt: new Date("2026-07-07T10:02:00.000Z"),
      }),
    ]);
    const service = createMachineConnectionService({
      machineConnections,
      deviceCommands,
      now: () => new Date("2026-07-07T10:05:00.000Z"),
      commandTtlMs: 30_000,
    });

    await expect(
      service.hello({
        machineId: "maimai-dx-1",
        capabilities: ["coin", "coin", "aime.scan"],
      }),
    ).resolves.toEqual({
      machineId: "maimai-dx-1",
      status: "online",
      capabilities: ["coin", "aime.scan"],
      connectedAt: new Date("2026-07-07T10:05:00.000Z"),
      lastSeenAt: new Date("2026-07-07T10:05:00.000Z"),
      disconnectedAt: undefined,
    });

    await expect(service.listDeliverableCommands({ machineId: "maimai-dx-1", limit: 10 })).resolves.toEqual([
      {
        type: "command",
        commandId: "command-1",
        action: "coin",
        payload: { count: 1 },
        expiresAt: new Date("2026-07-07T10:00:30.000Z"),
      },
      {
        type: "command",
        commandId: "command-3",
        action: "aime.scan",
        payload: { count: 1 },
        expiresAt: new Date("2026-07-07T10:02:30.000Z"),
      },
    ]);
  });

  it("marks command success and failed acknowledgements", async () => {
    const machineConnections = new MemoryMachineConnectionRepository();
    const deviceCommands = new MemoryDeviceCommandRepository([
      pendingCommand({ id: "command-1", type: "coin", deviceId: "maimai-dx-1" }),
      pendingCommand({ id: "command-2", type: "coin", deviceId: "maimai-dx-1" }),
    ]);
    const service = createMachineConnectionService({
      machineConnections,
      deviceCommands,
      now: () => new Date("2026-07-07T10:05:00.000Z"),
      commandTtlMs: 30_000,
    });
    await service.hello({ machineId: "maimai-dx-1", capabilities: ["coin"] });

    await expect(
      service.ack({
        machineId: "maimai-dx-1",
        commandId: "command-1",
        status: "success",
      }),
    ).resolves.toMatchObject({
      id: "command-1",
      status: "acked",
      ackedAt: new Date("2026-07-07T10:05:00.000Z"),
    });

    await expect(
      service.ack({
        machineId: "maimai-dx-1",
        commandId: "command-2",
        status: "failed",
        message: "coin controller timeout",
      }),
    ).resolves.toMatchObject({
      id: "command-2",
      status: "expired",
      expiredAt: new Date("2026-07-07T10:05:00.000Z"),
      payload: {
        count: 1,
        machineAck: {
          status: "failed",
          message: "coin controller timeout",
        },
      },
    });
  });

  it("marks a connected machine offline on disconnect", async () => {
    const service = createMachineConnectionService({
      machineConnections: new MemoryMachineConnectionRepository(),
      deviceCommands: new MemoryDeviceCommandRepository(),
      now: () => new Date("2026-07-07T10:05:00.000Z"),
      commandTtlMs: 30_000,
    });
    await service.hello({ machineId: "maimai-dx-1", capabilities: ["coin"] });

    await expect(service.disconnect({ machineId: "maimai-dx-1" })).resolves.toEqual({
      machineId: "maimai-dx-1",
      status: "offline",
      capabilities: ["coin"],
      connectedAt: new Date("2026-07-07T10:05:00.000Z"),
      lastSeenAt: new Date("2026-07-07T10:05:00.000Z"),
      disconnectedAt: new Date("2026-07-07T10:05:00.000Z"),
    });
  });

  it("refreshes a machine heartbeat", async () => {
    let now = new Date("2026-07-07T10:05:00.000Z");
    const service = createMachineConnectionService({
      machineConnections: new MemoryMachineConnectionRepository(),
      deviceCommands: new MemoryDeviceCommandRepository(),
      now: () => now,
      commandTtlMs: 30_000,
    });
    await service.hello({ machineId: "maimai-dx-1", capabilities: ["coin"] });
    now = new Date("2026-07-07T10:06:00.000Z");

    await expect(service.heartbeat({ machineId: "maimai-dx-1" })).resolves.toMatchObject({
      machineId: "maimai-dx-1",
      status: "online",
      lastSeenAt: new Date("2026-07-07T10:06:00.000Z"),
    });
  });
});

function pendingCommand(input: {
  id: string;
  type: DeviceCommand["type"];
  deviceId: string;
  requestedAt?: Date;
}): DeviceCommand {
  return {
    id: input.id,
    type: input.type,
    deviceId: input.deviceId,
    targetKind: "game_machine",
    executorKind: "machine_ws",
    playerId: "player-1",
    status: "pending",
    payload: { count: 1 },
    requestedAt: input.requestedAt ?? new Date("2026-07-07T10:00:00.000Z"),
  };
}

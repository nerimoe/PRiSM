import type {
  DeviceCommand,
  DeviceCommandRepository,
  MachineConnection,
  MachineConnectionRepository,
} from "@prism/core";
import { ackDeviceCommand, expireDeviceCommand, PrismDomainError } from "@prism/core";

export type MachineHelloInput = {
  machineId: string;
  capabilities: string[];
};

export type MachineAckInput = {
  machineId: string;
  commandId: string;
  status: "success" | "failed";
  message?: string;
};

export type MachineCommandMessage = {
  type: "command";
  commandId: string;
  action: DeviceCommand["type"];
  payload?: Record<string, unknown>;
  expiresAt: Date;
};

export type MachineConnectionServiceDependencies = {
  machineConnections: MachineConnectionRepository;
  deviceCommands: DeviceCommandRepository;
  now: () => Date;
  commandTtlMs: number;
};

export type MachineConnectionService = {
  hello(input: MachineHelloInput): Promise<MachineConnection>;
  heartbeat(input: { machineId: string }): Promise<MachineConnection>;
  disconnect(input: { machineId: string }): Promise<MachineConnection>;
  listDeliverableCommands(input: { machineId: string; limit: number }): Promise<MachineCommandMessage[]>;
  ack(input: MachineAckInput): Promise<DeviceCommand>;
};

export function createMachineConnectionService(
  dependencies: MachineConnectionServiceDependencies,
): MachineConnectionService {
  return {
    async hello(input) {
      const now = dependencies.now();
      const connection: MachineConnection = {
        machineId: input.machineId,
        status: "online",
        capabilities: [...new Set(input.capabilities.map((capability) => capability.trim()).filter(Boolean))],
        connectedAt: now,
        lastSeenAt: now,
        disconnectedAt: undefined,
      };
      await dependencies.machineConnections.save(connection);
      return connection;
    },

    async heartbeat(input) {
      const existing = await dependencies.machineConnections.findByMachineId(input.machineId);
      if (!existing) {
        throw new PrismDomainError("Machine connection was not found.", "MACHINE_CONNECTION_NOT_FOUND");
      }
      const connection: MachineConnection = {
        ...existing,
        status: "online",
        lastSeenAt: dependencies.now(),
        disconnectedAt: undefined,
      };
      await dependencies.machineConnections.save(connection);
      return connection;
    },

    async disconnect(input) {
      const existing = await dependencies.machineConnections.findByMachineId(input.machineId);
      if (!existing) {
        throw new PrismDomainError("Machine connection was not found.", "MACHINE_CONNECTION_NOT_FOUND");
      }
      const now = dependencies.now();
      const connection: MachineConnection = {
        ...existing,
        status: "offline",
        lastSeenAt: now,
        disconnectedAt: now,
      };
      await dependencies.machineConnections.save(connection);
      return connection;
    },

    async listDeliverableCommands(input) {
      const connection = await dependencies.machineConnections.findByMachineId(input.machineId);
      if (!connection || connection.status !== "online") {
        throw new PrismDomainError("Machine is not online.", "MACHINE_NOT_ONLINE");
      }

      const pending = await dependencies.deviceCommands.listPending(Math.max(input.limit * 4, input.limit));
      return pending
        .filter((command) => command.deviceId === input.machineId)
        .filter((command) => command.targetKind === "game_machine" && command.executorKind === "machine_ws")
        .filter((command) => connection.capabilities.includes(command.type))
        .slice(0, input.limit)
        .map((command) => ({
          type: "command",
          commandId: command.id,
          action: command.type,
          payload: command.payload,
          expiresAt: new Date(command.requestedAt.getTime() + dependencies.commandTtlMs),
        }));
    },

    async ack(input) {
      const command = await dependencies.deviceCommands.getDeviceCommand(input.commandId);
      if (!command) {
        throw new PrismDomainError("Machine command was not found.", "DEVICE_COMMAND_NOT_FOUND");
      }
      if (command.deviceId !== input.machineId || command.executorKind !== "machine_ws") {
        throw new PrismDomainError("Machine command does not belong to this machine.", "MACHINE_COMMAND_NOT_OWNED");
      }

      const now = dependencies.now();
      const updated = input.status === "success"
        ? ackDeviceCommand({ command, now })
        : {
            ...expireDeviceCommand({ command, now }),
            payload: {
              ...(command.payload ?? {}),
              machineAck: {
                status: "failed",
                ...(input.message ? { message: input.message } : {}),
              },
            },
          };
      await dependencies.deviceCommands.enqueueDeviceCommand(updated);
      return updated;
    },
  };
}

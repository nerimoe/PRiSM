import { describe, expect, it } from "bun:test";
import type { PrismAppDependencies } from "../src/index";
import {
  authenticateMachineWebSocketRequest,
  handleMachineWebSocketMessage,
  type MachineWebSocketPeer,
} from "../src/index";

describe("machine websocket protocol", () => {
  it("rejects non-machine tokens", async () => {
    const dependencies = dependenciesWithMachineCommands();

    const response = await authenticateMachineWebSocketRequest(
      new Request("https://prism.example.com/rpc/machine/ws", {
        headers: {
          Authorization: "Bearer integration-token",
        },
      }),
      dependencies,
    );

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(403);
  });

  it("accepts hello and sends pending commands for the machine", async () => {
    const sent: string[] = [];
    const calls: unknown[] = [];
    const dependencies = dependenciesWithMachineCommands({
      async hello(input) {
        calls.push(["hello", input]);
      },
      async listDeliverableCommands(input) {
        calls.push(["list", input]);
        return [
          {
            type: "command",
            commandId: "command-1",
            action: "coin",
            payload: { count: 1 },
            expiresAt: new Date("2026-07-07T10:00:30.000Z"),
          },
        ];
      },
    });
    const auth = await authenticateMachineWebSocketRequest(
      new Request("https://prism.example.com/rpc/machine/ws", {
        headers: {
          Authorization: "Bearer machine-token",
        },
      }),
      dependencies,
    );
    if (auth instanceof Response) throw new Error("machine auth should pass");
    const peer = peerWithSent(sent, auth.data);

    await handleMachineWebSocketMessage(
      peer,
      JSON.stringify({
        type: "hello",
        machineId: "maimai-dx-1",
        capabilities: ["coin"],
      }),
      dependencies,
    );

    expect(peer.data?.machineId).toBe("maimai-dx-1");
    expect(calls).toEqual([
      ["hello", { machineId: "maimai-dx-1", capabilities: ["coin"] }],
      ["list", { machineId: "maimai-dx-1", limit: 20 }],
    ]);
    expect(sent.map((message) => JSON.parse(message))).toEqual([
      {
        type: "hello.ack",
        machineId: "maimai-dx-1",
        status: "online",
      },
      {
        type: "command",
        commandId: "command-1",
        action: "coin",
        payload: { count: 1 },
        expiresAt: "2026-07-07T10:00:30.000Z",
      },
    ]);
  });

  it("passes machine acknowledgements to the connection service", async () => {
    const sent: string[] = [];
    const calls: unknown[] = [];
    const dependencies = dependenciesWithMachineCommands({
      async ack(input) {
        calls.push(input);
        return {
          id: input.commandId,
          type: "coin",
          deviceId: input.machineId,
          targetKind: "game_machine",
          executorKind: "machine_ws",
          status: input.status === "success" ? "acked" : "expired",
          requestedAt: new Date("2026-07-07T10:00:00.000Z"),
        };
      },
    });
    const peer = peerWithSent(sent, { machineId: "maimai-dx-1" });

    await handleMachineWebSocketMessage(
      peer,
      JSON.stringify({
        type: "ack",
        commandId: "command-1",
        status: "failed",
        message: "coin controller timeout",
      }),
      dependencies,
    );

    expect(calls).toEqual([
      {
        machineId: "maimai-dx-1",
        commandId: "command-1",
        status: "failed",
        message: "coin controller timeout",
      },
    ]);
    expect(sent.map((message) => JSON.parse(message))).toEqual([
      {
        type: "ack.received",
        commandId: "command-1",
        status: "expired",
      },
    ]);
  });
});

function peerWithSent(sent: string[], data: Record<string, unknown> = {}): MachineWebSocketPeer {
  return {
    data,
    send(data: string) {
      sent.push(data);
    },
    close() {},
  };
}

function dependenciesWithMachineCommands(
  overrides: Partial<NonNullable<PrismAppDependencies["machineConnectionCommands"]>> = {},
): PrismAppDependencies {
  return {
    playerQueries: {} as PrismAppDependencies["playerQueries"],
    staffQueries: {} as PrismAppDependencies["staffQueries"],
    playerCommands: {} as PrismAppDependencies["playerCommands"],
    staffOperations: {} as PrismAppDependencies["staffOperations"],
    apiTokenAuth: {
      async authenticateApiToken(token) {
        if (token === "integration-token") return { role: "integration" };
        if (token === "machine-token") return { role: "machine" };
        return null;
      },
    },
    machineConnectionCommands: {
      async hello() {},
      async heartbeat() {},
      async disconnect() {},
      async listDeliverableCommands() {
        return [];
      },
      async ack(input) {
        return {
          id: input.commandId,
          type: "coin",
          deviceId: input.machineId,
          targetKind: "game_machine",
          executorKind: "machine_ws",
          status: "acked",
          requestedAt: new Date("2026-07-07T10:00:00.000Z"),
        };
      },
      ...overrides,
    },
  };
}

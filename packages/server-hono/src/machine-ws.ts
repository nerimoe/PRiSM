import { PrismDomainError } from "@prism/core";
import { authenticate } from "./auth";
import type { MachineConnectionCommands, PrismAppDependencies } from "./types";

export type MachineWebSocketData = {
  machineId?: string;
};

export type MachineWebSocketPeer = {
  data?: MachineWebSocketData;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export async function authenticateMachineWebSocketRequest(
  request: Request,
  dependencies: PrismAppDependencies,
): Promise<{ ok: true; data: MachineWebSocketData } | Response> {
  const principal = await authenticate(request.headers.get("Authorization") ?? undefined, undefined, dependencies);
  if (!principal || principal.role !== "machine") {
    return jsonError("FORBIDDEN", "Machine principal required.", 403);
  }
  if (!dependencies.machineConnectionCommands) {
    return jsonError("MACHINE_WEBSOCKET_NOT_CONFIGURED", "Machine WebSocket is not configured.", 503);
  }
  return {
    ok: true,
    data: {},
  };
}

export async function handleMachineWebSocketMessage(
  peer: MachineWebSocketPeer,
  rawMessage: string | Buffer,
  dependencies: PrismAppDependencies,
): Promise<void> {
  const commands = requireMachineConnectionCommands(dependencies);
  const message = parseMachineMessage(rawMessage);

  if (message.type === "hello") {
    const machineId = stringField(message, "machineId");
    const capabilities = arrayOfStringsField(message, "capabilities");
    await commands.hello({ machineId, capabilities });
    peer.data = {
      ...(peer.data ?? {}),
      machineId,
    };
    peer.send(JSON.stringify({
      type: "hello.ack",
      machineId,
      status: "online",
    }));
    await sendPendingCommands(peer, commands, machineId);
    return;
  }

  const machineId = peer.data?.machineId;
  if (!machineId) {
    throw new PrismDomainError("Machine must send hello before other messages.", "MACHINE_HELLO_REQUIRED");
  }

  if (message.type === "ping") {
    await commands.heartbeat({ machineId });
    peer.send(JSON.stringify({
      type: "pong",
      machineId,
    }));
    await sendPendingCommands(peer, commands, machineId);
    return;
  }

  if (message.type === "ack") {
    const commandId = stringField(message, "commandId");
    const status = stringField(message, "status");
    if (status !== "success" && status !== "failed") {
      throw new PrismDomainError("Machine ack status must be success or failed.", "INVALID_MACHINE_ACK_STATUS");
    }
    const updated = await commands.ack({
      machineId,
      commandId,
      status,
      message: optionalStringField(message, "message"),
    });
    peer.send(JSON.stringify({
      type: "ack.received",
      commandId,
      status: updated.status,
    }));
    return;
  }

  throw new PrismDomainError("Unknown machine WebSocket message.", "UNKNOWN_MACHINE_WS_MESSAGE");
}

export async function handleMachineWebSocketClose(
  peer: MachineWebSocketPeer,
  dependencies: PrismAppDependencies,
): Promise<void> {
  const machineId = peer.data?.machineId;
  if (!machineId || !dependencies.machineConnectionCommands) return;
  await dependencies.machineConnectionCommands.disconnect({ machineId });
}

async function sendPendingCommands(
  peer: MachineWebSocketPeer,
  commands: MachineConnectionCommands,
  machineId: string,
): Promise<void> {
  const pending = await commands.listDeliverableCommands({ machineId, limit: 20 });
  for (const command of pending) {
    peer.send(JSON.stringify({
      type: "command",
      commandId: command.commandId,
      action: command.action,
      ...(command.payload === undefined ? {} : { payload: command.payload }),
      expiresAt: command.expiresAt.toISOString(),
    }));
  }
}

function requireMachineConnectionCommands(dependencies: PrismAppDependencies): MachineConnectionCommands {
  if (!dependencies.machineConnectionCommands) {
    throw new PrismDomainError("Machine WebSocket is not configured.", "MACHINE_WEBSOCKET_NOT_CONFIGURED");
  }
  return dependencies.machineConnectionCommands;
}

function parseMachineMessage(rawMessage: string | Buffer): Record<string, unknown> {
  const text = typeof rawMessage === "string" ? rawMessage : rawMessage.toString("utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PrismDomainError("Machine WebSocket message must be an object.", "INVALID_MACHINE_WS_MESSAGE");
  }
  return parsed as Record<string, unknown>;
}

function stringField(message: Record<string, unknown>, field: string): string {
  const value = message[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new PrismDomainError(`Machine WebSocket field ${field} is required.`, "INVALID_MACHINE_WS_MESSAGE");
  }
  return value.trim();
}

function optionalStringField(message: Record<string, unknown>, field: string): string | undefined {
  const value = message[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayOfStringsField(message: Record<string, unknown>, field: string): string[] {
  const value = message[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new PrismDomainError(`Machine WebSocket field ${field} must be a string array.`, "INVALID_MACHINE_WS_MESSAGE");
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function jsonError(code: string, message: string, status: 403 | 503): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

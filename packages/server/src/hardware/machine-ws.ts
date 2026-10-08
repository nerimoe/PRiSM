import { type DeviceCommand, PrismDomainError } from "@prism/core";

export type MachineWebSocketData = {
  machineId?: string;
};

export type MachineWebSocketPeer = {
  data?: MachineWebSocketData;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type MachineCommandMessage = {
  type: "command";
  commandId: string;
  action: DeviceCommand["type"];
  payload?: Record<string, unknown>;
  expiresAt: Date;
};

export type MachineConnectionCommands = {
  hello(input: { machineId: string; capabilities: string[] }): Promise<unknown>;
  heartbeat(input: { machineId: string }): Promise<unknown>;
  disconnect(input: { machineId: string }): Promise<unknown>;
  listDeliverableCommands(input: { machineId: string; limit: number }): Promise<MachineCommandMessage[]>;
  ack(input: {
    machineId: string;
    commandId: string;
    status: "success" | "failed";
    message?: string;
  }): Promise<DeviceCommand>;
};

export type MachineWebSocketDependencies = {
  machineConnectionCommands?: MachineConnectionCommands;
  apiTokenAuth?: {
    authenticateApiToken(token: string): Promise<{ role: string } | null>;
  };
  adminAuth?: {
    authenticateAdminSession(token: string): Promise<unknown>;
  };
  playerSessionAuth?: {
    authenticatePlayerSession(token: string): Promise<unknown>;
  };
  authenticatedPrincipal?: { role: string };
};

export async function authenticateMachineWebSocketRequest(
  request: Request,
  dependencies: MachineWebSocketDependencies,
): Promise<{ ok: true; data: MachineWebSocketData } | Response> {
  const principal = await authenticateMachineToken(
    request.headers.get("Authorization") ?? undefined,
    dependencies,
  );
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
  dependencies: MachineWebSocketDependencies,
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
    peer.send(
      JSON.stringify({
        type: "hello.ack",
        machineId,
        status: "online",
      }),
    );
    await sendPendingCommands(peer, commands, machineId);
    return;
  }

  const machineId = peer.data?.machineId;
  if (!machineId) {
    throw new PrismDomainError("Machine must send hello before other messages.", "MACHINE_HELLO_REQUIRED");
  }

  if (message.type === "ping") {
    await commands.heartbeat({ machineId });
    peer.send(
      JSON.stringify({
        type: "pong",
        machineId,
      }),
    );
    await sendPendingCommands(peer, commands, machineId);
    return;
  }

  if (message.type === "ack") {
    const commandId = stringField(message, "commandId");
    const status = stringField(message, "status");
    if (status !== "success" && status !== "failed") {
      throw new PrismDomainError(
        "Machine ack status must be success or failed.",
        "INVALID_MACHINE_ACK_STATUS",
      );
    }
    const updated = await commands.ack({
      machineId,
      commandId,
      status,
      message: optionalStringField(message, "message"),
    });
    peer.send(
      JSON.stringify({
        type: "ack.received",
        commandId,
        status: updated.status,
      }),
    );
    return;
  }

  throw new PrismDomainError("Unknown machine WebSocket message.", "UNKNOWN_MACHINE_WS_MESSAGE");
}

export async function handleMachineWebSocketClose(
  peer: MachineWebSocketPeer,
  dependencies: MachineWebSocketDependencies,
): Promise<void> {
  const machineId = peer.data?.machineId;
  if (!machineId || !dependencies.machineConnectionCommands) return;
  await dependencies.machineConnectionCommands.disconnect({ machineId });
}

export function createMachineWebSocketHandler(dependencies: MachineWebSocketDependencies) {
  return {
    authenticate: (request: Request) => authenticateMachineWebSocketRequest(request, dependencies),
    handleMessage: (peer: MachineWebSocketPeer, rawMessage: string | Buffer) =>
      handleMachineWebSocketMessage(peer, rawMessage, dependencies),
    handleClose: (peer: MachineWebSocketPeer) => handleMachineWebSocketClose(peer, dependencies),
  };
}

export const machineWebSocketHandler = {
  authenticate: authenticateMachineWebSocketRequest,
  handleMessage: handleMachineWebSocketMessage,
  handleClose: handleMachineWebSocketClose,
  create: createMachineWebSocketHandler,
};

async function authenticateMachineToken(
  authorization: string | undefined,
  dependencies: MachineWebSocketDependencies,
): Promise<{ role: string } | null> {
  if (dependencies.authenticatedPrincipal) return dependencies.authenticatedPrincipal;
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;

  const apiToken = await dependencies.apiTokenAuth?.authenticateApiToken(token);
  if (apiToken) {
    return { role: apiToken.role };
  }

  return null;
}

async function sendPendingCommands(
  peer: MachineWebSocketPeer,
  commands: MachineConnectionCommands,
  machineId: string,
): Promise<void> {
  const pending = await commands.listDeliverableCommands({ machineId, limit: 20 });
  for (const command of pending) {
    peer.send(
      JSON.stringify({
        type: "command",
        commandId: command.commandId,
        action: command.action,
        ...(command.payload === undefined ? {} : { payload: command.payload }),
        expiresAt: command.expiresAt.toISOString(),
      }),
    );
  }
}

function requireMachineConnectionCommands(
  dependencies: MachineWebSocketDependencies,
): MachineConnectionCommands {
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
    throw new PrismDomainError(
      `Machine WebSocket field ${field} is required.`,
      "INVALID_MACHINE_WS_MESSAGE",
    );
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
    throw new PrismDomainError(
      `Machine WebSocket field ${field} must be a string array.`,
      "INVALID_MACHINE_WS_MESSAGE",
    );
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

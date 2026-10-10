import { describe, expect, it } from "bun:test";
import type { DeviceCommand } from "@prism/core";
import type { TTLockConnectionConfig } from "@prism/application";
import {
  createHinataExecutor,
  createHinataIoExecutor,
  decryptHinataIoMessage,
  encryptHinataIoMessage,
  normalizeHinataUrl,
  resolveHinataIoDeviceRef,
  sendHinataCard,
  sendHinataCoin,
} from "../src/hardware/hinata.js";
import {
  createTtlockExecutor,
  createTTLockExecutor,
  queryTTLockDeviceState,
  resolveTTLockDeviceRef,
  TTLockClient,
  unlockTtlockDoor,
} from "../src/hardware/ttlock.js";
import {
  createHomeAssistantExecutor,
  executeHomeAssistantAction,
  getHomeAssistantEntityState,
  resolveHomeAssistantDeviceRef,
} from "../src/hardware/home-assistant.js";
import {
  authenticateMachineWebSocketRequest,
  handleMachineWebSocketClose,
  handleMachineWebSocketMessage,
  machineWebSocketHandler,
  type MachineWebSocketPeer,
} from "../src/hardware/machine-ws.js";

const hinataDevice = {
  id: "maimai-left",
  name: "舞萌 DX 左机",
  aliases: ["舞萌左机", "mai-left"],
  url: "https://relay.example/maimai-left",
  password: "test-remote-password",
  salt: "ABEiM0RVZneImaq7zN3u_w",
  coinKey: 32,
  cardType: "aime",
};

describe("Hinata IO encryption", () => {
  it("matches the Rust and Dart E2EE_V1 fixture", async () => {
    const envelope = await encryptHinataIoMessage({
      password: "test-remote-password",
      salt: "ABEiM0RVZneImaq7zN3u_w",
      nonce: Uint8Array.from([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4]),
      messageId: "00000000-0000-4000-8000-000000000001",
      expiresAt: 1_700_000_000_123,
      message: { action: "KEY_PRESS", body: { key: 32, count: 1 } },
    });

    expect(envelope).toEqual({
      action: "E2EE_V1",
      body: {
        salt: "ABEiM0RVZneImaq7zN3u_w",
        nonce: "Dw4NDAsKCQgHBgUE",
        message_id: "00000000-0000-4000-8000-000000000001",
        expires_at: 1_700_000_000_123,
        ciphertext: "2boPibGx_ErUB0K-8w2NPYaA6IK549jlVYQcZHoi_RAolCk7w8ktNj2WuKpVNftgGxS_08ksxVs97mw5l2Y-6JVv",
      },
    });

    const decrypted = await decryptHinataIoMessage("test-remote-password", envelope);
    expect(decrypted).toEqual({
      action: "KEY_PRESS",
      body: { key: 32, count: 1 },
    });
  });

  it("supports deterministic salt derivation and roundtrip decryption", async () => {
    const envelope = await encryptHinataIoMessage({
      password: "my-secret-password",
      message: { action: "PING" },
      version: "v2",
    });

    expect(envelope.action).toBe("E2EE_V2");
    expect((envelope.body as Record<string, unknown>).salt).toBeDefined();

    const decrypted = await decryptHinataIoMessage("my-secret-password", envelope);
    expect(decrypted).toEqual({ action: "PING" });
  });

  it("normalizes Hinata URLs properly", () => {
    expect(normalizeHinataUrl("ws://relay.example:8080/path/")).toBe("http://relay.example:8080/path");
    expect(normalizeHinataUrl("wss://relay.example/sub/")).toBe("https://relay.example/sub");
    expect(normalizeHinataUrl("https://relay.example/")).toBe("https://relay.example");
  });
});

describe("Hinata executor and direct send functions", () => {
  it("posts encrypted coin key events to the non-replay event endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const executor = createHinataExecutor({
      devices: [hinataDevice],
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return new Response("success");
      },
      now: () => new Date(1_700_000_000_000),
      id: () => "00000000-0000-4000-8000-000000000001",
      nonce: () => Uint8Array.from([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4]),
    });

    const result = await executor.execute({
      command: {
        id: "cmd-coin-1",
        type: "coin",
        deviceId: "maimai-left",
        targetKind: "game_machine",
        executorKind: "hinata_io",
        playerId: "p1",
        status: "pending",
        payload: { count: 2 },
        requestedAt: new Date(),
      },
    });

    expect(result).toEqual({ status: "success" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://relay.example/maimai-left/event");
    const envelope = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    const decrypted = await decryptHinataIoMessage(hinataDevice.password, envelope);
    expect(decrypted).toEqual({
      action: "KEY_PRESS",
      body: { key: 32, count: 2 },
    });
  });

  it("posts the player card as a disposable encrypted state", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const executor = createHinataIoExecutor({
      devices: [hinataDevice],
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return new Response("success");
      },
      id: () => "00000000-0000-4000-8000-000000000002",
      nonce: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    });

    const result = await executor.execute({
      command: {
        id: "cmd-card-1",
        type: "aime.scan",
        deviceId: "maimai-left",
        targetKind: "game_machine",
        executorKind: "hinata_io",
        playerId: "p1",
        status: "pending",
        payload: { provider: "aime", subject: "01234567890123456789" },
        requestedAt: new Date(),
      },
    });

    expect(result).toEqual({ status: "success" });
    expect(requests[0]?.url).toBe("https://relay.example/maimai-left");
    const envelope = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    const decrypted = await decryptHinataIoMessage(hinataDevice.password, envelope);
    expect(decrypted).toEqual({
      action: "SET_CARD",
      body: {
        type: "aime",
        value: "01234567890123456789",
        disposable: true,
      },
    });
  });

  it("records an offline relay as a failed execution", async () => {
    const executor = createHinataExecutor({
      devices: [hinataDevice],
      fetch: async () => new Response("No active client connected", { status: 404 }),
    });

    const result = await executor.execute({
      command: {
        id: "cmd-coin-2",
        type: "coin",
        deviceId: "maimai-left",
        targetKind: "game_machine",
        executorKind: "hinata_io",
        playerId: "p1",
        status: "pending",
        payload: { count: 1 },
        requestedAt: new Date(),
      },
    });

    expect(result).toEqual({
      status: "failed",
      message: "Hinata IO 没有在线客户端。",
    });
  });

  it("resolves Hinata devices by name or alias", () => {
    expect(resolveHinataIoDeviceRef("舞萌左机", [hinataDevice])?.id).toBe("maimai-left");
    expect(resolveHinataIoDeviceRef("舞萌 DX 左机", [hinataDevice])?.id).toBe("maimai-left");
    expect(resolveHinataIoDeviceRef("maimai-left", [hinataDevice])).toBeNull();
  });

  it("sendHinataCard sends encrypted payload when password is provided and plaintext fallback when not", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("OK", { status: 200 });
    }) as typeof fetch;

    const resEncrypted = await sendHinataCard(
      "https://relay.example/mai",
      "999888777",
      "pwd-123",
      "op-1",
      { fetcher: mockFetch },
    );
    expect(resEncrypted.ok).toBe(true);

    const resPlain = await sendHinataCard(
      "https://relay.example/mai",
      "999888777",
      null,
      "op-2",
      { fetcher: mockFetch },
    );
    expect(resPlain.ok).toBe(true);
    expect(calls[1].body).toEqual({ type: "aime", value: "999888777" });
  });

  it("sendHinataCoin validates keys and sends encrypted event payload", async () => {
    const badKey = await sendHinataCoin("https://relay.example/mai", 0, "pwd");
    expect(badKey.ok).toBe(false);
    expect(badKey.status).toBe(400);

    const noPwd = await sendHinataCoin("https://relay.example/mai", 32, null);
    expect(noPwd.ok).toBe(false);
    expect(noPwd.status).toBe(400);

    let sentUrl = "";
    const mockFetch = (async (url: string | URL | Request) => {
      sentUrl = String(url);
      return new Response("OK", { status: 200 });
    }) as typeof fetch;

    const good = await sendHinataCoin("https://relay.example/mai", 32, "pwd", "op-coin", {
      fetcher: mockFetch,
    });
    expect(good.ok).toBe(true);
    expect(sentUrl).toBe("https://relay.example/mai/event");
  });
});

const ttlockConnection = {
  baseUrl: "https://api.sciener.com",
  clientId: "client-id",
  clientSecret: "client-secret",
  appAccount: "15517998347",
  appPwd: "password",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  accessTokenExpiresAt: null,
};

const ttlockDevice = {
  id: "front-door",
  name: "前门",
  aliases: ["door", "门禁"],
  lockId: 25356943,
};

describe("TTLock driver & executor", () => {
  it("resolves configured names and aliases", () => {
    expect(resolveTTLockDeviceRef("门禁", [ttlockDevice])).toEqual(ttlockDevice);
    expect(resolveTTLockDeviceRef("DOOR", [ttlockDevice])).toEqual(ttlockDevice);
    expect(resolveTTLockDeviceRef("25356943", [ttlockDevice])).toBeNull();
  });

  it("creates a random temporary password for a configured lock", async () => {
    const requests: Request[] = [];
    const executor = createTtlockExecutor({
      connection: ttlockConnection,
      devices: [ttlockDevice],
      now: () => new Date("2026-09-07T00:00:00.000Z"),
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        requests.push(new Request(url, init));
        return Response.json({ errcode: 0, keyboardPwdId: 987654321 });
      },
    });

    const result = await executor.execute({
      command: {
        id: "cmd-ttlock-1",
        type: "door.open",
        deviceId: "front-door",
        targetKind: "facility",
        executorKind: "ttlock",
        status: "pending",
        requestedAt: new Date("2026-09-07T00:00:00.000Z"),
      },
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.payload?.temporaryPassword).toMatch(/^\d{8}$/);
      expect(result.payload?.keyboardPwdId).toBe(987654321);
      expect(result.payload?.temporaryPasswordExpiresAt).toBe("2026-09-07T00:03:00.000Z");
    }
  });

  it("refreshes expired token and invokes onConnectionUpdated callback", async () => {
    const requests: Request[] = [];
    let updatedConnection: TTLockConnectionConfig | undefined;
    const client = new TTLockClient({
      connection: ttlockConnection,
      fetcher: async (url: string | URL | Request, init?: RequestInit) => {
        const request = new Request(url, init);
        requests.push(request);
        if (request.url.endsWith("/oauth2/token")) {
          return Response.json({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 7776000,
          });
        }
        if (request.url.endsWith("/v3/keyboardPwd/add")) {
          const body = await request.text();
          return body.includes("accessToken=new-access-token")
            ? Response.json({ errcode: 0, keyboardPwdId: 1 })
            : Response.json({ errcode: 10004, errmsg: "invalid grant" });
        }
        return Response.json({ errcode: 10004, errmsg: "invalid grant" });
      },
      now: () => new Date("2026-09-07T00:00:00.000Z"),
      onConnectionUpdated: (next: TTLockConnectionConfig) => {
        updatedConnection = next;
      },
    });

    await expect(client.addTemporaryPassword(ttlockDevice.lockId, "12345678", "test")).resolves.toEqual({
      keyboardPwdId: 1,
    });
    expect(updatedConnection?.accessToken).toBe("new-access-token");
  });

  it("unlockTtlockDoor and queryTTLockDeviceState function correctly", async () => {
    const client = new TTLockClient({
      connection: ttlockConnection,
      fetcher: async (url: string | URL | Request) => {
        if (String(url).endsWith("/v3/lock/queryOpenState")) {
          return Response.json({ state: 1 });
        }
        return Response.json({ errcode: 0 });
      },
    });

    await expect(queryTTLockDeviceState(client, ttlockDevice)).resolves.toEqual({ state: 1 });

    const unlockResult = await unlockTtlockDoor({
      connection: ttlockConnection,
      lockId: ttlockDevice.lockId,
      fetch: async () => Response.json({ errcode: 0, msg: "unlocked" }),
    });
    expect(unlockResult.errcode).toBe(0);
  });
});

describe("Home Assistant driver & executor", () => {
  it("maps power.on to switch.turn_on service call", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const executor = createHomeAssistantExecutor({
      baseUrl: "https://ha.example.com/",
      accessToken: "ha-token",
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return Response.json([{ changed: true }]);
      },
    });

    const result = await executor.execute({
      command: {
        id: "cmd-ha-1",
        type: "power.on",
        deviceId: "switch.maimai_dx",
        targetKind: "facility",
        executorKind: "home_assistant",
        status: "pending",
        requestedAt: new Date(),
      },
    });

    expect(result).toEqual({ status: "success" });
    expect(calls[0]?.url).toBe("https://ha.example.com/api/services/switch/turn_on");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ entity_id: "switch.maimai_dx" });
  });

  it("handles climate and lock commands", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const executor = createHomeAssistantExecutor({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json([]);
      },
    });

    await executor.execute({
      command: {
        id: "cmd-ac",
        type: "ac.set_temperature",
        deviceId: "climate.room",
        targetKind: "facility",
        executorKind: "home_assistant",
        status: "pending",
        payload: { temperature: 25 },
        requestedAt: new Date(),
      },
    });

    expect(calls[0]?.url).toBe("https://ha.example.com/api/services/climate/set_temperature");
    expect(calls[0]?.body).toEqual({ entity_id: "climate.room", temperature: 25 });
  });

  it("operates all devices and skips duplicates", async () => {
    const calls: string[] = [];
    const executor = createHomeAssistantExecutor({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      devices: [
        { name: "d1", id: "switch.d1" },
        { name: "d2", id: "switch.d2" },
        { name: "d1-dup", id: "switch.d1" },
      ],
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { entity_id: string };
        calls.push(body.entity_id);
        return Response.json([]);
      },
    });

    const res = await executor.execute({
      command: {
        id: "cmd-all",
        type: "power.off",
        deviceId: null,
        targetKind: "facility",
        executorKind: "home_assistant",
        status: "pending",
        requestedAt: new Date(),
      },
    });

    expect(res).toEqual({ status: "success" });
    expect(calls).toEqual(["switch.d1", "switch.d2"]);
  });

  it("executeHomeAssistantAction directly executes actions and getHomeAssistantEntityState reads state", async () => {
    const res = await executeHomeAssistantAction({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      entityId: "switch.light",
      action: "power.on",
      fetch: async () => Response.json({ success: true }),
    });
    expect(res.ok).toBe(true);

    const state = await getHomeAssistantEntityState({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      entityId: "switch.light",
      fetch: async () => Response.json({ state: "on" }),
    });
    expect(state).toBe("on");
  });

  it("resolves device references", () => {
    const devices = [{ name: "wacca", alias: ["wc"], id: "switch.wacca" }];
    expect(resolveHomeAssistantDeviceRef("wc", devices)).toEqual(devices[0]);
    expect(resolveHomeAssistantDeviceRef("unknown", devices)).toBeNull();
  });
});

describe("Machine WebSocket handler", () => {
  function createTestPeer(sent: string[], data: Record<string, unknown> = {}): MachineWebSocketPeer {
    return {
      data,
      send(msg: string) {
        sent.push(msg);
      },
      close() {},
    };
  }

  it("authenticates valid machine tokens and rejects unauthorized", async () => {
    const deps = {
      apiTokenAuth: {
        async authenticateApiToken(token: string) {
          if (token === "token-mach") return { role: "machine", machineId: "mach-1" };
          return { role: "player" };
        },
      },
      machineConnectionCommands: {
        async hello() {},
        async heartbeat() {},
        async disconnect() {},
        async listDeliverableCommands() {
          return [];
        },
        async ack() {
          return {} as DeviceCommand;
        },
      },
    };

    const forbidden = await authenticateMachineWebSocketRequest(
      new Request("https://example.com/ws", {
        headers: { Authorization: "Bearer bad-token" },
      }),
      deps,
    );
    expect(forbidden).toBeInstanceOf(Response);
    expect((forbidden as Response).status).toBe(403);

    const ok = await authenticateMachineWebSocketRequest(
      new Request("https://example.com/ws", {
        headers: { Authorization: "Bearer token-mach" },
      }),
      deps,
    );
    expect((ok as { ok: boolean }).ok).toBe(true);
    expect((ok as { data: { authorizedMachineId: string } }).data.authorizedMachineId).toBe("mach-1");
  });

  it("processes hello, ping, and ack messages", async () => {
    const sent: string[] = [];
    const calls: string[] = [];
    const deps = {
      machineConnectionCommands: {
        async hello(input: { machineId: string }) {
          calls.push(`hello:${input.machineId}`);
        },
        async heartbeat(input: { machineId: string }) {
          calls.push(`ping:${input.machineId}`);
        },
        async disconnect(input: { machineId: string }) {
          calls.push(`disconnect:${input.machineId}`);
        },
        async listDeliverableCommands() {
          return [
            {
              type: "command" as const,
              commandId: "cmd-ws-1",
              action: "coin" as DeviceCommand["type"],
              expiresAt: new Date("2026-07-07T10:00:00.000Z"),
            },
          ];
        },
        async ack(input: { commandId: string; status: "success" | "failed" }) {
          calls.push(`ack:${input.commandId}:${input.status}`);
          return { status: "acked" } as DeviceCommand;
        },
      },
    };

    const peer = createTestPeer(sent, { authorizedMachineId: "mach-1" });

    await handleMachineWebSocketMessage(
      peer,
      JSON.stringify({ type: "hello", machineId: "mach-1", capabilities: ["coin"] }),
      deps,
    );

    expect(peer.data?.machineId).toBe("mach-1");
    const otherPeer = createTestPeer([], { authorizedMachineId: "mach-1" });
    await expect(handleMachineWebSocketMessage(
      otherPeer,
      JSON.stringify({ type: "hello", machineId: "another-machine", capabilities: [] }),
      deps,
    )).rejects.toThrow("Machine token does not authorize this machine.");
    expect(sent.map((s) => JSON.parse(s).type)).toEqual(["hello.ack", "command"]);

    await handleMachineWebSocketMessage(peer, JSON.stringify({ type: "ping" }), deps);
    expect(sent.map((s) => JSON.parse(s).type)).toContain("pong");

    await handleMachineWebSocketMessage(
      peer,
      JSON.stringify({ type: "ack", commandId: "cmd-ws-1", status: "success" }),
      deps,
    );
    expect(sent.map((s) => JSON.parse(s).type)).toContain("ack.received");

    await handleMachineWebSocketClose(peer, deps);
    expect(calls).toContain("disconnect:mach-1");
  });

  it("exports machineWebSocketHandler facade", () => {
    expect(machineWebSocketHandler.authenticate).toBe(authenticateMachineWebSocketRequest);
    expect(machineWebSocketHandler.handleMessage).toBe(handleMachineWebSocketMessage);
    expect(machineWebSocketHandler.handleClose).toBe(handleMachineWebSocketClose);
  });
});

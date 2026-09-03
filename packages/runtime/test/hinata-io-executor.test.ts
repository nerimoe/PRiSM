import { describe, expect, it } from "bun:test";
import type { DeviceCommand } from "@prism/core";
import {
  createHinataIoExecutor,
  encryptHinataIoMessage,
  resolveHinataIoDeviceRef,
} from "../src/hinata-io-executor";

const device = {
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
  });
});

describe("createHinataIoExecutor", () => {
  it("posts encrypted coin key events to the non-replay event endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const executor = createHinataIoExecutor({
      devices: [device],
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response("success");
      },
      now: () => new Date(1_700_000_000_000),
      id: () => "00000000-0000-4000-8000-000000000001",
      nonce: () => Uint8Array.from([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4]),
    });

    const result = await executor.execute({ command: command("coin", { count: 2 }) });

    expect(result).toEqual({ status: "success" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://relay.example/maimai-left/event");
    expect(requests[0]?.init?.method).toBe("POST");
    const envelope = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(await decryptEnvelope(envelope, device.password)).toEqual({
      action: "KEY_PRESS",
      body: { key: 32, count: 2 },
    });
    expect((envelope.body as Record<string, unknown>).expires_at).toBe(1_700_000_030_000);
  });

  it("posts the player's bound card as a disposable encrypted state", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const executor = createHinataIoExecutor({
      devices: [device],
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response("success");
      },
      id: () => "00000000-0000-4000-8000-000000000002",
      nonce: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    });

    const result = await executor.execute({
      command: command("aime.scan", {
        provider: "aime",
        subject: "01234567890123456789",
      }),
    });

    expect(result).toEqual({ status: "success" });
    expect(requests[0]?.url).toBe("https://relay.example/maimai-left");
    const envelope = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(await decryptEnvelope(envelope, device.password)).toEqual({
      action: "SET_CARD",
      body: {
        type: "aime",
        value: "01234567890123456789",
        disposable: true,
      },
    });
    expect((envelope.body as Record<string, unknown>).expires_at).toBeNull();
  });

  it("records an offline relay as a failed execution", async () => {
    const executor = createHinataIoExecutor({
      devices: [device],
      fetch: async () => new Response("No active client connected", { status: 404 }),
    });

    await expect(executor.execute({ command: command("coin", { count: 1 }) })).resolves.toEqual({
      status: "failed",
      message: "Hinata IO 没有在线客户端。",
    });
  });
});

describe("Hinata IO configuration", () => {
  it("resolves only player-facing names and aliases", () => {
    expect(resolveHinataIoDeviceRef("舞萌左机", [device])?.id).toBe("maimai-left");
    expect(resolveHinataIoDeviceRef("舞萌 DX 左机", [device])?.id).toBe("maimai-left");
    expect(resolveHinataIoDeviceRef("maimai-left", [device])).toBeNull();
  });
});

function command(type: "coin" | "aime.scan", payload: Record<string, unknown>): DeviceCommand {
  return {
    id: "command-1",
    type,
    deviceId: "maimai-left",
    targetKind: "game_machine",
    executorKind: "hinata_io",
    playerId: "player-1",
    status: "pending",
    payload,
    requestedAt: new Date("2026-08-15T00:00:00.000Z"),
  };
}

async function decryptEnvelope(envelope: Record<string, unknown>, password: string): Promise<unknown> {
  const body = envelope.body as Record<string, unknown>;
  const salt = decodeBase64Url(String(body.salt));
  const nonce = decodeBase64Url(String(body.nonce));
  const ciphertext = decodeBase64Url(String(body.ciphertext));
  const expiresAt = body.expires_at as number | null;
  const aad = new TextEncoder().encode(
    `aimeio-remote-e2ee-v1\n${body.salt}\n${body.message_id}\n${expiresAt ?? ""}`,
  );
  const imported = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations: 600_000 },
    imported,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(aad),
      tagLength: 128,
    },
    key,
    toArrayBuffer(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

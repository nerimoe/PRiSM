import type {
  DeviceActionExecutionInput,
  DeviceActionExecutionResult,
  DeviceActionExecutor,
  HinataIoDeviceConfig,
} from "@prism/application";

const KEY_PRESS_TTL_MS = 30_000;
const MAX_KEY_PRESS_COUNT = 20;
const MAX_KEY_VALUE = 65_535;
const PBKDF2_ITERATIONS = 600_000;

export type HinataIoExecutorInput = {
  devices: readonly HinataIoDeviceConfig[];
  fetch?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  id?: () => string;
  nonce?: () => Uint8Array;
};

export type EncryptHinataIoMessageInput = {
  password: string;
  salt: string;
  message: Record<string, unknown>;
  messageId: string;
  expiresAt: number | null;
  nonce?: Uint8Array;
};

export function createHinataIoExecutor(input: HinataIoExecutorInput): DeviceActionExecutor {
  const fetcher = input.fetch ?? ((url: string | URL | Request, init?: RequestInit) => fetch(url, init));
  const now = input.now ?? (() => new Date());
  const id = input.id ?? (() => crypto.randomUUID());
  const nonce = input.nonce ?? (() => crypto.getRandomValues(new Uint8Array(12)));
  const devicesById = new Map(input.devices.map((device) => [device.id, device]));

  return {
    async execute(executionInput) {
      const command = executionInput.command;
      if (command.executorKind !== "hinata_io" || command.targetKind !== "game_machine" || !command.deviceId) {
        return failed(`Hinata IO cannot execute ${command.type}.`);
      }
      const device = devicesById.get(command.deviceId);
      if (!device) return failed("Hinata IO 设备配置不存在。");

      try {
        if (command.type === "coin") {
          return await sendCoin({ executionInput, device, fetcher, now, id, nonce });
        }
        if (command.type === "aime.scan") {
          return await sendCard({ executionInput, device, fetcher, id, nonce });
        }
        return failed(`Hinata IO cannot execute ${command.type}.`);
      } catch (error) {
        return failed(error instanceof Error ? error.message : "Hinata IO request failed.");
      }
    },
  };
}

export function resolveHinataIoDeviceRef(
  deviceRef: string,
  devices: readonly HinataIoDeviceConfig[],
): HinataIoDeviceConfig | null {
  const target = deviceRef.trim().toLowerCase();
  if (!target) return null;
  return devices.find((device) => {
    if (device.name.trim().toLowerCase() === target) return true;
    return (device.aliases ?? []).some((alias) => alias.trim().toLowerCase() === target);
  }) ?? null;
}

export async function encryptHinataIoMessage(
  input: EncryptHinataIoMessageInput,
): Promise<Record<string, unknown>> {
  if (!input.password) throw new Error("Hinata IO password is required.");
  if (!input.messageId) throw new Error("Hinata IO message id is required.");
  const salt = decodeBase64Url(input.salt, 16, "salt");
  const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  if (nonce.byteLength !== 12) throw new Error("Hinata IO nonce must be 12 bytes.");
  const aad = new TextEncoder().encode(
    `aimeio-remote-e2ee-v1\n${input.salt}\n${input.messageId}\n${input.expiresAt ?? ""}`,
  );
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(aad),
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(JSON.stringify(input.message)),
  );

  return {
    action: "E2EE_V1",
    body: {
      salt: input.salt,
      nonce: encodeBase64Url(nonce),
      message_id: input.messageId,
      expires_at: input.expiresAt,
      ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    },
  };
}

async function sendCoin(input: {
  executionInput: DeviceActionExecutionInput;
  device: HinataIoDeviceConfig;
  fetcher: NonNullable<HinataIoExecutorInput["fetch"]>;
  now: () => Date;
  id: () => string;
  nonce: () => Uint8Array;
}): Promise<DeviceActionExecutionResult> {
  const count = input.executionInput.command.payload?.count ?? 1;
  if (!Number.isInteger(count) || typeof count !== "number" || count < 1 || count > MAX_KEY_PRESS_COUNT) {
    return failed(`投币数量必须是 1 到 ${MAX_KEY_PRESS_COUNT} 的整数。`);
  }
  const coinKey = input.device.coinKey ?? 32;
  if (!Number.isInteger(coinKey) || coinKey < 0 || coinKey > MAX_KEY_VALUE) {
    return failed("投币按键配置无效。");
  }
  const payload = await encryptHinataIoMessage({
    password: input.device.password,
    salt: input.device.salt,
    message: { action: "KEY_PRESS", body: { key: coinKey, count } },
    messageId: input.id(),
    expiresAt: input.now().getTime() + KEY_PRESS_TTL_MS,
    nonce: input.nonce(),
  });
  return postRemote(input.fetcher, eventUrl(input.device.url), payload);
}

async function sendCard(input: {
  executionInput: DeviceActionExecutionInput;
  device: HinataIoDeviceConfig;
  fetcher: NonNullable<HinataIoExecutorInput["fetch"]>;
  id: () => string;
  nonce: () => Uint8Array;
}): Promise<DeviceActionExecutionResult> {
  const provider = stringPayloadField(input.executionInput, "provider").toLowerCase();
  const subject = stringPayloadField(input.executionInput, "subject");
  const expectedProvider = (input.device.cardType ?? "aime").trim().toLowerCase();
  if (provider !== expectedProvider) return failed("该设备不支持这类卡片。");
  const payload = await encryptHinataIoMessage({
    password: input.device.password,
    salt: input.device.salt,
    message: {
      action: "SET_CARD",
      body: { type: provider, value: subject, disposable: true },
    },
    messageId: input.id(),
    expiresAt: null,
    nonce: input.nonce(),
  });
  return postRemote(input.fetcher, stateUrl(input.device.url), payload);
}

async function postRemote(
  fetcher: NonNullable<HinataIoExecutorInput["fetch"]>,
  url: string,
  payload: Record<string, unknown>,
): Promise<DeviceActionExecutionResult> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.ok) return { status: "success" };
  if (response.status === 404) return failed("Hinata IO 没有在线客户端。");
  return failed(`Hinata IO request failed with ${response.status}.`);
}

function stateUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Hinata IO URL must use HTTP or HTTPS.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function eventUrl(value: string): string {
  const url = new URL(stateUrl(value));
  url.pathname = `${url.pathname}/event`;
  return url.toString();
}

function stringPayloadField(input: DeviceActionExecutionInput, field: string): string {
  const value = input.command.payload?.[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Hinata IO ${field} is required.`);
  }
  return value.trim();
}

function failed(message: string): DeviceActionExecutionResult {
  return { status: "failed", message };
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string, length: number, field: string): Uint8Array {
  if (!value || value.includes("=")) throw new Error(`Invalid base64url ${field}.`);
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), "=");
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw new Error(`Invalid base64url ${field}.`);
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== length) throw new Error(`Hinata IO ${field} must be ${length} bytes.`);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

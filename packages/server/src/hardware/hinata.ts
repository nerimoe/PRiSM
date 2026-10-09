import type {
  DeviceActionExecutionInput,
  DeviceActionExecutionResult,
  DeviceActionExecutor,
  HinataIoDeviceConfig,
} from "@prism/application";

const KEY_PRESS_TTL_MS = 30_000;
const MAX_KEY_PRESS_COUNT = 20;
const MAX_KEY_VALUE = 65_535;
const PBKDF2_V1_ITERATIONS = 600_000;
const PBKDF2_V2_ITERATIONS = 20_000;

export type HinataResult = {
  ok: boolean;
  status: number;
  error?: string;
};

export type HinataExecutorInput = {
  devices: readonly HinataIoDeviceConfig[];
  fetch?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  id?: () => string;
  nonce?: () => Uint8Array;
};

export type HinataIoExecutorInput = HinataExecutorInput;

export type EncryptHinataIoMessageInput = {
  password: string;
  salt?: string | null;
  message: Record<string, unknown>;
  messageId?: string;
  expiresAt?: number | null;
  nonce?: Uint8Array;
  version?: "v1" | "v2";
};

const keyCache = new Map<string, Promise<CryptoKey>>();

export function normalizeHinataUrl(targetUrl: string): string {
  let url = targetUrl.trim();
  if (/^wss:\/\//i.test(url)) {
    url = "https://" + url.slice(6);
  } else if (/^ws:\/\//i.test(url)) {
    url = "http://" + url.slice(5);
  }
  return url.replace(/\/+$/, "");
}

export function resolveHinataIoDeviceRef(
  deviceRef: string,
  devices: readonly HinataIoDeviceConfig[],
): HinataIoDeviceConfig | null {
  const target = deviceRef.trim().toLowerCase();
  if (!target) return null;
  return (
    devices.find((device) => {
      if (device.name.trim().toLowerCase() === target) return true;
      return (device.aliases ?? []).some((alias) => alias.trim().toLowerCase() === target);
    }) ?? null
  );
}

export const resolveHinataDeviceRef = resolveHinataIoDeviceRef;

export async function encryptHinataIoMessage(
  input: EncryptHinataIoMessageInput,
): Promise<Record<string, unknown>> {
  if (!input.password) throw new Error("Hinata IO password is required.");
  const version = input.version ?? "v1";
  const iterations = version === "v2" ? PBKDF2_V2_ITERATIONS : PBKDF2_V1_ITERATIONS;
  const action = version === "v2" ? "E2EE_V2" : "E2EE_V1";
  const aadPrefix = version === "v2" ? "aimeio-remote-e2ee-v2" : "aimeio-remote-e2ee-v1";

  let saltBytes: Uint8Array;
  let saltB64: string;
  if (input.salt) {
    saltBytes = decodeBase64Url(input.salt, 16, "salt");
    saltB64 = input.salt;
  } else {
    // Independent random salt avoids deterministic password-derived KDF inputs.
    saltBytes = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = encodeBase64Url(saltBytes);
  }

  const messageId = input.messageId ?? crypto.randomUUID();
  const expiresAt = input.expiresAt ?? null;
  const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  if (nonce.byteLength !== 12) throw new Error("Hinata IO nonce must be 12 bytes.");

  const aad = new TextEncoder().encode(`${aadPrefix}\n${saltB64}\n${messageId}\n${expiresAt ?? ""}`);

  const cacheKey = `${input.password}\0${saltB64}\0${iterations}`;
  let keyPromise = keyCache.get(cacheKey);
  if (!keyPromise) {
    keyPromise = (async () => {
      const passwordKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(input.password),
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: toArrayBuffer(saltBytes),
          iterations,
        },
        passwordKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    // Do not cache random one-time salts: this would grow the key cache indefinitely.
    if (input.salt) keyCache.set(cacheKey, keyPromise);
  }
  const key = await keyPromise;

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
    action,
    body: {
      salt: saltB64,
      nonce: encodeBase64Url(nonce),
      message_id: messageId,
      expires_at: expiresAt,
      ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    },
  };
}

export const encryptE2EE = encryptHinataIoMessage;

export async function decryptHinataIoMessage(
  password: string,
  envelope: Record<string, unknown>,
): Promise<unknown> {
  const action = envelope.action;
  if (action !== "E2EE_V1" && action !== "E2EE_V2") {
    throw new Error(`Unsupported Hinata IO envelope action: ${String(action)}`);
  }

  const body = envelope.body as {
    salt: string;
    nonce: string;
    message_id: string;
    expires_at: number | null;
    ciphertext: string;
  };
  if (!body) throw new Error("Invalid Hinata IO envelope: missing body.");

  const iterations = action === "E2EE_V2" ? PBKDF2_V2_ITERATIONS : PBKDF2_V1_ITERATIONS;
  const aadPrefix = action === "E2EE_V2" ? "aimeio-remote-e2ee-v2" : "aimeio-remote-e2ee-v1";

  const saltBytes = decodeBase64Url(body.salt, 16, "salt");
  const nonceBytes = decodeBase64Url(body.nonce, 12, "nonce");
  const ciphertextBytes = decodeBase64Url(body.ciphertext);

  const aad = new TextEncoder().encode(
    `${aadPrefix}\n${body.salt}\n${body.message_id}\n${body.expires_at ?? ""}`,
  );

  const cacheKey = `${password}\0${body.salt}\0${iterations}`;
  let keyPromise = keyCache.get(cacheKey);
  if (!keyPromise) {
    keyPromise = (async () => {
      const passwordKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: toArrayBuffer(saltBytes),
          iterations,
        },
        passwordKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(cacheKey, keyPromise);
  }
  const key = await keyPromise;

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonceBytes),
      additionalData: toArrayBuffer(aad),
      tagLength: 128,
    },
    key,
    toArrayBuffer(ciphertextBytes),
  );

  return JSON.parse(new TextDecoder().decode(decrypted));
}

export const decryptE2EE = decryptHinataIoMessage;

export async function sendHinataCard(
  targetUrl: string,
  accessCode: string,
  password?: string | null,
  operationId?: string,
  options?: {
    salt?: string | null;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    retries?: number;
  },
): Promise<HinataResult> {
  const plain = { type: "aime", value: accessCode };
  const message = {
    action: "SET_CARD",
    body: { type: "aime", value: accessCode, disposable: true },
  };

  return sendHinataRequest({
    targetUrl: normalizeHinataUrl(targetUrl),
    plain,
    message,
    password,
    operationId,
    salt: options?.salt,
    fetcher: options?.fetcher,
    timeoutMs: options?.timeoutMs ?? 10_000,
    retries: options?.retries ?? 0,
    expiresAt: null,
  });
}

export async function sendHinataCoin(
  targetUrl: string,
  key: number,
  password?: string | null,
  operationId?: string,
  options?: {
    count?: number;
    salt?: string | null;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    retries?: number;
  },
): Promise<HinataResult> {
  if (!password || !Number.isInteger(key) || key < 1 || key > MAX_KEY_VALUE) {
    return { ok: false, status: 400, error: "投币需要有效按键码和连接密码" };
  }
  const count = options?.count ?? 1;
  const body = { key, count };
  const eventUrl = `${normalizeHinataUrl(targetUrl)}/event`;

  return sendHinataRequest({
    targetUrl: eventUrl,
    plain: { action: "KEY_PRESS", body },
    message: { action: "KEY_PRESS", body },
    password,
    operationId,
    salt: options?.salt,
    fetcher: options?.fetcher,
    timeoutMs: options?.timeoutMs ?? 10_000,
    retries: options?.retries ?? 0,
    expiresAt: Date.now() + KEY_PRESS_TTL_MS,
  });
}

async function sendHinataRequest(input: {
  targetUrl: string;
  plain: Record<string, unknown>;
  message: { action: string; body: Record<string, unknown> };
  password?: string | null;
  operationId?: string;
  salt?: string | null;
  fetcher?: typeof fetch;
  timeoutMs: number;
  retries: number;
  expiresAt: number | null;
}): Promise<HinataResult> {
  const fetcher = input.fetcher ?? fetch;
  const payload = input.password
    ? await encryptHinataIoMessage({
        password: input.password,
        salt: input.salt,
        messageId: input.operationId,
        expiresAt: input.expiresAt,
        message: input.message,
      })
    : input.plain;

  let attempts = 0;
  const maxAttempts = 1 + Math.max(0, input.retries);

  while (attempts < maxAttempts) {
    attempts++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), input.timeoutMs);

    try {
      const response = await fetcher(input.targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) return { ok: true, status: response.status };
      if (response.status === 404) {
        return { ok: false, status: 404, error: "机台未在线或连接地址不正确" };
      }

      const errorText = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        error: `机台响应异常 (${response.status}${errorText ? `: ${errorText.slice(0, 80)}` : ""})`,
      };
    } catch (error) {
      const isTimeout = controller.signal.aborted;
      if (attempts >= maxAttempts) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return {
          ok: false,
          status: 0,
          error: isTimeout ? "机台响应超时" : `机台通信失败 (${detail})`,
        };
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, status: 0, error: "机台通信失败" };
}

export function createHinataExecutor(input: HinataExecutorInput): DeviceActionExecutor {
  const fetcher = input.fetch ?? ((url: string | URL | Request, init?: RequestInit) => fetch(url, init));
  const now = input.now ?? (() => new Date());
  const id = input.id ?? (() => crypto.randomUUID());
  const nonce = input.nonce ?? (() => crypto.getRandomValues(new Uint8Array(12)));
  const devicesById = new Map(input.devices.map((device) => [device.id, device]));

  return {
    async execute(executionInput: DeviceActionExecutionInput): Promise<DeviceActionExecutionResult> {
      const command = executionInput.command;
      if (command.executorKind !== "hinata_io" || command.targetKind !== "game_machine" || !command.deviceId) {
        return failed(`Hinata IO cannot execute ${command.type}.`);
      }
      const device = devicesById.get(command.deviceId);
      if (!device) return failed("Hinata IO 设备配置不存在。");

      try {
        if (command.type === "coin") {
          return await executeCoinCommand({ executionInput, device, fetcher, now, id, nonce });
        }
        if (command.type === "aime.scan") {
          return await executeCardCommand({ executionInput, device, fetcher, id, nonce });
        }
        return failed(`Hinata IO cannot execute ${command.type}.`);
      } catch (error) {
        return failed(error instanceof Error ? error.message : "Hinata IO request failed.");
      }
    },
  };
}

export const createHinataIoExecutor = createHinataExecutor;

async function executeCoinCommand(input: {
  executionInput: DeviceActionExecutionInput;
  device: HinataIoDeviceConfig;
  fetcher: NonNullable<HinataExecutorInput["fetch"]>;
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

async function executeCardCommand(input: {
  executionInput: DeviceActionExecutionInput;
  device: HinataIoDeviceConfig;
  fetcher: NonNullable<HinataExecutorInput["fetch"]>;
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
  fetcher: NonNullable<HinataExecutorInput["fetch"]>,
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
  const url = new URL(normalizeHinataUrl(value));
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

function decodeBase64Url(value: string, length?: number, field = "value"): Uint8Array {
  if (!value || value.includes("=")) throw new Error(`Invalid base64url ${field}.`);
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw new Error(`Invalid base64url ${field}.`);
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (length !== undefined && bytes.byteLength !== length) {
    throw new Error(`Hinata IO ${field} must be ${length} bytes.`);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

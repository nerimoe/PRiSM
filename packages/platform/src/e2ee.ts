import { fromBase64Url, toBase64Url } from "./crypto";

const ENVELOPE_ACTION = "E2EE_V2";
const SALT_LEN = 16;
const NONCE_LEN = 12;
const PBKDF2_ROUNDS = 20_000;

export type EncryptedEnvelope = {
  action: "E2EE_V2";
  body: {
    salt: string;
    nonce: string;
    message_id: string;
    expires_at: number | null;
    ciphertext: string;
  };
};

const keyCache = new Map<string, Promise<CryptoKey>>();

function asArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

export function buildAad(salt: string, messageId: string, expiresAt?: number | null): Uint8Array {
  return new TextEncoder().encode(
    `aimeio-remote-e2ee-v2\n${salt}\n${messageId}\n${expiresAt ?? ""}`,
  );
}

export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const saltB64 = toBase64Url(salt);
  const cacheKey = `${password}\0${saltB64}`;
  const existing = keyCache.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const passwordKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: asArrayBuffer(salt),
        iterations: PBKDF2_ROUNDS,
        hash: "SHA-256",
      },
      passwordKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  })();

  keyCache.set(cacheKey, promise);
  return promise;
}

export async function encryptE2EE(options: {
  password: string;
  message: unknown;
  salt?: Uint8Array;
  nonce?: Uint8Array;
  messageId?: string;
  expiresAt?: number | null;
}): Promise<EncryptedEnvelope> {
  const { password, message, expiresAt = null } = options;
  if (!password) throw new Error("Remote encryption password is required");

  let salt = options.salt;
  if (!salt) {
    // ponytail: deterministic salt per password avoids PBKDF2 derivation on every card swipe
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`aimeio-salt:${password}`));
    salt = new Uint8Array(hash, 0, SALT_LEN);
  } else if (salt.length !== SALT_LEN) {
    throw new Error(`Salt must be ${SALT_LEN} bytes`);
  }

  const nonce = options.nonce ?? crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  if (nonce.length !== NONCE_LEN) {
    throw new Error(`Nonce must be ${NONCE_LEN} bytes`);
  }

  const messageId = options.messageId ?? crypto.randomUUID();
  if (!messageId) throw new Error("Message ID is required");

  const saltB64 = toBase64Url(salt);
  const nonceB64 = toBase64Url(nonce);
  const aad = buildAad(saltB64, messageId, expiresAt);
  const key = await deriveKey(password, salt);

  const plaintext = new TextEncoder().encode(JSON.stringify(message));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aad) },
    key,
    asArrayBuffer(plaintext),
  );

  return {
    action: ENVELOPE_ACTION,
    body: {
      salt: saltB64,
      nonce: nonceB64,
      message_id: messageId,
      expires_at: expiresAt,
      ciphertext: toBase64Url(ciphertextBuffer),
    },
  };
}

export async function decryptE2EE(
  password: string,
  envelope: EncryptedEnvelope,
): Promise<unknown> {
  if (envelope.action !== ENVELOPE_ACTION) throw new Error("Invalid envelope action");
  const { salt: saltB64, nonce: nonceB64, message_id: messageId, expires_at: expiresAt, ciphertext: cipherB64 } = envelope.body;
  const salt = fromBase64Url(saltB64);
  const nonce = fromBase64Url(nonceB64);
  const ciphertextWithTag = fromBase64Url(cipherB64);

  const aad = buildAad(saltB64, messageId, expiresAt);
  const key = await deriveKey(password, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aad) },
    key,
    asArrayBuffer(ciphertextWithTag),
  );

  return JSON.parse(new TextDecoder().decode(decrypted));
}

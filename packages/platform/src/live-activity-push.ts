import { toBase64Url } from "./crypto";
import { appClipBundleId, fullAppBundleId } from "./apple";

/**
 * Remote Live Activity delivery over APNs.
 *
 * The store visit Live Activity is created on the phone with `pushType: .token`, so the
 * server may update or end it while the app is suspended or killed. Every payload here
 * is addressed to a single activity token and carries the *whole* `ContentState`, because
 * ActivityKit replaces the content rather than merging it.
 *
 * Two details are load-bearing and easy to break silently:
 *
 *  1. `content-state` keys must match the Swift `StoreVisitAttributes.ContentState`
 *     property names exactly. ActivityKit drops a payload whose content state does not
 *     decode, and reports nothing back — the push simply never appears.
 *  2. The `apns-topic` is `<bundle id>.push-type.liveactivity`. The app and the App Clip
 *     are separate bundles, so the topic travels with the registered token.
 */

export type LiveActivityEnvironment = "sandbox" | "production";

export type LiveActivityPushRecord = {
  token: string;
  environment: LiveActivityEnvironment;
  bundleId: string;
};

export type LiveActivityConfig = {
  keyId: string;
  teamId: string;
  privateKey: string;
};

export function liveActivityConfig(env: {
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
}): LiveActivityConfig | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  // Secrets arrive with the newlines escaped when set through some tooling; `wrangler
  // secret put` preserves them, but a dashboard paste often does not.
  const privateKey = env.APNS_PRIVATE_KEY?.includes("\\n")
    ? env.APNS_PRIVATE_KEY.replaceAll("\\n", "\n")
    : env.APNS_PRIVATE_KEY;
  if (!keyId || !teamId || !privateKey?.includes("BEGIN PRIVATE KEY")) return null;
  return { keyId, teamId, privateKey };
}

export function liveActivityTopic(bundleId: string): string {
  return `${bundleId}.push-type.liveactivity`;
}

/** The bundle ids this deployment knows how to push to. */
export function isKnownLiveActivityBundle(bundleId: string): boolean {
  return bundleId === fullAppBundleId || bundleId === appClipBundleId;
}

/**
 * The `aps` dictionary for one update. `startedAtUnix` is an absolute instant so the
 * on-device timer renders correctly regardless of the phone's time zone.
 */
export function liveActivityContentState(input: {
  phase: "active" | "ended";
  startedAtUnix: number;
  endedAtUnix?: number | null;
}): Record<string, unknown> {
  return {
    phase: input.phase,
    startedAtUnix: input.startedAtUnix,
    endedAtUnix: input.endedAtUnix ?? null,
  };
}

export function liveActivityStartPayload(input: {
  sessionId: string;
  shopCode: string;
  shopName: string;
  origin?: string | null;
  startedAtUnix: number;
  now: number;
  staleAfterSeconds?: number;
}): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    sessionId: input.sessionId,
    shopCode: input.shopCode,
    shopName: input.shopName,
  };
  if (input.origin) {
    attributes.origin = input.origin;
  }
  return {
    aps: {
      timestamp: input.now,
      event: "start",
      "attributes-type": "StoreVisitAttributes",
      attributes,
      "content-state": liveActivityContentState({
        phase: "active",
        startedAtUnix: input.startedAtUnix,
        endedAtUnix: null,
      }),
      alert: {
        title: input.shopName || "PRiSM",
        body: "在店计费中",
      },
      "stale-date": input.now + (input.staleAfterSeconds ?? 3600),
      "relevance-score": 100,
      "input-push-token": 1,
    },
  };
}

export function liveActivityUpdatePayload(input: {
  startedAtUnix: number;
  now: number;
  staleAfterSeconds?: number;
}): Record<string, unknown> {
  return {
    aps: {
      timestamp: input.now,
      event: "update",
      "content-state": liveActivityContentState({
        phase: "active",
        startedAtUnix: input.startedAtUnix,
      }),
      "stale-date": input.now + (input.staleAfterSeconds ?? 3600),
      "relevance-score": 100,
    },
  };
}

export function liveActivityEndPayload(input: {
  startedAtUnix: number;
  endedAtUnix: number;
  dismissalAfterSeconds?: number;
}): Record<string, unknown> {
  return {
    aps: {
      timestamp: input.endedAtUnix,
      event: "end",
      "content-state": liveActivityContentState({
        phase: "ended",
        startedAtUnix: input.startedAtUnix,
        endedAtUnix: input.endedAtUnix,
      }),
      "dismissal-date": input.endedAtUnix + (input.dismissalAfterSeconds ?? 60),
    },
  };
}

export function maskToken(token: string): string {
  if (token.length <= 8) return "...";
  return `${token.slice(0, 4)}...${token.slice(-4)} (${token.length} chars)`;
}

export function liveActivityHost(environment: LiveActivityEnvironment): string {
  return environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
}

/** Minimal signing surface so tests can drive the client without real APNs credentials. */
export type ApnsTransport = (request: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ status: number; body: string }>;

export type LiveActivityPushOutcome =
  | { kind: "delivered" }
  | { kind: "expired"; reason?: string }
  | { kind: "skipped" }
  | { kind: "failed"; status?: number; reason?: string };

const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;
const APNS_TIMEOUT_MS = 10_000;

export class LiveActivityPusher {
  private readonly config: LiveActivityConfig;
  private readonly transport: ApnsTransport;
  private readonly now: () => number;
  private cachedToken: { value: string; issuedAt: number } | null = null;

  constructor(input: {
    config: LiveActivityConfig;
    transport?: ApnsTransport;
    now?: () => number;
  }) {
    this.config = input.config;
    this.transport = input.transport ?? defaultApnsTransport;
    this.now = input.now ?? (() => Date.now());
  }

  /**
   * Sends one payload to one activity token. Never throws: Live Activity delivery is a
   * best-effort enhancement and must never fail the billing request that triggered it.
   */
  async send(
    record: LiveActivityPushRecord,
    payload: Record<string, unknown>,
  ): Promise<LiveActivityPushOutcome> {
    if (!record.token || !isKnownLiveActivityBundle(record.bundleId)) {
      return { kind: "skipped" };
    }
    try {
      const authorization = await this.providerToken();
      const response = await this.transport({
        url: `${liveActivityHost(record.environment)}/3/device/${record.token}`,
        headers: {
          authorization: `bearer ${authorization}`,
          "apns-topic": liveActivityTopic(record.bundleId),
          "apns-push-type": "liveactivity",
          "apns-priority": "10",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (response.status === 200) return { kind: "delivered" };
      let reason: string | undefined;
      try {
        const parsed = JSON.parse(response.body) as { reason?: string };
        reason = parsed.reason;
      } catch {
        reason = response.body.slice(0, 200);
      }
      // Apple reports 410 when token is expired/unregistered.
      // Apple reports 400 BadDeviceToken / DeviceTokenNotForTopic if the token is permanently invalid.
      if (
        response.status === 410 ||
        (response.status === 400 &&
          (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic" || reason === "Unregistered"))
      ) {
        return { kind: "expired" };
      }
      return { kind: "failed", status: response.status, reason };
    } catch (error) {
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** ES256 provider token, cached because Apple rejects keys re-signed too often. */
  private async providerToken(): Promise<string> {
    const now = this.now();
    if (this.cachedToken && now - this.cachedToken.issuedAt < PROVIDER_TOKEN_TTL_MS) {
      return this.cachedToken.value;
    }
    const header = toBase64Url(
      new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: this.config.keyId })),
    );
    const claims = toBase64Url(
      new TextEncoder().encode(
        JSON.stringify({ iss: this.config.teamId, iat: Math.floor(now / 1000) }),
      ),
    );
    const signingInput = `${header}.${claims}`;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8(this.config.privateKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    );
    const value = `${signingInput}.${toBase64Url(signature)}`;
    this.cachedToken = { value, issuedAt: now };
    return value;
  }
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer as ArrayBuffer;
}

const defaultApnsTransport: ApnsTransport = async ({ url, headers, body }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APNS_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
};

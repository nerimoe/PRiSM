import { describe, expect, it } from "bun:test";
import { createPrismBotClient, PrismBotClientError } from "../src";

describe("createPrismBotClient", () => {
  it("starts a session by QQ with one integration API request", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createPrismBotClient({
      baseUrl: "https://prism.example.com/",
      integrationToken: "integration-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          session: {
            id: "session-1",
            playerId: "player-1",
            startedAt: "2026-06-07T10:00:00.000Z",
            status: "active",
          },
        });
      },
    });

    const session = await client.startSessionByIdentity(
      { provider: "qq", subject: "123456", autoRegister: true, displayName: "QQ 123456" },
      { pricingConfigIds: ["music"], label: "音游区间" },
    );

    expect(session.session.id).toBe("session-1");
    expect(calls).toEqual([
      {
        url: "https://prism.example.com/rpc/integration/players/by-identity/session/start",
        init: {
          method: "POST",
          headers: {
            Authorization: "Bearer integration-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            identity: { provider: "qq", subject: "123456" },
            autoRegister: true,
            displayName: "QQ 123456",
            pricingConfigIds: ["music"],
            label: "音游区间",
          }),
        },
      },
    ]);
  });

  it("resolves or registers an identity through integration APIs only", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createPrismBotClient({
      baseUrl: "https://prism.example.com",
      integrationToken: "integration-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          player: {
            id: "player-new",
            displayName: "QQ 123456",
            status: "active",
            createdAt: "2026-06-07T00:00:00.000Z",
          },
        });
      },
    });

    const player = await client.resolveOrRegisterIdentity({
      provider: "qq",
      subject: "123456",
      autoRegister: true,
      displayName: "QQ 123456",
    });

    expect(player.id).toBe("player-new");
    expect(calls.map((call) => [call.url, call.init?.method, call.init?.body])).toEqual([
      [
        "https://prism.example.com/rpc/integration/players/by-identity/register",
        "POST",
        JSON.stringify({
          identity: { provider: "qq", subject: "123456" },
          autoRegister: true,
          displayName: "QQ 123456",
        }),
      ],
    ]);
  });

  it("covers wallet, assets, history, checkout, stop, and redeem by identity", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createPrismBotClient({
      baseUrl: "https://prism.example.com",
      integrationToken: "integration-token",
      fetch: async (url, init) => {
        const normalizedUrl = String(url);
        calls.push({ url: normalizedUrl, init });
        if (normalizedUrl.endsWith("/wallet")) return jsonResponse({ wallet: [] });
        if (normalizedUrl.endsWith("/assets")) return jsonResponse({ holdings: [], ledgerEntries: [] });
        if (normalizedUrl.endsWith("/history")) return jsonResponse({ sessions: [] });
        if (normalizedUrl.endsWith("/checkout/preview")) return jsonResponse({ settlementPreview: { total: 0 } });
        if (normalizedUrl.endsWith("/checkout/confirm")) return jsonResponse({ settlement: { total: 0 } });
        if (normalizedUrl.endsWith("/sessions/mahjong%20session%2F1/stop")) {
          return jsonResponse({ session: { id: "mahjong session/1", status: "closed" } });
        }
        if (normalizedUrl.endsWith("/redeem")) return jsonResponse({ redeemRecord: { codeId: "code-1" } });
        throw new Error(`Unexpected request: ${normalizedUrl}`);
      },
    });
    const identity = { provider: "qq", subject: "123456", autoRegister: true };

    await client.getWalletByIdentity(identity);
    await client.getAssetsByIdentity(identity);
    await client.getSessionHistoryByIdentity(identity);
    await client.previewCheckoutByIdentity(identity);
    await client.confirmCheckoutByIdentity(identity);
    await client.stopSessionByIdentity(identity, "mahjong session/1");
    await client.redeemCodeByIdentity(identity, "PRISM-2026");

    expect(calls.map((call) => [call.url, call.init?.method, call.init?.body])).toEqual([
      [
        "https://prism.example.com/rpc/integration/players/by-identity/wallet",
        "POST",
        JSON.stringify({ identity: { provider: "qq", subject: "123456" }, autoRegister: true }),
      ],
      [
        "https://prism.example.com/rpc/integration/players/by-identity/assets",
        "POST",
        JSON.stringify({ identity: { provider: "qq", subject: "123456" }, autoRegister: true }),
      ],
      [
        "https://prism.example.com/rpc/integration/players/by-identity/history",
        "POST",
        JSON.stringify({ identity: { provider: "qq", subject: "123456" }, autoRegister: true }),
      ],
      [
        "https://prism.example.com/rpc/integration/players/by-identity/checkout/preview",
        "POST",
        JSON.stringify({ identity: { provider: "qq", subject: "123456" }, autoRegister: true }),
      ],
      [
        "https://prism.example.com/rpc/integration/players/by-identity/checkout/confirm",
        "POST",
        JSON.stringify({ identity: { provider: "qq", subject: "123456" }, autoRegister: true }),
      ],
      [
        "https://prism.example.com/rpc/integration/players/by-identity/sessions/mahjong%20session%2F1/stop",
        "POST",
        JSON.stringify({ identity: { provider: "qq", subject: "123456" }, autoRegister: true }),
      ],
      [
        "https://prism.example.com/rpc/integration/players/by-identity/redeem",
        "POST",
        JSON.stringify({ identity: { provider: "qq", subject: "123456" }, autoRegister: true, code: "PRISM-2026" }),
      ],
    ]);
  });

  it("throws structured API errors from integration requests", async () => {
    const client = createPrismBotClient({
      baseUrl: "https://prism.example.com",
      integrationToken: "integration-token",
      fetch: async () =>
        jsonResponse(
          {
            error: {
              code: "INSUFFICIENT_BALANCE",
              message: "Insufficient balance.",
            },
          },
          400,
        ),
    });

    await expect(client.confirmCheckoutByIdentity({ provider: "qq", subject: "123456" })).rejects.toThrow(PrismBotClientError);
    await expect(client.confirmCheckoutByIdentity({ provider: "qq", subject: "123456" })).rejects.toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      status: 400,
      message: "Insufficient balance.",
    });
  });

  it("keeps staff shortcut RPC separate from normal integration-token commands", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createPrismBotClient({
      baseUrl: "https://prism.example.com",
      integrationToken: "integration-token",
      staffSessionToken: "staff-session-token",
      fetch: async (url, init) => {
        const normalizedUrl = String(url);
        calls.push({ url: normalizedUrl, init });
        if (normalizedUrl.endsWith("/rpc/staff/players")) return jsonResponse({ players: [] });
        if (normalizedUrl.endsWith("/rpc/staff/players/player-1/assets/grants")) return jsonResponse({ holdings: [] });
        if (normalizedUrl.endsWith("/rpc/staff/redeem-codes")) return jsonResponse({ redeemCode: { id: "code-1" } });
        if (normalizedUrl.endsWith("/rpc/staff/players/player-1/checkout/confirm")) {
          return jsonResponse({ settlement: { total: 25 } });
        }
        throw new Error(`Unexpected request: ${normalizedUrl}`);
      },
    });

    await client.listStaffPlayers();
    await client.createStaffPlayer("Neri");
    await client.grantStaffAssets("player-1", [
      {
        assetType: "currency",
        assetCode: "paid",
        amount: 100,
        mergeStrategy: "stack",
        activeAt: null,
        expiresAt: null,
      },
    ]);
    await client.createStaffRedeemCode({
      code: "PRISM-2026",
      presentId: "present-1",
      activeAt: null,
      expiresAt: null,
      maxUseCount: 1,
    });
    await client.staffCheckout("player-1");

    expect(calls.every((call) => (call.init?.headers as Record<string, string>).Authorization === "Bearer staff-session-token")).toBe(true);
  });

  it("requests device actions through one integration-token request", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createPrismBotClient({
      baseUrl: "https://prism.example.com",
      integrationToken: "integration-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          action: {
            id: "command-1",
            type: "power.on",
            target: {
              kind: "facility",
              id: "switch.maimai_1",
            },
            status: "acked",
            payload: { deviceLabel: "舞萌一号机" },
          },
        });
      },
    });

    await client.requestDeviceCommandByIdentity(
      { provider: "qq", subject: "123456" },
      {
        type: "power.on",
        target: {
          kind: "facility",
          ref: "一号机",
        },
      },
    );

    expect(calls).toEqual([
      {
        url: "https://prism.example.com/rpc/integration/players/by-identity/device-actions",
        init: {
          method: "POST",
          headers: {
            Authorization: "Bearer integration-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            identity: {
              provider: "qq",
              subject: "123456",
            },
            target: {
              kind: "facility",
              ref: "一号机",
            },
            action: {
              type: "power.on",
            },
          }),
        },
      },
    ]);
  });

  it("marks trusted administrator power actions as staff overrides", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createPrismBotClient({
      baseUrl: "https://prism.example.com",
      integrationToken: "integration-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ action: { id: "command-1", status: "acked" } });
      },
    });

    await client.requestDeviceCommandByIdentity(
      { provider: "qq", subject: "admin-1" },
      { type: "power.off", target: { kind: "facility", ref: "all" } },
      { staffOverride: true },
    );

    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      identity: { provider: "qq", subject: "admin-1" },
      staffOverride: true,
      action: { type: "power.off" },
    });
  });

  it("maps scan shortcuts to Aime scan device actions", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createPrismBotClient({
      baseUrl: "https://prism.example.com",
      integrationToken: "integration-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          action: {
            id: "command-1",
            type: "aime.scan",
            status: "pending",
          },
        });
      },
    });

    await client.requestScanByIdentity(
      { provider: "qq", subject: "123456" },
      {
        deviceRef: "舞萌左机",
        provider: "aime",
      },
    );

    expect(calls[0]?.url).toBe("https://prism.example.com/rpc/integration/players/by-identity/device-actions");
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({
        identity: {
          provider: "qq",
          subject: "123456",
        },
        target: {
          kind: "game_machine",
          ref: "舞萌左机",
        },
        action: {
          type: "aime.scan",
          payload: {
            provider: "aime",
          },
        },
      }),
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

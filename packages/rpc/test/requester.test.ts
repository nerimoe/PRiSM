import { describe, expect, it } from "bun:test";
import { createPrismRpcRequester, prismRpcEndpointManifest, prismRpcEndpoints, PrismRpcClientError } from "../src";

describe("createPrismRpcRequester", () => {
  it("builds endpoint-backed requests with principal headers, params, and query", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const request = createPrismRpcRequester({
      baseUrl: "https://prism.example.com/",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          commands: [
            {
              id: "command-1",
              type: "coin",
              deviceId: "mai-1",
              status: "pending",
              requestedAt: "2026-06-07T10:00:00.000Z",
            },
          ],
        });
      },
    });

    const result = await request(prismRpcEndpoints.staff.listDeviceCommands, {
      auth: {
        token: "staff-token",
      },
      query: {
        limit: 10,
      },
    });

    expect(result).toEqual({
      commands: [
        {
          id: "command-1",
          type: "coin",
          deviceId: "mai-1",
          status: "pending",
          requestedAt: "2026-06-07T10:00:00.000Z",
        },
      ],
    });
    expect(calls).toEqual([
      {
        url: "https://prism.example.com/rpc/staff/device-commands?limit=10",
        init: {
          method: "GET",
          headers: {
            Authorization: "Bearer staff-token",
            "Content-Type": "application/json",
          },
        },
      },
    ]);
  });

  it("encodes route params and serializes JSON bodies from the shared endpoint contract", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const request = createPrismRpcRequester({
      baseUrl: "https://prism.example.com",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ command: { id: "acked-command" } });
      },
    });

    await request(prismRpcEndpoints.player.requestDeviceCommand, {
      auth: {
        token: "player-token",
        playerId: "player-1",
      },
      body: {
        type: "door.open",
        deviceId: "front-door",
      },
    });
    await request(prismRpcEndpoints.staff.getPricingTimeline, {
      auth: {
        token: "staff-token",
      },
      params: {
        pricingConfigId: "pricing 1/夏季",
      },
      query: {
        date: "2026-06-07",
      },
    });

    expect(calls.map((call) => [call.url, call.init?.method, call.init?.body])).toEqual([
      [
        "https://prism.example.com/rpc/player/device-commands",
        "POST",
        JSON.stringify({ type: "door.open", deviceId: "front-door" }),
      ],
      [
        "https://prism.example.com/rpc/staff/pricing-configs/pricing%201%2F%E5%A4%8F%E5%AD%A3/timeline?date=2026-06-07",
        "GET",
        undefined,
      ],
    ]);
  });

  it("sends integration player actions with structured identity bodies", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const request = createPrismRpcRequester({
      baseUrl: "https://prism.example.com",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          session: {
            id: "session-1",
            playerId: "player-1",
            startedAt: "2026-07-07T10:30:00.000Z",
            status: "active",
          },
        });
      },
    });

    await request(prismRpcEndpoints.integration.startSession, {
      auth: {
        token: "integration-token",
      },
      body: {
        identityKey: "QQ:123456",
        autoRegister: true,
        displayName: "QQ 123456",
        pricingConfigIds: ["music"],
        label: "音游区间",
      },
    });
    await request(prismRpcEndpoints.integration.stopSession, {
      auth: {
        token: "integration-token",
      },
      params: {
        sessionId: "mahjong session/1",
      },
      body: {
        identityKey: "QQ:123456",
      },
    });
    await request(prismRpcEndpoints.integration.requestDeviceAction, {
      auth: {
        token: "integration-token",
      },
      body: {
        identityKey: "QQ:123456",
        target: {
          kind: "game_machine",
          id: "maimai-dx-1",
        },
        action: {
          type: "coin",
          payload: {
            count: 1,
          },
        },
      },
    });

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
            identityKey: "QQ:123456",
            autoRegister: true,
            displayName: "QQ 123456",
            pricingConfigIds: ["music"],
            label: "音游区间",
          }),
        },
      },
      {
        url: "https://prism.example.com/rpc/integration/players/by-identity/sessions/mahjong%20session%2F1/stop",
        init: {
          method: "POST",
          headers: {
            Authorization: "Bearer integration-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            identityKey: "QQ:123456",
          }),
        },
      },
      {
        url: "https://prism.example.com/rpc/integration/players/by-identity/device-actions",
        init: {
          method: "POST",
          headers: {
            Authorization: "Bearer integration-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            identityKey: "QQ:123456",
            target: {
              kind: "game_machine",
              id: "maimai-dx-1",
            },
            action: {
              type: "coin",
              payload: {
                count: 1,
              },
            },
          }),
        },
      },
    ]);
  });

  it("throws structured API errors", async () => {
    const request = createPrismRpcRequester({
      baseUrl: "https://prism.example.com",
      fetch: async () =>
        jsonResponse(
          {
            error: {
              code: "FORBIDDEN",
              message: "Staff principal required.",
            },
          },
          403,
        ),
    });

    await expect(
      request(prismRpcEndpoints.staff.listPlayers, {
        auth: {
          token: "staff-token",
        },
      }),
    ).rejects.toThrow(PrismRpcClientError);
    await expect(
      request(prismRpcEndpoints.staff.listPlayers, {
        auth: {
          token: "staff-token",
        },
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
      message: "Staff principal required.",
    });
  });
});

describe("prismRpcEndpointManifest", () => {
  it("covers staff Web console endpoints with method and path metadata", () => {
    expect(prismRpcEndpointManifest.player).toMatchObject({
      sessionHistoryDetail: { method: "GET", path: "/rpc/player/sessions/:sessionId/history" },
      purchaseBusinessItem: { method: "POST", path: "/rpc/player/business-items/:businessItemId/purchase" },
      listBusinessItemOrders: { method: "GET", path: "/rpc/player/business-item-orders" },
    });
    expect(prismRpcEndpointManifest.playerAuth).toEqual({
      loginByIdentity: { method: "POST", path: "/rpc/player-auth/login/by-identity" },
    });
    expect(prismRpcEndpointManifest.integration).toMatchObject({
      resolvePlayer: { method: "POST", path: "/rpc/integration/players/by-identity/resolve" },
      registerPlayer: { method: "POST", path: "/rpc/integration/players/by-identity/register" },
      startSession: { method: "POST", path: "/rpc/integration/players/by-identity/session/start" },
      previewCheckout: { method: "POST", path: "/rpc/integration/players/by-identity/checkout/preview" },
      confirmCheckout: { method: "POST", path: "/rpc/integration/players/by-identity/checkout/confirm" },
      wallet: { method: "POST", path: "/rpc/integration/players/by-identity/wallet" },
      assets: { method: "POST", path: "/rpc/integration/players/by-identity/assets" },
      history: { method: "POST", path: "/rpc/integration/players/by-identity/history" },
      redeem: { method: "POST", path: "/rpc/integration/players/by-identity/redeem" },
      stopSession: { method: "POST", path: "/rpc/integration/players/by-identity/sessions/:sessionId/stop" },
    });
    expect(prismRpcEndpointManifest.staff).toMatchObject({
      me: { method: "GET", path: "/rpc/staff/me" },
      listStaffUsers: { method: "GET", path: "/rpc/staff/users" },
      createStaffUser: { method: "POST", path: "/rpc/staff/users" },
      updateStaffUser: { method: "PATCH", path: "/rpc/staff/users/:staffUserId" },
      resetStaffUserPassword: { method: "POST", path: "/rpc/staff/users/:staffUserId/password" },
      getSettings: { method: "GET", path: "/rpc/staff/settings" },
      updateSettings: { method: "PUT", path: "/rpc/staff/settings" },
      listApiTokens: { method: "GET", path: "/rpc/staff/api-tokens" },
      createApiToken: { method: "POST", path: "/rpc/staff/api-tokens" },
      revokeApiToken: { method: "POST", path: "/rpc/staff/api-tokens/:tokenId/revoke" },
      listPlayers: { method: "GET", path: "/rpc/staff/players" },
      createPlayer: { method: "POST", path: "/rpc/staff/players" },
      updatePlayerStatus: { method: "PATCH", path: "/rpc/staff/players/:playerId/status" },
      bindPlayerIdentity: { method: "POST", path: "/rpc/staff/players/:playerId/identities" },
      deletePlayerIdentity: {
        method: "DELETE",
        path: "/rpc/staff/players/:playerId/identities/:provider/:subject",
      },
      startPlayerSession: { method: "POST", path: "/rpc/staff/players/:playerId/session/start" },
      previewCheckout: { method: "POST", path: "/rpc/staff/players/:playerId/checkout/preview" },
      checkout: { method: "POST", path: "/rpc/staff/players/:playerId/checkout/confirm" },
      checkoutWithOverride: { method: "POST", path: "/rpc/staff/players/:playerId/checkout/override" },
      stopPlayerSession: { method: "POST", path: "/rpc/staff/players/:playerId/sessions/:sessionId/stop" },
      listLivePlayers: { method: "GET", path: "/rpc/staff/live-players" },
      listActiveSessions: { method: "GET", path: "/rpc/staff/sessions/active" },
      bulkCheckoutActiveSessions: { method: "POST", path: "/rpc/staff/sessions/active/checkout" },
      getPlayerAssets: { method: "GET", path: "/rpc/staff/players/:playerId/assets" },
      getPlayerSessionHistory: { method: "GET", path: "/rpc/staff/players/:playerId/sessions/history" },
      getPlayerSessionHistoryDetail: {
        method: "GET",
        path: "/rpc/staff/players/:playerId/sessions/:sessionId/history",
      },
      getPlayerRedeemRecords: { method: "GET", path: "/rpc/staff/players/:playerId/redeem-records" },
      listAssetDefinitions: { method: "GET", path: "/rpc/staff/asset-definitions" },
      saveAssetDefinition: { method: "PUT", path: "/rpc/staff/asset-definitions/:assetType/:assetCode" },
      archiveAssetDefinition: {
        method: "POST",
        path: "/rpc/staff/asset-definitions/:assetType/:assetCode/archive",
      },
      restoreAssetDefinition: {
        method: "POST",
        path: "/rpc/staff/asset-definitions/:assetType/:assetCode/restore",
      },
      grantAssets: { method: "POST", path: "/rpc/staff/players/:playerId/assets/grants" },
      adjustAssets: { method: "POST", path: "/rpc/staff/players/:playerId/assets/adjustments" },
      createPresent: { method: "POST", path: "/rpc/staff/presents" },
      listPresents: { method: "GET", path: "/rpc/staff/presents" },
      archivePresent: { method: "POST", path: "/rpc/staff/presents/:presentId/archive" },
      createRedeemCode: { method: "POST", path: "/rpc/staff/redeem-codes" },
      listRedeemCodes: { method: "GET", path: "/rpc/staff/redeem-codes" },
      createRedeemCodeBatch: { method: "POST", path: "/rpc/staff/redeem-codes/batch" },
      revokeRedeemCode: { method: "POST", path: "/rpc/staff/redeem-codes/:codeId/revoke" },
      restorePresent: { method: "POST", path: "/rpc/staff/presents/:presentId/restore" },
      listBusinessItems: { method: "GET", path: "/rpc/staff/business-items" },
      createBusinessItem: { method: "POST", path: "/rpc/staff/business-items" },
      archiveBusinessItem: { method: "POST", path: "/rpc/staff/business-items/:businessItemId/archive" },
      restoreBusinessItem: { method: "POST", path: "/rpc/staff/business-items/:businessItemId/restore" },
      listBusinessItemOrders: { method: "GET", path: "/rpc/staff/business-item-orders" },
      fulfillBusinessItemOrder: { method: "POST", path: "/rpc/staff/business-item-orders/:orderId/fulfill" },
      cancelBusinessItemOrder: { method: "POST", path: "/rpc/staff/business-item-orders/:orderId/cancel" },
      listPricingConfigs: { method: "GET", path: "/rpc/staff/pricing-configs" },
      listPricingExtensions: { method: "GET", path: "/rpc/staff/pricing-extensions" },
      getPricingTimeline: { method: "GET", path: "/rpc/staff/pricing-configs/:pricingConfigId/timeline" },
      restorePricingConfig: { method: "POST", path: "/rpc/staff/pricing-configs/:pricingConfigId/restore" },
      previewPricingTimeline: { method: "POST", path: "/rpc/staff/pricing-timeline/preview" },
      createPricingConfig: { method: "POST", path: "/rpc/staff/pricing-configs" },
      updatePricingConfig: { method: "PATCH", path: "/rpc/staff/pricing-configs/:pricingConfigId" },
      archivePricingConfig: { method: "POST", path: "/rpc/staff/pricing-configs/:pricingConfigId/archive" },
      listDeviceStates: { method: "GET", path: "/rpc/staff/device-states" },
      listMachineConnections: { method: "GET", path: "/rpc/staff/machine-connections" },
      listDeviceCommands: { method: "GET", path: "/rpc/staff/device-commands" },
      reportsSummary: { method: "GET", path: "/rpc/staff/reports/summary" },
      reportSettlements: { method: "GET", path: "/rpc/staff/reports/settlements" },
      reportPlayers: { method: "GET", path: "/rpc/staff/reports/players" },
    });
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

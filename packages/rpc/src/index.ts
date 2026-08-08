export type PrismFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type PrismRpcMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type PrismRpcEndpoint<ResponseBody = unknown> = {
  method: PrismRpcMethod;
  path: string;
  response?: ResponseBody;
};

export type PrismRpcAuth =
  | {
      token: string;
      playerId?: string;
    }
  | undefined;

export type PrismRpcRequestOptions = {
  auth?: PrismRpcAuth;
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
};

export type PrismRpcRequesterInput = {
  baseUrl: string;
  fetch?: PrismFetch;
};

export class PrismRpcClientError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly body: unknown;

  constructor(
    message: string,
    code: string,
    status: number,
    body: unknown,
  ) {
    super(message);
    this.name = "PrismRpcClientError";
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

export const prismRpcEndpoints = {
  bot: {
    resolveIdentity: endpoint<{ player: unknown }>("POST", "/rpc/bot/identities/resolve"),
  },
  playerAuth: {
    loginByIdentity: endpoint<{ session: { token: string }; player: unknown }>("POST", "/rpc/player-auth/login/by-identity"),
  },
  integration: {
    resolvePlayer: endpoint<{ player: unknown }>("POST", "/rpc/integration/players/by-identity/resolve"),
    registerPlayer: endpoint<{ player: unknown }>("POST", "/rpc/integration/players/by-identity/register"),
    startSession: endpoint<{ session: unknown }>("POST", "/rpc/integration/players/by-identity/session/start"),
    previewCheckout: endpoint("POST", "/rpc/integration/players/by-identity/checkout/preview"),
    confirmCheckout: endpoint("POST", "/rpc/integration/players/by-identity/checkout/confirm"),
    wallet: endpoint("POST", "/rpc/integration/players/by-identity/wallet"),
    assets: endpoint("POST", "/rpc/integration/players/by-identity/assets"),
    history: endpoint("POST", "/rpc/integration/players/by-identity/history"),
    redeem: endpoint("POST", "/rpc/integration/players/by-identity/redeem"),
    stopSession: endpoint("POST", "/rpc/integration/players/by-identity/sessions/:sessionId/stop"),
    requestDeviceAction: endpoint("POST", "/rpc/integration/players/by-identity/device-actions"),
    listActiveSessions: endpoint("GET", "/rpc/integration/sessions/active"),
    listDeviceStates: endpoint("GET", "/rpc/integration/device-states"),
  },
  player: {
    me: endpoint("GET", "/rpc/player/me"),
    assets: endpoint("GET", "/rpc/player/assets"),
    sessionHistory: endpoint("GET", "/rpc/player/sessions/history"),
    sessionHistoryDetail: endpoint("GET", "/rpc/player/sessions/:sessionId/history"),
    startSession: endpoint("POST", "/rpc/player/session/start"),
    requestDeviceCommand: endpoint("POST", "/rpc/player/device-commands"),
    previewCheckout: endpoint("POST", "/rpc/player/checkout/preview"),
    confirmCheckout: endpoint("POST", "/rpc/player/checkout/confirm"),
    redeem: endpoint("POST", "/rpc/player/redeem"),
    purchaseBusinessItem: endpoint("POST", "/rpc/player/business-items/:businessItemId/purchase"),
    listBusinessItemOrders: endpoint("GET", "/rpc/player/business-item-orders"),
  },
  staff: {
    me: endpoint("GET", "/rpc/staff/me"),
    listStaffUsers: endpoint("GET", "/rpc/staff/users"),
    createStaffUser: endpoint("POST", "/rpc/staff/users"),
    updateStaffUser: endpoint("PATCH", "/rpc/staff/users/:staffUserId"),
    resetStaffUserPassword: endpoint("POST", "/rpc/staff/users/:staffUserId/password"),
    getSettings: endpoint("GET", "/rpc/staff/settings"),
    updateSettings: endpoint("PUT", "/rpc/staff/settings"),
    listApiTokens: endpoint("GET", "/rpc/staff/api-tokens"),
    createApiToken: endpoint("POST", "/rpc/staff/api-tokens"),
    revokeApiToken: endpoint("POST", "/rpc/staff/api-tokens/:tokenId/revoke"),
    listPlayers: endpoint("GET", "/rpc/staff/players"),
    createPlayer: endpoint<{ player: unknown }>("POST", "/rpc/staff/players"),
    updatePlayerStatus: endpoint("PATCH", "/rpc/staff/players/:playerId/status"),
    bindPlayerIdentity: endpoint("POST", "/rpc/staff/players/:playerId/identities"),
    deletePlayerIdentity: endpoint("DELETE", "/rpc/staff/players/:playerId/identities/:provider/:subject"),
    startPlayerSession: endpoint("POST", "/rpc/staff/players/:playerId/session/start"),
    grantAssets: endpoint("POST", "/rpc/staff/players/:playerId/assets/grants"),
    adjustAssets: endpoint("POST", "/rpc/staff/players/:playerId/assets/adjustments"),
    createRedeemCode: endpoint("POST", "/rpc/staff/redeem-codes"),
    listRedeemCodes: endpoint("GET", "/rpc/staff/redeem-codes"),
    createRedeemCodeBatch: endpoint("POST", "/rpc/staff/redeem-codes/batch"),
    revokeRedeemCode: endpoint("POST", "/rpc/staff/redeem-codes/:codeId/revoke"),
    createPresent: endpoint("POST", "/rpc/staff/presents"),
    restorePresent: endpoint("POST", "/rpc/staff/presents/:presentId/restore"),
    previewCheckout: endpoint("POST", "/rpc/staff/players/:playerId/checkout/preview"),
    checkout: endpoint("POST", "/rpc/staff/players/:playerId/checkout/confirm"),
    checkoutWithOverride: endpoint("POST", "/rpc/staff/players/:playerId/checkout/override"),
    stopPlayerSession: endpoint("POST", "/rpc/staff/players/:playerId/sessions/:sessionId/stop"),
    listLivePlayers: endpoint("GET", "/rpc/staff/live-players"),
    bulkCheckoutActiveSessions: endpoint("POST", "/rpc/staff/sessions/active/checkout"),
    listActiveSessions: endpoint("GET", "/rpc/staff/sessions/active"),
    getPlayerAssets: endpoint("GET", "/rpc/staff/players/:playerId/assets"),
    getPlayerSessionHistory: endpoint("GET", "/rpc/staff/players/:playerId/sessions/history"),
    getPlayerSessionHistoryDetail: endpoint("GET", "/rpc/staff/players/:playerId/sessions/:sessionId/history"),
    getPlayerRedeemRecords: endpoint("GET", "/rpc/staff/players/:playerId/redeem-records"),
    listPricingEffects: endpoint("GET", "/rpc/staff/pricing-effects"),
    savePricingEffect: endpoint("PUT", "/rpc/staff/pricing-effects/:effectId"),
    archivePricingEffect: endpoint("POST", "/rpc/staff/pricing-effects/:effectId/archive"),
    restorePricingEffect: endpoint("POST", "/rpc/staff/pricing-effects/:effectId/restore"),
    listAssetDefinitions: endpoint("GET", "/rpc/staff/asset-definitions"),
    saveAssetDefinition: endpoint("PUT", "/rpc/staff/asset-definitions/:assetType/:assetCode"),
    archiveAssetDefinition: endpoint("POST", "/rpc/staff/asset-definitions/:assetType/:assetCode/archive"),
    restoreAssetDefinition: endpoint("POST", "/rpc/staff/asset-definitions/:assetType/:assetCode/restore"),
    listPresents: endpoint("GET", "/rpc/staff/presents"),
    archivePresent: endpoint("POST", "/rpc/staff/presents/:presentId/archive"),
    listBusinessItems: endpoint("GET", "/rpc/staff/business-items"),
    createBusinessItem: endpoint("POST", "/rpc/staff/business-items"),
    archiveBusinessItem: endpoint("POST", "/rpc/staff/business-items/:businessItemId/archive"),
    restoreBusinessItem: endpoint("POST", "/rpc/staff/business-items/:businessItemId/restore"),
    listBusinessItemOrders: endpoint("GET", "/rpc/staff/business-item-orders"),
    fulfillBusinessItemOrder: endpoint("POST", "/rpc/staff/business-item-orders/:orderId/fulfill"),
    cancelBusinessItemOrder: endpoint("POST", "/rpc/staff/business-item-orders/:orderId/cancel"),
    listPricingConfigs: endpoint("GET", "/rpc/staff/pricing-configs"),
    listPricingExtensions: endpoint("GET", "/rpc/staff/pricing-extensions"),
    getPricingTimeline: endpoint("GET", "/rpc/staff/pricing-configs/:pricingConfigId/timeline"),
    previewPricingTimeline: endpoint("POST", "/rpc/staff/pricing-timeline/preview"),
    createPricingConfig: endpoint("POST", "/rpc/staff/pricing-configs"),
    updatePricingConfig: endpoint("PATCH", "/rpc/staff/pricing-configs/:pricingConfigId"),
    archivePricingConfig: endpoint("POST", "/rpc/staff/pricing-configs/:pricingConfigId/archive"),
    restorePricingConfig: endpoint("POST", "/rpc/staff/pricing-configs/:pricingConfigId/restore"),
    listDeviceStates: endpoint("GET", "/rpc/staff/device-states"),
    listMachineConnections: endpoint("GET", "/rpc/staff/machine-connections"),
    listDeviceCommands: endpoint("GET", "/rpc/staff/device-commands"),
    reportsSummary: endpoint("GET", "/rpc/staff/reports/summary"),
    reportSettlements: endpoint("GET", "/rpc/staff/reports/settlements"),
    reportPlayers: endpoint("GET", "/rpc/staff/reports/players"),
  },
} as const;

export const prismRpcEndpointManifest = prismRpcEndpoints;

export function createPrismRpcRequester(input: PrismRpcRequesterInput) {
  const fetcher = input.fetch ?? fetch;
  const baseUrl = input.baseUrl.replace(/\/+$/, "");

  return async function request<TResponse = unknown>(
    endpoint: PrismRpcEndpoint<unknown>,
    options: PrismRpcRequestOptions = {},
  ): Promise<TResponse> {
    const url = buildRpcUrl(baseUrl, endpoint.path, options.params, options.query);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (options.auth?.token) headers.Authorization = `Bearer ${options.auth.token}`;
    if (options.auth?.playerId) headers["X-PRiSM-Player-Id"] = options.auth.playerId;

    const response = await fetcher(url, {
      method: endpoint.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = (body as { error?: { code?: string; message?: string } }).error;
      throw new PrismRpcClientError(
        error?.message ?? response.statusText,
        error?.code ?? `HTTP_${response.status}`,
        response.status,
        body,
      );
    }
    return body as TResponse;
  };
}

function endpoint<TResponse = unknown>(method: PrismRpcMethod, path: string): PrismRpcEndpoint<TResponse> {
  return { method, path };
}

function buildRpcUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | number> | undefined,
  query: Record<string, string | number | boolean | null | undefined> | undefined,
): string {
  const resolvedPath = path.replace(/:([A-Za-z0-9_]+)/g, (_, key: string) => {
    const value = params?.[key];
    if (value === undefined) throw new Error(`Missing RPC path parameter: ${key}.`);
    return encodeURIComponent(String(value));
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return `${baseUrl}${resolvedPath}${suffix}`;
}

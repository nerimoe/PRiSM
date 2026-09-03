import { createPrismRpcRequester, prismRpcEndpoints, PrismRpcClientError, type PrismFetch } from "@prism/rpc";

export type PrismBotClientInput = {
  baseUrl: string;
  integrationToken: string;
  staffSessionToken?: string;
  fetch?: PrismFetch;
};

export type { PrismFetch };

export type StartSessionResponse = {
  session: {
    id: string;
    playerId: string;
    startedAt: string;
    status: "active";
  };
};

export type ResolveIdentityInput = {
  provider: string;
  subject: string;
};

export type ResolveOrRegisterIdentityInput = ResolveIdentityInput & {
  autoRegister?: boolean;
  displayName?: string;
};

export type PrismBotPlayer = {
  id: string;
  displayName: string;
  status: string;
  createdAt?: string;
};

export type DeviceCommandInput = {
  type: "door.open" | "power.on" | "power.off" | "ac.set_temperature" | "coin" | "aime.scan";
  target:
    | {
        kind: "facility";
        ref: string;
      }
    | {
        kind: "game_machine";
        ref: string;
      };
  payload?: Record<string, unknown>;
};

export type ScanCommandInput = {
  deviceRef: string;
  provider: string;
};

export type StaffGrantAssetInput = {
  assetType: string;
  assetCode: string;
  amount: number;
  mergeStrategy: "stack" | "extendTime" | "replace";
  activeAt: string | null;
  expiresAt: string | null;
  durationMs?: number;
};

export type StaffCreateRedeemCodeInput = {
  code: string;
  presentId: string;
  activeAt: string | null;
  expiresAt: string | null;
  maxUseCount: number;
};

export class PrismBotClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "PrismBotClientError";
  }
}

export type PrismBotClient = ReturnType<typeof createPrismBotClient>;

export function createPrismBotClient(input: PrismBotClientInput) {
  const rpcRequest = createPrismRpcRequester({
    baseUrl: input.baseUrl,
    fetch: input.fetch,
  });

  async function request<T>(
    endpoint: Parameters<typeof rpcRequest<T>>[0],
    options: {
      token: string;
      params?: Record<string, string | number>;
      query?: Record<string, string | number | boolean | null | undefined>;
      body?: unknown;
    },
  ): Promise<T> {
    try {
      return await rpcRequest(endpoint, {
        auth: {
          token: options.token,
        },
        params: options.params,
        query: options.query,
        body: options.body,
      });
    } catch (error) {
      if (!(error instanceof PrismRpcClientError)) throw error;
      throw new PrismBotClientError(
        error.message,
        error.code,
        error.status,
        error.body,
      );
    }
  }

  function identityBody(identity: ResolveOrRegisterIdentityInput): Record<string, unknown> {
    return {
      identity: {
        provider: identity.provider,
        subject: identity.subject,
      },
      ...(identity.autoRegister === undefined ? {} : { autoRegister: identity.autoRegister }),
      ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
    };
  }

  async function integrationRequest<T>(
    endpoint: Parameters<typeof request<T>>[0],
    identity: ResolveOrRegisterIdentityInput,
    body: Record<string, unknown> = {},
    params?: Record<string, string | number>,
  ): Promise<T> {
    return request<T>(endpoint, {
      token: input.integrationToken,
      params,
      body: {
        ...identityBody(identity),
        ...body,
      },
    });
  }

  async function resolveIdentity(identity: ResolveIdentityInput): Promise<PrismBotPlayer> {
    const result = await integrationRequest<{ player: PrismBotPlayer }>(
      prismRpcEndpoints.integration.resolvePlayer,
      identity,
    );
    return result.player;
  }

  async function resolveOrRegisterIdentity(identity: ResolveOrRegisterIdentityInput): Promise<PrismBotPlayer> {
    const endpoint = identity.autoRegister
      ? prismRpcEndpoints.integration.registerPlayer
      : prismRpcEndpoints.integration.resolvePlayer;
    const result = await integrationRequest<{ player: PrismBotPlayer }>(endpoint, identity);
    return result.player;
  }

  function requireStaffSessionToken(): string {
    if (!input.staffSessionToken) {
      throw new PrismBotClientError("Staff session token is required for this Bot shortcut.", "STAFF_TOKEN_REQUIRED", 0, {});
    }
    return input.staffSessionToken;
  }

  async function staffRequest<T>(
    endpoint: Parameters<typeof request<T>>[0],
    options: {
      params?: Record<string, string | number>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    return request<T>(endpoint, {
      token: requireStaffSessionToken(),
      params: options.params,
      body: options.body,
    });
  }

  return {
    resolveIdentity,
    resolveOrRegisterIdentity,

    async startSessionByIdentity(identity: ResolveOrRegisterIdentityInput, body?: { pricingConfigIds?: string[]; label?: string }) {
      return integrationRequest<StartSessionResponse>(
        prismRpcEndpoints.integration.startSession,
        identity,
        body ?? {},
      );
    },

    async getWalletByIdentity(identity: ResolveOrRegisterIdentityInput) {
      return integrationRequest<unknown>(prismRpcEndpoints.integration.wallet, identity);
    },

    async getAssetsByIdentity(identity: ResolveOrRegisterIdentityInput) {
      return integrationRequest<unknown>(prismRpcEndpoints.integration.assets, identity);
    },

    async getSessionHistoryByIdentity(identity: ResolveOrRegisterIdentityInput) {
      return integrationRequest<unknown>(prismRpcEndpoints.integration.history, identity);
    },

    async previewCheckoutByIdentity(identity: ResolveOrRegisterIdentityInput) {
      return integrationRequest<unknown>(prismRpcEndpoints.integration.previewCheckout, identity);
    },

    async confirmCheckoutByIdentity(identity: ResolveOrRegisterIdentityInput) {
      return integrationRequest<unknown>(prismRpcEndpoints.integration.confirmCheckout, identity);
    },

    async stopSessionByIdentity(identity: ResolveOrRegisterIdentityInput, sessionId: string) {
      return integrationRequest<unknown>(
        prismRpcEndpoints.integration.stopSession,
        identity,
        {},
        { sessionId },
      );
    },

    async redeemCodeByIdentity(identity: ResolveOrRegisterIdentityInput, code: string) {
      return integrationRequest<unknown>(prismRpcEndpoints.integration.redeem, identity, {
        code,
      });
    },

    async requestDeviceCommandByIdentity(
      identity: ResolveOrRegisterIdentityInput,
      command: DeviceCommandInput,
      options?: { staffOverride?: boolean },
    ) {
      return integrationRequest<unknown>(prismRpcEndpoints.integration.requestDeviceAction, identity, {
        ...(options?.staffOverride ? { staffOverride: true } : {}),
        target: command.target,
        action: {
          type: command.type,
          ...(command.payload === undefined ? {} : { payload: command.payload }),
        },
      });
    },

    async requestScanByIdentity(identity: ResolveOrRegisterIdentityInput, scan: ScanCommandInput) {
      return integrationRequest<unknown>(prismRpcEndpoints.integration.requestDeviceAction, identity, {
        target: {
          kind: "game_machine",
          ref: scan.deviceRef,
        },
        action: {
          type: "aime.scan",
          payload: {
            provider: scan.provider,
          },
        },
      });
    },

    async listActiveSessions() {
      return request<unknown>(prismRpcEndpoints.integration.listActiveSessions, {
        token: input.integrationToken,
      });
    },

    async listDeviceStates() {
      return request<unknown>(prismRpcEndpoints.integration.listDeviceStates, {
        token: input.integrationToken,
      });
    },

    async listStaffPlayers() {
      return staffRequest<unknown>(prismRpcEndpoints.staff.listPlayers);
    },

    async createStaffPlayer(displayName: string) {
      return staffRequest<unknown>(prismRpcEndpoints.staff.createPlayer, {
        body: {
          displayName,
        },
      });
    },

    async grantStaffAssets(playerId: string, grants: StaffGrantAssetInput[]) {
      return staffRequest<unknown>(prismRpcEndpoints.staff.grantAssets, {
        params: {
          playerId,
        },
        body: {
          grants,
        },
      });
    },

    async createStaffRedeemCode(code: StaffCreateRedeemCodeInput) {
      return staffRequest<unknown>(prismRpcEndpoints.staff.createRedeemCode, {
        body: code,
      });
    },

    async staffCheckout(playerId: string) {
      return staffRequest<unknown>(prismRpcEndpoints.staff.checkout, {
        params: {
          playerId,
        },
      });
    },
  };
}

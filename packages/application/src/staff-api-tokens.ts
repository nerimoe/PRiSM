import { PrismDomainError, type ApiToken, type ApiTokenRole, type SystemRepository } from "@prism/core";
import type { SecretMaterial } from "./setup";

export type StaffApiTokenView = Omit<ApiToken, "tokenHash">;

export type StaffCreateApiTokenInput = {
  label: string;
  role: ApiTokenRole;
};

export type StaffCreateApiTokenResult = StaffApiTokenView & {
  token: string;
};

export type StaffApiTokenServiceDependencies = {
  system: SystemRepository;
  id: () => string;
  now: () => Date;
  createSecret(role: ApiTokenRole): SecretMaterial | Promise<SecretMaterial>;
};

export type StaffApiTokenService = {
  listApiTokens(): Promise<StaffApiTokenView[]>;
  createApiToken(input: StaffCreateApiTokenInput): Promise<StaffCreateApiTokenResult>;
  revokeApiToken(input: { tokenId: string }): Promise<StaffApiTokenView>;
};

export function createStaffApiTokenService(dependencies: StaffApiTokenServiceDependencies): StaffApiTokenService {
  return {
    async listApiTokens() {
      return (await dependencies.system.listApiTokens()).map(toView);
    },

    async createApiToken(input) {
      if (!isSupportedApiTokenRole(input.role)) {
        throw new PrismDomainError("This API token role is not supported.", "API_TOKEN_ROLE_NOT_SUPPORTED");
      }
      const now = dependencies.now();
      const secret = await dependencies.createSecret(input.role);
      const token: ApiToken = {
        id: dependencies.id(),
        label: input.label.trim(),
        role: input.role,
        tokenPrefix: secret.tokenPrefix,
        tokenHash: secret.tokenHash,
        status: "active",
        createdAt: now,
        lastUsedAt: null,
        revokedAt: null,
      };
      await dependencies.system.saveApiToken(token);
      return {
        ...toView(token),
        token: secret.token,
      };
    },

    async revokeApiToken(input) {
      const existing = (await dependencies.system.listApiTokens()).find((token) => token.id === input.tokenId);
      if (!existing) {
        throw new PrismDomainError("API token not found.", "API_TOKEN_NOT_FOUND");
      }
      const revokedAt = dependencies.now();
      await dependencies.system.revokeApiToken(input.tokenId, revokedAt);
      return toView({
        ...existing,
        status: "revoked",
        revokedAt,
      });
    },
  };
}

function toView(token: ApiToken): StaffApiTokenView {
  const { tokenHash: _tokenHash, ...view } = token;
  return view;
}

function isSupportedApiTokenRole(role: unknown): role is ApiTokenRole {
  return role === "integration" || role === "machine";
}

import { PrismDomainError, type ApiToken, type ApiTokenRole, type AssetDefinitionRepository, type StaffUser, type SystemRepository } from "@prism/core";

export type SecretMaterial = {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
};

export type SetupServiceDependencies = {
  system: SystemRepository;
  assetDefinitions: AssetDefinitionRepository;
  id: () => string;
  now: () => Date;
  hashPassword(password: string): Promise<{ hash: string; salt: string }>;
  verifyPassword(password: string, user: StaffUser): Promise<boolean>;
  createSecret(label: ApiTokenRole | "admin-session"): SecretMaterial | Promise<SecretMaterial>;
  sessionDurationMs: number;
};

export type InstallStoreInput = {
  storeName: string;
  timeZone: string;
  owner: {
    username: string;
    displayName: string;
    password: string;
  };
  coinCooldownMs: number;
  baseAssets?: {
    paid?: BaseAssetInput;
    free?: BaseAssetInput;
  };
};

export type BaseAssetInput = {
  name?: string;
  displayUnit?: string;
};

export type AdminLoginInput = {
  username: string;
  password: string;
};

export function createSetupService(dependencies: SetupServiceDependencies) {
  return {
    async getSetupStatus() {
      return {
        installed: await dependencies.system.hasOwnerStaffUser(),
      };
    },

    async install(input: InstallStoreInput) {
      if (await dependencies.system.hasOwnerStaffUser()) {
        throw new PrismDomainError("PRiSM is already installed.", "PRISM_ALREADY_INSTALLED");
      }

      const now = dependencies.now();
      const password = await dependencies.hashPassword(input.owner.password);
      const staffUser: StaffUser = {
        id: dependencies.id(),
        username: normalizeUsername(input.owner.username),
        displayName: input.owner.displayName.trim(),
        passwordHash: password.hash,
        passwordSalt: password.salt,
        role: "owner",
        status: "active",
        createdAt: now,
        updatedAt: now,
      };

      await dependencies.system.saveStaffUser(staffUser);
      const baseDefinitions = [
        createBaseCurrencyDefinition("paid", input.baseAssets?.paid, "余额"),
        createBaseCurrencyDefinition("free", input.baseAssets?.free, "赠送余额"),
      ];
      if (dependencies.assetDefinitions.saveMany) {
        await dependencies.assetDefinitions.saveMany(baseDefinitions);
      } else {
        for (const definition of baseDefinitions) await dependencies.assetDefinitions.save(definition);
      }
      const settings = [
        { key: "store.profile", value: { name: input.storeName.trim(), timeZone: input.timeZone } },
        { key: "venue.operations", value: { coinCooldownMs: input.coinCooldownMs } },
      ];
      if (dependencies.system.setAppSettings) {
        await dependencies.system.setAppSettings(settings);
      } else {
        for (const setting of settings) await dependencies.system.setAppSetting(setting.key, setting.value);
      }

      const generatedTokens = await Promise.all([
        createApiToken(dependencies, "integration", "机器人/店内入口 API", now),
        createApiToken(dependencies, "machine", "机器软件接入 API", now),
      ]);
      if (dependencies.system.saveApiTokens) {
        await dependencies.system.saveApiTokens(generatedTokens.map((token) => token.record));
      } else {
        for (const token of generatedTokens) await dependencies.system.saveApiToken(token.record);
      }
      const apiTokens = generatedTokens.map((token) => token.view);

      return {
        staffUser,
        apiTokens,
      };
    },

    async login(input: AdminLoginInput) {
      const staffUser = await dependencies.system.findStaffUserByUsername(normalizeUsername(input.username));
      if (!staffUser || staffUser.status !== "active" || !(await dependencies.verifyPassword(input.password, staffUser))) {
        throw new PrismDomainError("Username or password is incorrect.", "ADMIN_LOGIN_FAILED");
      }

      const now = dependencies.now();
      const secret = await dependencies.createSecret("admin-session");
      const session = {
        id: dependencies.id(),
        staffUserId: staffUser.id,
        tokenHash: secret.tokenHash,
        expiresAt: new Date(now.getTime() + dependencies.sessionDurationMs),
        createdAt: now,
        lastUsedAt: now,
      };
      await dependencies.system.saveAdminSession(session);

      return {
        token: secret.token,
        staff: toStaffView(staffUser),
      };
    },
  };
}

async function createApiToken(
  dependencies: SetupServiceDependencies,
  role: ApiTokenRole,
  label: string,
  now: Date,
) {
  const secret = await dependencies.createSecret(role);
  const token: ApiToken = {
    id: dependencies.id(),
    label,
    role,
    tokenPrefix: secret.tokenPrefix,
    tokenHash: secret.tokenHash,
    status: "active" as const,
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  };
  return {
    record: token,
    view: {
      id: token.id,
      label,
      role,
      token: secret.token,
      tokenPrefix: secret.tokenPrefix,
      createdAt: token.createdAt,
    },
  };
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function createBaseCurrencyDefinition(code: "paid" | "free", input: BaseAssetInput | undefined, fallbackName: string) {
  const name = input?.name?.trim() || fallbackName;
  const displayUnit = input?.displayUnit?.trim() || "JPY";

  return {
    type: "currency",
    code,
    name,
    stackable: true,
    metadata: {
      system: true,
      displayUnit,
    },
  };
}

function toStaffView(staffUser: StaffUser) {
  return {
    id: staffUser.id,
    username: staffUser.username,
    displayName: staffUser.displayName,
    role: staffUser.role,
  };
}

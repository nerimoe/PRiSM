import type { Database } from "bun:sqlite";
import { createD1Executor, createD1Repositories, type D1DatabaseLike } from "@prism/adapter-d1";
import { createBunSqliteExecutor, createSqliteRepositories } from "@prism/adapter-sqlite";
import {
  createAssetDefinitionEffectProvider,
  createAvailableAssetReader,
  createBusinessItemOrderService,
  createDeviceActionService,
  createDeviceStateSyncService,
  createIntegrationService,
  createMachineConnectionService,
  createPlayerAuthService,
  createPlayerCommandService,
  createRedeemService,
  createSettlementService,
  createSetupService,
  createSettingsService,
  createStaffApiTokenService,
  createStaffAssetDefinitionService,
  createStaffAssetService,
  createStaffBusinessItemService,
  createStaffPlayerService,
  createStaffPricingService,
  createStaffPricingEffectService,
  createStaffRedeemService,
  createStaffOperationsService,
  createStaffUserService,
  type ApplicationQueries,
  type DeviceActionExecutor,
  type HomeAssistantStateSource,
  type StaffPricingExtension,
  type StaffPricingExtensionRequiredAsset,
} from "@prism/application";
import { canStartPriorityTimePricingSession, collectPriorityTimePricingHistoryLookupKeys, createPricingProviderFromConfig, isActiveInWindow, PrismDomainError } from "@prism/core";
import type { AssetDefinition, AssetEffectProvider, BusinessItem, PricingConfig, PricingProvider } from "@prism/core";
import type { AssetDefinitionRepository } from "@prism/core";
import { createPrismApp } from "@prism/server-hono";
import { createHomeAssistantExecutor, resolveHomeAssistantDeviceRef, type HomeAssistantDeviceConfig } from "./home-assistant-executor";
import { createHomeAssistantStateSource } from "./home-assistant-state-source";
import type { PrismAppDependencies } from "@prism/server-hono";
import type { CreateSqlReadModelsInput, SqlRepositories } from "@prism/storage-sql";
import { createSqlReadModels, sqliteSchema } from "@prism/storage-sql";
import type { Hono } from "hono";
import { backendVersionInfo } from "./release-version";

export type RuntimeRepositoryInput = SqlRepositories;

export type RuntimeQueryInput = ApplicationQueries;

export type CreatePrismRuntimeDependenciesInput = {
  repositories: RuntimeRepositoryInput;
  queries: RuntimeQueryInput;
  pricingProviders: readonly PricingProvider[];
  assetEffectProviders: readonly AssetEffectProvider[];
  plugins?: readonly PrismRuntimePlugin[];
  deviceActionExecutors?: {
    homeAssistant?: DeviceActionExecutor;
  };
  homeAssistantStateSource?: HomeAssistantStateSource;
  coinCooldownMs: number;
  id: () => string;
  now: () => Date;
};

export type PrismRuntimePlugin = {
  id: string;
  staffCatalog?: readonly StaffPricingExtension[];
  pricingProviders?: readonly PricingProvider[];
  createPricingProviders?: (context: PrismRuntimePluginContext) => readonly PricingProvider[];
  assetEffectProviders?: readonly AssetEffectProvider[];
};

export type PrismRuntimePluginContext = {
  businessItems: {
    listActive(input?: { kind?: string; now?: Date }): Promise<BusinessItem[]>;
    findById(itemId: string): Promise<BusinessItem | null>;
  };
};

export type ComposedRuntimePlugins = {
  staffCatalog: readonly StaffPricingExtension[];
  pricingProviders: readonly PricingProvider[];
  assetEffectProviders: readonly AssetEffectProvider[];
};

export function composeRuntimePlugins(
  plugins: readonly PrismRuntimePlugin[],
  context?: PrismRuntimePluginContext,
): ComposedRuntimePlugins {
  return {
    staffCatalog: plugins.flatMap((plugin) => plugin.staffCatalog ?? []),
    pricingProviders: plugins.flatMap((plugin) => [
      ...(plugin.pricingProviders ?? []),
      ...(context && plugin.createPricingProviders ? plugin.createPricingProviders(context) : []),
    ]),
    assetEffectProviders: plugins.flatMap((plugin) => plugin.assetEffectProviders ?? []),
  };
}

export function createPrismRuntimeDependencies(input: CreatePrismRuntimeDependenciesInput): PrismAppDependencies {
  const pluginRuntime = composeRuntimePlugins(input.plugins ?? [], createRuntimePluginContext(input));
  const fallbackPricingProviders = input.pricingProviders;
  const pluginPricingProviders = pluginRuntime.pricingProviders;
  const assetEffectProviders = [
    createAssetDefinitionEffectProvider(input.repositories.assetDefinitions),
    ...input.assetEffectProviders,
    ...pluginRuntime.assetEffectProviders,
  ];
  const resolveFacilityTarget = createDynamicHomeAssistantTargetResolver({
    system: input.repositories.system,
  });
  const availableAssets = createAvailableAssetReader({
    assets: input.repositories.assets,
    assetDefinitions: input.repositories.assetDefinitions,
    now: input.now,
  });
  const playerQueries = input.queries.playerQueries;
  const storedStaffQueries = input.queries.staffQueries;
  const deviceStateSync = createDeviceStateSyncService({
    system: input.repositories.system,
    deviceStates: input.repositories.deviceStates,
    source: input.homeAssistantStateSource ?? createHomeAssistantStateSource(),
    now: input.now,
    onDeviceError(device, error) {
      console.error(`Failed to sync HA state for device ${device.id}:`, error);
    },
  });
  const staffQueries = storedStaffQueries.listDeviceStates
    ? {
        ...storedStaffQueries,
        async listDeviceStates() {
          try {
            await deviceStateSync.syncConfiguredHomeAssistantStates();
          } catch (error) {
            console.error("Failed to load or sync HA devices:", error);
          }
          return storedStaffQueries.listDeviceStates!();
        },
      }
    : storedStaffQueries;

  const playerCommands = createPlayerCommandService({
    sessions: input.repositories.sessions,
    pricingConfigs: input.repositories.pricingConfigs,
    deviceCommands: input.repositories.deviceCommands,
    playerIdentities: input.repositories.playerIdentities,
    coinCooldownMs: input.coinCooldownMs,
    getCoinCooldownMs: async () => {
      const operations = await input.repositories.system.getAppSetting<{ coinCooldownMs?: unknown }>("venue.operations");
      return normalizeNonNegativeInteger(operations?.coinCooldownMs, input.coinCooldownMs);
    },
    resolveFacilityTarget,
    canStartSessionAt: async ({ at }) => {
      const configs = await input.repositories.pricingConfigs.listEnabled();
      const timeConfigs = configs.filter((config): config is Extract<PricingConfig, { kind: "time.priority" }> => config.kind === "time.priority");
      if (timeConfigs.length === 0) return true;
      const storeProfile = await input.repositories.system.getAppSetting<{ timeZone?: unknown }>("store.profile");
      const storeTimeZone = typeof storeProfile?.timeZone === "string" ? storeProfile.timeZone : undefined;
      return timeConfigs.some((config) =>
        canStartPriorityTimePricingSession({
          config: {
            ...config.provider,
            timeZone: config.provider.timeZone ?? storeTimeZone,
          },
          at,
        }),
      );
    },
    id: input.id,
    now: input.now,
  });
  const playerCheckoutCommands = createSettlementService({
    sessions: input.repositories.sessions,
    operationLocks: input.repositories.operationLocks,
    assets: input.repositories.assets,
    settlements: input.repositories.settlements,
    assetDefinitions: input.repositories.assetDefinitions,
    availableAssets,
    system: input.repositories.system,
    pricingHistory: input.repositories.pricingHistory,
    pricingCapHistory: input.repositories.pricingCapHistory,
    pricingProviders: [...fallbackPricingProviders, ...pluginPricingProviders],
    async pricingProviderResolver(context) {
      const allConfigs = await input.repositories.pricingConfigs.listEnabled();
      const sessionConfigIds = context.session.pricingConfigIds ?? [];
      const configs = (sessionConfigIds.length > 0
        ? allConfigs.filter((config) => sessionConfigIds.includes(config.id))
        : allConfigs).filter((config) => config.kind !== "time.cap");

      if (configs.length === 0) return [...fallbackPricingProviders, ...pluginPricingProviders];
      const storeProfile = await input.repositories.system.getAppSetting<{ timeZone?: unknown }>("store.profile");
      const storeTimeZone = typeof storeProfile?.timeZone === "string" ? storeProfile.timeZone : undefined;
      const resolvedConfigs = await withRuntimePricingHistory(configs, {
        playerId: context.playerId,
        startedAt: context.session.startedAt,
        endedAt: context.session.endedAt ?? context.now,
        storeTimeZone,
        pricingHistory: input.repositories.pricingHistory,
      });
      return [
        ...pluginPricingProviders,
        ...resolvedConfigs.map((config) => createPricingProviderFromConfig(config)),
      ];
    },
    async globalCapResolver(context) {
      const allConfigs = await input.repositories.pricingConfigs.listEnabled();
      const storeProfile = await input.repositories.system.getAppSetting<{ timeZone?: unknown }>("store.profile");
      const storeTimeZone = typeof storeProfile?.timeZone === "string" ? storeProfile.timeZone : undefined;
      return allConfigs
        .filter((config): config is Extract<PricingConfig, { kind: "time.cap" }> => config.kind === "time.cap")
        .map((config) => ({
          ...config.provider,
          pricingConfigId: config.id,
          timeZone: config.provider.timeZone ?? context.timeZone ?? storeTimeZone,
        }));
    },
    assetEffectProviders,
    id: input.id,
    now: input.now,
  });
  const playerRedeemCommands = createRedeemService({
    assets: input.repositories.assets,
    assetDefinitions: input.repositories.assetDefinitions,
    availableAssets,
    redeems: input.repositories.redeems,
    operationLocks: input.repositories.operationLocks,
    id: input.id,
    now: input.now,
  });
  const deviceActions = createDeviceActionService({
    sessions: input.repositories.sessions,
    deviceCommands: input.repositories.deviceCommands,
    playerIdentities: input.repositories.playerIdentities,
    id: input.id,
    now: input.now,
    coinCooldownMs: input.coinCooldownMs,
    resolveFacilityTarget,
    executors: {
      home_assistant: createDynamicHomeAssistantExecutor({
        system: input.repositories.system,
      }),
    },
    async getCoinCooldownMs() {
      const operations = await input.repositories.system.getAppSetting<{ coinCooldownMs?: unknown }>("venue.operations");
      return normalizeNonNegativeInteger(operations?.coinCooldownMs, input.coinCooldownMs);
    },
  });
  const machineConnectionCommands = createMachineConnectionService({
    machineConnections: input.repositories.machineConnections,
    deviceCommands: input.repositories.deviceCommands,
    now: input.now,
    commandTtlMs: 30_000,
  });
  const playerAuthCommands = createPlayerAuthService({
    players: input.repositories.players,
    playerIdentities: input.repositories.playerIdentities,
    playerSessions: input.repositories.playerSessions,
    id: input.id,
    now: input.now,
    createSecret,
    sessionDurationMs: 30 * 24 * 60 * 60 * 1000,
  });
  const staffAssetCommands = createStaffAssetService({
    assets: input.repositories.assets,
    availableAssets,
    assetDefinitions: input.repositories.assetDefinitions,
    operationLocks: input.repositories.operationLocks,
    id: input.id,
    now: input.now,
  });
  const integrationCommands = createIntegrationService({
    players: input.repositories.players,
    playerIdentities: input.repositories.playerIdentities,
    sessions: input.repositories.sessions,
    playerCommands,
    playerCheckoutCommands,
    playerRedeemCommands,
    deviceActions,
    playerQueries,
    staffAssetCommands,
    staffCheckoutCommands: playerCheckoutCommands,
    id: input.id,
    now: input.now,
  });
  const staffAssetDefinitionCommands = createStaffAssetDefinitionService({
    assetDefinitions: input.repositories.assetDefinitions,
    pricingEffects: input.repositories.pricingEffects,
  });
  const staffPlayerCommands = createStaffPlayerService({
    players: input.repositories.players,
    assets: input.repositories.assets,
    playerIdentities: input.repositories.playerIdentities,
    id: input.id,
    now: input.now,
  });
  const staffRedeemCommands = createStaffRedeemService({
    redeems: input.repositories.redeems,
    assetDefinitions: input.repositories.assetDefinitions,
    id: input.id,
    now: input.now,
  });
  const staffPricingEffectCommands = createStaffPricingEffectService({
    pricingEffects: input.repositories.pricingEffects,
    id: input.id,
  });
  const staffPricingCommands = createStaffPricingService({
    pricingConfigs: input.repositories.pricingConfigs,
    async getDefaultTimeZone() {
      const storeProfile = await input.repositories.system.getAppSetting<{ timeZone?: unknown }>("store.profile");
      return typeof storeProfile?.timeZone === "string" ? storeProfile.timeZone : undefined;
    },
    id: input.id,
    now: input.now,
  });
  const staffBusinessItemCommands = createStaffBusinessItemService({
    businessItems: input.repositories.businessItems,
    id: input.id,
    now: input.now,
  });
  const businessItemOrderCommands = createBusinessItemOrderService({
    businessItems: input.repositories.businessItems,
    businessItemOrders: input.repositories.businessItemOrders,
    sessions: input.repositories.sessions,
    assets: input.repositories.assets,
    availableAssets,
    operationLocks: input.repositories.operationLocks,
    id: input.id,
    now: input.now,
  });
  const staffSettingsCommands = createSettingsService({
    system: input.repositories.system,
  });
  const staffApiTokenCommands = createStaffApiTokenService({
    system: input.repositories.system,
    id: input.id,
    now: input.now,
    createSecret,
  });
  const staffUserCommands = createStaffUserService({
    system: input.repositories.system,
    id: input.id,
    now: input.now,
    hashPassword,
  });
  const setupCommands = createSetupService({
    system: input.repositories.system,
    assetDefinitions: input.repositories.assetDefinitions,
    id: input.id,
    now: input.now,
    hashPassword,
    verifyPassword,
    createSecret,
    sessionDurationMs: 24 * 60 * 60 * 1000,
  });
  const staffOperations = createStaffOperationsService({
    staffQueries,
    checkout: playerCheckoutCommands,
    listPricingConfigs: () => staffPricingCommands.listPricingConfigs(),
    now: input.now,
  });

  return {
    playerQueries,
    staffQueries,
    playerCommands,
    playerCheckoutCommands,
    playerAuthCommands,
    integrationCommands,
    staffDeviceCommands: {
      requestDeviceAction(input) {
        return deviceActions.requestDeviceAction({
          actor: {
            type: "staff",
            staffId: input.staffId,
          },
          target: input.target,
          type: input.type,
          payload: input.payload,
        });
      },
    },
    staffCheckoutCommands: playerCheckoutCommands,
    staffOperations,
    playerRedeemCommands,
    staffPlayerCommands,
    staffAssetDefinitionCommands,
    staffPricingEffectCommands,
    staffAssetCommands,
    staffRedeemCommands,
    staffRedeemQueries: input.queries.staffRedeemQueries,
    staffPricingCommands,
    staffBusinessItemCommands,
    businessItemOrderCommands,
    staffPricingExtensions: () => resolveStaffPricingExtensions(pluginRuntime.staffCatalog, input.repositories.assetDefinitions),
    staffSettingsCommands,
    staffApiTokenCommands,
    staffUserCommands,
    setupCommands,
    adminAuth: {
      async authenticateAdminSession(token) {
        const session = await input.repositories.system.findAdminSessionByTokenHash(await sha256Hex(token));
        if (!session || session.expiresAt.getTime() <= input.now().getTime()) {
          return null;
        }
        const staffUser = await input.repositories.system.findStaffUserById(session.staffUserId);
        if (!staffUser || staffUser.status !== "active") {
          return null;
        }
        return {
          staffId: staffUser.id,
          role: staffUser.role,
          displayName: staffUser.displayName,
        };
      },
      async revokeAdminSession(token) {
        const session = await input.repositories.system.findAdminSessionByTokenHash(await sha256Hex(token));
        if (session) await input.repositories.system.revokeAdminSession(session.id);
      },
    },
    apiTokenAuth: {
      async authenticateApiToken(token) {
        const apiToken = await input.repositories.system.findActiveApiTokenByHash(await sha256Hex(token));
        if (!apiToken) {
          return null;
        }
        await input.repositories.system.updateApiTokenLastUsed(apiToken.id, input.now());
        return {
          role: apiToken.role,
        };
      },
    },
    playerSessionAuth: {
      async authenticatePlayerSession(token) {
        return playerAuthCommands.authenticate(await sha256Hex(token));
      },
    },
    machineConnectionCommands,
  };
}

function createRuntimePluginContext(input: CreatePrismRuntimeDependenciesInput): PrismRuntimePluginContext {
  return {
    businessItems: {
      async listActive(listInput = {}) {
        const now = listInput.now ?? input.now();
        const items = await input.repositories.businessItems.listAll();
        return items
          .filter((item) => {
            if (item.status !== "active") return false;
            if (listInput.kind && item.kind !== listInput.kind) return false;
            if (item.activeAt && item.activeAt > now) return false;
            if (item.expiresAt && item.expiresAt <= now) return false;
            return true;
          })
          .map(cloneBusinessItem);
      },

      async findById(itemId) {
        const item = await input.repositories.businessItems.findById(itemId);
        return item ? cloneBusinessItem(item) : null;
      },
    },
  };
}

function cloneBusinessItem(item: BusinessItem): BusinessItem {
  return {
    ...item,
    activeAt: item.activeAt ? new Date(item.activeAt) : null,
    expiresAt: item.expiresAt ? new Date(item.expiresAt) : null,
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt),
    metadata: item.metadata ? { ...item.metadata } : null,
  };
}

async function withRuntimePricingHistory(
  configs: readonly PricingConfig[],
  input: {
    playerId: string;
    startedAt: Date;
    endedAt: Date;
    storeTimeZone?: string;
    pricingHistory: RuntimeRepositoryInput["pricingHistory"];
  },
): Promise<PricingConfig[]> {
  const providersByConfigId = new Map<string, Extract<PricingConfig, { kind: "time.priority" }>["provider"]>();
  const keys = configs.flatMap((config) => {
    if (config.kind !== "time.priority") return [];
    const provider = {
      ...config.provider,
      timeZone: config.provider.timeZone ?? input.storeTimeZone,
      pricingConfigId: config.id,
    };
    providersByConfigId.set(config.id, provider);
    return collectPriorityTimePricingHistoryLookupKeys({
      config: provider,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
    });
  });
  const paidHistory = await input.pricingHistory.sumByPlayerAndKeys(input.playerId, keys);

  return configs.map((config) => {
    if (config.kind !== "time.priority") return config;
    return {
      ...config,
      provider: {
        ...providersByConfigId.get(config.id)!,
        paidHistory,
      },
    };
  });
}

function assetDefinitionKey(assetType: string, assetCode: string): string {
  return `${assetType}\u0000${assetCode}`;
}

async function resolveStaffPricingExtensions(
  catalog: readonly StaffPricingExtension[],
  assetDefinitions: AssetDefinitionRepository,
): Promise<readonly StaffPricingExtension[]> {
  if (!catalog.some((extension) => extension.requiredAssets?.length)) return catalog;
  const definitions = new Map(
    (await assetDefinitions.listAll()).map((definition) => [
      assetDefinitionKey(definition.type, definition.code),
      definition,
    ]),
  );
  return catalog.map((extension): StaffPricingExtension => {
    if (!extension.requiredAssets?.length) {
      return extension;
    }

    const requiredAssets = extension.requiredAssets.map((asset) =>
      resolveRequiredExtensionAsset(definitions, asset),
    );
    const hasMissingSetup = requiredAssets.some((asset) => asset.status !== "ready");

    return {
      ...extension,
      configurationStatus: hasMissingSetup ? "needs-setup" : (extension.configurationStatus ?? "ready"),
      requiredAssets,
    };
  });
}

function resolveRequiredExtensionAsset(
  definitions: ReadonlyMap<string, AssetDefinition>,
  asset: StaffPricingExtensionRequiredAsset,
): StaffPricingExtensionRequiredAsset {
  const definition = definitions.get(assetDefinitionKey(asset.type, asset.code));
  if (!definition) {
    return {
      ...asset,
      status: "missing",
    };
  }

  return {
    ...asset,
    name: definition.name || asset.name,
    status: definition.status === "archived" ? "archived" : "ready",
  };
}

export type PrismRuntimeEnv = {
  [key: string]: unknown;
};

export type PrismWorkerEnv = PrismRuntimeEnv & {
  DB: D1DatabaseLike;
};

export type CreatePrismLocalAppInput = {
  db: Database;
  env: PrismRuntimeEnv;
  plugins?: readonly PrismRuntimePlugin[];
};

export type CreatePrismWorkerAppOptions = {
  plugins?: readonly PrismRuntimePlugin[];
};

export function createPrismWorkerApp(env: PrismWorkerEnv, options: CreatePrismWorkerAppOptions = {}): Hono {
  const runtime = createDefaultRuntimeConfig(env);
  return createPrismApp(
    {
      ...createPrismRuntimeDependencies({
      repositories: RuntimeRepositories.fromD1({
        db: env.DB,
        id: runtime.id,
        now: runtime.now,
      }),
      queries: RuntimeRepositories.queriesFromD1({
        db: env.DB,
        now: runtime.now,
        env,
      }),
      pricingProviders: runtime.pricingProviders,
      assetEffectProviders: runtime.assetEffectProviders,
      deviceActionExecutors: undefined,
      coinCooldownMs: runtime.coinCooldownMs,
      plugins: options.plugins ?? runtime.plugins,
      id: runtime.id,
      now: runtime.now,
      }),
      versionInfo: backendVersionInfo,
    },
  );
}

export function createPrismLocalApp(input: CreatePrismLocalAppInput): Hono {
  return createPrismApp(createPrismLocalDependencies(input));
}

export function createPrismLocalDependencies(input: CreatePrismLocalAppInput): PrismAppDependencies {
  const runtime = createDefaultRuntimeConfig(input.env);
  return {
    ...createPrismRuntimeDependencies({
      repositories: RuntimeRepositories.fromBunSqlite({
        db: input.db,
        id: runtime.id,
        now: runtime.now,
      }),
      queries: RuntimeRepositories.queriesFromBunSqlite({
        db: input.db,
        now: runtime.now,
        env: input.env,
      }),
      pricingProviders: runtime.pricingProviders,
      assetEffectProviders: runtime.assetEffectProviders,
      deviceActionExecutors: undefined,
      coinCooldownMs: runtime.coinCooldownMs,
      plugins: input.plugins ?? runtime.plugins,
      id: runtime.id,
      now: runtime.now,
    }),
    versionInfo: backendVersionInfo,
  };
}

export function initializeSqliteSchema(db: Database): void {
  db.run("PRAGMA foreign_keys = ON");
  for (const statement of sqliteSchema) db.run(statement);
}

export const RuntimeRepositories = {
  fromBunSqlite(input: { db: Database; id: () => string; now: () => Date }): RuntimeRepositoryInput {
    return createSqliteRepositories(input);
  },

  fromD1(input: { db: D1DatabaseLike; id: () => string; now: () => Date }): RuntimeRepositoryInput {
    return createD1Repositories(input);
  },

  queriesFromBunSqlite(input: { db: Database; now: () => Date; env?: PrismRuntimeEnv }): RuntimeQueryInput {
    return createRuntimeQueries({
      executor: createBunSqliteExecutor(input.db),
      now: input.now,
      env: input.env,
    });
  },

  queriesFromD1(input: { db: D1DatabaseLike; now: () => Date; env?: PrismRuntimeEnv }): RuntimeQueryInput {
    return createRuntimeQueries({
      executor: createD1Executor(input.db),
      now: input.now,
      env: input.env,
    });
  },
};

type DefaultRuntimeConfig = {
  pricingProviders: readonly PricingProvider[];
  assetEffectProviders: readonly AssetEffectProvider[];
  plugins: readonly PrismRuntimePlugin[];
  coinCooldownMs: number;
  id: () => string;
  now: () => Date;
};

function createDefaultRuntimeConfig(env: PrismRuntimeEnv): DefaultRuntimeConfig {
  return {
    pricingProviders: [],
    assetEffectProviders: [],
    plugins: [],
    coinCooldownMs: 60_000,
    id: randomId,
    now: () => new Date(),
  };
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value;
}

function randomId(): string {
  return crypto.randomUUID();
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = toBase64Url(saltBytes);
  const hash = await pbkdf2(password, salt);
  return { hash, salt };
}

async function verifyPassword(password: string, user: { passwordHash: string; passwordSalt: string }): Promise<boolean> {
  return timingSafeEqual(await pbkdf2(password, user.passwordSalt), user.passwordHash);
}

async function createSecret(label: "integration" | "machine" | "admin-session" | "player-session") {
  const random = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const tokenPrefix = label === "admin-session"
    ? "prism_admin"
    : label === "player-session"
      ? "prism_player"
      : label;
  const token = `${tokenPrefix}_${random}`;
  return {
    token,
    tokenPrefix,
    tokenHash: await sha256Hex(token),
  };
}

async function pbkdf2(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations: 100_000,
    },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates an HA executor that reads the connection config (url + token) from the
 * database at execution time, so staff can configure HA access through the Settings UI
 * without redeploying.
 */
function createDynamicHomeAssistantExecutor(input: {
  system: SqlRepositories["system"];
}): DeviceActionExecutor {
  return {
    async execute(executionInput) {
      let baseUrl = "";
      let token = "";
      let devices: HomeAssistantDeviceConfig[] = [];

      try {
        const connSetting = await input.system.getAppSetting<{ url?: string; token?: string }>(
          "devices.homeassistant_connection"
        );
        if (connSetting) {
          baseUrl = typeof connSetting.url === "string" ? connSetting.url.trim() : "";
          token = typeof connSetting.token === "string" ? connSetting.token.trim() : "";
        }
        const devicesSetting = await input.system.getAppSetting<HomeAssistantDeviceConfig[]>(
          "devices.homeassistant"
        );
        if (Array.isArray(devicesSetting)) devices = devicesSetting;
      } catch {
        // ignore DB read errors
      }

      if (baseUrl && token) {
        return createHomeAssistantExecutor({ baseUrl, accessToken: token, devices }).execute(executionInput);
      }

      return {
        status: "failed",
        message: "Home Assistant 未配置。请在设备看板的设置中填写 URL 和 Token。",
      };
    },
  };
}

function createDynamicHomeAssistantTargetResolver(input: {
  system: SqlRepositories["system"];
}) {
  return async (deviceRef: string) => {
    const normalizedRef = typeof deviceRef === "string" ? deviceRef.trim().toLowerCase() : "";
    if (!normalizedRef) {
      throw new PrismDomainError("设备不存在", "DEVICE_NOT_FOUND");
    }
    if (normalizedRef === "all") {
      return {
        target: { kind: "facility", all: true } as const,
        deviceLabel: "所有设备",
      };
    }

    const devicesSetting = await input.system.getAppSetting<HomeAssistantDeviceConfig[]>(
      "devices.homeassistant",
    );
    const devices = Array.isArray(devicesSetting) ? devicesSetting : [];
    const device = resolveHomeAssistantDeviceRef(deviceRef, devices);
    const entityId = device?.id?.trim();
    if (!device || !entityId) {
      throw new PrismDomainError("设备不存在", "DEVICE_NOT_FOUND");
    }

    return {
      target: { kind: "facility", id: entityId } as const,
      deviceLabel: device.name.trim() || "设备",
    };
  };
}

export type CreateRuntimeQueriesInput = CreateSqlReadModelsInput & {
  env?: PrismRuntimeEnv;
};

export function createRuntimeQueries(input: CreateRuntimeQueriesInput): RuntimeQueryInput {
  return createSqlReadModels(input);
}

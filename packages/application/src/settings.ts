import { PrismDomainError, type SystemRepository } from "@prism/core";

export type HomeAssistantDeviceConfig = {
  name: string;
  alias?: string[];
  id: string;
};

export type HomeAssistantConnectionConfig = {
  url: string;
  token: string;
};

export type TTLockConnectionConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  appAccount: string;
  appPwd: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt?: number | null;
};

export type TTLockDeviceConfig = {
  id: string;
  name: string;
  aliases: string[];
  lockId: number;
};

export type HinataIoDeviceConfig = {
  id: string;
  name: string;
  aliases: string[];
  url: string;
  password: string;
  salt: string;
  coinKey: number;
  cardType: string;
};

export type PlayerRegistrationSettings = {
  defaultPresentId: string | null;
};

export type StoreSettings = {
  store: {
    name: string;
    timeZone: string;
  };
  operations: {
    coinCooldownMs: number;
  };
  homeAssistantConnection: HomeAssistantConnectionConfig;
  homeAssistantDevices: HomeAssistantDeviceConfig[];
  ttLockConnection?: TTLockConnectionConfig;
  ttLockDevices?: TTLockDeviceConfig[];
  hinataIoDevices: HinataIoDeviceConfig[];
  registration: PlayerRegistrationSettings;
};

export type SettingsServiceDependencies = {
  system: SystemRepository;
};

export function createSettingsService(dependencies: SettingsServiceDependencies) {
  return {
    async getSettings(): Promise<StoreSettings> {
      const settings = new Map(
        (await dependencies.system.listAppSettings()).map((setting) => [setting.key, setting.value]),
      );
      const store = settings.get("store.profile") as Partial<StoreSettings["store"]> | undefined;
      const operations = settings.get("venue.operations") as Partial<StoreSettings["operations"]> | undefined;
      const haDevices = settings.get("devices.homeassistant") as HomeAssistantDeviceConfig[] | undefined;
      const haConnection = settings.get("devices.homeassistant_connection") as Partial<HomeAssistantConnectionConfig> | undefined;
      const ttLockConnection = settings.get("devices.ttlock_connection");
      const ttLockDevices = settings.get("devices.ttlock");
      const hinataIoDevices = settings.get("devices.hinata_io");
      const registration = settings.get("player.registration");

      return {
        store: {
          name: typeof store?.name === "string" && store.name.trim() ? store.name : "PRiSM",
          timeZone: typeof store?.timeZone === "string" && store.timeZone.trim() ? store.timeZone : "Asia/Shanghai",
        },
        operations: {
          coinCooldownMs: normalizeNonNegativeInteger(operations?.coinCooldownMs, 60_000),
        },
        homeAssistantConnection: {
          url: typeof haConnection?.url === "string" ? haConnection.url : "",
          token: typeof haConnection?.token === "string" ? haConnection.token : "",
        },
        homeAssistantDevices: Array.isArray(haDevices) ? haDevices : [],
        ttLockConnection: normalizeTTLockConnectionConfig(ttLockConnection),
        ttLockDevices: normalizeTTLockDeviceConfigs(ttLockDevices),
        hinataIoDevices: normalizeHinataIoDeviceConfigs(hinataIoDevices),
        registration: normalizeRegistrationSettings(registration),
      };
    },

    async updateSettings(input: StoreSettings): Promise<StoreSettings> {
      const next = normalizeSettings(input);
      const haDevices = Array.isArray(input.homeAssistantDevices) ? input.homeAssistantDevices : [];
      
      for (const d of haDevices) {
        if (!d.name || typeof d.name !== "string" || !d.id || typeof d.id !== "string") {
          throw new PrismDomainError("Each Home Assistant device must have a name and id.", "INVALID_HA_DEVICE_FORMAT");
        }
        if (d.alias && !Array.isArray(d.alias)) {
          throw new PrismDomainError("Device alias must be a list of strings.", "INVALID_HA_DEVICE_ALIAS");
        }
      }

      const haConnection: HomeAssistantConnectionConfig = {
        url: typeof input.homeAssistantConnection?.url === "string" ? input.homeAssistantConnection.url.trim() : "",
        token: typeof input.homeAssistantConnection?.token === "string" ? input.homeAssistantConnection.token.trim() : "",
      };
      const ttLockConnection = normalizeTTLockConnectionConfig(
        input.ttLockConnection === undefined
          ? await dependencies.system.getAppSetting("devices.ttlock_connection")
          : input.ttLockConnection,
      );
      const ttLockDevices = normalizeTTLockDeviceConfigs(
        input.ttLockDevices === undefined
          ? await dependencies.system.getAppSetting("devices.ttlock")
          : input.ttLockDevices,
      );
      validateTTLockConfiguration(ttLockConnection, ttLockDevices);
      const hinataIoDevices = normalizeHinataIoDeviceConfigs(
        input.hinataIoDevices === undefined
          ? await dependencies.system.getAppSetting("devices.hinata_io")
          : input.hinataIoDevices,
      );
      const registration = normalizeRegistrationSettings(
        input.registration === undefined
          ? await dependencies.system.getAppSetting("player.registration")
          : input.registration,
      );

      const settings = [
        { key: "store.profile", value: next.store },
        { key: "venue.operations", value: next.operations },
        { key: "devices.homeassistant", value: haDevices },
        { key: "devices.homeassistant_connection", value: haConnection },
        { key: "devices.ttlock_connection", value: ttLockConnection },
        { key: "devices.ttlock", value: ttLockDevices },
        { key: "devices.hinata_io", value: hinataIoDevices },
        { key: "player.registration", value: registration },
      ];
      if (dependencies.system.setAppSettings) {
        await dependencies.system.setAppSettings(settings);
      } else {
        await Promise.all(settings.map((setting) =>
          dependencies.system.setAppSetting(setting.key, setting.value),
        ));
      }
      return {
        ...next,
        homeAssistantConnection: haConnection,
        homeAssistantDevices: haDevices,
        ttLockConnection,
        ttLockDevices,
        hinataIoDevices,
        registration,
      };
    },
  };
}

function normalizeSettings(input: StoreSettings): StoreSettings {
  const name = input.store.name.trim();
  const timeZone = input.store.timeZone.trim();
  const coinCooldownMs = input.operations.coinCooldownMs;
  if (!name) {
    throw new PrismDomainError("Store name is required.", "STORE_NAME_REQUIRED");
  }
  if (!timeZone) {
    throw new PrismDomainError("Store time zone is required.", "STORE_TIME_ZONE_REQUIRED");
  }
  if (!Number.isInteger(coinCooldownMs) || coinCooldownMs < 0) {
    throw new PrismDomainError("Coin cooldown must be a non-negative integer.", "INVALID_COIN_COOLDOWN");
  }
  return {
    store: {
      name,
      timeZone,
    },
    operations: {
      coinCooldownMs,
    },
    homeAssistantConnection: input.homeAssistantConnection,
    homeAssistantDevices: input.homeAssistantDevices,
    ttLockConnection: input.ttLockConnection,
    ttLockDevices: input.ttLockDevices,
    hinataIoDevices: input.hinataIoDevices,
    registration: normalizeRegistrationSettings(input.registration),
  };
}

function normalizeRegistrationSettings(value: unknown): PlayerRegistrationSettings {
  if (!isRecord(value)) return { defaultPresentId: null };
  const defaultPresentId = value.defaultPresentId;
  return {
    defaultPresentId: typeof defaultPresentId === "string" && defaultPresentId.trim()
      ? defaultPresentId.trim()
      : null,
  };
}

export function normalizeHinataIoDeviceConfigs(value: unknown): HinataIoDeviceConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PrismDomainError("Hinata IO devices must be a list.", "INVALID_HINATA_IO_DEVICES");
  }
  const devices = value.map((entry, index) => normalizeHinataIoDeviceConfig(entry, index));
  const ids = new Set<string>();
  const refs = new Set<string>();
  for (const device of devices) {
    const id = normalizeDeviceRef(device.id);
    if (ids.has(id)) {
      throw new PrismDomainError("Hinata IO device ids must be unique.", "DUPLICATE_HINATA_IO_DEVICE_ID");
    }
    ids.add(id);
    for (const ref of [device.name, ...device.aliases]) {
      const normalized = normalizeDeviceRef(ref);
      if (refs.has(normalized)) {
        throw new PrismDomainError(
          "Hinata IO device names and aliases must be unique.",
          "DUPLICATE_HINATA_IO_DEVICE_REF",
        );
      }
      refs.add(normalized);
    }
  }
  return devices;
}

const DEFAULT_TTLOCK_BASE_URL = "https://api.sciener.com";

export function normalizeTTLockConnectionConfig(value: unknown): TTLockConnectionConfig {
  const record = isRecord(value) ? value : {};
  const numberValue = record.accessTokenExpiresAt;
  return {
    baseUrl: typeof record.baseUrl === "string" && record.baseUrl.trim()
      ? record.baseUrl.trim().replace(/\/+$/, "")
      : DEFAULT_TTLOCK_BASE_URL,
    clientId: optionalString(record.clientId),
    clientSecret: optionalString(record.clientSecret),
    appAccount: optionalString(record.appAccount),
    appPwd: optionalString(record.appPwd),
    accessToken: optionalString(record.accessToken),
    refreshToken: optionalString(record.refreshToken),
    accessTokenExpiresAt: typeof numberValue === "number" && Number.isFinite(numberValue)
      ? numberValue
      : null,
  };
}

export function normalizeTTLockDeviceConfigs(value: unknown): TTLockDeviceConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PrismDomainError("TTLock devices must be a list.", "INVALID_TTLOCK_DEVICES");
  }
  const devices = value.map((entry, index) => normalizeTTLockDeviceConfig(entry, index));
  const ids = new Set<string>();
  const lockIds = new Set<number>();
  const refs = new Set<string>();
  for (const device of devices) {
    const normalizedId = normalizeDeviceRef(device.id);
    if (ids.has(normalizedId)) {
      throw new PrismDomainError("TTLock device ids must be unique.", "DUPLICATE_TTLOCK_DEVICE_ID");
    }
    ids.add(normalizedId);
    if (lockIds.has(device.lockId)) {
      throw new PrismDomainError("TTLock lock ids must be unique.", "DUPLICATE_TTLOCK_LOCK_ID");
    }
    lockIds.add(device.lockId);
    for (const ref of [device.name, ...device.aliases]) {
      const normalized = normalizeDeviceRef(ref);
      if (!normalized) continue;
      if (refs.has(normalized)) {
        throw new PrismDomainError(
          "TTLock device names and aliases must be unique.",
          "DUPLICATE_TTLOCK_DEVICE_REF",
        );
      }
      refs.add(normalized);
    }
  }
  return devices;
}

function normalizeTTLockDeviceConfig(value: unknown, index: number): TTLockDeviceConfig {
  if (!isRecord(value)) {
    throw new PrismDomainError(`TTLock device ${index + 1} is invalid.`, "INVALID_TTLOCK_DEVICE");
  }
  const id = requiredTTLockString(value.id, index, "id");
  const name = requiredTTLockString(value.name, index, "name");
  const lockId = value.lockId;
  if (typeof lockId !== "number" || !Number.isInteger(lockId) || lockId <= 0) {
    throw new PrismDomainError(`TTLock device ${index + 1} lockId is invalid.`, "INVALID_TTLOCK_LOCK_ID");
  }
  if (!Array.isArray(value.aliases) || !value.aliases.every((alias) => typeof alias === "string")) {
    throw new PrismDomainError(`TTLock device ${index + 1} aliases are invalid.`, "INVALID_TTLOCK_ALIASES");
  }
  return {
    id,
    name,
    aliases: value.aliases.map((alias) => alias.trim()).filter(Boolean),
    lockId,
  };
}

function validateTTLockConfiguration(
  connection: TTLockConnectionConfig,
  devices: readonly TTLockDeviceConfig[],
): void {
  if (devices.length === 0) return;
  if (!connection.clientId) {
    throw new PrismDomainError("TTLock clientId is required when locks are configured.", "INVALID_TTLOCK_CONNECTION");
  }
  const hasToken = Boolean(connection.accessToken || connection.refreshToken);
  const hasPasswordGrant = Boolean(connection.appAccount && connection.appPwd && connection.clientSecret);
  if (!hasToken && !hasPasswordGrant) {
    throw new PrismDomainError(
      "TTLock requires an access token, refresh token, or complete account credentials.",
      "INVALID_TTLOCK_CONNECTION",
    );
  }
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredTTLockString(value: unknown, index: number, field: string): string {
  const result = optionalString(value);
  if (!result) {
    throw new PrismDomainError(`TTLock device ${index + 1} ${field} is required.`, "INVALID_TTLOCK_DEVICE");
  }
  return result;
}

function normalizeHinataIoDeviceConfig(value: unknown, index: number): HinataIoDeviceConfig {
  if (!isRecord(value)) {
    throw new PrismDomainError(`Hinata IO device ${index + 1} is invalid.`, "INVALID_HINATA_IO_DEVICE");
  }
  const id = requiredHinataIoString(value.id, index, "id");
  const name = requiredHinataIoString(value.name, index, "name");
  const url = requiredHinataIoString(value.url, index, "url");
  const password = requiredHinataIoString(value.password, index, "password");
  const salt = requiredHinataIoString(value.salt, index, "salt");
  if (!isSixteenByteBase64Url(salt)) {
    throw new PrismDomainError(`Hinata IO device ${index + 1} salt is invalid.`, "INVALID_HINATA_IO_SALT");
  }
  if (!Array.isArray(value.aliases) || !value.aliases.every((alias) => typeof alias === "string")) {
    throw new PrismDomainError(`Hinata IO device ${index + 1} aliases are invalid.`, "INVALID_HINATA_IO_ALIASES");
  }
  const aliases = value.aliases.map((alias) => alias.trim()).filter(Boolean);
  const coinKey = value.coinKey ?? 32;
  if (typeof coinKey !== "number" || !Number.isInteger(coinKey) || coinKey < 0 || coinKey > 65_535) {
    throw new PrismDomainError(`Hinata IO device ${index + 1} coin key is invalid.`, "INVALID_HINATA_IO_COIN_KEY");
  }
  const cardType = typeof value.cardType === "string" && value.cardType.trim()
    ? value.cardType.trim().toLowerCase()
    : "aime";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
  } catch {
    throw new PrismDomainError(`Hinata IO device ${index + 1} URL is invalid.`, "INVALID_HINATA_IO_URL");
  }
  return { id, name, aliases, url, password, salt, coinKey, cardType };
}

function requiredHinataIoString(value: unknown, index: number, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PrismDomainError(
      `Hinata IO device ${index + 1} ${field} is required.`,
      "INVALID_HINATA_IO_DEVICE",
    );
  }
  return value.trim();
}

function normalizeDeviceRef(value: string): string {
  return value.trim().toLowerCase();
}

function isSixteenByteBase64Url(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.includes("=")) return false;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), "=");
    return atob(padded).length === 16;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value;
}

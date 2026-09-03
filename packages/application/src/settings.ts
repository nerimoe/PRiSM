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
  hinataIoDevices: HinataIoDeviceConfig[];
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
      const hinataIoDevices = settings.get("devices.hinata_io");

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
        hinataIoDevices: normalizeHinataIoDeviceConfigs(hinataIoDevices),
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
      const hinataIoDevices = normalizeHinataIoDeviceConfigs(
        input.hinataIoDevices === undefined
          ? await dependencies.system.getAppSetting("devices.hinata_io")
          : input.hinataIoDevices,
      );

      const settings = [
        { key: "store.profile", value: next.store },
        { key: "venue.operations", value: next.operations },
        { key: "devices.homeassistant", value: haDevices },
        { key: "devices.homeassistant_connection", value: haConnection },
        { key: "devices.hinata_io", value: hinataIoDevices },
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
        hinataIoDevices,
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
    hinataIoDevices: input.hinataIoDevices,
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

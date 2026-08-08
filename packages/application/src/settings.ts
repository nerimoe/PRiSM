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

      const settings = [
        { key: "store.profile", value: next.store },
        { key: "venue.operations", value: next.operations },
        { key: "devices.homeassistant", value: haDevices },
        { key: "devices.homeassistant_connection", value: haConnection },
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
  };
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value;
}

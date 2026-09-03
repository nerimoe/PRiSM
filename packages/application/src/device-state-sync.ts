import type { DeviceState, DeviceStateRepository, SystemRepository } from "@prism/core";
import type { HomeAssistantConnectionConfig, HomeAssistantDeviceConfig } from "./settings";

export type HomeAssistantStateSource = {
  readState(input: {
    connection: HomeAssistantConnectionConfig;
    device: HomeAssistantDeviceConfig;
  }): Promise<string>;
};

export type DeviceStateSyncService = {
  syncConfiguredHomeAssistantStates(): Promise<void>;
};

export type DeviceStateSyncServiceDependencies = {
  system: SystemRepository;
  deviceStates: DeviceStateRepository;
  source: HomeAssistantStateSource;
  now: () => Date;
  onDeviceError?: (device: HomeAssistantDeviceConfig, error: unknown) => void;
};

export function createDeviceStateSyncService(
  dependencies: DeviceStateSyncServiceDependencies,
): DeviceStateSyncService {
  return {
    async syncConfiguredHomeAssistantStates() {
      const [devicesSetting, connectionSetting] = await Promise.all([
        dependencies.system.getAppSetting<HomeAssistantDeviceConfig[]>("devices.homeassistant"),
        dependencies.system.getAppSetting<HomeAssistantConnectionConfig>("devices.homeassistant_connection"),
      ]);
      const devices = Array.isArray(devicesSetting) ? devicesSetting : [];
      const connection = normalizeConnection(connectionSetting);
      if (devices.length === 0 || !connection.url || !connection.token) return;

      const reportedAt = dependencies.now();
      const states = (await Promise.all(devices.map(async (device): Promise<DeviceState | null> => {
        if (!device?.id?.trim() || !device?.name?.trim()) return null;
        try {
          const state = await dependencies.source.readState({ connection, device });
          return {
            deviceId: device.id,
            type: "power.on",
            targetKind: "facility",
            executorKind: "home_assistant",
            label: device.name,
            status: "online",
            state: state === "on" ? "on" : "off",
            metadata: {},
            reportedAt,
            reportedBy: "home_assistant_sync",
          };
        } catch (error) {
          dependencies.onDeviceError?.(device, error);
          return null;
        }
      }))).filter((state): state is DeviceState => state !== null);

      if (states.length === 0) return;
      await dependencies.deviceStates.saveMany(states);
    },
  };
}

function normalizeConnection(
  input: HomeAssistantConnectionConfig | null,
): HomeAssistantConnectionConfig {
  return {
    url: typeof input?.url === "string" ? input.url.trim() : "",
    token: typeof input?.token === "string" ? input.token.trim() : "",
  };
}

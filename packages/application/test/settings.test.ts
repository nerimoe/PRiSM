import { describe, expect, it } from "bun:test";
import type { SystemRepository } from "@prism/core";
import { createSettingsService } from "../src/index";

describe("createSettingsService", () => {
  it("reads and updates structured store settings without exposing raw app setting keys", async () => {
    const system = createMemorySystemRepository();
    const service = createSettingsService({ system });

    await expect(service.getSettings()).resolves.toEqual({
      store: {
        name: "PRiSM",
        timeZone: "Asia/Shanghai",
      },
      operations: {
        coinCooldownMs: 60_000,
      },
      homeAssistantConnection: { url: "", token: "" },
      homeAssistantDevices: [],
      hinataIoDevices: [],
      registration: { defaultPresentId: null },
    });

    await expect(
      service.updateSettings({
        store: {
          name: "  音游窝  ",
          timeZone: " Asia/Shanghai ",
        },
        operations: {
          coinCooldownMs: 30_000,
        },
        homeAssistantConnection: {
          url: "http://homeassistant.local:8123",
          token: "test-token-abc",
        },
        homeAssistantDevices: [
          {
            name: "中二官拆",
            alias: ["chu2"],
            id: "switch.cuco_cn_571514441_v3_on_p_2_1",
          },
        ],
        hinataIoDevices: [hinataIoDevice],
        registration: { defaultPresentId: "present-welcome" },
      }),
    ).resolves.toEqual({
      store: {
        name: "音游窝",
        timeZone: "Asia/Shanghai",
      },
      operations: {
        coinCooldownMs: 30_000,
      },
      homeAssistantConnection: {
        url: "http://homeassistant.local:8123",
        token: "test-token-abc",
      },
      homeAssistantDevices: [
        {
          name: "中二官拆",
          alias: ["chu2"],
          id: "switch.cuco_cn_571514441_v3_on_p_2_1",
        },
      ],
      hinataIoDevices: [hinataIoDevice],
      registration: { defaultPresentId: "present-welcome" },
    });
    await expect(system.getAppSetting("store.profile")).resolves.toEqual({
      name: "音游窝",
      timeZone: "Asia/Shanghai",
    });
    await expect(system.getAppSetting("venue.operations")).resolves.toEqual({
      coinCooldownMs: 30_000,
    });
    await expect(system.getAppSetting("devices.homeassistant")).resolves.toEqual([
      {
        name: "中二官拆",
        alias: ["chu2"],
        id: "switch.cuco_cn_571514441_v3_on_p_2_1",
      },
    ]);
    await expect(system.getAppSetting("devices.hinata_io")).resolves.toEqual([hinataIoDevice]);
    await expect(system.getAppSetting("player.registration")).resolves.toEqual({
      defaultPresentId: "present-welcome",
    });
  });

  it("rejects invalid operation settings", async () => {
    const service = createSettingsService({
      system: createMemorySystemRepository(),
    });

    await expect(
      service.updateSettings({
        store: {
          name: "音游窝",
          timeZone: "Asia/Tokyo",
        },
        operations: {
          coinCooldownMs: -1,
        },
        homeAssistantConnection: { url: "", token: "" },
        homeAssistantDevices: [],
        hinataIoDevices: [],
        registration: { defaultPresentId: null },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_COIN_COOLDOWN",
    });
  });

  it("rejects duplicate Hinata IO aliases", async () => {
    const service = createSettingsService({ system: createMemorySystemRepository() });
    await expect(service.updateSettings({
      store: { name: "音游窝", timeZone: "Asia/Tokyo" },
      operations: { coinCooldownMs: 60_000 },
      homeAssistantConnection: { url: "", token: "" },
      homeAssistantDevices: [],
      hinataIoDevices: [
        hinataIoDevice,
        { ...hinataIoDevice, id: "maimai-right", name: "舞萌右机" },
      ],
      registration: { defaultPresentId: null },
    })).rejects.toMatchObject({ code: "DUPLICATE_HINATA_IO_DEVICE_REF" });
  });
});

const hinataIoDevice = {
  id: "maimai-left",
  name: "舞萌左机",
  aliases: ["mai-left"],
  url: "https://relay.example/maimai-left",
  password: "test-password",
  salt: "ABEiM0RVZneImaq7zN3u_w",
  coinKey: 32,
  cardType: "aime",
};

function createMemorySystemRepository(): SystemRepository {
  const settings = new Map<string, unknown>();
  return {
    async hasOwnerStaffUser() {
      return false;
    },
    async saveStaffUser() {},
    async listStaffUsers() {
      return [];
    },
    async findStaffUserByUsername() {
      return null;
    },
    async findStaffUserById() {
      return null;
    },
    async saveAdminSession() {},
    async findAdminSessionByTokenHash() {
      return null;
    },
    async revokeAdminSession() {},
    async saveApiToken() {},
    async listApiTokens() {
      return [];
    },
    async findActiveApiTokenByHash() {
      return null;
    },
    async updateApiTokenLastUsed() {},
    async revokeApiToken() {},
    async setAppSetting(key, value) {
      settings.set(key, value);
    },
    async getAppSetting<T = unknown>(key: string): Promise<T | null> {
      return (settings.get(key) as T | undefined) ?? null;
    },
    async listAppSettings() {
      return [...settings.entries()].map(([key, value]) => ({
        key,
        value,
        updatedAt: new Date("2026-06-08T10:00:00.000Z"),
      }));
    },
  };
}

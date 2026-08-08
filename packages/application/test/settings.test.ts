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
      }),
    ).rejects.toMatchObject({
      code: "INVALID_COIN_COOLDOWN",
    });
  });
});

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

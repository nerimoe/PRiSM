import { describe, expect, it } from "bun:test";
import type { DeviceState } from "@prism/core";
import { createDeviceStateSyncService } from "../src/device-state-sync";

describe("createDeviceStateSyncService", () => {
  it("loads configured devices, reads them concurrently, and persists one batch", async () => {
    const savedBatches: DeviceState[][] = [];
    const sourceCalls: string[] = [];
    const service = createDeviceStateSyncService({
      system: {
        async getAppSetting(key: string) {
          if (key === "devices.homeassistant") {
            return [
              { name: "舞萌一号", id: "switch.maimai_1" },
              { name: "WACCA", id: "light.wacca" },
            ];
          }
          if (key === "devices.homeassistant_connection") {
            return { url: "https://ha.example.com/", token: "ha-token" };
          }
          return null;
        },
      } as any,
      deviceStates: {
        async save() {
          throw new Error("batch persistence should be used");
        },
        async saveMany(states) {
          savedBatches.push([...states]);
        },
        async listAll() {
          return [];
        },
      },
      source: {
        async readState({ device }) {
          sourceCalls.push(device.id);
          return device.id.startsWith("switch") ? "on" : "off";
        },
      },
      now: () => new Date("2026-07-16T10:00:00.000Z"),
    });

    await service.syncConfiguredHomeAssistantStates();

    expect(sourceCalls.sort()).toEqual(["light.wacca", "switch.maimai_1"]);
    expect(savedBatches).toHaveLength(1);
    expect(savedBatches[0]).toEqual([
      expect.objectContaining({
        deviceId: "switch.maimai_1",
        label: "舞萌一号",
        state: JSON.stringify({ state: "on" }),
        reportedBy: "home_assistant_sync",
      }),
      expect.objectContaining({
        deviceId: "light.wacca",
        label: "WACCA",
        state: JSON.stringify({ state: "off" }),
        reportedBy: "home_assistant_sync",
      }),
    ]);
  });

  it("keeps successful device states when one external read fails", async () => {
    const saved: DeviceState[] = [];
    const errors: string[] = [];
    const service = createDeviceStateSyncService({
      system: {
        async getAppSetting(key: string) {
          if (key === "devices.homeassistant") {
            return [
              { name: "在线设备", id: "switch.online" },
              { name: "离线设备", id: "switch.offline" },
            ];
          }
          return { url: "https://ha.example.com", token: "ha-token" };
        },
      } as any,
      deviceStates: {
        async save(state) {
          saved.push(state);
        },
        async saveMany(states) {
          saved.push(...states);
        },
        async listAll() {
          return [];
        },
      },
      source: {
        async readState({ device }) {
          if (device.id === "switch.offline") throw new Error("offline");
          return "on";
        },
      },
      now: () => new Date("2026-07-16T10:00:00.000Z"),
      onDeviceError(device) {
        errors.push(device.id);
      },
    });

    await service.syncConfiguredHomeAssistantStates();

    expect(saved.map((state) => state.deviceId)).toEqual(["switch.online"]);
    expect(errors).toEqual(["switch.offline"]);
  });
});

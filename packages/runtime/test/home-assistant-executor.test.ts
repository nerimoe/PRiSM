import { describe, expect, it } from "bun:test";
import type { DeviceCommand } from "@prism/core";
import { createHomeAssistantExecutor, resolveHomeAssistantDeviceRef } from "../src/home-assistant-executor";

describe("createHomeAssistantExecutor", () => {
  it("maps power.on to a Home Assistant turn_on service call", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const executor = createHomeAssistantExecutor({
      baseUrl: "https://ha.example.com/",
      accessToken: "ha-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse([{ changed: true }]);
      },
    });

    await expect(
      executor.execute({
        command: facilityCommand({
          type: "power.on",
          deviceId: "switch.maimai_dx",
        }),
      }),
    ).resolves.toEqual({ status: "success" });

    expect(calls).toEqual([
      {
        url: "https://ha.example.com/api/services/switch/turn_on",
        init: {
          method: "POST",
          headers: {
            Authorization: "Bearer ha-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ entity_id: "switch.maimai_dx" }),
        },
      },
    ]);
  });

  it("invokes the injected fetch as a plain function", async () => {
    let receivedThis: unknown = globalThis;
    const executor = createHomeAssistantExecutor({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      fetch: async function (this: unknown) {
        receivedThis = this;
        return jsonResponse([]);
      },
    });

    await executor.execute({
      command: facilityCommand({
        type: "power.on",
        deviceId: "switch.maimai_dx",
      }),
    });

    expect(receivedThis).toBeUndefined();
  });

  it("maps ac.set_temperature to a Home Assistant climate service call", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const executor = createHomeAssistantExecutor({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse([]);
      },
    });

    await executor.execute({
      command: facilityCommand({
        type: "ac.set_temperature",
        deviceId: "climate.front_room",
        payload: { temperature: 24 },
      }),
    });

    expect(calls.map((call) => [call.url, call.init?.body])).toEqual([
      [
        "https://ha.example.com/api/services/climate/set_temperature",
        JSON.stringify({
          entity_id: "climate.front_room",
          temperature: 24,
        }),
      ],
    ]);
  });

  it("rejects game-machine actions configured with the Home Assistant executor", async () => {
    const executor = createHomeAssistantExecutor({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      fetch: async () => {
        throw new Error("coin should not call Home Assistant");
      },
    });

    await expect(
      executor.execute({
        command: {
          ...facilityCommand({
            type: "coin",
            deviceId: "maimai-dx-1",
          }),
          targetKind: "game_machine",
          executorKind: "machine_ws",
        },
      }),
    ).resolves.toEqual({
      status: "failed",
      message: "Home Assistant cannot execute coin.",
    });
  });

  it("returns a backend-visible failure message for Home Assistant non-2xx responses", async () => {
    const executor = createHomeAssistantExecutor({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      fetch: async () => jsonResponse({ error: "offline" }, 503),
    });

    await expect(
      executor.execute({
        command: facilityCommand({
          type: "power.off",
          deviceId: "switch.maimai_dx",
        }),
      }),
    ).resolves.toEqual({
      status: "failed",
      message: 'Home Assistant service switch.turn_off failed with 503: {"error":"offline"}.',
    });
  });

  it("turns off all configured Home Assistant devices and skips duplicate entity ids", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const executor = createHomeAssistantExecutor({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      devices: [
        { name: "maimai", id: "switch.maimai" },
        { name: "wacca", id: "light.wacca" },
        { name: "duplicate", id: "switch.maimai" },
      ],
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return jsonResponse([]);
      },
    });

    await expect(
      executor.execute({
        command: facilityCommand({
          type: "power.off",
          deviceId: null,
        }),
      }),
    ).resolves.toEqual({ status: "success" });

    expect(calls).toEqual([
      {
        url: "https://ha.example.com/api/services/switch/turn_off",
        body: { entity_id: "switch.maimai" },
      },
      {
        url: "https://ha.example.com/api/services/light/turn_off",
        body: { entity_id: "light.wacca" },
      },
    ]);
  });

  it("returns a useful failure when all is requested without configured devices", async () => {
    const executor = createHomeAssistantExecutor({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      devices: [],
      fetch: async () => {
        throw new Error("should not call Home Assistant");
      },
    });

    await expect(
      executor.execute({
        command: facilityCommand({
          type: "power.off",
          deviceId: null,
        }),
      }),
    ).resolves.toEqual({
      status: "failed",
      message: "没有配置任何 Home Assistant 设备，无法操作所有设备。",
    });
  });

  it("uses configured device names instead of entity ids in all-device failures", async () => {
    const executor = createHomeAssistantExecutor({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      devices: [
        { name: "舞萌一号机", id: "switch.maimai_1" },
      ],
      fetch: async () => jsonResponse({ error: "offline" }, 503),
    });

    const result = await executor.execute({
      command: facilityCommand({
        type: "power.on",
        deviceId: null,
      }),
    });

    expect(result).toEqual({
      status: "failed",
      message: '部分设备执行失败：舞萌一号机: Home Assistant service switch.turn_on failed with 503: {"error":"offline"}.',
    });
    expect(JSON.stringify(result)).not.toContain("switch.maimai_1");
  });

  it("executes only the canonical Home Assistant entity id stored on the command", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const executor = createHomeAssistantExecutor({
      baseUrl: "https://ha.example.com",
      accessToken: "ha-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse([{ changed: true }]);
      },
    });

    await expect(
      executor.execute({
        command: facilityCommand({
          type: "power.on",
          deviceId: "switch.cuco_cn_944020287_v3_on_p_2_1",
        }),
      }),
    ).resolves.toEqual({ status: "success" });

    const init = calls[0]?.init;
    expect(JSON.parse(String(init?.body))).toEqual({
      entity_id: "switch.cuco_cn_944020287_v3_on_p_2_1",
    });
    expect(calls[0]?.url).toBe("https://ha.example.com/api/services/switch/turn_on");
  });

  it("resolves only configured names and aliases, never Home Assistant ids", () => {
    const devices = [
      { name: "wacca", alias: ["wc", "划卡"], id: "switch.cuco_cn_944020287_v3_on_p_2_1" },
    ];
    expect(resolveHomeAssistantDeviceRef("wacca", devices)).toEqual(devices[0]);
    expect(resolveHomeAssistantDeviceRef("划卡", devices)).toEqual(devices[0]);
    expect(resolveHomeAssistantDeviceRef("switch.cuco_cn_944020287_v3_on_p_2_1", devices)).toBeNull();
    expect(resolveHomeAssistantDeviceRef("unknown-device", devices)).toBeNull();
  });

  it("rejects a single string alias because aliases must be configured as an array", () => {
    const invalidDevices = [
      { name: "wacca", alias: "wc", id: "switch.wacca" },
    ] as unknown as Parameters<typeof resolveHomeAssistantDeviceRef>[1];

    expect(resolveHomeAssistantDeviceRef("wc", invalidDevices)).toBeNull();
  });
});
function facilityCommand(input: {
  type: DeviceCommand["type"];
  deviceId: string | null;
  payload?: Record<string, unknown>;
}): DeviceCommand {
  return {
    id: "command-1",
    type: input.type,
    deviceId: input.deviceId,
    targetKind: "facility",
    executorKind: "home_assistant",
    staffId: "staff-1",
    status: "pending",
    payload: input.payload,
    requestedAt: new Date("2026-07-07T10:00:00.000Z"),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

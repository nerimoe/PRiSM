/**
 * Compatibility views over the device model for clients that predate it:
 * `/staff|integration/device-states` (the Bot's power listing and its
 * auto-power-off loop) and `/staff/machine-connections`.
 */
import type { DeviceState, MachineConnection } from "@prism/core";
import { createD1Executor } from "@prism/adapter-d1";
import { createDeviceEventRepository } from "@prism/storage-sql";
import { loadResources } from "../resource.js";
import type { DeviceRuntime } from "./runtime.js";
import { readShopDeviceStates } from "./device-state.js";

/**
 * Power of every enabled device that has it, read as everywhere else
 * (`readShopDeviceStates`): from storage while live, otherwise from Home
 * Assistant now. A device whose power cannot be read is `offline` with state
 * `unknown`; a value stored while nothing watched it is history, not its state.
 */
export async function listDeviceStates(runtime: DeviceRuntime): Promise<DeviceState[]> {
  const now = runtime.now ?? (() => new Date());
  const devices = (await loadResources(runtime.db, runtime.shopId, runtime.env.URL_ENCRYPTION_KEY))
    .filter((device) => device.enabled && device.capabilities.has("power"));
  if (!devices.length) return [];
  const { states } = await readShopDeviceStates(runtime, devices);
  return devices.map((device): DeviceState => {
    const power = states[device.id]?.power ?? null;
    return {
      deviceId: device.id,
      type: "power.on",
      targetKind: "facility",
      executorKind: "home_assistant",
      label: device.name,
      status: power ? "online" : "offline",
      state: power ?? "unknown",
      metadata: { aliases: device.aliases },
      reportedAt: now(),
      reportedBy: "home_assistant",
    };
  });
}

/** Embedded HINATA IO links, from the link state the relay records. */
export async function listMachineConnections(runtime: DeviceRuntime): Promise<MachineConnection[]> {
  const states = (await createDeviceEventRepository(createD1Executor(runtime.db, runtime.shopId)).listState())
    .filter((state) => state.capability === "hinata_io" && state.key === "link");
  return states.map((state) => {
    const online = state.value === "online";
    return {
      machineId: state.deviceId,
      status: online ? "online" : "offline",
      capabilities: ["aime.scan", "coin"],
      connectedAt: state.changedAt,
      lastSeenAt: state.changedAt,
      ...(online ? {} : { disconnectedAt: state.changedAt }),
    };
  });
}

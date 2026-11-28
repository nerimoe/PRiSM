import { expect, test } from "bun:test";
import { parseShopLocationSettings, resolveEffectiveLocationPolicy } from "../src/resources/location.js";

test("resolves independent gates with BLE-first auto fallback to GPS and resource overrides", () => {
  const shop = { checkin_geo: 1, checkout_geo: 0, machine_geo: 1 };
  const settings = parseShopLocationSettings(JSON.stringify({
    rssiThreshold: -75,
    resources: {
      door: { mode: "none" },
      vip: { mode: "require", beaconNodeId: "iot-vip", rssiThreshold: -65 },
      legacyBle: { mode: "ble", beaconNodeId: "iot-vip", rssiThreshold: -68 },
      legacyGps: { mode: "gps" },
    },
  }));

  expect(settings.resources.legacyBle).toEqual({ mode: "require", beaconNodeId: "iot-vip", rssiThreshold: -68 });
  expect(settings.resources.legacyGps).toEqual({ mode: "require", beaconNodeId: null, rssiThreshold: null });

  const onlineShop = [
    { nodeId: "iot-hall", online: true, rssiThreshold: -75 },
    { nodeId: "iot-vip", online: true, rssiThreshold: -75 },
  ];
  const vipOffline = [
    { nodeId: "iot-hall", online: true, rssiThreshold: -75 },
    { nodeId: "iot-vip", online: false, rssiThreshold: -75 },
  ];
  const allOffline = [
    { nodeId: "iot-hall", online: false, rssiThreshold: -75 },
    { nodeId: "iot-vip", online: false, rssiThreshold: -75 },
  ];

  // Disabled action stays `none` even when online beacons exist.
  expect(resolveEffectiveLocationPolicy({ shop, action: "checkout", settings, beacons: onlineShop }).mode).toBe("none");
  // `none` resource override skips verification across all actions on that resource.
  expect(resolveEffectiveLocationPolicy({ shop, action: "checkin", settings, beacons: onlineShop, deviceId: "door" }).mode).toBe("none");
  // `require` override enforces verification even if shop gate is off.
  expect(resolveEffectiveLocationPolicy({
    shop: { checkin_geo: 0, checkout_geo: 0, machine_geo: 0 },
    action: "machine",
    settings,
    beacons: onlineShop,
    deviceId: "vip",
  })).toEqual({ mode: "ble", beaconNodeId: "iot-vip", rssiThreshold: -65 });

  // Priority chain: pinned online beacon -> any online shop beacon -> GPS fallback.
  expect(resolveEffectiveLocationPolicy({ shop, action: "machine", settings, beacons: onlineShop, deviceId: "vip" }))
    .toEqual({ mode: "ble", beaconNodeId: "iot-vip", rssiThreshold: -65 });
  expect(resolveEffectiveLocationPolicy({ shop, action: "machine", settings, beacons: vipOffline, deviceId: "vip" }))
    .toEqual({ mode: "ble", beaconNodeId: null, rssiThreshold: -65 });
  expect(resolveEffectiveLocationPolicy({ shop, action: "machine", settings, beacons: allOffline, deviceId: "vip" }))
    .toEqual({ mode: "gps", beaconNodeId: null, rssiThreshold: null });
  expect(resolveEffectiveLocationPolicy({ shop, action: "checkin", settings, beacons: allOffline }))
    .toEqual({ mode: "gps", beaconNodeId: null, rssiThreshold: null });
  expect(resolveEffectiveLocationPolicy({ shop, action: "checkin", settings, beacons: onlineShop }))
    .toEqual({ mode: "ble", beaconNodeId: null, rssiThreshold: -75 });
});

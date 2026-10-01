import { expect, test } from "bun:test";
import { HinataReaderManager, type ReaderState } from "./reader-manager";
import { FakeDevice, FakeHid, until, wait } from "./reader-test-device";
import type { BasicCard, ReaderDevice } from "./card-reader";

function observe(hid: FakeHid) {
  const states: ReaderState[] = []; const cards: BasicCard[] = []; const errors: Error[] = [];
  const manager = new HinataReaderManager(hid, {
    onState: state => states.push(state), onCard: card => cards.push(card),
    onError: error => errors.push(error), onRecovered: () => {},
  });
  const status = () => states.at(-1)?.status;
  return { manager, states, cards, errors, status };
}

test("authorized devices auto-connect, duplicate events are ignored, and hotplug starts a fresh handshake", async () => {
  const device = new FakeDevice(); const hid = new FakeHid([device]);
  const { manager, status, cards, errors } = observe(hid);
  try {
    await manager.start(); await until(() => cards.length === 1);
    expect(status()).toBe("connected"); expect(device.opens).toBe(1);
    hid.emit("connect", device); hid.emit("connect", device);
    await wait(30); expect(device.opens).toBe(1);
    hid.emit("disconnect", device);
    await until(() => status() === "disconnected" && !device.opened);
    expect(errors.at(-1)?.message).toContain("重新接入后将自动连接");
    const writes = device.writes.length;
    hid.emit("connect", device);
    await until(() => status() === "connected" && cards.length === 2);
    expect(device.writes[writes]).toEqual([1]); expect(device.opens).toBe(2);
    await manager.disconnect();
    await wait(40); expect(device.opens).toBe(2); expect(status()).toBe("disconnected");
    await manager.requestDevice();
    await until(() => status() === "connected"); expect(device.opens).toBe(3);
  } finally { await manager.dispose(); }
  expect(device.inputListeners.size).toBe(0); expect(hid.listeners.size).toBe(0);
});

test("disconnect during initialization cancels its receive and a late response cannot replace the new reader", async () => {
  const old = new FakeDevice(); const replacement = new FakeDevice(); replacement.productName = "Replacement";
  old.handler = () => {}; // Firmware query receives no response.
  const hid = new FakeHid();
  const { manager, status, states, cards } = observe(hid);
  await manager.start();
  try {
    hid.emit("connect", old); await until(() => old.writes.length === 1);
    expect(status()).toBe("connecting");
    hid.emit("disconnect", old); hid.emit("connect", replacement);
    await until(() => status() === "connected");
    old.emit(new TextEncoder().encode("2025040400"));
    await until(() => cards.length === 1);
    expect(states.at(-1)?.name).toBe("Replacement");
    expect(old.inputListeners.size).toBe(0); expect(old.opened).toBe(false);
    hid.emit("disconnect", old); expect(status()).toBe("connected");
  } finally { await manager.dispose(); }
});

test("immediate reconnect on the same device waits for the previous reader's close", async () => {
  const device = new FakeDevice(); device.handler = () => {};
  const hid = new FakeHid(); const { manager, status, errors } = observe(hid);
  await manager.start();
  try {
    hid.emit("connect", device); await until(() => device.writes.length === 1);
    hid.emit("disconnect", device); device.handler = undefined; hid.emit("connect", device);
    await until(() => status() === "connected");
    expect(device.opens).toBe(2); expect(device.closes).toBe(1); expect(device.opened).toBe(true);
    expect(errors).toHaveLength(1);
  } finally { await manager.dispose(); }
});

test("a pending HID write is canceled on unplug so reconnect does not hang", async () => {
  const old = new FakeDevice(); let release!: () => void;
  old.handler = () => new Promise<void>(resolve => { release = resolve; });
  const next = new FakeDevice(); const hid = new FakeHid();
  const { manager, status } = observe(hid); await manager.start();
  try {
    hid.emit("connect", old); await until(() => old.writes.length === 1);
    hid.emit("disconnect", old); hid.emit("connect", next);
    await until(() => status() === "connected");
    expect(old.inputListeners.size).toBe(0); expect(next.opened).toBe(true);
  } finally { release(); await manager.dispose(); }
});

test("a stale authorized-device enumeration cannot supersede a manually selected device", async () => {
  const old = new FakeDevice(); const selected = new FakeDevice(); selected.productName = "Selected";
  const hid = new FakeHid([selected]); let resolveEnumeration!: (devices: ReaderDevice[]) => void;
  hid.enumeration = () => new Promise(resolve => { resolveEnumeration = resolve; });
  const { manager, states } = observe(hid);
  const started = manager.start();
  try {
    await manager.requestDevice(); resolveEnumeration([old]); await started;
    expect(states.at(-1)?.name).toBe("Selected"); expect(old.opens).toBe(0);
  } finally { await manager.dispose(); }
});

test("disposal cancels readiness and removes all device and report subscriptions", async () => {
  const device = new FakeDevice(); device.collections = [];
  const hid = new FakeHid([device]); const { manager, states, errors } = observe(hid);
  const started = manager.start();
  await until(() => states.length === 1);
  await manager.dispose(); await started;
  expect(device.opens).toBe(0); expect(device.inputListeners.size).toBe(0); expect(hid.listeners.size).toBe(0);
  const count = states.length;
  hid.emit("connect", device); device.collections = [{}, {}, {}];
  await wait(60); expect(states).toHaveLength(count); expect(errors).toEqual([]);
});

test("a remounted page waits for an asynchronous close before auto-connecting again", async () => {
  const device = new FakeDevice(); const hid = new FakeHid([device]);
  const first = observe(hid); await first.manager.start();
  const nativeClose = device.close.bind(device);
  let release!: () => void;
  device.close = async () => { await new Promise<void>(resolve => { release = resolve; }); await nativeClose(); };
  const disposal = first.manager.dispose();
  const second = observe(hid); const starting = second.manager.start();
  await wait(30); expect(device.opens).toBe(1);
  release(); await disposal; await starting;
  try { expect(second.status()).toBe("connected"); expect(device.opens).toBe(2); }
  finally { device.close = nativeClose; await second.manager.dispose(); }
});

test("canceling the picker leaves listeners ready for a later physical connection", async () => {
  const hid = new FakeHid(); const { manager, states, status } = observe(hid);
  await manager.start();
  try {
    await manager.requestDevice(); expect(states).toEqual([]);
    const device = new FakeDevice(); hid.emit("connect", device);
    await until(() => status() === "connected");
  } finally { await manager.dispose(); }
});

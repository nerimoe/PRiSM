import { expect, test } from "bun:test";
import { basicCard, CardPresence, HinataCardReader, HinataTransport, pn532Frame, pn532Response } from "./card-reader";
import { FakeDevice, FakeHid, response, until, wait } from "./reader-test-device";
test("PN532 WebHID frame includes the bridge header and validates responses", () => {
  expect([...pn532Frame(0x4a, [1, 0])]).toEqual([0xe2, 0, 0, 255, 4, 252, 0xd4, 0x4a, 1, 0, 0xe1, 0]);
  expect(pn532Response(Uint8Array.from([0xe2, 0, 0, 255, 0, 255, 0]), 0x4a)).toBeNull();
  const good = response(0x4a, [0]);
  expect([...pn532Response(good, 0x4a)!]).toEqual([0]);
  expect(pn532Response(good, 0x52)).toBeNull();
  const corrupt = good.slice(); corrupt[corrupt.length - 2]! ^= 1;
  expect(() => pn532Response(corrupt, 0x4a)).toThrow("校验失败");
  expect(() => pn532Response(good.slice(0, -2), 0x4a)).toThrow("不完整");
});
test("ordinary Type A UID and FeliCa IDm are read without access codes or sector authentication", () => {
  expect(basicCard(Uint8Array.from([1, 1, 0, 4, 8, 4, 0xaa, 0xbb, 0xcc, 0xdd]), "type-a")).toEqual({ kind: "type-a", uid: "AABBCCDD" });
  expect(basicCard(Uint8Array.from([1, 1, 0, 4, 0x20, 7, 1, 2, 3, 4, 5, 6, 7]), "type-a")?.uid).toBe("01020304050607");
  expect(basicCard(Uint8Array.from([1, 1, 18, 1, 0, 1, 2, 3, 4, 5, 6, 7, ...Array(8).fill(0)]), "felica")).toEqual({ kind: "felica", uid: "0001020304050607" });
  expect(basicCard(Uint8Array.from([0]), "type-a")).toBeNull();
  expect(() => basicCard(Uint8Array.from([2]), "type-a")).toThrow("一张卡片");
  expect(() => basicCard(Uint8Array.from([1, 1, 0, 4, 8, 10, 1]), "type-a")).toThrow("UID 无效");
});
test("card presence suppresses held cards and tolerates short RF misses", () => {
  const presence = new CardPresence();
  const card = { kind: "type-a", uid: "AABBCCDD" } as const;
  expect(presence.accept(card)).toBe(true);
  expect(presence.accept(card)).toBe(false);
  presence.accept(null); presence.accept(null);
  expect(presence.accept(card)).toBe(false);
  presence.accept(null); presence.accept(null); presence.accept(null);
  expect(presence.accept(card)).toBe(true);
  expect(presence.accept({ kind: "type-a", uid: "11223344" })).toBe(true);
});
test("the reader polls via WebHID, emits a basic card once, and closes on stop", async () => {
  const device = new FakeDevice();
  const hid = new FakeHid([device]);
  const reader = new HinataCardReader(device, hid);
  const cards: unknown[] = []; const errors: Error[] = [];
  await reader.start(card => cards.push(card), error => errors.push(error));
  await until(() => cards.length > 0);
  await wait(70);
  await reader.stop();
  expect(cards).toEqual([{ kind: "type-a", uid: "AABBCCDD" }]);
  expect(device.writes.some(frame => frame[7] === 0x32)).toBe(true);
  expect(device.opened).toBe(false); expect(errors).toEqual([]);
  expect(device.inputListeners.size).toBe(0); expect(hid.listeners.size).toBe(0);
});

test("bridge header routing accepts report IDs 0 and 1, buffers early ACKs and isolates CardIO", async () => {
  const device = new FakeDevice(); await device.open();
  const transport = new HinataTransport(device);
  const cardio: number[][] = [];
  const unsubscribe = transport.subscribeCardioInput(bytes => cardio.push([...bytes]));
  device.handler = data => {
    device.emit(response(data[7]!, [9]), 2);
    device.emit(Uint8Array.of(0xe5, 1)); // Other bridge channel.
    device.emit(response(0x52, [0])); // Other PN532 command.
    device.emit(Uint8Array.of(0xe2, 0, 0, 255, 0, 255, 0), 1);
    device.emit(response(data[7]!, [0]), 0);
  };
  expect([...await transport.pn532(0x4a, [1, 0])]).toEqual([0]);
  expect(cardio).toHaveLength(1); expect(cardio[0]).toHaveLength(8);
  unsubscribe();
  device.emit(Uint8Array.of(1, 2), 2);
  expect(cardio).toHaveLength(1);
  transport.close(); expect(device.inputListeners.size).toBe(0);
  await device.close();
});

test("PN532 ignores unrelated commands before checksum validation and permits absent postamble like Go", () => {
  const unrelated = response(0x52, [0]); unrelated[unrelated.length - 2]! ^= 1;
  expect(pn532Response(unrelated, 0x4a)).toBeNull();
  expect([...pn532Response(response(0x4a, [0]).slice(0, -1), 0x4a)!]).toEqual([0]);
  expect(basicCard(new Uint8Array(), "felica")).toBeNull();
});

test("PN532 grants each received ACK a new 1000ms response deadline", async () => {
  const device = new FakeDevice(); await device.open();
  const transport = new HinataTransport(device);
  const timers: ReturnType<typeof setTimeout>[] = [];
  device.handler = () => {
    timers.push(setTimeout(() => device.emit(Uint8Array.of(0xe2, 0, 0, 255, 0, 255, 0)), 650));
    timers.push(setTimeout(() => device.emit(response(0x4a, [0])), 1300));
  };
  try { expect([...await transport.pn532(0x4a, [1, 0])]).toEqual([0]); }
  finally { timers.forEach(clearTimeout); transport.close(); await device.close(); }
});

test("timeout diagnostics identify the polling stage and release the subscription for retry", async () => {
  const device = new FakeDevice(); await device.open();
  const transport = new HinataTransport(device);
  device.handler = () => { device.emit(Uint8Array.of(0xe2, 0, 0, 255, 0, 255, 0)); };
  let error: Error & { detail?: string } | undefined;
  try { await transport.pn532(0x4a, [1, 0], "brty=0"); }
  catch (caught) { error = caught as typeof error; }
  expect(error?.message).toBe("读卡器响应超时");
  expect(error?.detail).toContain("inListPassiveTarget 0x4a (brty=0)");
  expect(error?.detail).toContain("1 frame(s)"); expect(error?.detail).toContain("reportId=0");
  device.handler = undefined;
  expect((await transport.pn532(0x4a, [1, 0]))[0]).toBe(1);
  transport.close(); await device.close();
});

test("send failures and stopping an outstanding receive release their channels", async () => {
  const device = new FakeDevice(); await device.open();
  const transport = new HinataTransport(device);
  device.handler = () => { throw new Error("USB write failed"); };
  await expect(transport.request(1)).rejects.toThrow("USB write failed");
  device.handler = undefined;
  expect(new TextDecoder().decode(await transport.request(1))).toBe("2025100522");
  device.handler = () => {};
  const waiting = transport.pn532(0x52, [1]).then(() => { throw new Error("Expected cancellation"); },
    error => { expect(error.message).toContain("已断开"); });
  transport.close(); await waiting;
  expect(device.inputListeners.size).toBe(0);
  await device.close();
});

test.each([
  ["2025040400", [[1]]],
  ["2025040401", [[1], [0xe5]]],
  ["2025051301", [[1], [0xe5], [0xe6]]],
  ["2025100522", [[1], [0xe5], [0xe6], [0xd4, 0], [0xd4, 1], [0xd1, 3], [0xd1, 4], [0xd1, 5], [0xd1, 6], [0xd1, 7], [0xd1, 8]]],
] as [string, number[][]][])("firmware %s uses the Go startup handshake before the first FeliCa poll", async (firmware, commands) => {
  const device = new FakeDevice(); device.firmware = firmware;
  const reader = new HinataCardReader(device, new FakeHid([device]));
  await reader.start(() => {}, () => {});
  try {
    expect(device.writes.slice(0, commands.length)).toEqual(commands);
    expect(device.writes[commands.length]).toEqual([...pn532Frame(0x4a, [1, 1, 0, 255, 255, 1, 0])]);
    expect(reader.firmwareTimestamp).toBe(Number(firmware));
    if (firmware === "2025100522") expect(reader.startupConfig).toEqual({ segaBrightness: 10, config0: 11, idleRgb: [13, 14, 15], busyRgb: [16, 17, 18] });
  } finally { await reader.stop(); }
});

test.each([
  [0x0147, [[0x59, 0xf4, 0x3f], [0x69, 0xf4, 0x2b]]],
  [0x0148, [[0x29, 0x34, 0x11], [0x49, 0xb4, 0x0c], [0x59, 0xf4, 0x3f]]],
  [0x0999, [[0x59, 0xf4, 0x3f]]],
] as [number, number[][]][])("PID %i polls FeliCa, releases, then visits each Go Type A RF profile", async (pid, profiles) => {
  const device = new FakeDevice(); device.productId = pid; device.card = [0];
  const reader = new HinataCardReader(device, new FakeHid([device]));
  await reader.start(() => {}, () => {});
  try {
    await until(() => device.writes.filter(frame => frame[7] === 0x32).length >= profiles.length);
    await reader.suspendPolling();
    const pn = device.writes.filter(frame => frame[0] === 0xe2);
    const expected = [
      [...pn532Frame(0x4a, [1, 1, 0, 255, 255, 1, 0])],
      [...pn532Frame(0x52, [1])],
      ...profiles.flatMap(profile => [[...pn532Frame(0x32, [0x0a, ...profile, 0x11, 0x4d, 0x85, 0x61, 0x6f, 0x26, 0x62, 0x87])], [...pn532Frame(0x4a, [1, 0])]]),
    ];
    expect(pn.slice(0, expected.length)).toEqual(expected);
  } finally { await reader.stop(); }
});

test("FeliCa basic IDs finish the scan before any Type A release or RF command", async () => {
  const device = new FakeDevice();
  device.felica = [1, 1, 18, 1, 0, 1, 2, 3, 4, 5, 6, 7, ...Array(8).fill(0)];
  const reader = new HinataCardReader(device, new FakeHid([device]));
  const cards: unknown[] = [];
  await reader.start(card => cards.push(card), () => {});
  try {
    await until(() => cards.length === 1);
    expect(cards).toEqual([{ kind: "felica", uid: "0001020304050607" }]);
    expect(device.writes.filter(frame => frame[0] === 0xe2).every(frame => frame[7] === 0x4a && frame[9] === 1)).toBe(true);
  } finally { await reader.stop(); }
});

test("incomplete polls preserve a held card and recover without dropping the connection", async () => {
  const device = new FakeDevice();
  const reader = new HinataCardReader(device, new FakeHid([device]));
  const cards: unknown[] = []; const errors: Error[] = []; let recovered = 0;
  await reader.start(card => cards.push(card), error => errors.push(error), () => recovered++);
  try {
    await until(() => cards.length === 1);
    let corrupt = 4;
    device.handler = data => {
      if (data[7] === 0x4a && corrupt-- > 0) {
        const packet = response(0x4a, [0]); packet[packet.length - 2]! ^= 1;
        device.emit(packet);
      } else device.reply(data);
    };
    await until(() => recovered > 0);
    expect(errors).toHaveLength(4); expect(reader.connected).toBe(true); expect(cards).toHaveLength(1);
    device.handler = undefined; device.card = [0];
    await wait(80); device.card = [1, 1, 0, 4, 8, 4, 0xaa, 0xbb, 0xcc, 0xdd];
    await until(() => cards.length === 2);
  } finally { await reader.stop(); }
});

test("focus and explicit suspension pause polling without manufacturing card removals", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  let focused = false;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hasFocus: () => focused } });
  const device = new FakeDevice();
  const reader = new HinataCardReader(device, new FakeHid([device]));
  const cards: unknown[] = [];
  try {
    await reader.start(card => cards.push(card), () => {});
    await wait(50); expect(device.writes.some(frame => frame[0] === 0xe2)).toBe(false);
    focused = true; await until(() => cards.length === 1);
    await reader.suspendPolling();
    const writes = device.writes.length;
    await wait(60); expect(device.writes).toHaveLength(writes);
    reader.resumePolling(); await until(() => device.writes.length > writes);
    expect(cards).toHaveLength(1);
  } finally {
    await reader.stop();
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("HID readiness is awaited and cancellation releases listeners before a device is opened", async () => {
  const device = new FakeDevice(); device.collections = [];
  const hid = new FakeHid([device]); const reader = new HinataCardReader(device, hid);
  const starting = reader.start(() => {}, () => {});
  await wait(60); expect(device.opens).toBe(0);
  device.collections = [{}, {}, {}]; await starting;
  await reader.stop(); expect(device.opens).toBe(1);
  device.collections = [];
  const pending = reader.start(() => {}, () => {}).then(() => { throw new Error("Expected cancellation"); },
    error => { expect(error.message).toContain("已断开"); });
  await reader.stop(); await pending;
  expect(device.inputListeners.size).toBe(0); expect(hid.listeners.size).toBe(0);
});

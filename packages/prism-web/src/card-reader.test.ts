import { expect, test } from "bun:test";
import { basicCard, CardPresence, HinataCardReader, pn532Frame, pn532Response, type HidInput, type ReaderDevice, type ReaderHid } from "./card-reader";
function response(command: number, payload: number[]) {
  const body = [0xd5, command + 1, ...payload];
  return Uint8Array.from([0xe2, 0, 0, 255, body.length, (-body.length) & 255, ...body, (-body.reduce((a, b) => a + b, 0)) & 255, 0]);
}
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
class FakeDevice extends EventTarget implements ReaderDevice {
  vendorId = 0xf822; productId = 0x0147; productName = "HINATA test"; opened = false;
  sent: number[] = [];
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async sendReport(reportId: number, data: Uint8Array) {
    expect(reportId).toBe(1);
    const command = data[7]!; this.sent.push(command);
    // Empty FeliCa polling; any Type A card is accepted.
    const body = command === 0x4a ? data[9] === 1 ? [0] : [1, 1, 0, 4, 8, 4, 0xaa, 0xbb, 0xcc, 0xdd] : [0];
    queueMicrotask(() => {
      const event = new Event("inputreport") as HidInput;
      const bytes = response(command, body);
      Object.assign(event, { reportId: 1, data: new DataView(bytes.buffer) });
      this.dispatchEvent(event);
    });
  }
}
test("the reader polls via WebHID, emits a basic card once, and closes on stop", async () => {
  const device = new FakeDevice();
  const hid = Object.assign(new EventTarget(), { requestDevice: async () => [device] }) satisfies ReaderHid;
  const reader = new HinataCardReader(device, hid);
  const cards: unknown[] = []; const errors: Error[] = [];
  await reader.start(card => cards.push(card), error => errors.push(error));
  await new Promise(resolve => setTimeout(resolve, 350));
  await reader.stop();
  expect(cards).toEqual([{ kind: "type-a", uid: "AABBCCDD" }]);
  expect(device.sent).toContain(0x32); expect(device.sent).toContain(0x4a);
  expect(device.opened).toBe(false); expect(errors).toEqual([]);
});

import type { HidInput, ReaderDevice, ReaderHid } from "./card-reader";

export const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function until(predicate: () => boolean, timeout = 2000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("Test device condition timed out");
    await wait(5);
  }
}
export function response(command: number, payload: number[]) {
  const body = [0xd5, command + 1, ...payload];
  return Uint8Array.from([0xe2, 0, 0, 255, body.length, (-body.length) & 255, ...body,
    (-body.reduce((a, b) => a + b, 0)) & 255, 0]);
}
export class FakeDevice extends EventTarget implements ReaderDevice {
  vendorId = 0xf822; productId = 0x0147; productName = "HINATA test"; opened = false;
  collections: unknown[] = [{}, {}, {}];
  writes: number[][] = [];
  opens = 0; closes = 0;
  firmware = "2025100522";
  card: number[] = [1, 1, 0, 4, 8, 4, 0xaa, 0xbb, 0xcc, 0xdd];
  felica: number[] = [0];
  handler?: (data: Uint8Array) => Promise<void> | void;
  inputListeners = new Set<EventListenerOrEventListenerObject>();
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (type === "inputreport" && listener) this.inputListeners.add(listener);
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    if (type === "inputreport" && listener) this.inputListeners.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  async open() { this.opened = true; this.opens++; }
  async close() { this.opened = false; this.closes++; }
  emit(bytes: Uint8Array, reportId = 0) {
    // Offset DataView also verifies that only the report bytes are parsed.
    const backing = Uint8Array.from([99, ...bytes, 99]);
    const event = new Event("inputreport") as HidInput;
    Object.assign(event, { reportId, data: new DataView(backing.buffer, 1, bytes.length) });
    this.dispatchEvent(event);
  }
  reply(data: Uint8Array) {
    if (data[0] === 1) this.emit(new TextEncoder().encode(this.firmware));
    else if (data[0] === 0xe5 || data[0] === 0xe6) this.emit(Uint8Array.of(data[0], 1, 2, 3, 4));
    else if (data[0] === 0xd4 || data[0] === 0xd1) this.emit(Uint8Array.of(data[0], data[1]! + 10));
    else if (data[0] === 0xe2) {
      const command = data[7]!;
      const payload = command === 0x4a ? data[9] === 1 ? this.felica : this.card : [0];
      this.emit(Uint8Array.of(0xe2, 0, 0, 255, 0, 255, 0));
      this.emit(response(command, payload));
    }
  }
  async sendReport(reportId: number, data: Uint8Array) {
    if (reportId !== 1) throw new Error("Wrong HINATA output report ID");
    if (!this.opened) throw new Error("Device not opened");
    this.writes.push([...data]);
    if (this.handler) await this.handler(data);
    else this.reply(data); // Response precedes the resolution of sendReport.
  }
}
export class FakeHid extends EventTarget implements ReaderHid {
  constructor(public devices: ReaderDevice[] = []) { super(); }
  listeners = new Set<EventListenerOrEventListenerObject>();
  enumeration?: () => Promise<ReaderDevice[]>;
  selection?: () => Promise<ReaderDevice[]>;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (listener) this.listeners.add(listener);
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    if (listener) this.listeners.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  async getDevices() { return this.enumeration ? this.enumeration() : this.devices; }
  async requestDevice(options: { filters: { vendorId: number }[] }) {
    if (options.filters[0]?.vendorId !== 0xf822) throw new Error("Wrong vendor filter");
    return this.selection ? this.selection() : this.devices;
  }
  emit(type: "connect" | "disconnect", device: ReaderDevice) {
    const event = new Event(type);
    Object.assign(event, { device }); this.dispatchEvent(event);
  }
}

/** HINATA WebHID bridge + PN532 basic-ID polling, following hinata_go. */
export type BasicCard = { kind: "type-a" | "felica"; uid: string };
export type HidInput = Event & { reportId: number; data: DataView };
export interface ReaderDevice extends EventTarget {
  vendorId: number; productId: number; productName: string; opened: boolean;
  open(): Promise<void>; close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
}
export interface ReaderHid extends EventTarget {
  requestDevice(options: { filters: { vendorId: number }[] }): Promise<ReaderDevice[]>;
}
export function browserHid(): ReaderHid | undefined {
  return typeof navigator === "undefined" ? undefined : (navigator as Navigator & { hid?: ReaderHid }).hid;
}
export function pn532Frame(command: number, payload: readonly number[]): Uint8Array {
  const body = [0xd4, command, ...payload];
  return Uint8Array.from([0xe2, 0, 0, 0xff, body.length, (-body.length) & 255, ...body,
    (-body.reduce((sum, byte) => sum + byte, 0)) & 255, 0]);
}
/** Ignore unrelated reports and ACKs; reject truncated or corrupted response frames. */
export function pn532Response(data: Uint8Array, command: number): Uint8Array | null {
  if (data[0] !== 0xe2) return null;
  const frame = data.subarray(1);
  if (frame.length < 6 || frame[0] !== 0 || frame[1] !== 0 || frame[2] !== 255)
    throw new Error("读卡器响应格式无效");
  if (frame[3] === 0 && frame[4] === 255) return null;
  const length = frame[3]!;
  if (((length + frame[4]!) & 255) !== 0 || length < 2 || frame.length < length + 7)
    throw new Error("读卡器响应不完整");
  if ((frame.subarray(5, 6 + length).reduce((sum, byte) => sum + byte, 0) & 255) !== 0 || frame[6 + length] !== 0)
    throw new Error("读卡器响应校验失败");
  if (frame[5] !== 0xd5 || frame[6] !== command + 1) return null;
  return frame.slice(7, 5 + length);
}
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
export function basicCard(payload: Uint8Array, kind: BasicCard["kind"]): BasicCard | null {
  if (!payload.length) throw new Error("读卡器响应不完整");
  if (payload[0] === 0) return null;
  if (payload[0] !== 1) throw new Error("请一次只放置一张卡片");
  if (kind === "type-a") {
    const length = payload[5];
    if (!length || ![4, 7, 10].includes(length) || payload.length < 6 + length)
      throw new Error("卡片 UID 无效");
    return { kind, uid: hex(payload.slice(6, 6 + length)) };
  }
  const packetLength = payload[2];
  if (!packetLength || packetLength < 18 || payload.length < 2 + packetLength)
    throw new Error("卡片 IDm 无效");
  return { kind, uid: hex(payload.slice(4, 12)) };
}
export class CardPresence {
  private key: string | null = null;
  private misses = 0;
  accept(card: BasicCard | null): boolean {
    if (!card) {
      if (++this.misses >= 3) this.key = null;
      return false;
    }
    this.misses = 0;
    const key = `${card.kind}:${card.uid}`;
    if (key === this.key) return false;
    this.key = key;
    return true;
  }
}
export class HinataCardReader {
  private pending?: { command: number; resolve: (value: Uint8Array) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private running = false;
  private loop?: Promise<void>;
  private presence = new CardPresence();
  constructor(private device: ReaderDevice, private hid: ReaderHid) {}
  get name() { return this.device.productName || "HINATA"; }
  private input = (event: Event) => {
    const report = event as HidInput;
    if (report.reportId !== 1 || !this.pending) return;
    try {
      const value = pn532Response(new Uint8Array(report.data.buffer, report.data.byteOffset, report.data.byteLength), this.pending.command);
      if (value) { clearTimeout(this.pending.timer); this.pending.resolve(value); this.pending = undefined; }
    } catch (error) {
      const pending = this.pending;
      if (pending) { clearTimeout(pending.timer); pending.reject(error as Error); this.pending = undefined; }
    }
  };
  private command(command: number, payload: readonly number[] = []): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = undefined; reject(new Error("读卡器响应超时，请重新连接")); }, 2000);
      this.pending = { command, resolve, reject, timer };
      void this.device.sendReport(1, pn532Frame(command, payload)).catch(error => {
        clearTimeout(timer); this.pending = undefined; reject(error);
      });
    });
  }
  private async poll(): Promise<BasicCard | null> {
    await this.command(0x52, [1]);
    const felica = basicCard(await this.command(0x4a, [1, 1, 0, 255, 255, 1, 0]), "felica");
    if (felica) return felica;
    await this.command(0x52, [1]);
    const profiles = this.device.productId === 0x0148 ? [[0x29, 0x03, 0x11], [0x49, 0x0b, 0x0c], [0x59, 0x0f, 0x3f]]
      : this.device.productId === 0x0147 ? [[0x59, 0x0f, 0x3f], [0x69, 0x0f, 0x2b]] : [[0x59, 0x0f, 0x3f]];
    for (const [rf, n, p] of profiles) {
      await this.command(0x32, [0x0a, rf!, (n! << 4) | 4, p!, 0x11, 0x4d, 0x85, 0x61, 0x6f, 0x26, 0x62, 0x87]);
      const card = basicCard(await this.command(0x4a, [1, 0]), "type-a");
      if (card) return card;
    }
    return null;
  }
  async start(onCard: (card: BasicCard) => void, onError: (error: Error) => void): Promise<void> {
    await this.device.open();
    this.device.addEventListener("inputreport", this.input);
    this.running = true;
    const disconnected = (event: Event) => {
      if ((event as Event & { device: ReaderDevice }).device === this.device) {
        this.running = false;
        onError(new Error("读卡器已断开，请重新连接"));
      }
    };
    this.hid.addEventListener("disconnect", disconnected);
    this.loop = (async () => {
      try {
        while (this.running) {
          const card = await this.poll();
          if (!this.running) break;
          if (this.presence.accept(card) && card) onCard(card);
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      } catch (error) { if (this.running) onError(error as Error); }
      finally {
        this.running = false;
        this.device.removeEventListener("inputreport", this.input);
        this.hid.removeEventListener("disconnect", disconnected);
        if (this.device.opened) await this.device.close().catch(() => {});
      }
    })();
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error("读卡器已断开")); this.pending = undefined; }
    await this.loop;
  }
}

/**
 * TypeScript port of the HINATA Go WebHID/PN532 link (3ca80cc).
 * Sources: hinata_reader.dart, subscription.dart, pn532.dart,
 * usb_hinata_impl.dart and hardware_device_provider.dart. See docs/cashier.md.
 */
import { ReportSubscription, type UnsubscribePolicy } from "./reader-subscription";

export type BasicCard = { kind: "type-a" | "felica"; uid: string };
export type HidInput = Event & { reportId: number; data: DataView };
export interface ReaderDevice extends EventTarget {
  vendorId: number; productId: number; productName: string; opened: boolean;
  readonly collections: readonly unknown[];
  open(): Promise<void>; close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
}
export interface ReaderHid extends EventTarget {
  getDevices(): Promise<ReaderDevice[]>;
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
  if (frame.length < 5) throw new Error("读卡器响应不完整");
  if (frame[3] === 0 && frame[4] === 255) return null;
  const length = frame[3]!;
  if (((length + frame[4]!) & 255) !== 0 || length < 2 || frame.length < 7)
    throw new Error("读卡器响应不完整");
  // Go skips unrelated PN532 commands before parsing their packet checksum.
  if (frame[5] !== 0xd5 || frame[6] !== command + 1) return null;
  if (frame[0] !== 0 || frame[1] !== 0 || frame[2] !== 255)
    throw new Error("读卡器响应格式无效");
  if (frame.length < length + 6) throw new Error("读卡器响应不完整");
  if ((frame.subarray(5, 6 + length).reduce((sum, byte) => sum + byte, 0) & 255) !== 0)
    throw new Error("读卡器响应校验失败");
  return frame.slice(7, 5 + length);
}
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
export function basicCard(payload: Uint8Array, kind: BasicCard["kind"]): BasicCard | null {
  if (!payload.length) return null;
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

export class ReaderError extends Error {
  constructor(message: string, readonly detail: string) { super(message); this.name = "ReaderError"; }
}

/** HINATA sends output report 1; input reports are routed by payload header. */
export class HinataTransport {
  private subscriptions = new Map<number, ReportSubscription>();
  private closed = false;
  private cancel = new AbortController();
  private lastReportId?: number;
  private cardioListeners = new Set<(data: Uint8Array) => void>();
  constructor(private device: ReaderDevice) { device.addEventListener("inputreport", this.input); }
  private input = (event: Event) => {
    const report = event as HidInput;
    const data = new Uint8Array(report.data.buffer, report.data.byteOffset, report.data.byteLength);
    if (report.reportId === 2) {
      for (const listener of this.cardioListeners) listener(data.slice(0, 8));
      return; // CardIO must never be interpreted as a PN532 response or UID.
    }
    if (!data.length) return;
    const subscription = this.subscriptions.get(data[0]!);
    if (subscription) {
      this.lastReportId = report.reportId;
      if (subscription.push(data.slice())) this.subscriptions.delete(data[0]!);
    }
  };
  subscribeCardioInput(listener: (data: Uint8Array) => void): () => void {
    if (!this.closed) this.cardioListeners.add(listener);
    return () => { this.cardioListeners.delete(listener); };
  }
  private async write(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("读卡器已断开");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => { reject(new Error("读卡器已断开")); };
        timer = setTimeout(() => reject(new ReaderError("读卡器写入超时",
          `HINATA output reportId=1, command=0x${data[0]!.toString(16)}, write, 1000ms`)), 1000);
        this.cancel.signal.addEventListener("abort", abort, { once: true });
        // A timed-out native write can still settle later. Handle its rejection
        // without letting it change the next exchange's subscription.
        try { void this.device.sendReport(1, data).then(resolve, reject); }
        catch (error) { reject(error); }
      });
    } finally {
      clearTimeout(timer);
      this.cancel.signal.removeEventListener("abort", abort);
    }
  }
  /** HINATA Go resetStateMachine: command 0xE8 has no response. */
  resetStateMachine(): Promise<void> {
    return this.write(Uint8Array.of(0xe8));
  }
  private async exchange<T>(header: number, data: Uint8Array, policy: UnsubscribePolicy, action: (subscription: ReportSubscription) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("读卡器已断开");
    if (this.subscriptions.has(header)) throw new Error("读卡器请求正在进行");
    const subscription = new ReportSubscription(policy);
    this.subscriptions.set(header, subscription);
    this.lastReportId = undefined;
    try {
      // Response deadlines start after writing; the write has its own deadline.
      await this.write(data);
      return await action(subscription);
    } finally {
      if (this.subscriptions.get(header) === subscription) this.subscriptions.delete(header);
      subscription.close();
    }
  }
  request(command: number, payload: readonly number[] = []): Promise<Uint8Array> {
    // Firmware timestamp is ten ASCII digits beginning with '2' (0x32).
    const header = command === 1 ? 0x32 : command;
    return this.exchange(header, Uint8Array.from([command, ...payload]), { type: "count", count: 1 }, subscription => subscription.receive(() =>
      new ReaderError("读卡器响应超时", `HINATA 0x${command.toString(16)}, response=0x${header.toString(16)}, 1000ms, 0 frame(s)`)));
  }
  pn532(command: number, payload: readonly number[] = [], context = ""): Promise<Uint8Array> {
    return this.exchange(0xe2, pn532Frame(command, payload), { type: "never" }, async subscription => {
      let count = 0;
      let lastFrame = "";
      const names: Record<number, string> = { 0x4a: "inListPassiveTarget", 0x52: "inRelease", 0x32: "rfConfiguration" };
      const stage = `PN532 ${names[command] ?? "command"} 0x${command.toString(16)}${context ? ` (${context})` : ""}`;
      while (true) {
        // Go applies a fresh 1000ms timeout to each receive, including after ACK.
        const frame = await subscription.receive(() => new ReaderError("读卡器响应超时",
          `${stage}, 1000ms, ${count} frame(s)${lastFrame ? `, reportId=${this.lastReportId}, last=${lastFrame}` : ""}`));
        count++; lastFrame = hex(frame.slice(0, 8));
        try {
          const result = pn532Response(frame, command);
          if (result !== null) return result;
        } catch (error) { throw new ReaderError((error as Error).message, `${stage}, ${count} frame(s), reportId=${this.lastReportId}, last=${lastFrame}`); }
      }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancel.abort();
    this.device.removeEventListener("inputreport", this.input);
    for (const subscription of this.subscriptions.values()) subscription.close();
    this.subscriptions.clear();
    this.cardioListeners.clear();
  }
}

export class HinataCardReader {
  private transport?: HinataTransport;
  private running = false;
  private initialized = false;
  private initialization?: Promise<void>;
  private loop?: Promise<void>;
  private wake?: () => void;
  private presence = new CardPresence();
  private closing?: Promise<void>;
  private suspended = false;
  private activePoll?: Promise<void>;
  firmwareTimestamp = 0;
  commitHash = new Uint8Array();
  chipId = new Uint8Array();
  startupConfig?: { segaBrightness: number; config0: number; idleRgb: number[]; busyRgb: number[] };
  constructor(private device: ReaderDevice, private hid: ReaderHid) {}
  get name() { return this.device.productName || "HINATA"; }
  get connected() { return this.running && this.initialized && this.device.opened; }
  async suspendPolling(): Promise<void> {
    this.suspended = true;
    await this.activePoll?.catch(() => {});
  }
  resumePolling() { this.suspended = false; this.wake?.(); }
  private closeDevice(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.device.opened) return Promise.resolve();
    this.closing = this.device.close().catch(() => {});
    return this.closing;
  }
  private pause(ms: number): Promise<void> {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
      const timer = setTimeout(finish, ms); this.wake = finish;
    });
  }
  private checkRunning() { if (!this.running) throw new Error("读卡器已断开"); }
  private async initialize() {
    // hardware_device_provider.dart waits for all three HID collections.
    for (let attempt = 0; attempt < 60; attempt++) {
      this.checkRunning();
      if (this.device.collections.length > 2) break;
      await this.pause(50);
    }
    this.checkRunning();
    if (this.device.collections.length <= 2) throw new Error("读卡器 HID 尚未就绪，请重新连接");
    if (!this.device.opened) await this.device.open();
    this.checkRunning();
    const transport = this.transport!;
    const timestamp = new TextDecoder().decode((await transport.request(1)).slice(0, 10));
    if (!/^\d{10}$/.test(timestamp)) throw new Error("读卡器固件响应无效");
    this.firmwareTimestamp = Number(timestamp);
    const fourBytes = async (command: number) => {
      const response = await transport.request(command);
      if (response.length < 5) throw new Error("读卡器响应不完整");
      return response.slice(1, 5);
    };
    if (this.firmwareTimestamp > 2025040400) this.commitHash = await fourBytes(0xe5);
    if (this.firmwareTimestamp >= 2025051301) this.chipId = await fourBytes(0xe6);
    if (this.firmwareTimestamp >= 2025100522) {
      const config = async (command: number, index: number) => {
        const response = await transport.request(command, [index]);
        if (response.length < 2) throw new Error("读卡器响应不完整");
        return response[1]!;
      };
      const segaBrightness = await config(0xd4, 0);
      const config0 = await config(0xd4, 1);
      const idleRgb = [await config(0xd1, 3), await config(0xd1, 4), await config(0xd1, 5)];
      const busyRgb = [await config(0xd1, 6), await config(0xd1, 7), await config(0xd1, 8)];
      this.startupConfig = { segaBrightness, config0, idleRgb, busyRgb };
    }
  }
  private async poll(): Promise<BasicCard | null> {
    const transport = this.transport!;
    // usb_hinata_impl.dart polls FeliCa first, then releases before Type A.
    const felica = basicCard(await transport.pn532(0x4a, [1, 1, 0, 255, 255, 1, 0], "brty=1"), "felica");
    if (felica) return felica;
    await transport.pn532(0x52, [1], "tg=1");
    const profiles = this.device.productId === 0x0148 ? [[0x29, 0x03, 0x11], [0x49, 0x0b, 0x0c], [0x59, 0x0f, 0x3f]]
      : this.device.productId === 0x0147 ? [[0x59, 0x0f, 0x3f], [0x69, 0x0f, 0x2b]] : [[0x59, 0x0f, 0x3f]];
    for (let index = 0; index < profiles.length; index++) {
      const [rf, n, p] = profiles[index]!;
      const context = `Type A profile ${index + 1}, rfCfg=0x${rf!.toString(16)}, cwGsNOn=0x${n!.toString(16)}, cwGsP=0x${p!.toString(16)}`;
      await transport.pn532(0x32, [0x0a, rf!, (n! << 4) | 4, p!, 0x11, 0x4d, 0x85, 0x61, 0x6f, 0x26, 0x62, 0x87], `cfgItem=0x0a, ${context}`);
      const card = basicCard(await transport.pn532(0x4a, [1, 0], `brty=0, ${context}`), "type-a");
      if (card) return card;
    }
    return null;
  }
  private async recover() {
    // Retrying the same PN532 command cannot repair a wedged HID/firmware link.
    // Replace the input subscription before reopening, so old waiters cannot
    // consume the new handshake. Preserve presence across this recovery.
    this.transport?.close();
    await this.closeDevice();
    this.closing = undefined;
    this.checkRunning();
    this.transport = new HinataTransport(this.device);
    await this.initialize();
    this.checkRunning();
    await this.transport.resetStateMachine();
    await this.pause(200);
  }
  async start(onCard: (card: BasicCard) => void, onError: (error: Error) => void, onRecovered?: () => void): Promise<void> {
    if (this.running || this.initialization || this.loop) throw new Error("读卡器请求正在进行");
    this.running = true; this.initialized = false; this.presence = new CardPresence();
    this.suspended = false;
    this.closing = undefined;
    this.transport = new HinataTransport(this.device);
    const disconnected = (event: Event) => {
      if ((event as Event & { device: ReaderDevice }).device === this.device) {
        this.running = false; this.initialized = false;
        this.transport?.close(); this.wake?.();
        onError(new Error("读卡器已断开，请重新连接"));
      }
    };
    this.hid.addEventListener("disconnect", disconnected);
    const cleanup = async () => {
      this.running = false; this.initialized = false;
      this.transport?.close(); this.wake?.();
      this.hid.removeEventListener("disconnect", disconnected);
      await this.closeDevice();
    };
    this.initialization = this.initialize();
    try { await this.initialization; this.checkRunning(); }
    catch (error) { await cleanup(); throw error; }
    finally { this.initialization = undefined; }
    this.initialized = true;
    this.loop = (async () => {
      let incomplete = false;
      let failures = 0;
      let needsRecovery = false;
      try {
        while (this.running) {
          if (this.suspended) { await this.pause(16); continue; }
          if (typeof document !== "undefined" && !document.hasFocus()) { await this.pause(200); continue; }
          this.activePoll = (async () => {
            try {
              if (needsRecovery) {
                // Back off on every recovery attempt, including failed handshakes.
                await this.pause(200);
                if (!this.running) return;
                await this.recover();
                needsRecovery = false;
              }
              if (!this.running || this.suspended) return;
              const card = await this.poll();
              if (!this.running) return;
              failures = 0;
              if (incomplete) { incomplete = false; onRecovered?.(); }
              if (this.presence.accept(card) && card) onCard(card);
            } catch (error) {
              if (!this.running) return;
              // Go reports an incomplete scan, keeps the link and does not mark
              // the card removed until three successful no-target polls.
              incomplete = true; onError(error as Error);
              if (++failures >= 3) {
                failures = 0;
                needsRecovery = true;
              }
            }
          })();
          // Suspension must wait for recovery as well as the scan itself.
          try { await this.activePoll; }
          finally { this.activePoll = undefined; }
          if (!this.running) break;
          await this.pause(16);
        }
      } finally { await cleanup(); }
    })();
  }
  async stop(): Promise<void> {
    this.running = false; this.initialized = false;
    this.transport?.close(); this.wake?.();
    await this.closeDevice();
    await this.initialization?.catch(() => {});
    await this.loop;
    await this.closeDevice();
    this.loop = undefined;
  }
}

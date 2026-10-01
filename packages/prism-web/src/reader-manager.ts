import { HinataCardReader, type BasicCard, type ReaderDevice, type ReaderHid } from "./card-reader";

export type ReaderState = { status: "disconnected" | "connecting" | "connected"; name: string };
type ReaderEvents = {
  onState: (state: ReaderState) => void;
  onCard: (card: BasicCard) => void;
  onError: (error: Error) => void;
  onRecovered: () => void;
};
type DeviceEvent = Event & { device: ReaderDevice };
// Page remounts (including React StrictMode) must wait for the previous close.
const deviceClosures = new WeakMap<ReaderDevice, Promise<void>>();

/** HINATA Go hardware_device_provider lifecycle, with removable web listeners. */
export class HinataReaderManager {
  private generation = 0;
  private device?: ReaderDevice;
  private reader?: HinataCardReader;
  private started = false;
  private disposed = false;
  private pending = new Set<Promise<void>>();
  private shutdown: Promise<void> = Promise.resolve();
  constructor(private hid: ReaderHid, private events: ReaderEvents) {}

  private state(status: ReaderState["status"], name = "") {
    if (!this.disposed) this.events.onState({ status, name });
  }
  private track(task: Promise<void>): Promise<void> {
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }
  private stopReader(reader?: HinataCardReader, device?: ReaderDevice): Promise<void> {
    // Invalidate the transport immediately; serialize closing before reopening.
    const stopped = reader?.stop() ?? Promise.resolve();
    if (reader && device) deviceClosures.set(device, stopped);
    this.shutdown = Promise.all([this.shutdown, stopped]).then(() => {});
    return this.shutdown;
  }
  private connected = (event: Event) => { void this.connect((event as DeviceEvent).device); };
  private disconnected = (event: Event) => {
    if ((event as DeviceEvent).device === this.device) {
      void this.disconnect();
      if (!this.disposed) this.events.onError(new Error("读卡器已断开，重新接入后将自动连接"));
    }
  };

  start(): Promise<void> {
    if (this.started || this.disposed) return Promise.resolve();
    this.started = true;
    this.hid.addEventListener("connect", this.connected);
    this.hid.addEventListener("disconnect", this.disconnected);
    const generation = this.generation;
    return this.track((async () => {
      try {
        const devices = await this.hid.getDevices();
        if (this.disposed || generation !== this.generation) return;
        const device = devices.find(candidate => candidate.vendorId === 0xf822);
        if (device) await this.connect(device);
      } catch (error) {
        if (!this.disposed && generation === this.generation) this.events.onError(error as Error);
      }
    })());
  }

  async requestDevice(): Promise<void> {
    if (this.disposed) return;
    try {
      // Invoke the picker synchronously within the user's click activation.
      const devices = await this.hid.requestDevice({ filters: [{ vendorId: 0xf822 }] });
      if (!this.disposed && devices[0]) await this.connect(devices[0]);
    } catch (error) { if (!this.disposed) this.events.onError(error as Error); }
  }

  private connect(device: ReaderDevice): Promise<void> {
    if (this.disposed || device.vendorId !== 0xf822) return Promise.resolve();
    // getDevices and a hotplug event may announce the same device together.
    if (this.device === device) return Promise.resolve();
    const generation = ++this.generation;
    const previous = this.reader;
    const previousDevice = this.device;
    this.reader = undefined; this.device = device;
    this.state("connecting", device.productName);
    const stopped = this.stopReader(previous, previousDevice);
    return this.track((async () => {
      await stopped;
      await deviceClosures.get(device);
      if (this.disposed || generation !== this.generation) return;
      const reader = new HinataCardReader(device, this.hid);
      this.reader = reader;
      const current = () => !this.disposed && generation === this.generation;
      try {
        await reader.start(card => { if (current()) this.events.onCard(card); },
          error => { if (current()) this.events.onError(error); },
          () => { if (current()) this.events.onRecovered(); });
        if (current()) this.state("connected", reader.name);
        else await reader.stop();
      } catch (error) {
        await reader.stop();
        if (current()) {
          this.reader = undefined; this.device = undefined;
          this.state("disconnected"); this.events.onError(error as Error);
        }
      }
    })());
  }

  async disconnect(): Promise<void> {
    this.generation++;
    const reader = this.reader;
    const device = this.device;
    this.reader = undefined; this.device = undefined;
    this.state("disconnected");
    await this.stopReader(reader, device);
  }

  async suspendPolling(): Promise<void> { await this.reader?.suspendPolling(); }
  resumePolling() { this.reader?.resumePolling(); }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.hid.removeEventListener("connect", this.connected);
    this.hid.removeEventListener("disconnect", this.disconnected);
    await this.disconnect();
    await Promise.all([...this.pending]);
  }
}

/** Port of HINATA Go subscription.dart: queued receives and broadcast events. */
export type UnsubscribePolicy =
  | { type: "count"; count: number }
  | { type: "never" }
  | { type: "specificIsOn" | "specificNotOn"; index: number; byte: number };

type Waiter = {
  resolve: (frame: Uint8Array) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};
type Listener = { active: boolean; callback: (frame: Uint8Array) => void };

export class ReportSubscription {
  private frames: Uint8Array[] = [];
  private waiters: Waiter[] = [];
  private listeners = new Set<Listener>();
  private closed = false;
  private count = 0;
  constructor(private policy: UnsubscribePolicy = { type: "never" }) {}

  listen(listener: (frame: Uint8Array) => void): () => void {
    const entry = { active: !this.closed, callback: listener };
    if (!this.closed) this.listeners.add(entry);
    return () => { entry.active = false; this.listeners.delete(entry); };
  }

  /** Returns true when the owner should remove this subscription. */
  push(frame: Uint8Array): boolean {
    if (this.closed) return true;
    this.count++;
    const policy = this.policy;
    const dispose = policy.type === "count" ? this.count >= policy.count
      : policy.type === "never" ? false
      : frame.length <= policy.index || (policy.type === "specificIsOn"
        ? frame[policy.index] === policy.byte : frame[policy.index] !== policy.byte);
    // Dart's broadcast stream delivers asynchronously; preserve that ordering.
    for (const listener of this.listeners) queueMicrotask(() => {
      if (listener.active) listener.callback(frame.slice());
    });
    const waiter = this.waiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(frame); }
    else this.frames.push(frame);
    if (dispose) this.close();
    return dispose;
  }

  receive(timeout?: () => Error): Promise<Uint8Array> {
    // Auto-closing a count(1) subscription must preserve its buffered response.
    if (this.frames.length) return Promise.resolve(this.frames.shift()!);
    if (this.closed) return Promise.reject(new Error("读卡器已断开"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (timeout) waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        reject(timeout());
      }, 1000);
      this.waiters.push(waiter);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer); waiter.reject(new Error("读卡器已断开"));
    }
  }
}

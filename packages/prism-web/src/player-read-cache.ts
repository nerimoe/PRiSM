export class PlayerReadCache {
  private entries = new Map<string, { expiresAt: number; promise: Promise<unknown> }>();
  clear() { this.entries.clear(); }
  read<T>(key: string, ttl: number, fetcher: () => Promise<T>, now = Date.now()): Promise<T> {
    const old = this.entries.get(key);
    if (old && old.expiresAt > now) return old.promise as Promise<T>;
    if (this.entries.size >= 100) this.entries.delete(this.entries.keys().next().value!);
    const entry = { expiresAt: Infinity, promise: Promise.resolve().then(fetcher) as Promise<unknown> };
    this.entries.set(key, entry);
    entry.promise.then(() => { entry.expiresAt = Date.now() + ttl; }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.promise as Promise<T>;
  }
}

export function subscribeRead<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

import { api, ApiError } from "./api";
import type { BrowserCheckoutPreview } from "./checkout-preview";

/** Every quote uses a fresh server clock and read-only inputs, then runs in a cancellable worker. */
export async function browserCheckoutPreview(
  inputsPath: string,
  legacyPath: string,
  signal?: AbortSignal,
): Promise<BrowserCheckoutPreview> {
  let inputs: { playerId: string; billingSnapshot: unknown };
  try {
    inputs = await api(inputsPath, { signal });
  } catch (error) {
    // Custom runtime plugins cannot be serialized into browser engine inputs.
    if (
      error instanceof ApiError &&
      error.code === "CLIENT_BILLING_UNAVAILABLE"
    )
      return api<BrowserCheckoutPreview>(legacyPath, {
        method: "POST",
        body: "{}",
        signal,
      });
    throw error;
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./live-billing.worker.ts", import.meta.url),
      { type: "module" },
    );
    let finished = false;
    const complete = (action: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      action();
    };
    const abort = () =>
      complete(() => reject(new DOMException("Aborted", "AbortError")));
    const timer = setTimeout(
      () => complete(() => reject(new Error("账单预估失败，请刷新后重试"))),
      60000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<{ preview?: BrowserCheckoutPreview; error?: string }>,
    ) => {
      if (event.data.preview) complete(() => resolve(event.data.preview!));
      else if (event.data.error)
        complete(() => reject(new Error(event.data.error)));
    };
    worker.onerror = () =>
      complete(() => reject(new Error("账单预估失败，请刷新后重试")));
    try {
      worker.postMessage({
        type: "init",
        snapshot: inputs.billingSnapshot,
        players: [],
      });
      worker.postMessage({ type: "preview", playerId: inputs.playerId });
    } catch (error) {
      complete(() => reject(error));
    }
    // Handles an abort racing with worker initialization.
    if (signal?.aborted) abort();
  });
}

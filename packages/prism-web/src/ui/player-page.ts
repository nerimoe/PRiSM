import type { Notice } from "../api";
import { pageReport } from "./page-report";

/** The page as the platform generates it. `docs/player-page.md` has what clients must do with it. */
export type PageButton = {
  kind: "button";
  id: string;
  label: string;
  againLabel?: string;
  icon?: "coin" | "power" | "door";
  style?: "primary";
  enabled: boolean;
  action: string;
  answerOnButton?: boolean;
  payload?: Record<string, unknown>;
  requires?: string;
  needsLocation: boolean;
};
export type PageCards = { kind: "cards"; id: string; enabled: boolean; capture: boolean; action: string; needsLocation: boolean };
export type PageBlock =
  | PageButton
  | PageCards
  | { kind: "text"; id: string; text: string; style?: "heading"; level?: "error" }
  | { kind: "signin"; id: string }
  | { kind: "binding"; id: string }
  | { kind: "pricing"; id: string; rules: unknown; changes: unknown }
  | { kind: "consent"; id: string; text: string }
  | { kind: "climate"; id: string; state: unknown; needsLocation: boolean }
  | { kind: "mahjong"; id: string; title: string; status: string; capacity: number; emptyLabel: string; mineLabel: string; seats: Array<{ name: string; mine: boolean }> };
export type Page = {
  shop: string;
  shopCode: string;
  heroUrl: string | null;
  resource: string;
  publicId: string;
  billingActive: boolean;
  blocks: PageBlock[];
};
export type PageCode = { title: string; value: string; expiresAt: string; expiresLabel: string; hint: string };
export type ActionAnswer = { ok: boolean; page: Page; notices: Notice[]; code?: PageCode };

/**
 * From a shop's China Mobile line a new connection to Cloudflare can stall for
 * seconds or forever while another tried a moment later goes straight through.
 * So nothing waits long on one attempt: a read gives up after 5 s. An action may
 * really take a while, and asking again is safe, so it gets longer and more tries.
 */
export const READ_RETRY = { timeoutMs: 5000, attempts: 3, waitMs: 300 };
export const ACTION_RETRY = { timeoutMs: 10_000, attempts: 5, waitMs: 1500 };
/** What a page does in case a push never reached it. */
export const RECHECK_MS = 60_000;
export const HEARTBEAT_MS = 25_000;
export const PONG_WAIT_MS = 10_000;
/** A read this recent makes another one on connecting pointless. */
export const FRESH_READ_MS = 3000;
const RECONNECT_MS = [1000, 3000, 5000, 10_000, 20_000, 30_000, 60_000];

/** Ask again: the operation is still running on the server. */
export class StillRunning extends Error {}

/**
 * Runs `attempt`, starting over when it times out or no answer came. An answer,
 * good or bad, ends it. `onRetry` says a further attempt is starting.
 */
export async function withRetries<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs: number; attempts: number; waitMs: number; signal?: AbortSignal; onRetry?: () => void },
): Promise<T> {
  for (let tried = 1; ; tried++) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    options.signal?.addEventListener("abort", stop);
    const timer = setTimeout(stop, options.timeoutMs);
    try {
      return await attempt(controller.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const unanswered = controller.signal.aborted || error instanceof TypeError || error instanceof StillRunning;
      if (!unanswered) throw error;
      if (tried >= options.attempts) throw new TypeError("网络连接失败，请检查网络后重试");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    }
    options.onRetry?.();
    await new Promise((resolve) => setTimeout(resolve, options.waitMs));
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  }
}

export function pageChannelUrl(ticket: string, base: string) {
  const url = new URL(`/api/v1/devices/session/ws?ticket=${encodeURIComponent(ticket)}&v=2`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Whether a frame from the channel says the page changed. Everything else is ignored. */
export function isPageChanged(raw: unknown) {
  if (typeof raw !== "string" || raw === "pong") return false;
  try {
    return (JSON.parse(raw) as { method?: unknown } | null)?.method === "event.pageChanged";
  } catch {
    return false;
  }
}

/**
 * The hub's channel, kept up. A connection that stops answering its heartbeat, as
 * a line that silently dropped it does, is replaced in the background.
 * `wake` is for coming back to the foreground, when timers may have been frozen.
 */
export function openPageChannel(
  url: string,
  handlers: { onChanged(): void; onOpen(firstTime: boolean): void },
  make: (url: string) => WebSocket = (address) => new WebSocket(address),
) {
  let socket: WebSocket | null = null;
  let stopped = false;
  let opens = 0;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let waiting: ReturnType<typeof setTimeout> | undefined;
  const quiet = () => {
    clearInterval(beat);
    clearTimeout(waiting);
    waiting = undefined;
  };
  const replace = (from: WebSocket) => {
    if (socket !== from || stopped) return;
    socket = null;
    quiet();
    from.onopen = from.onmessage = from.onclose = null;
    try { from.close(); } catch { /* Already gone. */ }
    clearTimeout(retry);
    retry = setTimeout(connect, RECONNECT_MS[Math.min(failures++, RECONNECT_MS.length - 1)]);
  };
  const ping = (on: WebSocket) => {
    if (waiting) return;
    try { on.send("ping"); } catch { return replace(on); }
    waiting = setTimeout(() => replace(on), PONG_WAIT_MS);
  };
  function connect() {
    const connectingAt = performance.now();
    const opened = make(url);
    socket = opened;
    opened.onopen = () => {
      if (socket !== opened) return;
      pageReport.socketOpened(performance.now() - connectingAt);
      failures = 0;
      beat = setInterval(() => ping(opened), HEARTBEAT_MS);
      handlers.onOpen(opens++ === 0);
    };
    opened.onmessage = (event) => {
      if (socket !== opened) return;
      clearTimeout(waiting);
      waiting = undefined;
      if (isPageChanged(event.data)) handlers.onChanged();
    };
    opened.onclose = () => {
      if (socket !== opened) return;
      if (opens) pageReport.socketDropped();
      replace(opened);
    };
  }
  connect();
  return {
    wake() {
      if (stopped) return;
      if (socket && socket.readyState === 1) return ping(socket);
      if (socket) return; // Still connecting.
      clearTimeout(retry);
      failures = 0;
      connect();
    },
    close() {
      stopped = true;
      clearTimeout(retry);
      quiet();
      const closing = socket;
      socket = null;
      if (closing) {
        closing.onopen = closing.onmessage = closing.onclose = null;
        try { closing.close(); } catch { /* Already gone. */ }
      }
    },
  };
}

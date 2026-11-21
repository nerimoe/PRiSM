/**
 * How this visit to a scanned page fared on the player's network, for the platform
 * to decide whether shops need a better route to it (`docs/page-reports.md`).
 *
 * It never gets in the page's way. A visit is kept on the phone until it has
 * been delivered, because a network bad enough to matter is one where sending the
 * report fails too: a visit that could not even open is sent by the next one.
 * Nothing identifies the player.
 */
const STORAGE_KEY = "prism.pageReports";
const MAX_KEPT = 5;
/** A visit that lingers still reports, in case the page is never cleanly left. */
const FIRST_REPORT_MS = 20_000;

export type VisitReport = {
  id: string;
  client: "web";
  openMs: number | null;
  openFailed: boolean;
  documentMs: number | null;
  documentConnectMs: number | null;
  apiConnectMs: number | null;
  reads: number;
  readFailures: number;
  readMs: number;
  readMaxMs: number;
  actions: number;
  actionFailures: number;
  actionMs: number;
  actionMaxMs: number;
  socketConnectMs: number | null;
  socketDrops: number;
};

type Store = Pick<Storage, "getItem" | "setItem">;
type Send = (publicId: string, visits: VisitReport[]) => Promise<boolean>;

const whole = (value: number) => Math.max(0, Math.round(value));

export function createPageReporter(options: { id: () => string; store: Store | null; send: Send }) {
  let visit: VisitReport | null = null;
  let publicId: string | null = null;

  const kept = (): VisitReport[] => {
    try {
      const parsed = JSON.parse(options.store?.getItem(STORAGE_KEY) ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const keep = (visits: VisitReport[]) => {
    try {
      options.store?.setItem(STORAGE_KEY, JSON.stringify(visits.slice(-MAX_KEPT)));
    } catch {
      // A phone with no room for this has lost nothing the player needs.
    }
  };

  return {
    /** A visit begins, before its first request. Only the first call of a visit counts. */
    start() {
      visit ??= {
        id: options.id(), client: "web", openMs: null, openFailed: false,
        documentMs: null, documentConnectMs: null, apiConnectMs: null,
        reads: 0, readFailures: 0, readMs: 0, readMaxMs: 0,
        actions: 0, actionFailures: 0, actionMs: 0, actionMaxMs: 0,
        socketConnectMs: null, socketDrops: 0,
      };
    },
    /** The page has what it needs to show. */
    opened(resource: string, timing: { openMs: number; documentMs?: number | null; documentConnectMs?: number | null; apiConnectMs?: number | null }) {
      if (!visit) return;
      publicId = resource;
      visit.openMs ??= whole(timing.openMs);
      visit.openFailed = false;
      visit.documentMs ??= timing.documentMs == null ? null : whole(timing.documentMs);
      visit.documentConnectMs ??= timing.documentConnectMs == null ? null : whole(timing.documentConnectMs);
      visit.apiConnectMs ??= timing.apiConnectMs == null ? null : whole(timing.apiConnectMs);
    },
    openFailed() {
      if (!visit || visit.openMs !== null) return;
      visit.openFailed = true;
      keep([...kept().filter((other) => other.id !== visit!.id), visit]);
    },
    /** One attempt at a request. A failure is the network's: an answer of any status got through. */
    request(method: string, ms: number, reached: boolean) {
      if (!visit) return;
      const taken = whole(ms);
      if (method.toUpperCase() === "GET") {
        visit.reads++;
        if (!reached) visit.readFailures++;
        visit.readMs += taken;
        visit.readMaxMs = Math.max(visit.readMaxMs, taken);
      } else {
        visit.actions++;
        if (!reached) visit.actionFailures++;
        visit.actionMs += taken;
        visit.actionMaxMs = Math.max(visit.actionMaxMs, taken);
      }
    },
    socketOpened(ms: number) {
      if (visit) visit.socketConnectMs ??= whole(ms);
    },
    socketDropped() {
      if (visit) visit.socketDrops++;
    },
    /** Send this visit and any earlier one still here; what is delivered stops being kept. */
    async flush() {
      if (!visit) return;
      const current = visit;
      const visits = [...kept().filter((other) => other.id !== current.id), current].slice(-MAX_KEPT);
      keep(visits);
      if (!publicId) return;
      let delivered = false;
      try {
        delivered = await options.send(publicId, visits);
      } catch {
        // Kept for the next try.
      }
      if (delivered) keep(kept().filter((other) => !visits.some((sent) => sent.id === other.id)));
    },
  };
}

/** How a page's connections went, from what the browser recorded. */
function browserTiming() {
  const connect = (entry: PerformanceResourceTiming | undefined) => (entry ? entry.connectEnd - entry.connectStart : null);
  const [document] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
  const api = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .find((entry) => entry.name.includes("/api/v1/devices/session/bootstrap"));
  return {
    openMs: performance.now(),
    documentMs: document ? document.responseEnd : null,
    documentConnectMs: connect(document),
    apiConnectMs: connect(api),
  };
}

const safeStorage = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const reporter = createPageReporter({
  id: () => crypto.randomUUID(),
  store: safeStorage(),
  send: async (publicId, visits) => {
    const response = await fetch("/api/v1/devices/report", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicId, visits }),
    });
    return response.ok;
  },
});

let listening = false;

export const pageReport = {
  start() {
    reporter.start();
    if (listening || typeof document === "undefined") return;
    listening = true;
    document.addEventListener("visibilitychange", () => { if (document.hidden) void reporter.flush(); });
    window.addEventListener("pagehide", () => void reporter.flush());
  },
  opened(publicId: string) {
    reporter.opened(publicId, browserTiming());
    setTimeout(() => void reporter.flush(), FIRST_REPORT_MS);
  },
  openFailed: () => reporter.openFailed(),
  request: reporter.request,
  socketOpened: reporter.socketOpened,
  socketDropped: reporter.socketDropped,
};

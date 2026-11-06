import { describe, expect, test } from "bun:test";
import { createPageReporter, type VisitReport } from "../src/ui/page-report";

function memoryStore() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); } };
}

let next = 0;
function setup(store = memoryStore()) {
  const sent: Array<{ publicId: string; visits: VisitReport[] }> = [];
  let deliver = true;
  const reporter = createPageReporter({
    id: () => `visit-${++next}`,
    store,
    send: async (publicId, visits) => {
      sent.push({ publicId, visits: structuredClone(visits) });
      if (!deliver) throw new TypeError("offline");
      return true;
    },
  });
  return { reporter, sent, store, offline: () => { deliver = false; }, online: () => { deliver = true; } };
}

describe("what a scanned page reports of its network", () => {
  test("counts reads and actions apart, and a failure only when nothing answered", async () => {
    const { reporter, sent } = setup();
    reporter.start();
    reporter.opened("pub", { openMs: 1234.4, documentMs: 800, documentConnectMs: 500, apiConnectMs: 0 });
    reporter.request("GET", 100, true);
    reporter.request("GET", 300, false);
    reporter.request("POST", 50, true);
    reporter.socketOpened(70.6);
    reporter.socketDropped();
    await reporter.flush();
    expect(sent[0]!.publicId).toBe("pub");
    expect(sent[0]!.visits[0]).toMatchObject({
      openMs: 1234, documentConnectMs: 500, apiConnectMs: 0,
      reads: 2, readFailures: 1, readMs: 400, readMaxMs: 300,
      actions: 1, actionFailures: 0, actionMs: 50, actionMaxMs: 50,
      socketConnectMs: 71, socketDrops: 1,
    });
  });

  test("keeps one visit one report however often it is sent", async () => {
    const { reporter, sent } = setup();
    reporter.start();
    reporter.opened("pub", { openMs: 1 });
    await reporter.flush();
    reporter.start();
    reporter.request("GET", 10, true);
    await reporter.flush();
    expect(sent[0]!.visits[0]!.id).toBe(sent[1]!.visits[0]!.id);
    expect(sent[1]!.visits).toHaveLength(1);
    expect(sent[1]!.visits[0]!.reads).toBe(1);
  });

  test("keeps what could not be delivered, and the next visit sends it", async () => {
    const store = memoryStore();
    const first = setup(store);
    first.offline();
    first.reporter.start();
    first.reporter.opened("pub", { openMs: 9000 });
    await first.reporter.flush();
    const second = setup(store);
    second.reporter.start();
    second.reporter.opened("pub", { openMs: 200 });
    await second.reporter.flush();
    expect(second.sent[0]!.visits.map((visit) => visit.openMs)).toEqual([9000, 200]);
    // Delivered: nothing is sent twice by a later visit.
    const third = setup(store);
    third.reporter.start();
    third.reporter.opened("pub", { openMs: 50 });
    await third.reporter.flush();
    expect(third.sent[0]!.visits.map((visit) => visit.openMs)).toEqual([50]);
  });

  test("remembers a visit that could not open, for the next one to send", async () => {
    const store = memoryStore();
    const failed = setup(store);
    failed.reporter.start();
    failed.reporter.openFailed();
    await failed.reporter.flush();
    // It does not know its resource, so it cannot be sent yet.
    expect(failed.sent).toEqual([]);
    const next = setup(store);
    next.reporter.start();
    next.reporter.opened("pub", { openMs: 300 });
    await next.reporter.flush();
    expect(next.sent[0]!.visits[0]).toMatchObject({ openFailed: true, openMs: null });
  });

  test("keeps no more than a few visits, and works without storage", async () => {
    const store = memoryStore();
    for (let index = 0; index < 8; index++) {
      const round = setup(store);
      round.offline();
      round.reporter.start();
      round.reporter.opened("pub", { openMs: index });
      await round.reporter.flush();
    }
    expect(JSON.parse(store.getItem("prism.pageReports")!)).toHaveLength(5);
    const bare = createPageReporter({ id: () => "x", store: null, send: async () => true });
    bare.start();
    bare.opened("pub", { openMs: 1 });
    await bare.flush();
  });
});

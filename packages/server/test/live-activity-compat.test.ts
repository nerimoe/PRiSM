import { describe, expect, it } from "bun:test";
import {
  liveActivityStartPayload,
  liveActivityEndPayload,
  liveActivityUpdatePayload,
} from "../src/durable-objects/live-activity-push.js";

describe("Live Activity API compatibility across channels", () => {
  it("uses APNs ActivityKit start/end payloads, including sessionId and shopCode", () => {
    const started = liveActivityStartPayload({
      sessionId: "s1", shopCode: "demo", shopName: "Example", startedAtUnix: 100, now: 110,
    }) as { aps: Record<string, any> };
    expect(started.aps.event).toBe("start");
    expect(started.aps.attributes).toMatchObject({ sessionId: "s1", shopCode: "demo" });
    expect(started.aps["content-state"].phase).toBe("active");
    const ended = liveActivityEndPayload({ startedAtUnix: 100, endedAtUnix: 200 }) as {
      aps: Record<string, any>;
    };
    expect(ended.aps.event).toBe("end");
    expect(ended.aps["content-state"]).toMatchObject({ phase: "ended", startedAtUnix: 100, endedAtUnix: 200 });
  });

  it("carries one bounded forecast in start/update payloads and drops it when billing stops", () => {
    const bill = { amountCents: 0, planLabel: "方案".repeat(80), nextEvent: { atUnix: 220, label: "下次计费" }, asOfUnix: 100 };
    const nextBill = { ...bill, amountCents: 200, nextEvent: { atUnix: 340, label: "下次计费" }, asOfUnix: 220 };
    const inputs = { startedAtUnix: 100, now: 101, bill, nextBill, staleAfterSeconds: 119 };
    for (const payload of [liveActivityUpdatePayload(inputs),
      liveActivityStartPayload({ ...inputs, sessionId: "s", shopCode: "mmw", shopName: "牧喵窝" })]) {
      const aps = payload.aps as Record<string, any>;
      expect(aps["content-state"].nextBill).toEqual(nextBill);
      expect(aps["stale-date"]).toBe(220);
      expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThan(4096);
    }
    const stopped = liveActivityUpdatePayload({ ...inputs, endedAtUnix: 200 }).aps as Record<string, any>;
    expect(stopped["content-state"].nextBill).toBeUndefined();
  });
});

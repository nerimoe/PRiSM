import { expect, test } from "bun:test";
import { projectApiTimes } from "../src/api-time";
import { wrapApiResponse } from "../src/api-contract";

test("transport projects event times while preserving UTC rule definitions, identifiers, metadata and epochs", async () => {
  const at = "2026-10-03T02:08:00.123Z";
  const data = { startedAt: at, actualEndedAt: at, expires_at: at, atUnix: 1790993280, subject: at,
    metadata: { startedAt: at }, provider: { timeZone: "UTC", rules: [{ dateTimeRange: { start: at, end: at }, timeRange: { start: "02:00", end: "19:00" }, weekdays: [5] }] },
    timeline: { events: [{ at, time: "02:08", date: "2026-10-03", entries: [{ startedAt: at, endedAt: "2026-10-03T03:54:00Z", periodLabel: "02:08 – 03:54", amount: 36 }] }] } };
  const response = await wrapApiResponse(Response.json(data), "Asia/Shanghai");
  const result = (await response.json()).data;
  expect(result.startedAt).toBe("2026-10-03T10:08:00.123+08:00");
  expect(result.expires_at).toBe(result.startedAt);
  expect(result.subject).toBe(at);
  expect(result.atUnix).toBe(data.atUnix);
  expect(result.metadata).toEqual(data.metadata);
  expect(result.provider).toEqual(data.provider);
  expect(result.timeline.events[0].time).toBe("10:08");
  expect(result.timeline.events[0].entries[0].periodLabel).toBe("10:08 – 11:54");
  expect(result.timeline.events[0].entries[0].amount).toBe(36);
  expect(projectApiTimes(result, "Asia/Shanghai")).toEqual(result);
  expect(data.timeline.events[0].at).toBe(at);
});

test("non-event payloads, errors and non-JSON responses do not trigger a time-zone lookup", async () => {
  const zone = async () => { throw new Error("Unexpected lookup"); };
  expect((await (await wrapApiResponse(Response.json({ provider: { timeZone: "UTC", rules: [{ dateTimeRange: { start: "2026-10-03T00:00:00Z" } }] } }), zone)).json()).data.provider.timeZone).toBe("UTC");
  expect((await (await wrapApiResponse(Response.json({ error: "Denied" }, { status: 403 }), zone)).json()).error.message).toBe("Denied");
  expect(await (await wrapApiResponse(new Response("image"), zone)).text()).toBe("image");
});

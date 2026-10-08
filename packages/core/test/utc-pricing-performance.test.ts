import { expect, test } from "bun:test";
import {
  createPriorityTimePricingProvider,
  formatLocalDate,
  parseLocalDateTime,
  formatOffsetTimestamp,
} from "../src";

test("month-long UTC pricing does not construct timezone formatters", async () => {
  let count = 0;
  const original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = new Proxy(original, {
    construct(target, args) {
      count++;
      return Reflect.construct(target, args);
    },
  });
  try {
    const start = parseLocalDateTime("2026-09-07", "10:00", "UTC");
    expect(formatLocalDate(start, "UTC")).toBe("2026-09-07");
    const quote = await createPriorityTimePricingProvider({
      id: "base",
      timeZone: "UTC",
      rules: [
        {
          id: "day",
          label: "Day",
          priority: 1,
          timeRange: { start: "02:00", end: "19:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 18,
            roundGraceMinutes: 10,
            priceCap: 90,
          },
        },
      ],
    }).quote({
      session: {
        id: "session",
        playerId: "player",
        startedAt: start,
        status: "active",
      },
      now: new Date("2026-10-07T10:00:00Z"),
      assetHoldings: [],
    });
    expect(quote.reduce((sum, item) => sum + item.amount, 0)).toBe(279000);
    expect(count).toBe(0);
  } finally {
    Intl.DateTimeFormat = original;
  }
});

test("cached formatter configuration still resolves DST for each timestamp", () => {
  let count = 0;
  const original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = new Proxy(original, {
    construct(target, args) {
      count++;
      return Reflect.construct(target, args);
    },
  });
  try {
    expect(
      formatOffsetTimestamp("2026-01-01T12:00:00Z", "Pacific/Auckland"),
    ).toBe("2026-01-02T01:00:00.000+13:00");
    expect(
      formatOffsetTimestamp("2026-07-01T12:00:00Z", "Pacific/Auckland"),
    ).toBe("2026-07-02T00:00:00.000+12:00");
    expect(count).toBe(1);
  } finally {
    Intl.DateTimeFormat = original;
  }
});

import { describe, expect, it } from "bun:test";
import { createPricingProviderFromConfig, PrismDomainError, validatePricingConfig } from "../src/index";

describe("validatePricingConfig", () => {
  it("accepts an enabled time priority config with a full-day rule", () => {
    expect(() =>
      validatePricingConfig({
        id: "pricing-1",
        kind: "time.priority",
        name: "Default time pricing",
        enabled: true,
        provider: {
          id: "time.default",
          rules: [
            {
              id: "base",
              label: "Base",
              priority: 0,
              timeRange: {
                start: "00:00",
                end: "00:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 10,
                roundGraceMinutes: 5,
                priceCap: 80,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      }),
    ).not.toThrow();
  });

  it("accepts enabled time priority configs whose unrestricted day and night rules cover the full day", () => {
    expect(() =>
      validatePricingConfig({
        id: "pricing-day-night",
        kind: "time.priority",
        name: "标准日夜计费",
        enabled: true,
        provider: {
          id: "time.day-night",
          rules: [
            {
              id: "day",
              label: "日间",
              priority: 1,
              timeRange: {
                start: "10:00",
                end: "22:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 4,
                roundGraceMinutes: 0,
                priceCap: 40,
              },
            },
            {
              id: "night",
              label: "夜间",
              priority: 1,
              timeRange: {
                start: "22:00",
                end: "10:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 4,
                roundGraceMinutes: 0,
                priceCap: 40,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      }),
    ).not.toThrow();
  });

  it("accepts enabled time priority configs with closed non-billable gaps", () => {
    expect(() =>
      validatePricingConfig({
        id: "pricing-1",
        kind: "time.priority",
        name: "Business hours pricing",
        enabled: true,
        provider: {
          id: "time.business-hours",
          rules: [
            {
              id: "business-hours",
              label: "Business hours",
              priority: 10,
              timeRange: {
                start: "10:00",
                end: "22:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 10,
                roundGraceMinutes: 5,
                priceCap: 80,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      }),
    ).not.toThrow();
  });

  it("rejects enabled time priority configs whose only billable rule is archived", () => {
    expect(() =>
      validatePricingConfig({
        id: "pricing-1",
        kind: "time.priority",
        name: "Archived business hours pricing",
        enabled: true,
        provider: {
          id: "time.archived-business-hours",
          rules: [
            {
              id: "base",
              label: "Base",
              priority: 0,
              status: "archived",
              timeRange: {
                start: "00:00",
                end: "00:00",
              },
              pricing: {
                unitMinutes: 30,
                unitPrice: 10,
                roundGraceMinutes: 5,
                priceCap: 80,
              },
            },
          ],
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      }),
    ).toThrow(new PrismDomainError("Enabled time priority pricing config requires at least one active time rule.", "PRICING_CONFIG_REQUIRES_ACTIVE_TIME_RULE"));
  });

  it("creates a fixed charge pricing provider for non-time venue products", async () => {
    const provider = createPricingProviderFromConfig({
      id: "pricing-cover",
      kind: "charge.fixed",
      name: "入场费",
      enabled: true,
      provider: {
        id: "cover-charge",
        label: "入场费",
        amount: 500,
      },
      createdAt: new Date("2026-06-07T10:00:00.000Z"),
      updatedAt: new Date("2026-06-07T10:00:00.000Z"),
    });

    await expect(
      Promise.resolve(provider.quote({
        session: {
          id: "session-fixed",
          playerId: "player-1",
          startedAt: new Date("2026-06-07T10:00:00.000Z"),
          endedAt: new Date("2026-06-07T11:00:00.000Z"),
          status: "closed",
        },
        assetHoldings: [],
        now: new Date("2026-06-07T11:00:00.000Z"),
      })),
    ).resolves.toEqual([
      {
        id: "session-fixed:cover-charge",
        source: "cover-charge",
        label: "入场费",
        amount: 500,
      },
    ]);
  });

  it("rejects enabled fixed charge pricing configs with invalid amounts", () => {
    expect(() =>
      validatePricingConfig({
        id: "pricing-broken-fixed",
        kind: "charge.fixed",
        name: "坏的固定收费",
        enabled: true,
        provider: {
          id: "broken-fixed",
          label: "坏的固定收费",
          amount: -1,
        },
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
        updatedAt: new Date("2026-06-07T10:00:00.000Z"),
      }),
    ).toThrow(new PrismDomainError("Fixed charge pricing amount must be a non-negative finite number.", "INVALID_FIXED_CHARGE_AMOUNT"));
  });
});

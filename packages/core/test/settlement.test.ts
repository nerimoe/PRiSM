import { describe, expect, it } from "bun:test";
import {
  type AssetEffectProvider,
  type AssetHolding,
  type PricingProvider,
  PrismDomainError,
  previewSessionSettlement,
  settleSession,
} from "../src/index";

describe("settleSession", () => {
  it("settles plugin charge items through the core asset ledger", async () => {
    const pricing: PricingProvider = {
      id: "manual-package",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "manual-package",
            label: "One song package",
            amount: 12,
          },
        ];
      },
    };

    const wallet: AssetHolding[] = [
      {
        assetType: "currency",
        assetCode: "currency.free",
        quantity: 5,
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: 20,
      },
    ];

    const result = await settleSession({
      session: {
        id: "session-1",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetHoldings: wallet,
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(result.settlement.total).toBe(12);
    expect(result.settlement.status).toBe("settled");
    expect(result.chargeItems).toEqual([
      {
        id: "charge-1",
        source: "manual-package",
        label: "One song package",
        amount: 12,
      },
    ]);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        delta: -5,
        reason: "session.settlement",
        refId: "session-1",
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: -7,
        reason: "session.settlement",
        refId: "session-1",
      },
    ]);
    expect(result.assetHoldings).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        quantity: 0,
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: 13,
      },
    ]);
  });

  it("rejects settlement without enough currency balance", async () => {
    const pricing: PricingProvider = {
      id: "cover-charge",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "cover-charge",
            label: "Cover charge",
            amount: 30,
          },
        ];
      },
    };

    const wallet: AssetHolding[] = [
      {
        assetType: "currency",
        assetCode: "currency.free",
        quantity: 5,
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: 20,
      },
    ];

    expect(
      settleSession({
        session: {
          id: "session-2",
          playerId: "player-1",
          startedAt: new Date("2026-06-07T10:00:00.000Z"),
          endedAt: new Date("2026-06-07T10:30:00.000Z"),
        },
        pricingProviders: [pricing],
        assetHoldings: wallet,
        now: new Date("2026-06-07T10:30:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "PrismDomainError",
      code: "INSUFFICIENT_BALANCE",
    } satisfies Partial<PrismDomainError>);
  });

  it("deducts only active and unexpired currency holdings", async () => {
    const pricing: PricingProvider = {
      id: "cover-charge",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "cover-charge",
            label: "Cover charge",
            amount: 20,
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-windowed-currency",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetHoldings: [
        {
          id: "expired-free",
          assetType: "currency",
          assetCode: "currency.free",
          quantity: 999,
          activeAt: new Date("2026-06-01T00:00:00.000Z"),
          expiresAt: new Date("2026-06-07T09:59:59.000Z"),
        },
        {
          id: "future-free",
          assetType: "currency",
          assetCode: "currency.free",
          quantity: 999,
          activeAt: new Date("2026-06-08T00:00:00.000Z"),
          expiresAt: null,
        },
        {
          id: "active-paid",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: 30,
          activeAt: new Date("2026-06-01T00:00:00.000Z"),
          expiresAt: new Date("2026-06-08T00:00:00.000Z"),
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: -20,
        reason: "session.settlement",
        refId: "session-windowed-currency",
      },
    ]);
    expect(result.assetHoldings).toEqual([
      {
        id: "expired-free",
        assetType: "currency",
        assetCode: "currency.free",
        quantity: 999,
        activeAt: new Date("2026-06-01T00:00:00.000Z"),
        expiresAt: new Date("2026-06-07T09:59:59.000Z"),
      },
      {
        id: "future-free",
        assetType: "currency",
        assetCode: "currency.free",
        quantity: 999,
        activeAt: new Date("2026-06-08T00:00:00.000Z"),
        expiresAt: null,
      },
      {
        id: "active-paid",
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: 10,
        activeAt: new Date("2026-06-01T00:00:00.000Z"),
        expiresAt: new Date("2026-06-08T00:00:00.000Z"),
      },
    ]);
  });

  it("deducts free currency before paid currency for canonical setup codes", async () => {
    const pricing: PricingProvider = {
      id: "cover-charge",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "cover-charge",
            label: "Cover charge",
            amount: 12,
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-canonical-currency",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetHoldings: [
        {
          assetType: "currency",
          assetCode: "paid",
          quantity: 20,
        },
        {
          assetType: "currency",
          assetCode: "free",
          quantity: 5,
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "free",
        delta: -5,
        reason: "session.settlement",
        refId: "session-canonical-currency",
      },
      {
        assetType: "currency",
        assetCode: "paid",
        delta: -7,
        reason: "session.settlement",
        refId: "session-canonical-currency",
      },
    ]);
    expect(result.assetHoldings).toEqual([
      {
        assetType: "currency",
        assetCode: "paid",
        quantity: 13,
      },
      {
        assetType: "currency",
        assetCode: "free",
        quantity: 0,
      },
    ]);
  });

  it("does not let pricing plugins mutate asset holdings", async () => {
    const pricing: PricingProvider = {
      id: "mutating-plugin",
      async quote(context) {
        context.assetHoldings[0].quantity = 999;
        return [
          {
            id: "charge-1",
            source: "mutating-plugin",
            label: "Mutating plugin charge",
            amount: 12,
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-3",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetHoldings: [
        {
          assetType: "currency",
          assetCode: "currency.free",
          quantity: 5,
        },
        {
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: 20,
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        delta: -5,
        reason: "session.settlement",
        refId: "session-3",
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: -7,
        reason: "session.settlement",
        refId: "session-3",
      },
    ]);
    expect(result.assetHoldings).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        quantity: 0,
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        quantity: 13,
      },
    ]);
  });

  it("applies asset effect adjustments before currency deduction", async () => {
    const pricing: PricingProvider = {
      id: "time-pricing",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "time-pricing",
            label: "Time charge",
            amount: 20,
          },
        ];
      },
    };

    const couponEffect: AssetEffectProvider = {
      id: "coupon.fixed-off",
      async apply() {
        return [
          {
            id: "adjustment-1",
            source: "coupon.fixed-off",
            label: "Coupon fixed discount",
            amount: -6,
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-4",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetEffectProviders: [couponEffect],
      assetHoldings: [
        {
          assetType: "currency",
          assetCode: "currency.free",
          quantity: 5,
        },
        {
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: 20,
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(result.settlement.subtotal).toBe(20);
    expect(result.settlement.total).toBe(14);
    expect(result.adjustments).toEqual([
      {
        id: "adjustment-1",
        source: "coupon.fixed-off",
        label: "Coupon fixed discount",
        amount: -6,
      },
    ]);
    expect(result.assetLedgerEntries).toEqual([
      {
        assetType: "currency",
        assetCode: "currency.free",
        delta: -5,
        reason: "session.settlement",
        refId: "session-4",
      },
      {
        assetType: "currency",
        assetCode: "currency.paid",
        delta: -9,
        reason: "session.settlement",
        refId: "session-4",
      },
    ]);
  });

  it("passes only active and unexpired assets to asset effect providers", async () => {
    const pricing: PricingProvider = {
      id: "time-pricing",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "time-pricing",
            label: "Time charge",
            amount: 20,
          },
        ];
      },
    };

    const seenAssetCodes: string[] = [];
    const passEffect: AssetEffectProvider = {
      id: "pass.active-only",
      async apply(context) {
        seenAssetCodes.push(...context.assetHoldings.map((holding) => holding.assetCode));
        return context.assetHoldings.some((holding) => holding.assetCode === "pass.active")
          ? [
              {
                id: "pass-active",
                source: "pass.active",
                label: "Active pass",
                amount: -20,
              },
            ]
          : [];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-windowed-pass",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetEffectProviders: [passEffect],
      assetHoldings: [
        {
          assetType: "pass",
          assetCode: "pass.expired",
          quantity: 1,
          expiresAt: new Date("2026-06-07T09:59:59.000Z"),
        },
        {
          assetType: "pass",
          assetCode: "pass.future",
          quantity: 1,
          activeAt: new Date("2026-06-08T00:00:00.000Z"),
        },
        {
          assetType: "pass",
          assetCode: "pass.active",
          quantity: 1,
          activeAt: new Date("2026-06-01T00:00:00.000Z"),
          expiresAt: new Date("2026-06-08T00:00:00.000Z"),
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(seenAssetCodes).toEqual(["pass.active"]);
    expect(result.settlement.total).toBe(0);
  });

  it("floors settlement total at zero after adjustments", async () => {
    const pricing: PricingProvider = {
      id: "time-pricing",
      async quote() {
        return [
          {
            id: "charge-1",
            source: "time-pricing",
            label: "Short visit",
            amount: 4,
          },
        ];
      },
    };

    const passEffect: AssetEffectProvider = {
      id: "pass.workday",
      async apply() {
        return [
          {
            id: "adjustment-1",
            source: "pass.workday",
            label: "Workday pass benefit",
            amount: -10,
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-5",
        playerId: "player-1",
        startedAt: new Date("2026-06-08T10:00:00.000Z"),
        endedAt: new Date("2026-06-08T10:10:00.000Z"),
      },
      pricingProviders: [pricing],
      assetEffectProviders: [passEffect],
      assetHoldings: [
        {
          assetType: "currency",
          assetCode: "currency.free",
          quantity: 0,
        },
      ],
      now: new Date("2026-06-08T10:10:00.000Z"),
    });

    expect(result.settlement.subtotal).toBe(4);
    expect(result.settlement.total).toBe(0);
    expect(result.assetLedgerEntries).toEqual([]);
  });

  it("allows negative charge items and sums them correctly", async () => {
    const pricing: PricingProvider = {
      id: "split-pricing",
      async quote() {
        return [
          {
            id: "charge-positive",
            source: "split-pricing",
            label: "Base Rate",
            amount: 25,
          },
          {
            id: "charge-negative",
            source: "split-pricing",
            label: "Discount Rule",
            amount: -10,
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-neg-1",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetHoldings: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: 100,
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(result.settlement.subtotal).toBe(15);
    expect(result.settlement.total).toBe(15);
  });

  it("preserves a negative charge subtotal while flooring the final total at 0", async () => {
    const pricing: PricingProvider = {
      id: "excess-discount",
      async quote() {
        return [
          {
            id: "charge-positive",
            source: "excess-discount",
            label: "Base Rate",
            amount: 25,
          },
          {
            id: "charge-negative",
            source: "excess-discount",
            label: "Discount Rule",
            amount: -40,
          },
        ];
      },
    };

    const result = await settleSession({
      session: {
        id: "session-neg-2",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T10:30:00.000Z"),
      },
      pricingProviders: [pricing],
      assetHoldings: [
        {
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: 100,
        },
      ],
      now: new Date("2026-06-07T10:30:00.000Z"),
    });

    expect(result.settlement.subtotal).toBe(-15);
    expect(result.settlement.total).toBe(0);
  });
});

describe("previewSessionSettlement", () => {
  it("quotes charges and adjustments without deducting currency", async () => {
    const result = await previewSessionSettlement({
      session: {
        id: "session-6",
        playerId: "player-1",
        startedAt: new Date("2026-06-07T10:00:00.000Z"),
        endedAt: new Date("2026-06-07T11:00:00.000Z"),
        status: "closed",
      },
      pricingProviders: [
        {
          id: "time",
          quote() {
            return [
              {
                id: "charge-1",
                source: "time",
                label: "Time charge",
                amount: 20,
              },
            ];
          },
        },
      ],
      assetEffectProviders: [
        {
          id: "coupon",
          apply() {
            return [
              {
                id: "coupon-1",
                source: "coupon",
                label: "Coupon",
                amount: -5,
              },
            ];
          },
        },
      ],
      assetHoldings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: 100,
        },
      ],
      now: new Date("2026-06-07T11:00:00.000Z"),
    });

    expect(result).toEqual({
      settlementPreview: {
        sessionId: "session-6",
        subtotal: 20,
        total: 15,
        status: "preview",
        previewedAt: new Date("2026-06-07T11:00:00.000Z"),
      },
      chargeItems: [
        {
          id: "charge-1",
          source: "time",
          label: "Time charge",
          amount: 20,
        },
      ],
      adjustments: [
        {
          id: "coupon-1",
          source: "coupon",
          label: "Coupon",
          amount: -5,
        },
      ],
      assetHoldings: [
        {
          id: "holding-1",
          assetType: "currency",
          assetCode: "currency.paid",
          quantity: 100,
        },
      ],
    });
  });
});

import { describe, expect, it } from "bun:test";
import { exportPrismNeoPostgresSnapshot, type PrismNeoPostgresSql } from "../src";

describe("exportPrismNeoPostgresSnapshot", () => {
  it("reads prism-neo Prisma PostgreSQL tables directly into the migration snapshot", async () => {
    const queries: string[] = [];
    const sql: PrismNeoPostgresSql = async (strings) => {
      const query = strings.join("?");
      queries.push(query);
      return postgresRows[extractTableName(query)] ?? [];
    };

    const snapshot = await exportPrismNeoPostgresSnapshot({
      sql,
      exportedAt: new Date("2026-06-08T00:00:00.000Z"),
    });

    expect(queries).toContain('SELECT "id", "createdAt", "isBanned" FROM "User" ORDER BY "id"');
    expect(queries).toContain('SELECT "id", "assetId", "type", "name", "description", "valid", "activeAt", "expireAt", "billingEffect" FROM "Asset" ORDER BY "id"');
    expect(snapshot).toMatchObject({
      exportedAt: new Date("2026-06-08T00:00:00.000Z"),
      users: [{ id: 7, createdAt: new Date("2026-01-01T00:00:00.000Z"), isBanned: false }],
      binds: [{ id: 31, userId: 7, type: "QQ", bid: "123456" }],
      assetDefinitions: [
        {
          id: 1,
          type: "CURRENCY",
          assetId: 10001,
          name: "Paid balance",
          valid: true,
          billingEffect: { type: "FIXED_OFF", value: 10, consume: false },
        },
      ],
      userAssets: [
        {
          id: 101,
          userId: 7,
          assetDefId: 10001,
          assetType: "CURRENCY",
          count: 500,
          activeAt: null,
          expireAt: null,
          hide: false,
        },
      ],
      billingRules: [
        {
          id: 2,
          name: "Default time",
          available: true,
          priority: 1,
          matchDate: { weekdays: [1, 2, 3, 4, 5] },
          timeRange: { start: "00:00", end: "00:00" },
          pricing: { unitMinutes: 30, unitPrice: 40, priceCap: 160, roundGraceMinutes: 5 },
        },
      ],
      presents: [
        {
          id: 61,
          name: "Recharge pack",
          oncePerUser: true,
          body: [{ assetType: "CURRENCY", assetId: 10001, count: 500, mergeStrategy: "STACK" }],
        },
      ],
      coinRecords: [
        {
          id: 91,
          userId: 7,
          machineName: "mai-1",
          count: 2,
          createAt: new Date("2026-01-03T10:30:00.000Z"),
        },
      ],
    });
  });
});

const postgresRows: Record<string, Array<Record<string, unknown>>> = {
  User: [{ id: 7, createdAt: new Date("2026-01-01T00:00:00.000Z"), isBanned: false }],
  Bind: [{ id: 31, userId: 7, type: "QQ", bid: "123456" }],
  Asset: [
    {
      id: 1,
      assetId: 10001,
      type: "CURRENCY",
      name: "Paid balance",
      description: "Paid wallet",
      valid: true,
      activeAt: null,
      expireAt: null,
      billingEffect: { type: "FIXED_OFF", value: 10, consume: false },
    },
  ],
  UserAsset: [
    {
      id: 101,
      userId: 7,
      assetDefId: 10001,
      assetType: "CURRENCY",
      assetId: 1,
      count: 500,
      activeAt: null,
      expireAt: null,
      hide: false,
    },
  ],
  UserAssetLog: [
    {
      id: 301,
      userId: 7,
      userAssetId: 101,
      assetId: 10001,
      assetType: "CURRENCY",
      changeAmount: 500,
      action: "ADMIN_GRANT",
      comment: "legacy import",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ],
  Session: [
    {
      id: 51,
      userId: 7,
      createdAt: new Date("2026-01-03T10:00:00.000Z"),
      closedAt: new Date("2026-01-03T11:30:00.000Z"),
      isActive: null,
      billingCost: 120,
      finalCost: 90,
      costOverwrite: null,
    },
  ],
  BillingRule: [
    {
      id: 2,
      name: "Default time",
      available: true,
      priority: 1,
      matchDate: { weekdays: [1, 2, 3, 4, 5] },
      timeRange: { start: "00:00", end: "00:00" },
      pricing: { unitMinutes: 30, unitPrice: 40, priceCap: 160, roundGraceMinutes: 5 },
    },
  ],
  BillingRecord: [
    {
      id: 401,
      userId: 7,
      ruleId: 2,
      ruleStartTimeStamp: 1767424800000n,
      cost: 120,
      billingStart: new Date("2026-01-03T10:00:00.000Z"),
      billingEnd: new Date("2026-01-03T11:30:00.000Z"),
      durationMin: 90,
    },
  ],
  Present: [
    {
      id: 61,
      name: "Recharge pack",
      oncePerUser: true,
      body: [{ assetType: "CURRENCY", assetId: 10001, count: 500, mergeStrategy: "STACK" }],
    },
  ],
  Redeem: [
    {
      id: 71,
      code: "PRISM-LEGACY",
      presentId: 61,
      activeAt: new Date("2026-01-01T00:00:00.000Z"),
      expireAt: null,
      maxUseCount: 1,
    },
  ],
  RedeemRecord: [
    {
      id: 81,
      userId: 7,
      redeemId: 71,
      presentId: 61,
      date: new Date("2026-01-02T00:00:00.000Z"),
    },
  ],
  CoinRecord: [
    {
      id: 91,
      userId: 7,
      machineName: "mai-1",
      count: 2,
      createAt: new Date("2026-01-03T10:30:00.000Z"),
    },
  ],
};

function extractTableName(query: string): string {
  const match = query.match(/FROM "([^"]+)"/);
  if (!match) throw new Error(`No table found in query: ${query}`);
  return match[1];
}

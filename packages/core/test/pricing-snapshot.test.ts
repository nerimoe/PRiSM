import { describe, expect, it } from "bun:test";
import {
  diffPricingSnapshots,
  overlayPricingSnapshot,
  reconcilePricingTarget,
  validatePricingSnapshot,
  type PricingBindings,
  type PricingConfig,
} from "../src";

const at = new Date("2026-11-24T00:00:00.000Z");

function plan(id: string, price = 12, options: { status?: "active" | "archived"; requires?: string[]; name?: string } = {}): PricingConfig {
  return {
    id,
    kind: "time.priority",
    name: options.name ?? id,
    enabled: options.status !== "archived",
    status: options.status ?? "active",
    provider: {
      id,
      timeZone: "UTC",
      rules: [{
        id: `${id}-day`, label: "日间", priority: 0, timeRange: { start: "10:00", end: "22:00" },
        pricing: { unitMinutes: 60, unitPrice: price, roundGraceMinutes: 5, priceCap: 0 },
      }],
    },
    ...(options.requires ? { relations: { requires: options.requires, conflicts: [] } } : {}),
    createdAt: at,
    updatedAt: at,
  };
}

const bindings = (groups: Record<string, string | null>, resources: Record<string, string | null> = {}): PricingBindings =>
  ({ groups, resources, tables: {} });

describe("price list differences", () => {
  it("names the plan, the period and each field that changed", () => {
    const before = { configs: [plan("base", 12)], bindings: bindings({ music: "base" }) };
    const after = { configs: [plan("base", 13), plan("night", 8)], bindings: bindings({ music: "night" }) };
    expect(diffPricingSnapshots(before, after)).toEqual([
      { kind: "period-changed", planId: "base", name: "base", period: "日间", fields: [{ field: "unitPrice", from: 12, to: 13 }] },
      { kind: "plan-added", planId: "night", name: "night" },
      { kind: "binding-changed", target: "group", targetId: "music", from: "base", to: "night" },
    ]);
  });

  it("counts a new thing only once it uses a plan, and never one that went away", () => {
    const before = { configs: [], bindings: bindings({ music: "base", old: "base" }) };
    expect(diffPricingSnapshots(before, { configs: [], bindings: bindings({ music: "base", hall: null }) })).toEqual([]);
    expect(diffPricingSnapshots(before, { configs: [], bindings: bindings({ music: "base", hall: "night" }) }))
      .toEqual([{ kind: "binding-changed", target: "group", targetId: "hall", from: null, to: "night" }]);
  });

  it("skips bindings when the earlier list did not record them", () => {
    expect(diffPricingSnapshots({ configs: [], bindings: null }, { configs: [], bindings: bindings({ music: "base" }) })).toEqual([]);
  });

  it("reports archiving, schedule changes and relations", () => {
    const moved = plan("base");
    const rule = (moved.provider as any).rules[0];
    (moved.provider as any).rules = [{ ...rule, timeRange: { start: "09:00", end: "22:00" } }];
    const items = diffPricingSnapshots(
      { configs: [plan("base"), plan("night"), plan("vip")], bindings: null },
      { configs: [moved, plan("night", 12, { status: "archived" }), plan("vip", 12, { requires: ["base"] })], bindings: null },
    );
    expect(items.map((item) => item.kind)).toEqual(["period-changed", "plan-archived", "relations-changed"]);
    expect(items[0]).toMatchObject({ fields: [{ field: "schedule" }] });
  });
});

describe("price lists over time", () => {
  it("lays a target over a base: its plans and bindings win, the rest stays", () => {
    const merged = overlayPricingSnapshot(
      { configs: [plan("base", 12), plan("night", 8)], bindings: bindings({ music: "base", hall: "base" }) },
      { configs: [plan("night", 10)], bindings: bindings({ music: "night" }) },
    );
    expect(merged.configs.map((config) => [config.id, (config.provider as any).rules[0].pricing.unitPrice])).toEqual([["base", 12], ["night", 10]]);
    expect(merged.bindings!.groups).toEqual({ music: "night", hall: "base" });
  });

  it("refuses a list that binds or requires an archived plan", () => {
    expect(() => validatePricingSnapshot({ configs: [plan("base", 12, { status: "archived" })], bindings: bindings({ music: "base" }) }))
      .toThrow(expect.objectContaining({ code: "RESOURCE_PRICING_INVALID" }));
    expect(() => validatePricingSnapshot({ configs: [plan("base", 12, { status: "archived" }), plan("vip", 12, { requires: ["base"] })], bindings: null }))
      .toThrow(expect.objectContaining({ code: "PRICING_CONFIG_IN_USE" }));
  });

  it("applies a target without undoing what came after it was saved", () => {
    const { snapshot, notes } = reconcilePricingTarget({
      current: {
        configs: [plan("base"), plan("night"), plan("later")],
        bindings: { groups: { music: "base" }, resources: { fresh: "night" }, tables: { t1: "base" } },
      },
      target: {
        configs: [plan("base", 15), plan("night", 8, { status: "archived" })],
        bindings: { groups: { music: "base", gone: "base" }, resources: {}, tables: { t1: "night" } },
      },
      seatedTables: new Set(["t1"]),
    });
    expect(notes).toEqual([
      { kind: "binding-skipped-missing", target: "group", targetId: "gone" },
      { kind: "binding-skipped-seated", targetId: "t1" },
      { kind: "archive-kept", planId: "night", name: "night" },
    ]);
    expect(snapshot.configs.map((config) => [config.id, config.status, (config.provider as any).rules[0].pricing.unitPrice]))
      .toEqual([["base", "active", 15], ["night", "active", 12], ["later", "active", 12]]);
    expect(snapshot.bindings.tables.t1).toBe("base");
  });

  it("ignores a plan that neither existed before nor stays active after", () => {
    const before = { configs: [plan("base", 12)], bindings: bindings({ music: "base" }) };
    const after = {
      configs: [plan("base", 12), plan("temp", 5, { status: "archived" })],
      bindings: bindings({ music: "base" }),
    };
    expect(diffPricingSnapshots(before, after)).toEqual([]);
  });
});

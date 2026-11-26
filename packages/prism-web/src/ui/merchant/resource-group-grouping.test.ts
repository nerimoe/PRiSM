import { describe, expect, it } from "vitest";
import type { Resource, ResourceGroup } from "../../api";
import {
  buildPricingBindingTree,
  effectiveResourcePlan,
  groupResourcesByGroup,
  resolveResourceGroup,
} from "./resource-group-grouping";

const makeGroup = (over: Partial<ResourceGroup> = {}): ResourceGroup => ({
  id: "default",
  name: "默认资源组",
  enabled: true,
  isDefault: false,
  defaultPricingConfigId: null,
  resourceCount: 0,
  ...over,
});

const makeResource = (
  over: Partial<Resource> = {},
): Pick<Resource, "id" | "name" | "resourceGroupId" | "pricingConfigOverrideId"> => ({
  id: "r1",
  name: "资源 1",
  resourceGroupId: undefined,
  pricingConfigOverrideId: null,
  ...over,
});

describe("groupResourcesByGroup", () => {
  it("groups resources in group order and routes missing or orphan groups to an ungrouped section", () => {
    const groups: ResourceGroup[] = [
      makeGroup({ id: "default", name: "默认资源组", isDefault: true, resourceCount: 2 }),
      makeGroup({ id: "vip", name: "包间区", resourceCount: 1 }),
      makeGroup({ id: "empty", name: "空组", resourceCount: 0 }),
    ];
    const resources = [
      makeResource({ id: "a", name: "机台 A" }),
      makeResource({ id: "b", name: "包间 1", resourceGroupId: "vip" }),
      makeResource({ id: "c", name: "机台 C", resourceGroupId: "default" }),
      makeResource({ id: "d", name: "孤立资源", resourceGroupId: "deleted-group" }),
    ];

    const sections = groupResourcesByGroup(resources, groups);
    expect(sections.map((s) => s.group?.id ?? null)).toEqual(["default", "vip", null]);
    expect(sections[0]!.resources.map((r) => r.id)).toEqual(["a", "c"]);
    expect(sections[1]!.resources.map((r) => r.id)).toEqual(["b"]);
    expect(sections[2]!.resources.map((r) => r.id)).toEqual(["d"]);
  });

  it("places resources without resourceGroupId into ungrouped fallback when no default group is listed", () => {
    const groups: ResourceGroup[] = [makeGroup({ id: "vip", name: "包间区" })];
    const resources = [
      makeResource({ id: "a", name: "未指定" }),
      makeResource({ id: "b", name: "包间 1", resourceGroupId: "vip" }),
    ];

    const sections = groupResourcesByGroup(resources, groups);
    expect(sections.map((s) => s.group?.id ?? null)).toEqual(["vip", null]);
    expect(sections[1]!.resources.map((r) => r.id)).toEqual(["a"]);
  });

  it("resolves a resource's group with default and missing fallbacks", () => {
    const defaultGroup = makeGroup({ id: "default", name: "默认资源组", isDefault: true });
    const vipGroup = makeGroup({ id: "vip", name: "包间区" });
    const groups = [defaultGroup, vipGroup];

    expect(resolveResourceGroup(undefined, groups)).toEqual(defaultGroup);
    expect(resolveResourceGroup("vip", groups)).toEqual(vipGroup);
    expect(resolveResourceGroup("deleted", groups)).toBeNull();
    expect(resolveResourceGroup(undefined, [vipGroup])).toBeNull();
  });
});

describe("effectiveResourcePlan", () => {
  const plans = [
    { id: "p1", name: "标准入场" },
    { id: "p2", name: "包间计费" },
  ];

  it("prefers resource override over group default and resolves free fallback", () => {
    const group = makeGroup({ id: "default", defaultPricingConfigId: "p1", enabled: true });
    expect(effectiveResourcePlan(makeResource({ pricingConfigOverrideId: "p2" }), group, plans)).toEqual({
      kind: "override",
      planId: "p2",
      plan: { id: "p2", name: "包间计费" },
    });
    expect(effectiveResourcePlan(makeResource(), group, plans)).toEqual({
      kind: "group",
      planId: "p1",
      plan: { id: "p1", name: "标准入场" },
      groupDisabled: false,
    });
    expect(effectiveResourcePlan(makeResource(), { ...group, enabled: false }, plans)).toEqual({
      kind: "group",
      planId: "p1",
      plan: { id: "p1", name: "标准入场" },
      groupDisabled: true,
    });
    expect(effectiveResourcePlan(makeResource(), makeGroup(), plans)).toEqual({
      kind: "free",
      groupDisabled: false,
    });
    expect(effectiveResourcePlan(makeResource(), null, plans)).toEqual({
      kind: "free",
      groupDisabled: false,
    });
  });
});

describe("buildPricingBindingTree", () => {
  it("groups resources once under each group, attaches tabletop bindings, filters excluded items, and keeps ungrouped/orphan entries", () => {
    const groups: ResourceGroup[] = [
      makeGroup({ id: "default", name: "默认资源组", isDefault: true }),
      makeGroup({ id: "vip", name: "麻将包间区" }),
      makeGroup({ id: "empty", name: "空组" }),
    ];
    const bindings = {
      groups: { vip: "p2", default: "p1", empty: null, deletedGroup: "p1" },
      resources: { m2: null, m1: "p2", table1: null, bot1: null, botWithOverride: "p1", missingGroupRes: null },
      tables: { table1: "p2", orphanTable: "p1" },
    };
    const names = {
      groups: { default: "默认资源组", vip: "麻将包间区", empty: "空组", deletedGroup: "旧区" },
      resources: {
        m1: "maimai DX #1",
        m2: "CHUNITHM #2",
        table1: "麻将桌 1 号",
        bot1: "月宫 Bot",
        botWithOverride: "特价 Bot",
        missingGroupRes: "漂流机台",
        orphanTable: "独立桌游",
      },
    };
    const groupMap: Record<string, string | undefined> = {
      m1: undefined,
      m2: "default",
      table1: "vip",
      bot1: undefined,
      botWithOverride: "default",
      missingGroupRes: "nonexistent",
      orphanTable: "vip",
    };

    const tree = buildPricingBindingTree({
      bindings,
      groups,
      names,
      groupIdOfResource: (id) => groupMap[id],
      shouldExcludeResource: (id, info) => id.startsWith("bot") && info.resourcePlan === null && !info.hasTablePlan,
    });

    expect(tree.map((node) => ({ id: node.id, name: node.name, hasGroupBinding: node.hasGroupBinding, groupPlan: node.groupPlan }))).toEqual([
      { id: "default", name: "默认资源组", hasGroupBinding: true, groupPlan: "p1" },
      { id: "vip", name: "麻将包间区", hasGroupBinding: true, groupPlan: "p2" },
      { id: "empty", name: "空组", hasGroupBinding: true, groupPlan: null },
      { id: "deletedGroup", name: "旧区", hasGroupBinding: true, groupPlan: "p1" },
      { id: null, name: "未分组", hasGroupBinding: false, groupPlan: null },
    ]);

    expect(tree[0]!.resources).toEqual([
      { id: "m1", name: "maimai DX #1", kind: "resource", resourcePlan: "p2", hasTablePlan: false, tablePlan: null },
      { id: "botWithOverride", name: "特价 Bot", kind: "resource", resourcePlan: "p1", hasTablePlan: false, tablePlan: null },
      { id: "m2", name: "CHUNITHM #2", kind: "resource", resourcePlan: null, hasTablePlan: false, tablePlan: null },
    ]);
    expect(tree[1]!.resources).toEqual([
      { id: "orphanTable", name: "独立桌游", kind: "table", resourcePlan: null, hasTablePlan: true, tablePlan: "p1" },
      { id: "table1", name: "麻将桌 1 号", kind: "resource", resourcePlan: null, hasTablePlan: true, tablePlan: "p2" },
    ]);
    expect(tree[2]!.resources).toEqual([]);
    expect(tree[4]!.resources).toEqual([
      { id: "missingGroupRes", name: "漂流机台", kind: "resource", resourcePlan: null, hasTablePlan: false, tablePlan: null },
    ]);
  });

  it("returns empty array when bindings is null", () => {
    expect(
      buildPricingBindingTree({
        bindings: null,
        groups: [],
        names: { groups: {}, resources: {} },
        groupIdOfResource: () => undefined,
      }),
    ).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { Resource, ResourceGroup } from "../../api";
import {
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

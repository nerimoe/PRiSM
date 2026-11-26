import type { Resource, ResourceGroup } from "../../api";

export type GroupedResources<T extends Pick<Resource, "id" | "name" | "resourceGroupId">> = {
  group: ResourceGroup | null;
  resources: T[];
};

/**
 * Resolve the ResourceGroup a resource belongs to, falling back to the default
 * group when `resourceGroupId` is unset or null when no matching group exists.
 */
export function resolveResourceGroup(
  resourceGroupId: string | undefined,
  groups: readonly ResourceGroup[],
): ResourceGroup | null {
  const defaultGroup = groups.find((group) => group.isDefault || group.id === "default") ?? null;
  if (!resourceGroupId) return defaultGroup;
  return groups.find((group) => group.id === resourceGroupId) ?? null;
}

/**
 * Group resources by their ResourceGroup in group order.
 * Resources with no `resourceGroupId` fall into the default group when present,
 * and any resource without a matching group falls into an ungrouped section (`group: null`).
 */
export function groupResourcesByGroup<T extends Pick<Resource, "id" | "name" | "resourceGroupId">>(
  resources: readonly T[],
  groups: readonly ResourceGroup[],
): GroupedResources<T>[] {
  const buckets = new Map<string, T[]>(groups.map((group) => [group.id, []]));
  const ungrouped: T[] = [];
  const defaultId = groups.find((group) => group.isDefault || group.id === "default")?.id;

  for (const resource of resources) {
    const targetId = resource.resourceGroupId || defaultId || "";
    const bucket = targetId ? buckets.get(targetId) : undefined;
    if (bucket) bucket.push(resource);
    else ungrouped.push(resource);
  }

  const sections: GroupedResources<T>[] = groups
    .map((group) => ({ group, resources: buckets.get(group.id) ?? [] }))
    .filter((section) => section.resources.length > 0);

  if (ungrouped.length > 0) {
    sections.push({ group: null, resources: ungrouped });
  }
  return sections;
}

export type EffectiveResourcePlan<P extends { id: string; name: string }> =
  | { kind: "override"; planId: string; plan: P | null }
  | { kind: "group"; planId: string; plan: P | null; groupDisabled: boolean }
  | { kind: "free"; groupDisabled: boolean };

/**
 * Resolve how a resource bills: an explicit override replaces its group's plan,
 * otherwise it follows its group (when enabled and assigned a plan), or is free.
 */
export function effectiveResourcePlan<P extends { id: string; name: string }>(
  resource: Pick<Resource, "pricingConfigOverrideId">,
  group: Pick<ResourceGroup, "enabled" | "defaultPricingConfigId"> | null,
  plans: readonly P[],
): EffectiveResourcePlan<P> {
  const findPlan = (id: string) => plans.find((plan) => plan.id === id) ?? null;
  if (resource.pricingConfigOverrideId) {
    return {
      kind: "override",
      planId: resource.pricingConfigOverrideId,
      plan: findPlan(resource.pricingConfigOverrideId),
    };
  }
  if (group?.defaultPricingConfigId) {
    return {
      kind: "group",
      planId: group.defaultPricingConfigId,
      plan: findPlan(group.defaultPricingConfigId),
      groupDisabled: !group.enabled,
    };
  }
  return { kind: "free", groupDisabled: group ? !group.enabled : false };
}

export type PricingBindingResourceItem = {
  id: string;
  name: string;
  kind: "resource" | "table";
  resourcePlan: string | null;
  hasTablePlan: boolean;
  tablePlan: string | null;
};

export type PricingBindingGroupNode = {
  id: string | null;
  name: string;
  hasGroupBinding: boolean;
  groupPlan: string | null;
  resources: PricingBindingResourceItem[];
};

export type PricingBindingsMap = {
  groups: Record<string, string | null>;
  resources: Record<string, string | null>;
  tables: Record<string, string | null>;
};

export type BuildPricingBindingTreeInput = {
  bindings: PricingBindingsMap | null;
  groups: readonly ResourceGroup[];
  names: { groups: Record<string, string>; resources: Record<string, string> };
  groupIdOfResource: (id: string) => string | undefined;
  shouldExcludeResource?: (
    id: string,
    info: { resourcePlan: string | null; hasTablePlan: boolean; tablePlan: string | null },
  ) => boolean;
};

/**
 * Build a unified group-first tree for pricing bindings:
 * each ResourceGroup appears once with its child resources indented beneath,
 * tabletop game plans attached directly to their resource, and missing groups
 * collected in a single trailing ungrouped fallback node.
 */
export function buildPricingBindingTree({
  bindings,
  groups,
  names,
  groupIdOfResource,
  shouldExcludeResource,
}: BuildPricingBindingTreeInput): PricingBindingGroupNode[] {
  if (!bindings) return [];

  const buckets = new Map<string, PricingBindingGroupNode>();
  const orderedIds: string[] = [];

  for (const group of groups) {
    if (!Object.prototype.hasOwnProperty.call(bindings.groups, group.id)) continue;
    buckets.set(group.id, {
      id: group.id,
      name: group.name,
      hasGroupBinding: true,
      groupPlan: bindings.groups[group.id] ?? null,
      resources: [],
    });
    orderedIds.push(group.id);
  }

  const extraGroupIds = Object.keys(bindings.groups)
    .filter((id) => !buckets.has(id))
    .sort((a, b) => (names.groups[a] ?? a).localeCompare(names.groups[b] ?? b));

  for (const id of extraGroupIds) {
    buckets.set(id, {
      id,
      name: names.groups[id] ?? id,
      hasGroupBinding: true,
      groupPlan: bindings.groups[id] ?? null,
      resources: [],
    });
    orderedIds.push(id);
  }

  const defaultCandidate = groups.find((group) => group.isDefault || group.id === "default")?.id;
  const defaultGroupId =
    defaultCandidate && buckets.has(defaultCandidate)
      ? defaultCandidate
      : buckets.has("default")
        ? "default"
        : undefined;

  const ungrouped: PricingBindingResourceItem[] = [];
  const pushItem = (item: PricingBindingResourceItem) => {
    const resolvedGroupId = groupIdOfResource(item.id);
    const targetId = resolvedGroupId || defaultGroupId || "";
    const bucket = targetId ? buckets.get(targetId) : undefined;
    if (bucket) bucket.resources.push(item);
    else ungrouped.push(item);
  };

  for (const [id, rawPlan] of Object.entries(bindings.resources)) {
    const resourcePlan = rawPlan ?? null;
    const hasTablePlan = Object.prototype.hasOwnProperty.call(bindings.tables, id);
    const tablePlan = hasTablePlan ? (bindings.tables[id] ?? null) : null;
    if (shouldExcludeResource?.(id, { resourcePlan, hasTablePlan, tablePlan })) continue;
    pushItem({
      id,
      name: names.resources[id] ?? id,
      kind: "resource",
      resourcePlan,
      hasTablePlan,
      tablePlan,
    });
  }

  for (const [id, rawPlan] of Object.entries(bindings.tables)) {
    if (Object.prototype.hasOwnProperty.call(bindings.resources, id)) continue;
    pushItem({
      id,
      name: names.resources[id] ?? id,
      kind: "table",
      resourcePlan: null,
      hasTablePlan: true,
      tablePlan: rawPlan ?? null,
    });
  }

  const sortItems = (items: PricingBindingResourceItem[]) =>
    items.sort((a, b) => Number(a.resourcePlan === null) - Number(b.resourcePlan === null) || a.name.localeCompare(b.name));

  const nodes = orderedIds.map((id) => {
    const node = buckets.get(id)!;
    sortItems(node.resources);
    return node;
  });

  if (ungrouped.length > 0) {
    sortItems(ungrouped);
    nodes.push({
      id: null,
      name: "未分组",
      hasGroupBinding: false,
      groupPlan: null,
      resources: ungrouped,
    });
  }

  return nodes;
}

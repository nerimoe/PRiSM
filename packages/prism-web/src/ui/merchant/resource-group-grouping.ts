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

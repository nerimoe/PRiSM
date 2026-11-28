import type { Resource } from "../../api";
import {
  capabilityOrder,
  deviceActionGroups,
  resourceCapabilities,
  type CapabilityId,
} from "./resource-capabilities";

export type ResourceActionsModalSize = "default" | "lg" | "xl";

export type ResourceActionsLayoutMode = "compact" | "two-column" | "host-only" | "split-host";

export type ResourceActionsLayout = {
  sections: CapabilityId[];
  deviceSections: CapabilityId[];
  hasHost: boolean;
  modalSize: ResourceActionsModalSize;
  mode: ResourceActionsLayoutMode;
};

const SECTION_WEIGHT: Record<CapabilityId, number> = {
  hinata_io: 3,
  climate: 3,
  table: 3,
  keys: 2,
  power: 1,
  coin: 1,
  door: 1,
  iot: 1,
  host: 4,
  bot: 1,
};

/**
 * Picks the modal width and pane layout for a resource's operations panel:
 * - Launcher + other capabilities -> wide two-pane split workbench (`xl`)
 * - Launcher alone -> dedicated Launcher workbench (`lg`)
 * - 3+ non-Launcher capabilities -> balanced 2-column grid (`lg`)
 * - 1-2 non-Launcher capabilities -> compact single column (`default`)
 */
export function resolveResourceActionsLayout(
  device: Parameters<typeof resourceCapabilities>[0] & Parameters<typeof deviceActionGroups>[0],
): ResourceActionsLayout {
  const caps = resourceCapabilities(device);
  const groups = deviceActionGroups(device);
  const sections = capabilityOrder.filter(
    (id) =>
      groups.some((group) => group.capability === id) ||
      (id === "table" && caps.table) ||
      (id === "host" && caps.host),
  );
  const hasHost = sections.includes("host");
  const deviceSections = sections.filter((id) => id !== "host");

  if (hasHost && deviceSections.length > 0) {
    return { sections, deviceSections, hasHost, modalSize: "xl", mode: "split-host" };
  }
  if (hasHost) {
    return { sections, deviceSections, hasHost, modalSize: "lg", mode: "host-only" };
  }
  if (deviceSections.length >= 3) {
    return { sections, deviceSections, hasHost, modalSize: "lg", mode: "two-column" };
  }
  return { sections, deviceSections, hasHost, modalSize: "default", mode: "compact" };
}

/**
 * Greedily balances non-Launcher capability cards across two columns by
 * estimated vertical height while keeping their relative order inside each column.
 */
export function partitionDeviceSections(
  sections: readonly CapabilityId[],
): [CapabilityId[], CapabilityId[]] {
  const left: CapabilityId[] = [];
  const right: CapabilityId[] = [];
  let leftWeight = 0;
  let rightWeight = 0;

  for (const id of sections) {
    const weight = SECTION_WEIGHT[id] ?? 1;
    if (leftWeight <= rightWeight) {
      left.push(id);
      leftWeight += weight;
    } else {
      right.push(id);
      rightWeight += weight;
    }
  }

  return [left, right];
}

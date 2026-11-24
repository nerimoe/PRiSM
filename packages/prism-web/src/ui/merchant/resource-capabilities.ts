import type { Resource } from "../../api";

/**
 * What a device can do, derived from the machine row once, together with the
 * declarative capability conflict, dependency, and player-link rules mirrored
 * from the server catalog.
 */
export type CapabilityId =
  | "power"
  | "climate"
  | "hinata_io"
  | "keys"
  | "coin"
  | "host"
  | "iot"
  | "door"
  | "table"
  | "bot";

export const capabilityOrder: CapabilityId[] = [
  "power",
  "climate",
  "hinata_io",
  "keys",
  "coin",
  "host",
  "iot",
  "door",
  "table",
  "bot",
];

type CapabilityRule = {
  needsLink: boolean;
  conflicts?: readonly CapabilityId[];
  conflictsWithAll?: boolean;
  requires?: readonly CapabilityId[];
};

export const capabilityRules: Record<CapabilityId, CapabilityRule> = {
  power: { needsLink: true },
  climate: { needsLink: true },
  hinata_io: { needsLink: true },
  keys: { needsLink: true },
  coin: { needsLink: true, requires: ["keys"] },
  host: { needsLink: true },
  iot: { needsLink: false, conflicts: ["table", "door", "climate"] },
  door: { needsLink: true },
  table: { needsLink: true },
  bot: { needsLink: false, conflictsWithAll: true },
};

/** Symmetric conflict check between two capabilities on one resource. */
export function capabilityConflicts(a: CapabilityId, b: CapabilityId): boolean {
  if (a === b) return false;
  const ra = capabilityRules[a];
  const rb = capabilityRules[b];
  return Boolean(
    ra.conflictsWithAll ||
    rb.conflictsWithAll ||
    ra.conflicts?.includes(b) ||
    rb.conflicts?.includes(a),
  );
}

/** Capabilities currently enabled that conflict with adding `target`. */
export function conflictingCapabilities(
  target: CapabilityId,
  active: Record<CapabilityId, boolean>,
): CapabilityId[] {
  return capabilityOrder.filter((id) => active[id] && capabilityConflicts(target, id));
}

/** Capabilities required before `target` can be enabled. */
export function capabilityRequires(target: CapabilityId): readonly CapabilityId[] {
  return capabilityRules[target].requires ?? [];
}

/** Capabilities currently enabled that depend on `target` (blocking its removal). */
export function dependentCapabilities(
  target: CapabilityId,
  active: Record<CapabilityId, boolean>,
): CapabilityId[] {
  return capabilityOrder.filter(
    (id) => active[id] && (capabilityRules[id].requires ?? []).includes(target),
  );
}

/**
 * Whether a resource has a player-facing QR / NFC link.
 * A resource with no capabilities is a plain check-in QR code (has a link);
 * otherwise it has a link iff at least one enabled capability needs a link.
 */
export function hasResourceLink(active: Record<CapabilityId, boolean>): boolean {
  const enabled = capabilityOrder.filter((id) => active[id]);
  if (!enabled.length) return true;
  return enabled.some((id) => capabilityRules[id].needsLink);
}

/** The capabilities this device currently carries. */
export function resourceCapabilities(
  machine: Pick<
    Resource,
    | "homeAssistant"
    | "climate"
    | "ttlockLockId"
    | "table"
    | "hasHinata"
    | "relayConnection"
    | "coinEnabled"
    | "hasPassword"
  > & Partial<Pick<Resource, "bot" | "coin" | "host" | "iot" | "keys" | "hasKeys">>,
): Record<CapabilityId, boolean> {
  return {
    power: !!machine.homeAssistant,
    climate: !!machine.climate,
    hinata_io:
      !!machine.hasHinata || machine.relayConnection === "embedded",
    keys: !!machine.hasKeys || (machine.keys?.length ?? 0) > 0,
    coin: !!machine.coin,
    host: !!machine.host,
    iot: !!machine.iot,
    door: !!machine.ttlockLockId,
    table: !!machine.table,
    bot: !!machine.bot,
  };
}

/** Direct-connect machines authenticate the socket, so they need no password. */
export function isDirectConnect(
  machine: Pick<Resource, "relayConnection">,
): boolean {
  return machine.relayConnection === "embedded";
}

/**
 * Whether the coin action can actually be sent: the server says so
 * (`coinEnabled`, its `coin.available`); an older response is read from the
 * coin config, its chosen button in `keys`, and how IO/Launcher is connected.
 */
export function canOperateCoin(
  machine: Pick<
    Resource,
    "hasHinata" | "relayConnection" | "coinKey" | "hasPassword"
  > & Partial<Pick<Resource, "coinEnabled" | "coin" | "host" | "keys">>,
): boolean {
  if (machine.coinEnabled !== undefined) return machine.coinEnabled;
  if (machine.coin?.keyId && machine.keys?.length) {
    const btn = machine.keys.find((b) => b.id === machine.coin!.keyId);
    if (!btn) return false;
    if (btn.mode === "gpio") return !!btn.nodeId;
    if (machine.host?.nodeId) return true;
    return (machine.hasHinata || machine.relayConnection === "embedded") && (isDirectConnect(machine) || !!machine.hasPassword);
  }
  if (!(machine.hasHinata || machine.relayConnection === "embedded")) {
    return false;
  }
  if (!((machine.coinKey ?? 0) > 0)) return false;
  return isDirectConnect(machine) || !!machine.hasPassword;
}

export type ResourceAction = { name: string; capability: string };

/**
 * Which capability owns an action. The server states this for every action it
 * reports; this mapping only covers the built-in catalog and is used when an
 * older response has no capability tag.
 */
export function actionCapability(action: string): CapabilityId | null {
  if (action === "power.on" || action === "power.off" || action === "power.keep") return "power";
  if (action.startsWith("climate.")) return "climate";
  if (action === "aime.scan") return "hinata_io";
  if (action === "key.press") return "keys";
  if (action === "coin") return "coin";
  if (action.startsWith("host.")) return "host";
  if (action === "door.open") return "door";
  if (action.startsWith("table.")) return "table";
  return null;
}

/** Staff actions grouped by the capability that owns them. */
export function deviceActionGroups(
  machine: Pick<
    Resource,
    | "homeAssistant"
    | "climate"
    | "ttlockLockId"
    | "table"
    | "hasHinata"
    | "relayConnection"
    | "coinKey"
    | "hasPassword"
  > & Partial<Pick<Resource, "bot" | "coin" | "host" | "iot" | "keys" | "hasKeys">> & { actions?: ResourceAction[] },
): { capability: CapabilityId; actions: string[] }[] {
  const groups = new Map<CapabilityId, string[]>();
  const add = (capability: CapabilityId | null, action: string) => {
    if (!capability) return;
    groups.set(capability, [...(groups.get(capability) ?? []), action]);
  };
  if (machine.actions?.length) {
    for (const action of machine.actions) {
      add(
        capabilityOrder.includes(action.capability as CapabilityId)
          ? (action.capability as CapabilityId)
          : actionCapability(action.name),
        action.name,
      );
    }
  } else {
    const caps = resourceCapabilities(machine);
    if (caps.power) {
      add("power", "power.on");
      add("power", "power.off");
    }
    if (caps.climate)
      for (const action of ["climate.on", "climate.off", "climate.set_mode", "climate.set_temperature", "climate.set_fan_mode"])
        add("climate", action);
    if (caps.hinata_io) add("hinata_io", "aime.scan");
    if (caps.keys && (machine.keys?.length ?? 0) > 0) add("keys", "key.press");
    if (canOperateCoin(machine)) add("coin", "coin");
    if (caps.door) add("door", "door.open");
  }
  return capabilityOrder
    .filter((capability) => groups.has(capability))
    .map((capability) => ({
      capability,
      actions: groups.get(capability)!,
    }));
}

/** Flat list of the actions the device offers, in capability order. */
export function deviceActions(
  machine: Parameters<typeof deviceActionGroups>[0],
): string[] {
  return deviceActionGroups(machine).flatMap((group) => group.actions);
}

/** A device with no capability has nothing a staff member can do with it. */
export function isUnconfigured(
  machine: Parameters<typeof resourceCapabilities>[0],
): boolean {
  return !Object.values(resourceCapabilities(machine)).some(Boolean);
}

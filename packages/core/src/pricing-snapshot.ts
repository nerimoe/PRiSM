import { PrismDomainError } from "./errors";
import type { PricingConfig } from "./pricing-config";
import { validatePricingConfig } from "./pricing-config";
import { buildPricingRelationGraph, isStartablePricingKind, relationsOf } from "./pricing-relations";

/**
 * Which plan each billable thing uses: a resource group's plan, a resource's
 * own plan, a table's game plan. `null` means the thing is free (or, for a
 * resource, that it falls back to its group's plan).
 */
export type PricingBindings = {
  groups: Record<string, string | null>;
  resources: Record<string, string | null>;
  tables: Record<string, string | null>;
};

export type PricingBindingTarget = "group" | "resource" | "table";

/**
 * A shop's whole price list at one moment: every plan (disabled and archived
 * included) and every binding. `bindings` is null for history recorded before
 * bindings were kept.
 */
export type PricingSnapshot = {
  configs: PricingConfig[];
  bindings: PricingBindings | null;
};

export type PricingPeriodField =
  | "label"
  | "priority"
  | "status"
  | "schedule"
  | "unitMinutes"
  | "unitPrice"
  | "roundGraceMinutes"
  | "priceCap";

export type PricingChangeItem =
  | { kind: "plan-added"; planId: string; name: string }
  | { kind: "plan-archived" | "plan-unarchived" | "plan-enabled" | "plan-disabled"; planId: string; name: string }
  | { kind: "plan-renamed"; planId: string; from: string; to: string }
  | { kind: "period-added" | "period-removed"; planId: string; name: string; period: string }
  | {
      kind: "period-changed";
      planId: string;
      name: string;
      period: string;
      fields: Array<{ field: PricingPeriodField; from?: number | string; to?: number | string }>;
    }
  | { kind: "amount-changed"; planId: string; name: string; from: number; to: number }
  | {
      kind: "relations-changed";
      planId: string;
      name: string;
      requires: { added: string[]; removed: string[] };
      conflicts: { added: string[]; removed: string[] };
    }
  | { kind: "binding-changed"; target: PricingBindingTarget; targetId: string; from: string | null; to: string | null };

export function emptyPricingBindings(): PricingBindings {
  return { groups: {}, resources: {}, tables: {} };
}

const BINDING_KEYS: ReadonlyArray<[keyof PricingBindings, PricingBindingTarget]> = [
  ["groups", "group"],
  ["resources", "resource"],
  ["tables", "table"],
];

/** What changed from `before` to `after`, plan by plan, then binding by binding. */
export function diffPricingSnapshots(before: PricingSnapshot | null, after: PricingSnapshot): PricingChangeItem[] {
  const items: PricingChangeItem[] = [];
  const previous = new Map((before?.configs ?? []).map((config) => [config.id, config]));
  for (const config of after.configs) {
    const old = previous.get(config.id);
    if (!old) {
      // A plan added and removed in a future version before it ever took effect
      // neither existed before nor exists in this version.
      if ((config.status ?? "active") === "archived") continue;
      items.push({ kind: "plan-added", planId: config.id, name: config.name });
      continue;
    }
    items.push(...diffPlan(old, config));
  }
  if (before?.bindings && after.bindings) {
    for (const [key, target] of BINDING_KEYS) {
      const ids = new Set([...Object.keys(before.bindings[key]), ...Object.keys(after.bindings[key])]);
      for (const targetId of [...ids].sort()) {
        // A thing that went away is not a price change; one that appeared is
        // only when it already uses a plan.
        if (!(targetId in after.bindings[key])) continue;
        const from = before.bindings[key][targetId] ?? null;
        const to = after.bindings[key][targetId] ?? null;
        if (from !== to) items.push({ kind: "binding-changed", target, targetId, from, to });
      }
    }
  }
  return items;
}

function diffPlan(old: PricingConfig, config: PricingConfig): PricingChangeItem[] {
  const items: PricingChangeItem[] = [];
  const base = { planId: config.id, name: config.name };
  if (old.name !== config.name) items.push({ kind: "plan-renamed", planId: config.id, from: old.name, to: config.name });
  const wasArchived = (old.status ?? "active") === "archived";
  const isArchived = (config.status ?? "active") === "archived";
  if (wasArchived !== isArchived) items.push({ kind: isArchived ? "plan-archived" : "plan-unarchived", ...base });
  else if (!isArchived && old.enabled !== config.enabled) items.push({ kind: config.enabled ? "plan-enabled" : "plan-disabled", ...base });

  if (old.kind === "charge.fixed" && config.kind === "charge.fixed") {
    if (old.provider.amount !== config.provider.amount)
      items.push({ kind: "amount-changed", ...base, from: old.provider.amount, to: config.provider.amount });
  } else if (old.kind !== "charge.fixed" && config.kind !== "charge.fixed") {
    const oldRules = new Map(old.provider.rules.map((rule) => [rule.id, rule]));
    const newRules = new Map(config.provider.rules.map((rule) => [rule.id, rule]));
    for (const rule of config.provider.rules) {
      const previous = oldRules.get(rule.id);
      if (!previous) {
        items.push({ kind: "period-added", ...base, period: rule.label });
        continue;
      }
      const fields: Array<{ field: PricingPeriodField; from?: number | string; to?: number | string }> = [];
      if (previous.label !== rule.label) fields.push({ field: "label", from: previous.label, to: rule.label });
      if (previous.priority !== rule.priority) fields.push({ field: "priority", from: previous.priority, to: rule.priority });
      if ((previous.status ?? "active") !== (rule.status ?? "active"))
        fields.push({ field: "status", from: previous.status ?? "active", to: rule.status ?? "active" });
      if (scheduleKey(previous) !== scheduleKey(rule)) fields.push({ field: "schedule" });
      const prices = (value: typeof rule): Record<string, number> =>
        "pricing" in value ? { ...value.pricing } : { priceCap: (value as { priceCap: number }).priceCap };
      const from = prices(previous);
      const to = prices(rule);
      for (const field of ["unitMinutes", "unitPrice", "roundGraceMinutes", "priceCap"] as const) {
        if (from[field] !== to[field]) fields.push({ field, from: from[field], to: to[field] });
      }
      if (fields.length) items.push({ kind: "period-changed", ...base, period: rule.label, fields });
    }
    for (const rule of old.provider.rules) {
      if (!newRules.has(rule.id)) items.push({ kind: "period-removed", ...base, period: rule.label });
    }
  }

  const before = relationsOf(old);
  const after = relationsOf(config);
  const change = (from: string[], to: string[]) => ({
    added: to.filter((id) => !from.includes(id)),
    removed: from.filter((id) => !to.includes(id)),
  });
  const requires = change(before.requires, after.requires);
  const conflicts = change(before.conflicts, after.conflicts);
  if (requires.added.length || requires.removed.length || conflicts.added.length || conflicts.removed.length)
    items.push({ kind: "relations-changed", ...base, requires, conflicts });
  return items;
}

function scheduleKey(rule: {
  timeRange?: { start: string; end: string };
  weekdays?: readonly number[];
  specificDates?: readonly string[];
  dateTimeRange?: { start: Date; end: Date };
}): string {
  return JSON.stringify([
    rule.timeRange ?? null,
    rule.weekdays ?? null,
    rule.specificDates ?? null,
    rule.dateTimeRange ? [new Date(rule.dateTimeRange.start).toISOString(), new Date(rule.dateTimeRange.end).toISOString()] : null,
  ]);
}

/**
 * `target` laid over `base`: its plans replace the plans with the same ID, its
 * bindings replace the bindings it names. What it does not mention stays.
 */
export function overlayPricingSnapshot(base: PricingSnapshot, target: PricingSnapshot): PricingSnapshot {
  const configs = new Map(base.configs.map((config) => [config.id, config]));
  for (const config of target.configs) configs.set(config.id, config);
  const bindings = base.bindings ?? emptyPricingBindings();
  return {
    configs: [...configs.values()],
    bindings: target.bindings
      ? {
          groups: { ...bindings.groups, ...target.bindings.groups },
          resources: { ...bindings.resources, ...target.bindings.resources },
          tables: { ...bindings.tables, ...target.bindings.tables },
        }
      : bindings,
  };
}

/**
 * A price list that can bill: every enabled plan is complete, the relation
 * graph holds, no live plan requires an archived one, and every binding names a
 * plan that can start.
 */
export function validatePricingSnapshot(snapshot: PricingSnapshot): void {
  for (const config of snapshot.configs) validatePricingConfig(config);
  buildPricingRelationGraph(snapshot.configs);
  const byId = new Map(snapshot.configs.map((config) => [config.id, config]));
  const live = (config: PricingConfig | undefined) => !!config && (config.status ?? "active") !== "archived";
  for (const config of snapshot.configs) {
    if (!live(config)) continue;
    for (const required of relationsOf(config).requires) {
      if (!live(byId.get(required)))
        throw new PrismDomainError(
          `规则「${config.name}」依赖的规则「${byId.get(required)?.name ?? required}」已归档。`,
          "PRICING_CONFIG_IN_USE",
        );
    }
  }
  if (!snapshot.bindings) return;
  for (const [key, target] of BINDING_KEYS) {
    for (const [targetId, planId] of Object.entries(snapshot.bindings[key])) {
      if (!planId) continue;
      const plan = byId.get(planId);
      if (!live(plan) || !isStartablePricingKind(plan!.kind) || (target === "table" && !plan!.enabled))
        throw new PrismDomainError(
          `${target === "group" ? "资源组" : target === "resource" ? "资源" : "桌游"}「${targetId}」使用的规则「${plan?.name ?? planId}」不能计费。`,
          "RESOURCE_PRICING_INVALID",
        );
    }
  }
}

export type PricingReconcileNote =
  | { kind: "binding-skipped-missing"; target: PricingBindingTarget; targetId: string }
  | { kind: "binding-skipped-seated"; targetId: string }
  | { kind: "archive-kept"; planId: string; name: string };

/**
 * The price list a scheduled change produces against the shop as it is now.
 * Plans and things made after the change was saved stay as they are; a binding
 * for a thing that is gone, or a table someone is seated at, is left alone; a
 * plan the change archives that something kept still uses is not archived.
 */
export function reconcilePricingTarget(input: {
  current: PricingSnapshot & { bindings: PricingBindings };
  target: PricingSnapshot;
  seatedTables?: ReadonlySet<string>;
}): { snapshot: PricingSnapshot & { bindings: PricingBindings }; notes: PricingReconcileNote[] } {
  const notes: PricingReconcileNote[] = [];
  const current = input.current;
  const bindings: PricingBindings = {
    groups: { ...current.bindings.groups },
    resources: { ...current.bindings.resources },
    tables: { ...current.bindings.tables },
  };
  for (const [key, target] of BINDING_KEYS) {
    for (const [targetId, planId] of Object.entries(input.target.bindings?.[key] ?? {})) {
      if (!(targetId in current.bindings[key])) {
        notes.push({ kind: "binding-skipped-missing", target, targetId });
        continue;
      }
      if ((current.bindings[key][targetId] ?? null) === (planId ?? null)) continue;
      if (target === "table" && input.seatedTables?.has(targetId)) {
        notes.push({ kind: "binding-skipped-seated", targetId });
        continue;
      }
      bindings[key][targetId] = planId ?? null;
    }
  }

  const configs = new Map(current.configs.map((config) => [config.id, config]));
  for (const config of input.target.configs) configs.set(config.id, config);
  const live = (config: PricingConfig | undefined) => !!config && (config.status ?? "active") !== "archived";
  // Keeping one plan can keep what it requires, so settle until nothing moves.
  for (let changed = true; changed; ) {
    changed = false;
    const used = new Set<string>();
    for (const [key] of BINDING_KEYS) for (const planId of Object.values(bindings[key])) if (planId) used.add(planId);
    for (const config of configs.values()) if (live(config)) for (const id of relationsOf(config).requires) used.add(id);
    for (const before of current.configs) {
      const next = configs.get(before.id)!;
      if (live(before) && !live(next) && used.has(before.id)) {
        configs.set(before.id, before);
        notes.push({ kind: "archive-kept", planId: before.id, name: before.name });
        changed = true;
      }
    }
  }
  return { snapshot: { configs: [...configs.values()], bindings }, notes };
}

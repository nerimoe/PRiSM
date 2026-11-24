import type { D1BoundStatementLike, D1DatabaseLike } from "@prism/adapter-d1";
import {
  diffPricingSnapshots,
  overlayPricingSnapshot,
  PrismDomainError,
  reconcilePricingTarget,
  relationsOf,
  validatePricingSnapshot,
  type PricingBindings,
  type PricingChangeItem,
  type PricingConfig,
  type PricingReconcileNote,
  type PricingSnapshot,
} from "@prism/core";
import { serializePricingConfigProviderJson, toPricingConfig, type PricingConfigRow } from "@prism/storage-sql";
import { liveSeatsSql } from "./resources/capabilities/table-occupancy.js";
import { logger } from "./log.js";

/**
 * A shop's price list over time: every change to its plans and to which plan
 * each resource group, resource and table uses, applied or scheduled. See
 * docs/pricing-changes.md.
 *
 * Plans are written to `pricing_configs` as before, so the version and release
 * triggers keep doing their work; this module records each change and holds
 * scheduled ones until they are due.
 */

const log = logger("pricing-changes");

export type PricingChangeSource = "edit" | "schedule" | "restore" | "import" | "history";
export type PricingChangeStatus = "pending" | "applied" | "cancelled" | "failed";
export type PricingActor = { id: string; name: string | null } | null;

type ChangeRow = {
  shop_id: string;
  id: string;
  status: PricingChangeStatus;
  source: PricingChangeSource;
  effective_at: string | null;
  applied_at: string | null;
  release_id: string | null;
  bindings_json: string | null;
  target_json: string | null;
  restored_from: string | null;
  notes_json: string | null;
  note: string | null;
  error_code: string | null;
  actor_id: string | null;
  actor_name: string | null;
  created_at: string;
  updated_at: string;
};

type StoredTarget = { configs: PricingConfigRow[]; bindings: PricingBindings };
type CurrentSnapshot = PricingSnapshot & { bindings: PricingBindings };

/** Edits by one person this close together read as one change. */
const MERGE_WINDOW_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Reading the price list

export async function readCurrentSnapshot(db: D1DatabaseLike, shopId: string): Promise<CurrentSnapshot> {
  const [rows, bindings] = await Promise.all([
    db.prepare(
      `SELECT id, kind, name, enabled, status, provider_json, created_at, updated_at
       FROM pricing_configs WHERE shop_id = ? ORDER BY created_at, id`,
    ).bind(shopId).all<PricingConfigRow>(),
    readCurrentBindings(db, shopId),
  ]);
  return { configs: rows.results.map(toPricingConfig), bindings };
}

export async function readCurrentBindings(db: D1DatabaseLike, shopId: string): Promise<PricingBindings> {
  const [groups, resources, tables] = await Promise.all([
    db.prepare("SELECT id, default_pricing_config_id AS plan FROM resource_groups WHERE shop_id = ?")
      .bind(shopId).all<{ id: string; plan: string | null }>(),
    db.prepare("SELECT id, pricing_config_override_id AS plan FROM machines WHERE shop_id = ?")
      .bind(shopId).all<{ id: string; plan: string | null }>(),
    db.prepare(
      `SELECT device_id AS id, json_extract(config_json, '$.pricingConfigIds[0]') AS plan
       FROM device_capabilities WHERE shop_id = ? AND capability = 'table'`,
    ).bind(shopId).all<{ id: string; plan: string | null }>(),
  ]);
  const map = (rows: { id: string; plan: string | null }[]) =>
    Object.fromEntries([...rows].sort((a, b) => a.id.localeCompare(b.id)).map((row) => [row.id, row.plan ?? null]));
  return { groups: map(groups.results), resources: map(resources.results), tables: map(tables.results) };
}

/** Names to show for the things bindings point at, as they are now. */
export async function readBindingNames(db: D1DatabaseLike, shopId: string) {
  const [groups, machines] = await Promise.all([
    db.prepare("SELECT id, name FROM resource_groups WHERE shop_id = ?").bind(shopId).all<{ id: string; name: string }>(),
    db.prepare("SELECT id, name FROM machines WHERE shop_id = ?").bind(shopId).all<{ id: string; name: string }>(),
  ]);
  return {
    groups: Object.fromEntries(groups.results.map((row) => [row.id, row.name])),
    resources: Object.fromEntries(machines.results.map((row) => [row.id, row.name])),
  };
}

function toRow(config: PricingConfig): PricingConfigRow {
  return {
    id: config.id,
    kind: config.kind,
    name: config.name,
    enabled: config.enabled ? 1 : 0,
    status: config.status ?? "active",
    provider_json: JSON.stringify(serializePricingConfigProviderJson(config)),
    created_at: config.createdAt.toISOString(),
    updated_at: config.updatedAt.toISOString(),
  };
}

/** Whether saving `next` over `stored` would change what the version triggers look at. */
function samePlan(stored: PricingConfig | undefined, next: PricingConfig | undefined): boolean {
  if (!stored || !next) return stored === next;
  const a = toRow(stored);
  const b = toRow(next);
  return a.kind === b.kind && a.name === b.name && a.enabled === b.enabled && a.status === b.status
    && a.provider_json === b.provider_json;
}

function sameBindings(a: PricingBindings | null, b: PricingBindings | null): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => x.localeCompare(y)))
      : item);
}

function parseTarget(row: ChangeRow): PricingSnapshot & { bindings: PricingBindings } {
  const stored = JSON.parse(row.target_json ?? '{"configs":[],"bindings":{}}') as StoredTarget;
  return {
    configs: stored.configs.map(toPricingConfig),
    bindings: {
      groups: stored.bindings?.groups ?? {},
      resources: stored.bindings?.resources ?? {},
      tables: stored.bindings?.tables ?? {},
    },
  };
}

function storeTarget(target: PricingSnapshot & { bindings: PricingBindings }): string {
  return JSON.stringify({ configs: target.configs.map(toRow), bindings: target.bindings } satisfies StoredTarget);
}

async function releaseConfigs(db: D1DatabaseLike, shopId: string, releaseIds: string[]): Promise<Map<string, PricingConfig[]>> {
  const result = new Map<string, PricingConfig[]>(releaseIds.map((id) => [id, []]));
  if (!releaseIds.length) return result;
  const rows = await db.prepare(
    `SELECT r.id AS release_id, v.*, v.config_id AS id FROM pricing_releases r
     JOIN pricing_config_versions v ON v.shop_id = r.shop_id
       AND v.version_id IN (SELECT value FROM json_each(r.version_ids_json))
     WHERE r.shop_id = ? AND r.id IN (SELECT value FROM json_each(?))
     ORDER BY v.config_id`,
  ).bind(shopId, JSON.stringify(releaseIds)).all<PricingConfigRow & { release_id: string }>();
  for (const row of rows.results) result.get(row.release_id)?.push(toPricingConfig(row));
  return result;
}

async function pendingRows(db: D1DatabaseLike, shopId: string): Promise<ChangeRow[]> {
  return (await db.prepare(
    "SELECT * FROM pricing_changes WHERE shop_id = ? AND status = 'pending' ORDER BY effective_at, id",
  ).bind(shopId).all<ChangeRow>()).results;
}

async function findChange(db: D1DatabaseLike, shopId: string, id: string): Promise<ChangeRow | null> {
  return db.prepare("SELECT * FROM pricing_changes WHERE shop_id = ? AND id = ?").bind(shopId, id).first<ChangeRow>();
}

/**
 * The price list as it will be at `at`: now, with every scheduled change due
 * before then laid over it in order. `except` leaves out the change being edited.
 */
export async function projectedSnapshot(
  db: D1DatabaseLike,
  shopId: string,
  at: Date,
  except?: string,
): Promise<CurrentSnapshot> {
  let snapshot: CurrentSnapshot = await readCurrentSnapshot(db, shopId);
  for (const row of await pendingRows(db, shopId)) {
    if (row.id === except || new Date(row.effective_at!).getTime() >= at.getTime()) continue;
    snapshot = overlayPricingSnapshot(snapshot, parseTarget(row)) as CurrentSnapshot;
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Recording changes made directly

/**
 * Records the price list as it now stands after a direct edit, unless nothing
 * billing-relevant moved. Several edits by one person within ten minutes are
 * one entry. A record that fails to write is logged and not retried: the next
 * entry compares against the last one written, so the change still shows,
 * only folded into the next.
 */
export async function recordPricingChange(
  db: D1DatabaseLike,
  shopId: string,
  input: { source: Exclude<PricingChangeSource, "schedule" | "history">; actor: PricingActor; restoredFrom?: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  try {
    const [head, bindings, latest] = await Promise.all([
      db.prepare("SELECT release_id FROM pricing_release_heads WHERE shop_id = ?").bind(shopId).first<{ release_id: string }>(),
      readCurrentBindings(db, shopId),
      db.prepare(
        "SELECT * FROM pricing_changes WHERE shop_id = ? AND status = 'applied' ORDER BY applied_at DESC, created_at DESC LIMIT 1",
      ).bind(shopId).first<ChangeRow>(),
    ]);
    const releaseId = head?.release_id ?? null;
    const bindingsJson = JSON.stringify(bindings);
    if (latest && latest.release_id === releaseId && latest.bindings_json) {
      const recorded = JSON.parse(latest.bindings_json) as PricingBindings;
      if (sameBindings(recorded, bindings)) return;
      // Things added or removed (a new resource, a deleted group) are not a
      // price change: the last entry takes them in quietly.
      if (!diffPricingSnapshots({ configs: [], bindings: recorded }, { configs: [], bindings }).length) {
        await db.prepare("UPDATE pricing_changes SET bindings_json = ? WHERE shop_id = ? AND id = ?")
          .bind(bindingsJson, shopId, latest.id).run();
        return;
      }
    }
    const mergeable = latest && input.source === "edit" && latest.source === "edit" && input.actor
      && latest.actor_id === input.actor.id && now.getTime() - new Date(latest.applied_at!).getTime() < MERGE_WINDOW_MS;
    if (mergeable) {
      await db.prepare(
        "UPDATE pricing_changes SET release_id = ?, bindings_json = ?, applied_at = ?, updated_at = ? WHERE shop_id = ? AND id = ?",
      ).bind(releaseId, bindingsJson, now.toISOString(), now.toISOString(), shopId, latest.id).run();
      return;
    }
    await db.prepare(
      `INSERT INTO pricing_changes(shop_id, id, status, source, applied_at, release_id, bindings_json, restored_from,
         actor_id, actor_name, created_at, updated_at)
       VALUES (?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      shopId, crypto.randomUUID(), input.source, now.toISOString(), releaseId, bindingsJson, input.restoredFrom ?? null,
      input.actor?.id ?? null, input.actor?.name ?? null, now.toISOString(), now.toISOString(),
    ).run();
  } catch (error) {
    log.error("record failed: the change folds into the next entry", { shopId, error });
  }
}

/**
 * Before the first recorded change of a shop, the price list as it stands is
 * written down as history, so that change is compared with what it replaced
 * rather than with nothing. Plans made by imports or before this history
 * existed land here.
 */
export async function ensurePricingBaseline(db: D1DatabaseLike, shopId: string, now = new Date()): Promise<void> {
  const [any, head] = await Promise.all([
    db.prepare("SELECT 1 AS found FROM pricing_changes WHERE shop_id = ? AND status = 'applied' LIMIT 1").bind(shopId).first<{ found: number }>(),
    db.prepare("SELECT release_id FROM pricing_release_heads WHERE shop_id = ?").bind(shopId).first<{ release_id: string }>(),
  ]);
  if (any || !head) return;
  const stamp = now.toISOString();
  await db.prepare(
    `INSERT OR IGNORE INTO pricing_changes(shop_id, id, status, source, applied_at, release_id, bindings_json, created_at, updated_at)
     VALUES (?, ?, 'applied', 'history', ?, ?, ?, ?, ?)`,
  ).bind(shopId, `history-${head.release_id}`, stamp, head.release_id, JSON.stringify(await readCurrentBindings(db, shopId)), stamp, stamp).run();
}

/**
 * A direct change to which plan a group, resource or table uses: kept in the
 * history and carried into scheduled changes, like an edit of a plan.
 */
export async function recordBindingEdit<T>(
  db: D1DatabaseLike,
  shopId: string,
  userId: string | null,
  edit: () => Promise<T>,
): Promise<T> {
  await applyDuePricingChanges(db, shopId);
  await ensurePricingBaseline(db, shopId);
  const before = await readCurrentSnapshot(db, shopId);
  const result = await edit();
  await syncDirectEdit(db, shopId, before);
  await recordPricingChange(db, shopId, { source: "edit", actor: await pricingActor(db, shopId, { userId }) });
  return result;
}

export type PricingSyncConflict = { changeId: string; effectiveAt: string; plans: string[]; bindings: string[] };

/**
 * After a direct edit, carries it into every scheduled change that had left
 * the edited plan or binding as it was, so the schedule does not quietly undo
 * it. A schedule that changes the same thing keeps its own value and is
 * reported; so is one the edit would make invalid.
 */
export async function syncDirectEdit(
  db: D1DatabaseLike,
  shopId: string,
  before: CurrentSnapshot,
  now = new Date(),
): Promise<PricingSyncConflict[]> {
  const pending = await pendingRows(db, shopId);
  if (!pending.length) return [];
  const after = await readCurrentSnapshot(db, shopId);
  const beforePlans = new Map(before.configs.map((config) => [config.id, config]));
  const changedPlans = after.configs.filter((config) => beforePlans.has(config.id) && !samePlan(beforePlans.get(config.id), config));
  const changedBindings: Array<[keyof PricingBindings, string]> = [];
  for (const key of ["groups", "resources", "tables"] as const)
    for (const [id, plan] of Object.entries(after.bindings[key]))
      if (id in before.bindings[key] && (before.bindings[key][id] ?? null) !== plan) changedBindings.push([key, id]);
  if (!changedPlans.length && !changedBindings.length) return [];

  const conflicts: PricingSyncConflict[] = [];
  const statements: D1BoundStatementLike[] = [];
  let base: CurrentSnapshot = after;
  for (const row of pending) {
    const target = parseTarget(row);
    const plans = new Map(target.configs.map((config) => [config.id, config]));
    const conflict: PricingSyncConflict = { changeId: row.id, effectiveAt: row.effective_at!, plans: [], bindings: [] };
    const synced = { configs: new Map(plans), bindings: structuredClone(target.bindings) };
    for (const config of changedPlans) {
      const held = plans.get(config.id);
      if (!held) continue;
      if (samePlan(held, beforePlans.get(config.id))) synced.configs.set(config.id, config);
      else conflict.plans.push(config.name);
    }
    for (const [key, id] of changedBindings) {
      if (!(id in target.bindings[key])) continue;
      if ((target.bindings[key][id] ?? null) === (before.bindings[key][id] ?? null)) synced.bindings[key][id] = after.bindings[key][id] ?? null;
      else conflict.bindings.push(id);
    }
    const next = { configs: [...synced.configs.values()], bindings: synced.bindings };
    let kept = next;
    try {
      validatePricingSnapshot(overlayPricingSnapshot(base, next));
    } catch {
      kept = target;
      conflict.plans = [...new Set([...conflict.plans, ...changedPlans.filter((config) => plans.has(config.id)).map((config) => config.name)])];
    }
    if (kept === next && canonical(next) !== canonical(target)) {
      statements.push(db.prepare("UPDATE pricing_changes SET target_json = ?, updated_at = ? WHERE shop_id = ? AND id = ? AND status = 'pending'")
        .bind(storeTarget(next), now.toISOString(), shopId, row.id));
    }
    if (conflict.plans.length || conflict.bindings.length) conflicts.push(conflict);
    base = overlayPricingSnapshot(base, kept) as CurrentSnapshot;
  }
  if (statements.length) await db.batch(statements);
  return conflicts;
}

/** Scheduled changes that bind or require `planId`, for refusing to archive it. */
export async function pendingPlanUsers(db: D1DatabaseLike, shopId: string, planId: string, timeZone: string): Promise<string[]> {
  const users: string[] = [];
  for (const row of await pendingRows(db, shopId)) {
    const target = parseTarget(row);
    const own = target.configs.find((config) => config.id === planId);
    if (own && (own.status ?? "active") === "archived") continue;
    const bound = Object.values(target.bindings).some((map) => Object.values(map).includes(planId));
    const required = target.configs.some((config) => (config.status ?? "active") !== "archived" && relationsOf(config).requires.includes(planId));
    if (bound || required) users.push(`${formatLocal(row.effective_at!, timeZone)} 的调价计划`);
  }
  return users;
}

function formatLocal(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// ---------------------------------------------------------------------------
// Scheduled changes

export type PricingChangeDraft = {
  /** Plans the editor changed or created, already normalized for storage. */
  configs: PricingConfig[];
  /** Bindings the editor set; the rest stay as in the base. */
  bindings: Partial<PricingBindings>;
};

/**
 * Saves a scheduled change (or one applied right away when `effectiveAt` is
 * null). The stored target is the whole price list at that moment: the base
 * (what will be in place by then, or the change's own target when it is being
 * edited) with the draft laid over it. It has to bill on its own, and every
 * later scheduled change has to still hold on top of it.
 */
export async function savePricingChange(
  db: D1DatabaseLike,
  shopId: string,
  input: {
    id?: string;
    effectiveAt: Date | null;
    draft: PricingChangeDraft;
    note?: string | null;
    actor: PricingActor;
    source?: "edit" | "schedule" | "restore";
    restoredFrom?: string | null;
    /** The shop's zone, for naming a later change in an error. */
    timeZone?: string;
    now?: Date;
  },
): Promise<{ id: string; status: PricingChangeStatus; pendingConflicts: PricingSyncConflict[] }> {
  const now = input.now ?? new Date();
  // What is already due goes first, so this change is laid over the price list
  // that is really in place.
  await applyDuePricingChanges(db, shopId, now, true);
  const immediate = input.effectiveAt === null;
  const effectiveAt = input.effectiveAt ?? now;
  if (!immediate && effectiveAt.getTime() <= now.getTime())
    throw new PrismDomainError("生效时间需要晚于现在。", "PRICING_CHANGE_IN_PAST");
  const existing = input.id ? await findChange(db, shopId, input.id) : null;
  if (input.id && !existing) throw new PrismDomainError("没有找到这个调价计划。", "PRICING_CHANGE_NOT_FOUND");
  if (existing && existing.status !== "pending")
    throw new PrismDomainError("这个调价计划已经生效或取消，不能再修改。", "PRICING_CHANGE_NOT_PENDING");
  const pending = await pendingRows(db, shopId);
  const taken = pending.find((row) => row.id !== existing?.id && new Date(row.effective_at!).getTime() === effectiveAt.getTime());
  if (taken) throw new PrismDomainError("这个时刻已经有一个调价计划。", "PRICING_CHANGE_TIME_TAKEN");

  const base = existing ? overlayPricingSnapshot(await projectedSnapshot(db, shopId, effectiveAt, existing.id), parseTarget(existing)) as CurrentSnapshot
    : await projectedSnapshot(db, shopId, effectiveAt);
  const target = overlayPricingSnapshot(base, {
    configs: input.draft.configs,
    bindings: {
      groups: input.draft.bindings.groups ?? {},
      resources: input.draft.bindings.resources ?? {},
      tables: input.draft.bindings.tables ?? {},
    },
  }) as CurrentSnapshot;
  validatePricingSnapshot(target);
  // Later versions are built on this one: what they left as it was follows
  // this change, what they changed themselves stays theirs and is reported.
  const carried = new Map<string, CurrentSnapshot>();
  const pendingConflicts: PricingSyncConflict[] = [];
  let chain: PricingSnapshot = target;
  for (const later of pending) {
    if (later.id === existing?.id || new Date(later.effective_at!).getTime() <= effectiveAt.getTime()) continue;
    const laterTarget = parseTarget(later);
    const { next, conflict } = carryForward(base, target, laterTarget, later.id, later.effective_at!);
    if (canonical(next) !== canonical(laterTarget)) carried.set(later.id, next);
    if (conflict.plans.length || conflict.bindings.length) pendingConflicts.push(conflict);
    chain = overlayPricingSnapshot(chain, next);
    try {
      validatePricingSnapshot(chain);
    } catch (error) {
      throw new PrismDomainError(
        `这样保存后，${formatLocal(later.effective_at!, input.timeZone ?? "UTC")} 的调价计划会无法生效：${(error as Error).message}`,
        "PRICING_CHANGE_BREAKS_LATER",
      );
    }
  }

  const id = existing?.id ?? crypto.randomUUID();
  const stamp = now.toISOString();
  if (existing) {
    await db.prepare(
      "UPDATE pricing_changes SET effective_at = ?, target_json = ?, note = ?, updated_at = ? WHERE shop_id = ? AND id = ? AND status = 'pending'",
    ).bind(effectiveAt.toISOString(), storeTarget(target), input.note === undefined ? existing.note : input.note, stamp, shopId, id).run();
  } else {
    await db.prepare(
      `INSERT INTO pricing_changes(shop_id, id, status, source, effective_at, target_json, restored_from, note,
         actor_id, actor_name, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      shopId, id, input.source ?? (immediate ? "edit" : "schedule"), effectiveAt.toISOString(), storeTarget(target), input.restoredFrom ?? null,
      input.note ?? null, input.actor?.id ?? null, input.actor?.name ?? null, stamp, stamp,
    ).run();
  }
  for (const [laterId, next] of carried) {
    await db.prepare("UPDATE pricing_changes SET target_json = ?, updated_at = ? WHERE shop_id = ? AND id = ? AND status = 'pending'")
      .bind(storeTarget(next), stamp, shopId, laterId).run();
  }
  forgetPricingChangeSchedule(db, shopId);
  if (immediate) return { id, status: await applyPricingChange(db, shopId, id, now), pendingConflicts };
  return { id, status: "pending", pendingConflicts };
}

/**
 * A later version after an earlier one changed from `before` to `after`:
 * every plan and binding the later one still held as `before` had it takes
 * the new value; those it changed itself keep theirs and are reported.
 */
function carryForward(
  before: CurrentSnapshot,
  after: CurrentSnapshot,
  later: PricingSnapshot & { bindings: PricingBindings },
  laterId: string,
  laterEffectiveAt: string,
): { next: CurrentSnapshot; conflict: PricingSyncConflict } {
  const was = new Map(before.configs.map((config) => [config.id, config]));
  const conflict: PricingSyncConflict = { changeId: laterId, effectiveAt: laterEffectiveAt, plans: [], bindings: [] };
  const configs = later.configs.map((config) => {
    const old = was.get(config.id);
    const now = after.configs.find((candidate) => candidate.id === config.id);
    if (!old || !now || samePlan(old, now)) return config;
    if (samePlan(config, old)) return now;
    conflict.plans.push(now.name);
    return config;
  });
  const bindings = structuredClone(later.bindings);
  for (const key of ["groups", "resources", "tables"] as const) {
    for (const [id, plan] of Object.entries(after.bindings[key])) {
      const old = before.bindings[key][id] ?? null;
      if (old === (plan ?? null) || !(id in bindings[key])) continue;
      if ((bindings[key][id] ?? null) === old) bindings[key][id] = plan ?? null;
      else conflict.bindings.push(id);
    }
  }
  return { next: { configs, bindings }, conflict };
}

export async function cancelPricingChange(db: D1DatabaseLike, shopId: string, id: string, now = new Date()): Promise<void> {
  const row = await findChange(db, shopId, id);
  if (!row) throw new PrismDomainError("没有找到这个调价计划。", "PRICING_CHANGE_NOT_FOUND");
  if (row.status !== "pending" && row.status !== "failed")
    throw new PrismDomainError("这个调价计划已经生效或取消。", "PRICING_CHANGE_NOT_PENDING");
  await db.prepare("UPDATE pricing_changes SET status = 'cancelled', updated_at = ? WHERE shop_id = ? AND id = ? AND status IN ('pending', 'failed')")
    .bind(now.toISOString(), shopId, id).run();
  forgetPricingChangeSchedule(db, shopId);
}

/** Moves a scheduled change to now and applies it. */
export async function applyPricingChangeNow(db: D1DatabaseLike, shopId: string, id: string, now = new Date()): Promise<PricingChangeStatus> {
  const row = await findChange(db, shopId, id);
  if (!row) throw new PrismDomainError("没有找到这个调价计划。", "PRICING_CHANGE_NOT_FOUND");
  if (row.status !== "pending") throw new PrismDomainError("这个调价计划已经生效或取消。", "PRICING_CHANGE_NOT_PENDING");
  // Anything scheduled before it goes first, so the order stays the one shown.
  for (const earlier of await pendingRows(db, shopId)) {
    if (earlier.id === id) break;
    await applyPricingChange(db, shopId, earlier.id, now);
  }
  await db.prepare("UPDATE pricing_changes SET effective_at = ? WHERE shop_id = ? AND id = ? AND status = 'pending'")
    .bind(now.toISOString(), shopId, id).run();
  return applyPricingChange(db, shopId, id, now);
}

/**
 * Puts a scheduled change in place, in one batch: its plans, its bindings, and
 * the entry marked applied. Safe to run twice; plans already as the change has
 * them are not written again, so no new version is made for them.
 */
export async function applyPricingChange(db: D1DatabaseLike, shopId: string, id: string, now = new Date()): Promise<PricingChangeStatus> {
  const row = await findChange(db, shopId, id);
  if (!row || row.status !== "pending") return row?.status ?? "cancelled";
  await ensurePricingBaseline(db, shopId, new Date(now.getTime() - 1));
  const [current, seated] = await Promise.all([
    readCurrentSnapshot(db, shopId),
    db.prepare(`SELECT DISTINCT machine_id AS id FROM (${liveSeatsSql}) WHERE shop_id = ?`).bind(shopId).all<{ id: string }>(),
  ]);
  const { snapshot, notes } = reconcilePricingTarget({
    current,
    target: parseTarget(row),
    seatedTables: new Set(seated.results.map((seat) => seat.id)),
  });
  const stamp = now.toISOString();
  try {
    validatePricingSnapshot(snapshot);
  } catch (error) {
    const code = error instanceof PrismDomainError ? error.code : "PRICING_CHANGE_INVALID";
    log.warn("scheduled change could not apply", { shopId, changeId: id, code, error });
    await db.prepare("UPDATE pricing_changes SET status = 'failed', error_code = ?, notes_json = ?, updated_at = ? WHERE shop_id = ? AND id = ? AND status = 'pending'")
      .bind(code, JSON.stringify([{ kind: "error", message: (error as Error).message }]), stamp, shopId, id).run();
    return "failed";
  }

  const statements: D1BoundStatementLike[] = [];
  const currentPlans = new Map(current.configs.map((config) => [config.id, config]));
  for (const config of snapshot.configs) {
    const stored = currentPlans.get(config.id);
    if (!stored && (config.status ?? "active") === "archived") continue;
    if (samePlan(stored, config)) continue;
    const next = toRow({ ...config, createdAt: stored?.createdAt ?? config.createdAt, updatedAt: now });
    statements.push(db.prepare(
      `INSERT INTO pricing_configs (shop_id, id, kind, name, enabled, status, provider_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(shop_id, id) DO UPDATE SET kind = excluded.kind, name = excluded.name, enabled = excluded.enabled,
         status = excluded.status, provider_json = excluded.provider_json, updated_at = excluded.updated_at`,
    ).bind(shopId, next.id, next.kind, next.name, next.enabled, next.status ?? "active", next.provider_json, next.created_at, next.updated_at));
  }
  for (const [groupId, plan] of Object.entries(snapshot.bindings.groups)) {
    if ((current.bindings.groups[groupId] ?? null) === plan) continue;
    statements.push(db.prepare("UPDATE resource_groups SET default_pricing_config_id = ?, updated_at = ? WHERE shop_id = ? AND id = ?")
      .bind(plan, stamp, shopId, groupId));
  }
  for (const [resourceId, plan] of Object.entries(snapshot.bindings.resources)) {
    if ((current.bindings.resources[resourceId] ?? null) === plan) continue;
    statements.push(db.prepare("UPDATE machines SET pricing_config_override_id = ?, updated_at = ? WHERE shop_id = ? AND id = ?")
      .bind(plan, stamp, shopId, resourceId));
  }
  for (const [tableId, plan] of Object.entries(snapshot.bindings.tables)) {
    if ((current.bindings.tables[tableId] ?? null) === plan) continue;
    statements.push(db.prepare(
      `UPDATE device_capabilities SET config_json = json_set(config_json, '$.pricingConfigIds', json(?)), updated_at = ?
       WHERE shop_id = ? AND device_id = ? AND capability = 'table'`,
    ).bind(JSON.stringify(plan ? [plan] : []), stamp, shopId, tableId));
  }
  statements.push(db.prepare(
    `UPDATE pricing_changes SET status = 'applied', applied_at = ?,
       release_id = (SELECT release_id FROM pricing_release_heads WHERE shop_id = ?),
       bindings_json = ?, target_json = NULL, notes_json = ?, updated_at = ?
     WHERE shop_id = ? AND id = ? AND status = 'pending'`,
  ).bind(stamp, shopId, JSON.stringify(snapshot.bindings), notes.length ? JSON.stringify(notes) : null, stamp, shopId, id));
  await db.batch(statements);
  log.info("scheduled change applied", { shopId, changeId: id, plans: statements.length - 1, notes: notes.length });
  return "applied";
}

/**
 * Applies every scheduled change of this shop that is due, oldest first. Run
 * before anything starts billing, so a player who enters after the moment is
 * always on the new prices whether or not a timer fired.
 */
export async function applyDuePricingChanges(
  db: D1DatabaseLike,
  shopId: string,
  now = new Date(),
  /** Read the schedule even if it was read moments ago (the sweep, saving a change). */
  fresh = false,
): Promise<number> {
  const at = now.getTime();
  const nextDue = nextDueOf(db);
  const known = nextDue.get(shopId);
  if (!fresh && known && at < known.until && at < known.next) return 0;
  const soonest = await db.prepare(
    "SELECT MIN(effective_at) AS next FROM pricing_changes WHERE shop_id = ? AND status = 'pending'",
  ).bind(shopId).first<{ next: string | null }>();
  const next = soonest?.next ? new Date(soonest.next).getTime() : Number.POSITIVE_INFINITY;
  if (next > at) {
    nextDue.set(shopId, { next, until: at + DUE_CHECK_TTL_MS });
    return 0;
  }
  nextDue.delete(shopId);
  const due = await db.prepare(
    "SELECT id FROM pricing_changes WHERE shop_id = ? AND status = 'pending' AND effective_at <= ? ORDER BY effective_at, id",
  ).bind(shopId, now.toISOString()).all<{ id: string }>();
  for (const row of due.results) await applyPricingChange(db, shopId, row.id, now);
  return due.results.length;
}

/**
 * When each shop's next scheduled change is due, as last read here, so the
 * check before every billing read costs nothing between changes. A change
 * saved in another isolate is seen within the TTL; one saved here clears it.
 */
let nextDueByDb = new WeakMap<D1DatabaseLike, Map<string, { next: number; until: number }>>();
const DUE_CHECK_TTL_MS = 30_000;

function nextDueOf(db: D1DatabaseLike) {
  let known = nextDueByDb.get(db);
  if (!known) nextDueByDb.set(db, known = new Map());
  return known;
}

/** Forgets one shop's known schedule, or (no arguments) every one. */
export function forgetPricingChangeSchedule(db?: D1DatabaseLike, shopId?: string): void {
  if (db && shopId) nextDueOf(db).delete(shopId);
  else nextDueByDb = new WeakMap();
}

/** The cron sweep: every shop's due changes. */
export async function applyAllDuePricingChanges(db: D1DatabaseLike, now = new Date()): Promise<void> {
  const shops = await db.prepare(
    "SELECT DISTINCT shop_id FROM pricing_changes WHERE status = 'pending' AND effective_at <= ?",
  ).bind(now.toISOString()).all<{ shop_id: string }>();
  for (const { shop_id } of shops.results) {
    try {
      await applyDuePricingChanges(db, shop_id, now, true);
    } catch (error) {
      log.error("sweep failed for a shop", { shopId: shop_id, error });
    }
  }
}

// ---------------------------------------------------------------------------
// The timeline

export type PricingTimelineEntry = {
  id: string;
  status: PricingChangeStatus;
  source: PricingChangeSource;
  effectiveAt: string | null;
  appliedAt: string | null;
  actorName: string | null;
  note: string | null;
  restoredFrom: string | null;
  errorCode: string | null;
  notes: Array<PricingReconcileNote | { kind: "error"; message: string }>;
  /** Null when the bindings before this entry were never recorded. */
  bindingsRecorded: boolean;
  items: PricingChangeItem[];
  /** Players whose unsettled bill still runs on this entry's prices. */
  playersOnIt: number;
};

function entryOf(row: ChangeRow, items: PricingChangeItem[], playersOnIt: number): PricingTimelineEntry {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    effectiveAt: row.effective_at,
    appliedAt: row.applied_at,
    actorName: row.actor_name,
    note: row.note,
    restoredFrom: row.restored_from,
    errorCode: row.error_code,
    notes: row.notes_json ? JSON.parse(row.notes_json) : [],
    bindingsRecorded: row.status === "pending" || !!row.bindings_json,
    items,
    playersOnIt,
  };
}

/**
 * Scheduled changes (soonest first, each compared with the price list it will
 * replace) and a page of applied ones (newest first, each compared with the
 * entry before it).
 */
export async function pricingTimeline(
  db: D1DatabaseLike,
  shopId: string,
  input: { before?: string; limit?: number } = {},
): Promise<{ pending: PricingTimelineEntry[]; applied: PricingTimelineEntry[]; nextBefore: string | null; failed: PricingTimelineEntry[] }> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const before = input.before ?? "9999";
  const [appliedRows, failedRows, pending, current] = await Promise.all([
    db.prepare(
      "SELECT * FROM pricing_changes WHERE shop_id = ? AND status = 'applied' AND applied_at < ? ORDER BY applied_at DESC, created_at DESC LIMIT ?",
    ).bind(shopId, before, limit + 1).all<ChangeRow>(),
    input.before ? Promise.resolve({ results: [] as ChangeRow[] }) : db.prepare(
      "SELECT * FROM pricing_changes WHERE shop_id = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 5",
    ).bind(shopId).all<ChangeRow>(),
    input.before ? Promise.resolve([] as ChangeRow[]) : pendingRows(db, shopId),
    readCurrentSnapshot(db, shopId),
  ]);
  const rows = appliedRows.results;
  const releases = await releaseConfigs(db, shopId, [...new Set(rows.map((row) => row.release_id).filter((id): id is string => !!id))]);
  const players = await db.prepare(
    `SELECT b.release_id, COUNT(DISTINCT s.player_id) AS n FROM session_pricing_releases b
     JOIN sessions s ON s.shop_id = b.shop_id AND s.id = b.session_id
     WHERE b.shop_id = ? AND s.payment_status = 'unpaid' GROUP BY b.release_id`,
  ).bind(shopId).all<{ release_id: string; n: number }>();
  const onRelease = new Map(players.results.map((row) => [row.release_id, row.n]));
  const snapshotOf = (row: ChangeRow | undefined): PricingSnapshot | null => row
    ? { configs: releases.get(row.release_id ?? "") ?? [], bindings: row.bindings_json ? JSON.parse(row.bindings_json) : null }
    : null;

  const applied: PricingTimelineEntry[] = [];
  for (let index = 0; index < Math.min(rows.length, limit); index += 1) {
    const row = rows[index]!;
    const previous = rows[index + 1];
    // `limit + 1` rows were read, so a row without a successor here has none at all.
    const prior = snapshotOf(previous);
    applied.push(entryOf(row, diffPricingSnapshots(prior, snapshotOf(row)!), onRelease.get(row.release_id ?? "") ?? 0));
  }
  let base: CurrentSnapshot = current;
  const upcoming: PricingTimelineEntry[] = [];
  for (const row of pending) {
    const target = parseTarget(row);
    const next = overlayPricingSnapshot(base, target) as CurrentSnapshot;
    upcoming.push(entryOf(row, diffPricingSnapshots(base, next), 0));
    base = next;
  }
  return {
    pending: upcoming,
    applied,
    failed: failedRows.results.map((row) => entryOf(row, [], 0)),
    nextBefore: rows.length > limit ? rows[limit - 1]!.applied_at : null,
  };
}

async function previousSnapshot(db: D1DatabaseLike, shopId: string, row: ChangeRow): Promise<PricingSnapshot | null> {
  const previous = await db.prepare(
    "SELECT * FROM pricing_changes WHERE shop_id = ? AND status = 'applied' AND (applied_at < ? OR (applied_at = ? AND created_at < ?)) ORDER BY applied_at DESC, created_at DESC LIMIT 1",
  ).bind(shopId, row.applied_at, row.applied_at, row.created_at).first<ChangeRow>();
  if (!previous) return null;
  const configs = (await releaseConfigs(db, shopId, previous.release_id ? [previous.release_id] : [])).get(previous.release_id ?? "") ?? [];
  return { configs, bindings: previous.bindings_json ? JSON.parse(previous.bindings_json) : null };
}

/**
 * One entry in full: the price list it produced (or, scheduled, will produce)
 * and what changed against the one before.
 */
export async function pricingChangeDetail(db: D1DatabaseLike, shopId: string, id: string): Promise<{
  entry: PricingTimelineEntry;
  snapshot: PricingSnapshot;
}> {
  const row = await findChange(db, shopId, id);
  if (!row) throw new PrismDomainError("没有找到这条修改记录。", "PRICING_CHANGE_NOT_FOUND");
  if (row.status === "pending" || row.status === "failed" || row.status === "cancelled") {
    const base = row.status === "pending"
      ? await projectedSnapshot(db, shopId, new Date(row.effective_at!), row.id)
      : await readCurrentSnapshot(db, shopId);
    const snapshot = row.target_json ? overlayPricingSnapshot(base, parseTarget(row)) : base;
    return { entry: entryOf(row, diffPricingSnapshots(base, snapshot), 0), snapshot };
  }
  const configs = (await releaseConfigs(db, shopId, row.release_id ? [row.release_id] : [])).get(row.release_id ?? "") ?? [];
  const snapshot: PricingSnapshot = { configs, bindings: row.bindings_json ? JSON.parse(row.bindings_json) : null };
  const players = await db.prepare(
    `SELECT COUNT(DISTINCT s.player_id) AS n FROM session_pricing_releases b JOIN sessions s ON s.shop_id = b.shop_id AND s.id = b.session_id
     WHERE b.shop_id = ? AND b.release_id = ? AND s.payment_status = 'unpaid'`,
  ).bind(shopId, row.release_id).first<{ n: number }>();
  return { entry: entryOf(row, diffPricingSnapshots(await previousSnapshot(db, shopId, row), snapshot), players?.n ?? 0), snapshot };
}

/**
 * A draft that brings back the price list of an entry: its plans as they were,
 * plans made since then archived (unless something kept still uses them), and
 * its bindings for the things that still exist. History recorded without
 * bindings keeps the current ones.
 */
export async function restoreDraft(db: D1DatabaseLike, shopId: string, id: string): Promise<PricingSnapshot & { bindings: PricingBindings }> {
  const { snapshot } = await pricingChangeDetail(db, shopId, id);
  const current = await readCurrentSnapshot(db, shopId);
  const then = new Set(snapshot.configs.map((config) => config.id));
  const bindings: PricingBindings = structuredClone(current.bindings);
  if (snapshot.bindings) {
    for (const key of ["groups", "resources", "tables"] as const)
      for (const [thing, plan] of Object.entries(snapshot.bindings[key]))
        if (thing in bindings[key]) bindings[key][thing] = plan;
  }
  const used = new Set(Object.values(bindings).flatMap((map) => Object.values(map)).filter((plan): plan is string => !!plan));
  const later = current.configs
    .filter((config) => !then.has(config.id))
    .map((config) => used.has(config.id) || (config.status ?? "active") === "archived"
      ? config
      : { ...config, enabled: false, status: "archived" as const });
  return { configs: [...snapshot.configs, ...later], bindings };
}

/** Who made a change, for the timeline. */
export async function pricingActor(
  db: D1DatabaseLike,
  shopId: string,
  who: { userId?: string | null; staffId?: string | null },
): Promise<PricingActor> {
  if (who.userId) {
    const row = await db.prepare(
      "SELECT display_name AS name FROM auth_identities WHERE user_id = ? AND display_name IS NOT NULL ORDER BY last_login_at DESC LIMIT 1",
    ).bind(who.userId).first<{ name: string }>().catch(() => null);
    return { id: `user:${who.userId}`, name: row?.name ?? null };
  }
  if (who.staffId) {
    const row = await db.prepare("SELECT display_name AS name FROM staff_users WHERE shop_id = ? AND id = ?")
      .bind(shopId, who.staffId).first<{ name: string }>().catch(() => null);
    return { id: `staff:${who.staffId}`, name: row?.name ?? null };
  }
  return null;
}

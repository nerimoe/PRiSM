import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, Calculator, Layers, Network, Pencil, Plus, Save, Unplug } from "lucide-react";
import { Api, type Resource, type ResourceGroup } from "../../api";
import { useI18n } from "../../i18n";
import { displayDateTime } from "../bill-time";
import { planColor } from "../plan-colors";
import { BillingManualButton } from "./BillingExplainer";
import { BillingSimulator } from "./BillingSimulator";
import { PlanDetail } from "./PlanDetail";
import { PlanRelationGraph } from "./PlanRelationGraph";
import { PricingEditor, kinds, newRule, type PendingConflict, type Pricing } from "./Pricing";
import {
  findChange,
  usePricingChanges,
  usersOfPlan,
  type PricingBindingsView,
  type PricingChangeEntry,
  type PricingNames,
} from "./PricingChanges";
import {
  VersionBanner,
  VersionBar,
  VersionTimeDialog,
  localInput,
  tomorrowMidnight,
  versionMarks,
  versionMode,
  type VersionRef,
} from "./PricingVersions";
import { useResourceGroups } from "./ResourceGroups";
import { hasResourceLink, resourceCapabilities } from "./resource-capabilities";
import {
  buildPricingBindingTree,
  effectiveResourcePlan,
  resolveResourceGroup,
} from "./resource-group-grouping";
import {
  State,
  buttonQuiet,
  input,
  money,
  primary,
  segment,
  useMerchant,
  useResource,
  useStaffApi,
} from "./shared";

/**
 * The pricing page: one workbench for the price list, version by version.
 * The bar on top picks the version (now, a scheduled one, or one that has
 * passed); edits to rules and bindings are staged locally and committed in one
 * master Save so multi-rule edits produce a single atomic change. See
 * docs/pricing-changes.md.
 */

type Tab = "plans" | "bindings";
type Pick =
  | { kind: "plan"; id: string }
  | { kind: "relations" }
  | { kind: "simulator" }
  | { kind: "binding"; key: BindingKey };
type BindingSection = "groups" | "resources" | "tables";
type BindingKey = `${BindingSection}:${string}`;
type Snapshot = { configs: Pricing[]; bindings: PricingBindingsView | null };

const listAction =
  "focus-ring inline-flex min-h-8 items-center gap-1 whitespace-nowrap rounded-lg border border-mint/25 bg-mint/10 px-2.5 text-xs font-medium text-mint transition-colors hover:bg-mint/15";

/** Oldest first, so a save neither moves a rule nor changes its color, which follows its place. */
const byAge = (plans: Pricing[]) =>
  [...plans].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.name.localeCompare(b.name));

/** Canonical shape of a plan for comparing staged edits against the saved snapshot. */
function planKey(plan: Pricing): string {
  const provider = { ...plan.provider, timeZone: plan.provider.timeZone ?? "UTC" };
  return JSON.stringify({
    kind: plan.kind,
    name: plan.name,
    enabled: plan.enabled,
    status: plan.status === "archived" ? "archived" : "active",
    provider,
    ...(plan.kind === "time.priority"
      ? {
          relations: {
            requires: [...(plan.relations?.requires ?? [])].sort(),
            conflicts: [...(plan.relations?.conflicts ?? [])].sort(),
          },
        }
      : {}),
  });
}

function planPayload(plan: Pricing) {
  return {
    id: plan.id,
    kind: plan.kind,
    name: plan.name,
    enabled: plan.enabled,
    status: plan.status === "archived" ? "archived" : "active",
    provider: { ...plan.provider, timeZone: plan.provider.timeZone ?? "UTC" },
    ...(plan.kind === "time.priority" ? { relations: plan.relations ?? { requires: [], conflicts: [] } } : {}),
  };
}

function diffStaged(saved: Snapshot | null, draft: Snapshot | null) {
  const plans: Pricing[] = [];
  const planIds = new Set<string>();
  const bindings: Record<BindingSection, Record<string, string | null>> = { groups: {}, resources: {}, tables: {} };
  const bindingKeys = new Set<BindingKey>();
  if (!saved || !draft) return { plans, planIds, bindings, bindingKeys, count: 0 };

  const savedById = new Map(saved.configs.map((plan) => [plan.id, plan]));
  for (const plan of draft.configs) {
    const prev = savedById.get(plan.id);
    if (!prev || planKey(prev) !== planKey(plan)) {
      plans.push(plan);
      planIds.add(plan.id);
    }
  }
  for (const section of ["groups", "resources", "tables"] as const) {
    const baseMap = saved.bindings?.[section] ?? {};
    const nextMap = draft.bindings?.[section] ?? {};
    for (const [id, plan] of Object.entries(nextMap)) {
      if ((baseMap[id] ?? null) !== (plan ?? null)) {
        bindings[section][id] = plan ?? null;
        bindingKeys.add(`${section}:${id}`);
      }
    }
  }
  return { plans, planIds, bindings, bindingKeys, count: plans.length + bindingKeys.size };
}

export function PricingPage() {
  const { t } = useI18n();
  const { canWrite, shopCode, shopId, owner } = useMerchant();
  const request = useStaffApi();
  const resourceGroups = useResourceGroups(shopId);
  const [machines, setMachines] = useState<Resource[] | null>(null);
  const loadMachines = useCallback(() => {
    if (!shopId) {
      setMachines([]);
      return Promise.resolve();
    }
    return Api.machines(shopId)
      .then((result) => setMachines(result.machines ?? []))
      .catch(() => setMachines([]));
  }, [shopId]);
  useEffect(() => {
    setMachines(null);
    void loadMachines();
  }, [loadMachines]);
  const resource = useResource<{ pricingConfigs: Pricing[] }>("pricing-configs");
  const changes = usePricingChanges(resource.reload);
  const [params] = useSearchParams();
  const [version, setVersion] = useState<VersionRef>({ kind: "now" });
  const [tab, setTab] = useState<Tab>("plans");
  const [pick, setPick] = useState<Pick | null>(() => (params.get("simulate") === "1" ? { kind: "simulator" } : null));
  const [draft, setDraft] = useState<Snapshot | null>(null);
  const [edit, setEdit] = useState<Pricing | null>(null);
  const [conflicts, setConflicts] = useState<PendingConflict[]>([]);
  const [dialog, setDialog] = useState<"add" | "time" | "copy" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const zone = changes.zone;

  // The version shown: now, or a change that is still listed.
  const entry: PricingChangeEntry | null = version.kind === "change" ? findChange(changes, version.id) : null;
  const shown: VersionRef = version.kind === "change" && !entry && changes.data ? { kind: "now" } : version;
  const mode = versionMode(shown.kind === "now" ? null : entry);
  const detail = useResource<{ entry: PricingChangeEntry; snapshot: Snapshot; names: PricingNames }>(
    shown.kind === "change" ? `pricing-configs/changes/${segment(shown.id)}` : null,
  );
  const snapshot: Snapshot | null = shown.kind === "now"
    ? resource.data ? { configs: resource.data.pricingConfigs, bindings: changes.data ? changes.bindings : null } : null
    : detail.data?.snapshot ?? null;
  const working: Snapshot | null = draft ?? snapshot;
  const staged = useMemo(() => diffStaged(snapshot, draft), [snapshot, draft]);
  const dirty = staged.count > 0;

  // Warn before leaving the browser tab when staged edits or an open rule form would be lost.
  useEffect(() => {
    if (!dirty && !edit) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty, edit]);

  const all = useMemo(() => byAge(working?.configs ?? []), [working?.configs]);
  const names: PricingNames = useMemo(() => ({
    plans: {
      ...changes.names.plans,
      ...(detail.data?.names.plans ?? {}),
      ...Object.fromEntries(all.map((plan) => [plan.id, plan.name])),
    },
    groups: { ...changes.names.groups, ...(detail.data?.names.groups ?? {}) },
    resources: { ...changes.names.resources, ...(detail.data?.names.resources ?? {}) },
  }), [changes.names, detail.data?.names, all]);
  const bindings = working?.bindings ?? null;
  const editable = canWrite && (mode === "now" || mode === "future");
  const versionItems = mode === "now" ? [] : detail.data?.entry?.items ?? entry?.items ?? [];
  const marks = versionMarks(versionItems);
  // Each version only shows the rules that exist in that version (removed
  // rules are stored as `archived` underneath to preserve bill references).
  const rows = all.filter((row) => row.status !== "archived");
  const timePlans = rows.filter((row) => row.kind === "time.priority");
  /** Groups as this version (including staged edits) binds them, for the relation graph and resource grouping. */
  const versionGroups: ResourceGroup[] = (resourceGroups.groups ?? []).map((group) => ({
    ...group,
    defaultPricingConfigId:
      bindings?.groups && group.id in bindings.groups
        ? (bindings.groups[group.id] ?? null)
        : group.defaultPricingConfigId,
  }));

  const reloadAll = () => {
    resource.reload();
    changes.reload();
    detail.reload();
    void loadMachines();
  };

  /** Guard leaving an open rule editor (keeps version-level staged draft intact). */
  const leaveEditor = (then: () => void) => {
    if (edit && !window.confirm(t("放弃当前方案的未保存编辑？"))) return;
    setEdit(null);
    then();
  };

  /** Guard switching versions when either a rule editor is open or the version has staged edits. */
  const leaveVersion = (then: () => void) => {
    if ((edit || dirty) && !window.confirm(t("放弃未保存的修改？"))) return;
    setEdit(null);
    setDraft(null);
    setError("");
    then();
  };

  const selectVersion = (next: VersionRef) => {
    if (next.kind === shown.kind && (next.kind === "now" || (shown.kind === "change" && next.id === shown.id))) return;
    leaveVersion(() => setVersion(next));
  };

  const mutateDraft = (updater: (current: Snapshot) => Snapshot) => {
    if (!snapshot) return;
    const base = draft ? structuredClone(draft) : structuredClone(snapshot);
    const next = updater(base);
    setDraft(diffStaged(snapshot, next).count > 0 ? next : null);
    setError("");
  };

  const stagePlan = (plan: Pricing) => {
    const normalized: Pricing = {
      ...plan,
      provider: { ...plan.provider, timeZone: "UTC" },
      createdAt: plan.createdAt ?? new Date().toISOString(),
    };
    mutateDraft((current) => {
      const exists = current.configs.some((row) => row.id === normalized.id);
      return {
        ...current,
        configs: exists
          ? current.configs.map((row) => (row.id === normalized.id ? normalized : row))
          : [...current.configs, normalized],
      };
    });
    setPick({ kind: "plan", id: normalized.id });
    setEdit(null);
  };

  const removePlan = (plan: Pricing) => {
    const users = usersOfPlan(bindings, names, plan.id);
    const dependents = rows
      .filter((other) => other.id !== plan.id && other.relations?.requires.includes(plan.id))
      .map((other) => other.name);
    const inUse = [...users.groups, ...users.resources, ...users.tables, ...dependents];
    if (inUse.length) {
      setError(t("「{name}」仍被 {list} 使用，请先修改对应资源计费或依赖后再移除。", { name: plan.name, list: inUse.join("、") }));
      return;
    }
    const existed = snapshot?.configs.some((row) => row.id === plan.id) ?? false;
    if (!existed) {
      // Never saved yet: drop completely from the local draft.
      mutateDraft((current) => ({ ...current, configs: current.configs.filter((row) => row.id !== plan.id) }));
      return;
    }
    stagePlan({ ...plan, status: "archived", enabled: false });
  };

  /** Copy a rule from a historical version into the current version's draft as a new active rule. */
  const copyPlanToNow = (plan: Pricing) => {
    if (!resource.data) return;
    const nowConfigs = resource.data.pricingConfigs;
    const liveIds = new Set(nowConfigs.filter((row) => row.status !== "archived").map((row) => row.id));
    const newId = crypto.randomUUID();
    const copied: Pricing = {
      ...structuredClone(plan),
      id: newId,
      status: "active",
      enabled: true,
      createdAt: new Date().toISOString(),
      provider: {
        ...structuredClone(plan.provider),
        id: newId,
        timeZone: plan.provider.timeZone ?? "UTC",
        ...(plan.provider.rules
          ? {
              rules: plan.provider.rules.map((rule) => {
                const { dateTimeRange: _retired, ...rest } = structuredClone(rule);
                return { ...rest, id: crypto.randomUUID() };
              }),
            }
          : {}),
      },
      ...(plan.kind === "time.priority"
        ? {
            relations: {
              requires: (plan.relations?.requires ?? []).filter((id) => liveIds.has(id)),
              conflicts: (plan.relations?.conflicts ?? []).filter((id) => liveIds.has(id)),
            },
          }
        : {}),
    };
    const nowBase: Snapshot = {
      configs: structuredClone(nowConfigs),
      bindings: changes.data ? structuredClone(changes.bindings) : null,
    };
    setError("");
    setEdit(null);
    setVersion({ kind: "now" });
    setDraft({ ...nowBase, configs: [...nowBase.configs, copied] });
    setTab("plans");
    setPick({ kind: "plan", id: copied.id });
  };

  const stageBinding = (section: BindingSection, id: string, plan: string | null) => {
    mutateDraft((current) => ({
      ...current,
      bindings: {
        groups: { ...(current.bindings?.groups ?? {}) },
        resources: { ...(current.bindings?.resources ?? {}) },
        tables: { ...(current.bindings?.tables ?? {}) },
        [section]: { ...(current.bindings?.[section] ?? {}), [id]: plan },
      },
    }));
  };

  const commitDraft = async () => {
    if (!dirty || !editable) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        plans: staged.plans.map(planPayload),
        bindings: staged.bindings,
      };
      if (mode === "now") {
        const result = await request<{ pendingConflicts?: PendingConflict[] }>("pricing-configs/changes", "POST", {
          effectiveAt: null,
          ...body,
        });
        if (result?.pendingConflicts?.length) setConflicts(result.pendingConflicts);
        resourceGroups.reload();
      } else if (entry) {
        const result = await request<{ pendingConflicts?: PendingConflict[] }>(`pricing-configs/changes/${segment(entry.id)}`, "PATCH", {
          effectiveAt: entry.effectiveAt,
          ...body,
        });
        if (result?.pendingConflicts?.length) setConflicts(result.pendingConflicts);
      }
      setDraft(null);
      setEdit(null);
      reloadAll();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("操作失败"));
    } finally {
      setBusy(false);
    }
  };

  const discardDraft = () => {
    if (!window.confirm(t("放弃当前所有未保存的修改？"))) return;
    setDraft(null);
    setEdit(null);
    setError("");
  };

  const startNew = () => leaveEditor(() => {
    setTab("plans");
    setEdit({
      id: "",
      kind: "time.priority",
      name: "",
      enabled: true,
      status: "active",
      provider: { id: crypto.randomUUID(), rules: [newRule()] },
    });
  });

  const machineById = useMemo(
    () => new Map((machines ?? []).map((machine) => [machine.id, machine])),
    [machines],
  );
  const groupIdOfResource = (id: string) =>
    machines === null
      ? undefined
      : machineById.has(id)
        ? machineById.get(id)!.resourceGroupId
        : "__ungrouped__";
  const bindingName = (key: BindingSection, id: string) =>
    key === "groups" ? names.groups[id] ?? id : names.resources[id] ?? id;
  const bindingTree = buildPricingBindingTree({
    bindings,
    groups: versionGroups,
    names,
    groupIdOfResource,
    shouldExcludeResource: (id, info) => {
      if (machines === null) return false;
      const machine = machineById.get(id);
      if (!machine) return false;
      return (
        !hasResourceLink(resourceCapabilities(machine))
        && info.resourcePlan === null
        && !info.hasTablePlan
        && !staged.bindingKeys.has(`resources:${id}`)
        && !marks.bindings.has(`resources:${id}`)
      );
    },
  });

  // What the right pane shows: the pick if this version has it, otherwise the
  // first thing the tab lists.
  const picked: Pick | null = (() => {
    if (pick?.kind === "simulator" && canWrite) return pick;
    if (pick?.kind === "plan" && tab === "plans" && rows.some((row) => row.id === pick.id)) return pick;
    if (pick?.kind === "relations" && tab === "plans" && timePlans.length > 1) return pick;
    if (pick?.kind === "binding" && tab === "bindings") {
      const [key, id] = pick.key.split(/:(.*)/s) as [BindingSection, string];
      if (key === "tables" && bindings && id in (bindings.resources ?? {})) {
        return { kind: "binding", key: `resources:${id}` };
      }
      if (bindings && id in (bindings[key] ?? {})) return pick;
    }
    if (tab === "plans") {
      const first = rows[0];
      return first ? { kind: "plan", id: first.id } : null;
    }
    const firstGroup = bindingTree.find((node) => node.hasGroupBinding && node.id !== null);
    if (firstGroup?.id) return { kind: "binding", key: `groups:${firstGroup.id}` };
    const firstItem = bindingTree.flatMap((node) => node.resources)[0];
    if (firstItem) {
      return { kind: "binding", key: `${firstItem.kind === "resource" ? "resources" : "tables"}:${firstItem.id}` };
    }
    return null;
  })();
  const pickedPlan = picked?.kind === "plan" ? rows.find((row) => row.id === picked.id) ?? null : null;
  const scheduleLabel = mode === "now"
    ? dirty ? t("现在的计划（含未保存修改）") : t("现在的计划")
    : mode === "past" && entry
      ? t("{time} 的计划", { time: displayDateTime(entry.appliedAt!, zone) })
      : entry
        ? dirty
          ? t("{time} 起生效的计划（含未保存修改）", { time: displayDateTime(entry.effectiveAt!, zone) })
          : t("{time} 起生效的计划", { time: displayDateTime(entry.effectiveAt!, zone) })
        : t("现在的计划");

  const versionAction = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError("");
    try {
      await action();
      setDraft(null);
      setEdit(null);
      after?.();
      reloadAll();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("操作失败"));
    } finally {
      setBusy(false);
    }
  };

  /** The price list of a past version, for copying it forward or restoring it now. */
  const restoreBody = async (from: PricingChangeEntry) => {
    const draftData = await request<{ snapshot: Snapshot }>(`pricing-configs/changes/${segment(from.id)}/restore-draft`);
    return {
      plans: draftData.snapshot.configs.map(planPayload),
      bindings: draftData.snapshot.bindings ?? {},
      restoredFrom: from.id,
    };
  };

  const rowClass = (selected: boolean) =>
    `focus-ring flex w-full min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${
      selected ? "bg-mint/[0.08] ring-1 ring-mint/25" : "hover:bg-ink/[0.03]"
    }`;
  const markTag = (mark: "new" | "changed" | "archived" | undefined) =>
    mark && (
      <span className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium ${
        mark === "new" ? "bg-emerald-500/15 text-[#23815d] dark:text-emerald-300" : mark === "archived" ? "bg-coral/10 text-coral" : "bg-sky-500/10 text-sky-700 dark:text-sky-300"
      }`}>
        {t(mark === "new" ? "新增" : mark === "archived" ? "归档" : "已改")}
      </span>
    );
  const unsavedTag = (
    <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-800 dark:text-amber-300">
      {t("未保存")}
    </span>
  );

  if (!resource.data) return <State error={resource.error} />;
  const pickedBinding = picked?.kind === "binding" ? (() => {
    const [key, id] = picked.key.split(/:(.*)/s) as [BindingSection, string];
    return { key, id, plan: bindings?.[key]?.[id] ?? null };
  })() : null;
  const pickedGroup = pickedBinding && pickedBinding.key !== "groups"
    ? resolveResourceGroup(groupIdOfResource(pickedBinding.id), versionGroups)
    : null;
  const pickedEffectivePlan = pickedBinding?.key === "resources"
    ? effectiveResourcePlan({ pricingConfigOverrideId: pickedBinding.plan }, pickedGroup, all)
    : null;
  const planName = (id: string | null) => (id ? all.find((plan) => plan.id === id)?.name ?? names.plans[id] ?? id : null);

  return (
    <div className="grid gap-3">
      {/* One workbench, sized to fill the desktop viewport without outer scroll:
          the list on the left and the detail/editor on the right each scroll. */}
      <div data-tour="pricing-workbench" className="flex flex-col overflow-hidden rounded-2xl border border-ink/10 bg-panel shadow-soft lg:h-[calc(100dvh-8.75rem)] lg:min-h-[36rem]">
        <VersionBar
          model={changes}
          selected={shown}
          onSelect={selectVersion}
          onAddFuture={() => leaveVersion(() => setDialog("add"))}
          canWrite={canWrite}
        />
        <VersionBanner
          model={changes}
          entry={shown.kind === "now" ? null : entry}
          names={names}
          canWrite={canWrite}
          busy={busy}
          dirty={dirty || Boolean(edit)}
          onEditTime={() => setDialog("time")}
          onApplyNow={() => entry && versionAction(
            () => request(`pricing-configs/changes/${segment(entry.id)}/apply-now`, "POST", {}),
            () => setVersion({ kind: "now" }),
          )}
          onDelete={() => entry && window.confirm(t("删除这份未来计划？")) && versionAction(
            () => request(`pricing-configs/changes/${segment(entry.id)}/cancel`, "POST", {}),
            () => setVersion({ kind: "now" }),
          )}
          onCopyToFuture={() => setDialog("copy")}
          onRestoreNow={() => entry && window.confirm(t("用这份历史计划覆盖现在的计划？会立即生效。")) && versionAction(
            async () => request("pricing-configs/changes", "POST", { effectiveAt: null, ...(await restoreBody(entry)) }),
            () => setVersion({ kind: "now" }),
          )}
        />

        {dirty && editable && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-500/25 bg-amber-500/[0.08] px-4 py-2 dark:bg-amber-500/[0.12]">
            <span className="size-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
            <span className="text-sm font-semibold text-ink">
              {t("有 {count} 项未保存修改", { count: staged.count })}
            </span>
            <span className="text-xs text-ink/60">
              {mode === "now"
                ? t("全部改完后点右侧统一保存，只生成一条历史计划。")
                : t("点击保存后一并写入这份未来计划。")}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              className="focus-ring inline-flex min-h-8 items-center rounded-lg px-2.5 text-xs font-medium text-ink/65 transition-colors hover:bg-ink/5 hover:text-ink disabled:opacity-50"
              disabled={busy}
              onClick={discardDraft}
            >
              {t("放弃修改")}
            </button>
            <button
              type="button"
              className="focus-ring inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              disabled={busy || Boolean(edit)}
              title={edit ? t("请先完成当前方案的编辑") : undefined}
              onClick={commitDraft}
            >
              <Save size={13} aria-hidden="true" />
              {busy ? t("保存中…") : t("保存全部修改")}
            </button>
          </div>
        )}

        {!working ? (
          <div className="p-5"><State error={detail.error || resource.error} /></div>
        ) : (
          <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)] lg:divide-x lg:divide-ink/10">
            <div className="flex min-h-0 flex-col border-b border-ink/10 lg:border-b-0">
              <div className="shrink-0 border-b border-ink/10 p-2">
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-ink/[0.04] p-1" role="tablist" aria-label={t("计费计划")}>
                  {([["plans", "方案", rows.length], ["bindings", "资源计费", Object.keys(bindings?.groups ?? {}).length]] as const).map(([key, label, count]) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      data-tour={key === "plans" ? "pricing-tab-plans" : "pricing-tab-bindings"}
                      aria-selected={tab === key}
                      className={`focus-ring inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] font-medium transition-colors ${
                        tab === key ? "bg-panel text-ink shadow-sm" : "text-ink/55 hover:text-ink"
                      }`}
                      onClick={() => leaveEditor(() => {
                        setTab(key);
                        if (pick?.kind === "simulator") setPick(null);
                      })}
                    >
                      {t(label)}
                      <span className="text-[11px] tabular-nums opacity-60">{count}</span>
                    </button>
                  ))}
                </div>
              </div>

              {tab === "plans" && editable && (
                <div className="flex shrink-0 items-center justify-end px-3.5 py-1.5">
                  <button type="button" className={listAction} onClick={startNew}>
                    <Plus size={14} aria-hidden="true" />
                    {t("添加方案")}
                  </button>
                </div>
              )}

              <nav className="max-h-[44vh] min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 pt-1 lg:max-h-none" aria-label={t(tab === "plans" ? "方案" : "资源计费")}>
                {tab === "plans" ? (
                  <ul className="grid gap-0.5 px-2">
                    {edit && !edit.id && (
                      <li>
                        <div className={rowClass(true)}>
                          <Plus size={13} className="shrink-0 text-mint" aria-hidden="true" />
                          <span className="truncate text-sm font-medium text-ink">{t("新方案（未保存）")}</span>
                        </div>
                      </li>
                    )}
                    {rows.map((row) => {
                      const index = all.indexOf(row);
                      const users = usersOfPlan(bindings, names, row.id);
                      const usedBy = [...users.groups, ...users.resources, ...users.tables];
                      const required = rows.some((other) => other.relations?.requires.includes(row.id));
                      const selected = edit ? edit.id === row.id : picked?.kind === "plan" && picked.id === row.id;
                      return (
                        <li key={row.id}>
                          <button
                            type="button"
                            aria-current={selected ? "true" : undefined}
                            className={rowClass(selected)}
                            onClick={() => leaveEditor(() => setPick({ kind: "plan", id: row.id }))}
                          >
                            <span className="size-2.5 shrink-0 rounded-full" style={{ background: planColor(index) }} aria-hidden="true" />
                            <span className="grid min-w-0 flex-1 gap-0.5">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate text-sm font-medium text-ink">{row.name}</span>
                                {!row.enabled && (
                                  <span className="shrink-0 rounded-full bg-coral/10 px-1.5 py-px text-[10px] font-medium text-coral">{t("停用")}</span>
                                )}
                                {staged.planIds.has(row.id) ? unsavedTag : markTag(marks.plans.get(row.id))}
                              </span>
                              <span className="truncate text-xs text-ink/50">
                                {t(kinds[row.kind])} · {row.kind === "charge.fixed"
                                  ? money(row.provider.amount)
                                  : t("{count} 个时段", { count: (row.provider.rules ?? []).filter((rule) => rule.status !== "archived").length })}
                              </span>
                              {row.kind !== "time.cap" && (
                                <span className={`truncate text-xs ${usedBy.length || required ? "text-ink/45" : "text-amber-700 dark:text-amber-300"}`}>
                                  {usedBy.length ? t("用于 {list}", { list: usedBy.join("、") }) : required ? t("随依赖它的方案计费") : t("未被使用")}
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                    {timePlans.length > 1 && (
                      <li className="mt-1 border-t border-ink/[0.06] pt-1">
                        <button
                          type="button"
                          aria-current={picked?.kind === "relations" ? "true" : undefined}
                          className={rowClass(!edit && picked?.kind === "relations")}
                          onClick={() => leaveEditor(() => setPick({ kind: "relations" }))}
                        >
                          <span className="grid size-2.5 shrink-0 place-items-center text-ink/45" aria-hidden="true"><Network size={13} /></span>
                          <span className="grid min-w-0 gap-0.5">
                            <span className="truncate text-sm text-ink/80">{t("方案关系图")}</span>
                            <span className="truncate text-xs text-ink/45">{t("依赖与冲突一览")}</span>
                          </span>
                        </button>
                      </li>
                    )}
                  </ul>
                ) : (
                  <div className="space-y-2 px-2">
                    {bindingTree.map((groupNode) => {
                      const groupKey = groupNode.id !== null ? (`groups:${groupNode.id}` as BindingKey) : null;
                      const groupSelected = Boolean(groupKey && picked?.kind === "binding" && picked.key === groupKey);
                      return (
                        <div key={groupNode.id ?? "__ungrouped__"}>
                          {groupNode.hasGroupBinding && groupKey ? (
                            <button
                              type="button"
                              aria-current={groupSelected ? "true" : undefined}
                              className={rowClass(groupSelected)}
                              onClick={() => setPick({ kind: "binding", key: groupKey })}
                            >
                              <Layers size={14} className="shrink-0 text-ink/50" aria-hidden="true" />
                              <span className="grid min-w-0 flex-1 gap-0.5">
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate text-sm font-semibold text-ink">{groupNode.name}</span>
                                  {staged.bindingKeys.has(groupKey) ? unsavedTag : marks.bindings.has(groupKey) && markTag("changed")}
                                </span>
                                <span className={`truncate text-xs ${groupNode.groupPlan ? "text-ink/55" : "text-ink/40"}`}>
                                  {planName(groupNode.groupPlan) ?? t("不计费")}
                                </span>
                              </span>
                            </button>
                          ) : (
                            <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-ink/55">
                              <Layers size={13} className="shrink-0 opacity-60" aria-hidden="true" />
                              <span className="truncate">{t(groupNode.name)}</span>
                            </div>
                          )}
                          {groupNode.resources.length > 0 && (
                            <ul className="ml-4 mt-1 grid gap-0.5 border-l border-ink/10 pl-2">
                              {groupNode.resources.map((item) => {
                                const rowKey = (item.kind === "resource" ? `resources:${item.id}` : `tables:${item.id}`) as BindingKey;
                                const tableKey = `tables:${item.id}` as BindingKey;
                                const selected = picked?.kind === "binding" && (picked.key === rowKey || (item.kind === "resource" && picked.key === tableKey));
                                const isUnsaved = staged.bindingKeys.has(rowKey) || (item.hasTablePlan && staged.bindingKeys.has(tableKey));
                                const isChanged = marks.bindings.has(rowKey) || (item.hasTablePlan && marks.bindings.has(tableKey));
                                const resourcePlanText = planName(item.resourcePlan) ?? t("跟随资源组");
                                const subtitle = item.kind === "table"
                                  ? t("对局：{plan}", { plan: planName(item.tablePlan) ?? t("不计费") })
                                  : item.hasTablePlan
                                    ? `${resourcePlanText} · ${t("对局：{plan}", { plan: planName(item.tablePlan) ?? t("不计费") })}`
                                    : resourcePlanText;
                                const hasExplicitPlan = item.kind === "table"
                                  ? Boolean(item.tablePlan)
                                  : Boolean(item.resourcePlan || item.tablePlan);
                                return (
                                  <li key={rowKey}>
                                    <button
                                      type="button"
                                      aria-current={selected ? "true" : undefined}
                                      className={rowClass(selected)}
                                      onClick={() => setPick({ kind: "binding", key: rowKey })}
                                    >
                                      <span className="grid min-w-0 flex-1 gap-0.5">
                                        <span className="flex min-w-0 items-center gap-1.5">
                                          <span className="truncate text-sm font-medium text-ink">{item.name}</span>
                                          {isUnsaved ? unsavedTag : isChanged && markTag("changed")}
                                        </span>
                                        <span className={`truncate text-xs ${hasExplicitPlan ? "text-ink/55" : "text-ink/40"}`}>
                                          {subtitle}
                                        </span>
                                      </span>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </nav>

              <div className="flex shrink-0 items-center gap-1 border-t border-ink/10 p-2">
                {canWrite && (
                  <button
                    type="button"
                    data-tour="pricing-simulator-btn"
                    aria-current={!edit && picked?.kind === "simulator" ? "true" : undefined}
                    className={`focus-ring flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                      !edit && picked?.kind === "simulator"
                        ? "bg-mint/[0.08] text-mint ring-1 ring-mint/25"
                        : "text-ink/70 hover:bg-ink/[0.04] hover:text-ink"
                    }`}
                    onClick={() => leaveEditor(() => setPick({ kind: "simulator" }))}
                  >
                    <Calculator size={14} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">{t("计费模拟器")}</span>
                  </button>
                )}
                <BillingManualButton />
              </div>
            </div>

            <main className={`min-h-0 min-w-0 overflow-y-auto overscroll-contain p-5 ${edit ? "pb-0" : ""}`}>
              {error && <p role="alert" className="mb-4 rounded-xl border border-coral/30 bg-coral/5 px-3.5 py-2.5 text-sm text-coral">{error}</p>}
              {conflicts.length > 0 && (
                <div role="status" className="mb-4 flex flex-wrap items-start gap-3 rounded-xl border border-amber-500/35 bg-amber-500/[0.08] px-4 py-3 text-sm dark:bg-amber-500/[0.12]">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
                  <div className="grid min-w-0 flex-1 gap-1">
                    <p className="font-medium text-ink">{t("已保存。下面的未来计划也修改了同一项，到点时会以那份计划为准：")}</p>
                    {conflicts.map((conflict) => (
                      <button
                        key={conflict.changeId}
                        type="button"
                        className="text-left text-xs text-amber-800 underline-offset-2 hover:underline dark:text-amber-200"
                        onClick={() => selectVersion({ kind: "change", id: conflict.changeId })}
                      >
                        <span className="font-semibold tabular-nums">{displayDateTime(conflict.effectiveAt, zone)}</span>
                        {" · "}
                        {[...conflict.plans, ...conflict.bindings.map((id) => names.groups[id] ?? names.resources[id] ?? id)].join("、")}
                      </button>
                    ))}
                  </div>
                  <button type="button" className={`${buttonQuiet} min-h-8 shrink-0 px-2.5 text-xs font-medium`} onClick={() => setConflicts([])}>
                    {t("知道了")}
                  </button>
                </div>
              )}

              {edit ? (
                <div className="grid gap-4">
                  <div className="flex items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-mint/10 text-mint" aria-hidden="true">
                      {edit.id ? <Pencil size={16} /> : <Plus size={16} />}
                    </span>
                    <div className="grid min-w-0 gap-0.5">
                      <h3 className="truncate text-lg font-semibold tracking-tight">
                        {edit.id ? t("编辑方案「{name}」", { name: edit.name }) : t("添加方案")}
                      </h3>
                      <p className="text-xs text-ink/50">
                        {t("完成编辑后先暂存到当前计划，全部改完再点顶部「保存全部修改」统一提交。")}
                      </p>
                    </div>
                    <span className="flex-1" />
                    <button type="button" className={`${buttonQuiet} min-h-9 px-3 text-sm`} onClick={() => setEdit(null)}>{t("取消")}</button>
                  </div>
                  <PricingEditor
                    key={`${shown.kind === "change" ? shown.id : "now"}:${edit.id || "new"}`}
                    value={edit}
                    all={all}
                    submitLabel="完成编辑"
                    onSave={stagePlan}
                    done={() => setEdit(null)}
                  />
                </div>
              ) : picked?.kind === "simulator" && canWrite ? (
                <div className="grid gap-4">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Calculator size={16} className="text-ink/50" aria-hidden="true" />
                    <h3 className="text-lg font-semibold tracking-tight">{t("计费模拟器")}</h3>
                    <span className="rounded-full bg-ink/[0.05] px-2.5 py-0.5 text-xs text-ink/65">{scheduleLabel}</span>
                  </div>
                  <BillingSimulator
                    key={`${shown.kind === "change" ? shown.id : "now"}:${dirty ? "draft" : "saved"}`}
                    pricingConfigs={all}
                    scheduleLabel={scheduleLabel}
                    useProvidedConfigs
                  />
                </div>
              ) : tab === "plans" && pickedPlan ? (
                <PlanDetail
                  key={`${shown.kind === "change" ? shown.id : "now"}:${pickedPlan.id}`}
                  plan={pickedPlan}
                  index={all.indexOf(pickedPlan)}
                  all={all}
                  bindings={bindings}
                  names={names}
                  zone={zone}
                  items={versionItems.filter((item) =>
                    item.kind === "binding-changed" ? item.from === pickedPlan.id || item.to === pickedPlan.id : item.planId === pickedPlan.id)}
                  canWrite={editable}
                  onEdit={() => setEdit(structuredClone(pickedPlan))}
                  onRemove={() => removePlan(pickedPlan)}
                  onCopyToNow={mode === "past" && canWrite ? () => copyPlanToNow(pickedPlan) : undefined}
                  onSelectPlan={(id) => setPick({ kind: "plan", id })}
                />
              ) : tab === "plans" && picked?.kind === "relations" ? (
                <div className="grid gap-3">
                  <div className="flex items-center gap-2">
                    <Network size={16} className="text-ink/45" aria-hidden="true" />
                    <h3 className="text-lg font-semibold tracking-tight">{t("方案关系图")}</h3>
                  </div>
                  <PlanRelationGraph plans={all} groups={versionGroups} onSelect={(plan) => setPick({ kind: "plan", id: plan.id })} />
                  {owner && (
                    <p className="text-xs text-ink/55">
                      {t("新建的方案要被资源组、资源或其他方案的「依赖」引用才会计费。")}{" "}
                      <Link className="underline" to={`/merchant/${segment(shopCode)}/resources`}>{t("资源组")}</Link>
                    </p>
                  )}
                </div>
              ) : tab === "bindings" && pickedBinding ? (() => {
                const hasTableBinding = pickedBinding.key === "resources"
                  && Boolean(bindings?.tables && Object.prototype.hasOwnProperty.call(bindings.tables, pickedBinding.id));
                const tablePlan = hasTableBinding ? (bindings?.tables?.[pickedBinding.id] ?? null) : null;
                const detailSubtitle = pickedBinding.key === "groups"
                  ? t("资源组")
                  : `${t(pickedBinding.key === "tables" ? "桌游对局方案" : hasTableBinding ? "桌游" : "资源")} · ${t(pickedGroup?.name ?? "未分组")}`;
                const primarySelectLabel = pickedBinding.key === "tables"
                  ? "桌游对局方案"
                  : hasTableBinding
                    ? "入场 / 等位方案"
                    : "使用的方案";
                const primaryDefaultLabel = pickedBinding.key === "resources" ? "跟随资源组" : "不计费";
                const primaryPlans = all.filter((plan) =>
                  plan.status !== "archived"
                  && plan.kind !== "time.cap"
                  && (pickedBinding.key !== "tables" || (plan.kind === "time.priority" && plan.enabled)));
                return (
                  <div className="grid gap-4">
                    <div className="flex items-center gap-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-ink/[0.05] text-ink/55" aria-hidden="true">
                        {pickedBinding.key === "groups" ? <Layers size={16} /> : <Unplug size={16} />}
                      </span>
                      <div className="grid min-w-0 gap-0.5">
                        <h3 className="truncate text-lg font-semibold tracking-tight">{bindingName(pickedBinding.key, pickedBinding.id)}</h3>
                        <p className="text-xs text-ink/50">{detailSubtitle}</p>
                      </div>
                    </div>
                    <section className="grid gap-2 rounded-xl border border-ink/10 p-4">
                      <label className="text-sm font-semibold text-ink" htmlFor="binding-plan">{t(primarySelectLabel)}</label>
                      {editable ? (
                        <select
                          id="binding-plan"
                          className={`${input} max-w-sm`}
                          value={pickedBinding.plan ?? ""}
                          onChange={(event) => stageBinding(pickedBinding.key, pickedBinding.id, event.target.value || null)}
                        >
                          <option value="">{t(primaryDefaultLabel)}</option>
                          {primaryPlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
                        </select>
                      ) : (
                        <p className="text-sm text-ink/75">{planName(pickedBinding.plan) ?? t(primaryDefaultLabel)}</p>
                      )}
                      {pickedEffectivePlan?.kind === "group" ? (
                        <p className="text-xs text-ink/60">
                          {t("跟随资源组（{plan}）", { plan: pickedEffectivePlan.plan?.name ?? t("未知方案") })}
                          {pickedEffectivePlan.groupDisabled ? ` · ${t("资源组已停用")}` : ""}
                        </p>
                      ) : pickedEffectivePlan?.kind === "free" && pickedGroup ? (
                        <p className="text-xs text-ink/60">{t("跟随资源组（资源组未设置方案）")}</p>
                      ) : null}
                      {pickedBinding.plan && (
                        <button type="button" className={`${buttonQuiet} justify-self-start px-2 text-sm`} onClick={() => { setTab("plans"); setPick({ kind: "plan", id: pickedBinding.plan! }); }}>
                          {t("查看方案「{name}」", { name: planName(pickedBinding.plan) ?? "" })}
                        </button>
                      )}
                      {!hasTableBinding && (
                        <p className="text-xs text-ink/50">
                          {mode === "past"
                            ? t("历史计划只读。")
                            : t("修改会先暂存，点顶部「保存全部修改」后统一生效。")}
                        </p>
                      )}
                    </section>
                    {hasTableBinding && (
                      <section className="grid gap-2 rounded-xl border border-ink/10 p-4">
                        <label className="text-sm font-semibold text-ink" htmlFor="binding-table-plan">{t("桌游对局方案")}</label>
                        {editable ? (
                          <select
                            id="binding-table-plan"
                            className={`${input} max-w-sm`}
                            value={tablePlan ?? ""}
                            onChange={(event) => stageBinding("tables", pickedBinding.id, event.target.value || null)}
                          >
                            <option value="">{t("不计费")}</option>
                            {all
                              .filter((plan) => plan.status !== "archived" && plan.kind === "time.priority" && plan.enabled)
                              .map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
                          </select>
                        ) : (
                          <p className="text-sm text-ink/75">{planName(tablePlan) ?? t("不计费")}</p>
                        )}
                        <p className="text-xs text-ink/50">
                          {t("满员开桌后按此方案计费；未开桌前的入场或等位按上方方案计费。")}
                        </p>
                        {tablePlan && (
                          <button type="button" className={`${buttonQuiet} justify-self-start px-2 text-sm`} onClick={() => { setTab("plans"); setPick({ kind: "plan", id: tablePlan }); }}>
                            {t("查看方案「{name}」", { name: planName(tablePlan) ?? "" })}
                          </button>
                        )}
                        <p className="text-xs text-ink/50">
                          {mode === "past"
                            ? t("历史计划只读。")
                            : t("修改会先暂存，点顶部「保存全部修改」后统一生效。")}
                        </p>
                      </section>
                    )}
                  </div>
                );
              })() : tab === "plans" && !rows.length && mode === "now" && canWrite ? (
                <div className="mx-auto my-8 max-w-sm rounded-xl border border-dashed border-ink/20 px-6 py-10 text-center">
                  <p className="font-medium">{t("还没有计费方案")}</p>
                  <p className="mt-2 text-sm text-ink/55">
                    {t("方案决定玩家在哪些时段按什么价格付费。给资源组选上方案后，组里的资源才开始计费。")}
                  </p>
                  <button type="button" className={`${primary} mt-5`} onClick={startNew}>
                    <Plus size={16} aria-hidden="true" />
                    {t("添加方案")}
                  </button>
                </div>
              ) : (
                <p className="py-16 text-center text-sm text-ink/50">
                  {t(tab === "plans"
                    ? "这份计划里没有计费方案"
                    : mode === "past" && entry && !entry.bindingsRecorded
                      ? "早期记录没有保存资源计费设置"
                      : "还没有资源")}
                </p>
              )}
            </main>
          </div>
        )}
      </div>

      {dialog === "add" && (
        <VersionTimeDialog
          title={t("添加未来计划")}
          label="添加"
          timeZone={zone}
          initial={{ at: tomorrowMidnight(zone), note: "" }}
          close={() => setDialog(null)}
          submit={async (value) => {
            const created = await request<{ id: string }>("pricing-configs/changes", "POST", { ...value, plans: [], bindings: {} });
            reloadAll();
            setVersion({ kind: "change", id: created.id });
          }}
        />
      )}
      {dialog === "time" && entry && (
        <VersionTimeDialog
          title={t("改时间与备注")}
          label="保存"
          timeZone={zone}
          initial={{ at: localInput(entry.effectiveAt!, zone), note: entry.note ?? "" }}
          close={() => setDialog(null)}
          submit={async (value) => {
            await request(`pricing-configs/changes/${segment(entry.id)}`, "PATCH", value);
            reloadAll();
          }}
        />
      )}
      {dialog === "copy" && entry && (
        <VersionTimeDialog
          title={t("以此创建未来计划")}
          label="创建"
          timeZone={zone}
          initial={{ at: tomorrowMidnight(zone), note: entry.note ?? "" }}
          close={() => setDialog(null)}
          submit={async (value) => {
            const created = await request<{ id: string }>("pricing-configs/changes", "POST", { ...value, ...(await restoreBody(entry)) });
            reloadAll();
            setVersion({ kind: "change", id: created.id });
          }}
        />
      )}
    </div>
  );
}

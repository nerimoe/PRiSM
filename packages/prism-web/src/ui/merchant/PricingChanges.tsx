import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import type { PricingChangeItem } from "@prism/core";
import { useI18n } from "../../i18n";
import { billTime } from "../bill-time";
import { useMerchant, useResource, useStaffApi } from "./shared";

/**
 * The price list's versions as the server lists them, and how their changes
 * read, for the pricing workbench. See docs/pricing-changes.md.
 */

type Bindings = {
  groups: Record<string, string | null>;
  resources: Record<string, string | null>;
  tables: Record<string, string | null>;
};
export type PricingNames = Names;
type Names = {
  plans: Record<string, string>;
  groups: Record<string, string>;
  resources: Record<string, string>;
};
type Note =
  | { kind: "binding-skipped-missing"; target: "group" | "resource" | "table"; targetId: string }
  | { kind: "binding-skipped-seated"; targetId: string }
  | { kind: "archive-kept"; planId: string; name: string }
  | { kind: "error"; message: string };
export type PricingChangeEntry = Entry;
type Entry = {
  id: string;
  status: "pending" | "applied" | "cancelled" | "failed";
  source: "edit" | "schedule" | "restore" | "import" | "history";
  effectiveAt: string | null;
  appliedAt: string | null;
  actorName: string | null;
  note: string | null;
  restoredFrom: string | null;
  errorCode: string | null;
  notes: Note[];
  bindingsRecorded: boolean;
  items: PricingChangeItem[];
  playersOnIt: number;
};
type Timeline = {
  pending: Entry[];
  applied: Entry[];
  failed: Entry[];
  nextBefore: string | null;
  names: Names;
  /** What each group, resource and table bills now. */
  bindings?: Bindings;
  timeZone: string;
};

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** One line per change, in the merchant's words. */
export function describeItem(item: PricingChangeItem, names: Names, t: Translate): string {
  const plan = (id: string | null) => (id ? names.plans[id] ?? id : null);
  switch (item.kind) {
    case "plan-added": return t("新建方案「{name}」", { name: item.name });
    case "plan-archived": return t("移除方案「{name}」", { name: item.name });
    case "plan-unarchived": return t("恢复方案「{name}」", { name: item.name });
    case "plan-enabled": return t("启用方案「{name}」", { name: item.name });
    case "plan-disabled": return t("停用方案「{name}」", { name: item.name });
    case "plan-renamed": return t("方案「{from}」改名为「{to}」", { from: item.from, to: item.to });
    case "period-added": return t("「{name}」新增时段「{period}」", { name: item.name, period: item.period });
    case "period-removed": return t("「{name}」删除时段「{period}」", { name: item.name, period: item.period });
    case "amount-changed":
      return t("「{name}」金额 {from} → {to} 元", { name: item.name, from: item.from, to: item.to });
    case "period-changed": {
      const parts = item.fields.map((field) => {
        switch (field.field) {
          case "unitPrice": return t("收费 {from} → {to} 元", { from: field.from!, to: field.to! });
          case "unitMinutes": return t("计费间隔 {from} → {to} 分钟", { from: field.from!, to: field.to! });
          case "roundGraceMinutes": return t("宽限 {from} → {to} 分钟", { from: field.from!, to: field.to! });
          case "priceCap": return t("封顶 {from} → {to} 元", { from: field.from || t("不限"), to: field.to || t("不限") });
          case "priority": return t("优先级 {from} → {to}", { from: field.from!, to: field.to! });
          case "label": return t("改名为「{to}」", { to: field.to! });
          case "status": return t(field.to === "archived" ? "停用时段" : "启用时段");
          case "schedule": return t("时间或日期调整");
        }
      });
      return t("「{name}」{period}：{changes}", { name: item.name, period: item.period, changes: parts.join("，") });
    }
    case "relations-changed": {
      const list = (ids: string[]) => ids.map((id) => plan(id)).join("、");
      const parts = [
        item.requires.added.length ? t("新增依赖 {list}", { list: list(item.requires.added) }) : null,
        item.requires.removed.length ? t("去掉依赖 {list}", { list: list(item.requires.removed) }) : null,
        item.conflicts.added.length ? t("新增冲突 {list}", { list: list(item.conflicts.added) }) : null,
        item.conflicts.removed.length ? t("去掉冲突 {list}", { list: list(item.conflicts.removed) }) : null,
      ].filter(Boolean);
      return t("「{name}」{changes}", { name: item.name, changes: parts.join("，") });
    }
    case "binding-changed": {
      const thing = item.target === "group"
        ? t("资源组「{name}」", { name: names.groups[item.targetId] ?? item.targetId })
        : item.target === "resource"
          ? t("资源「{name}」", { name: names.resources[item.targetId] ?? item.targetId })
          : t("桌游「{name}」", { name: names.resources[item.targetId] ?? item.targetId });
      const none = t(item.target === "resource" ? "跟随资源组" : "不计费");
      return t("{thing}：{from} → {to}", { thing, from: plan(item.from) ?? none, to: plan(item.to) ?? none });
    }
  }
}

/** What happened when a version took effect that differs from what it asked for. */
export function describeNote(note: Note, names: Names, t: Translate): string {
  switch (note.kind) {
    case "binding-skipped-missing": return t("「{name}」已删除，跳过它的计费设置", { name: names.groups[note.targetId] ?? names.resources[note.targetId] ?? note.targetId });
    case "binding-skipped-seated": return t("桌游「{name}」有人在桌，没有切换方案", { name: names.resources[note.targetId] ?? note.targetId });
    case "archive-kept": return t("方案「{name}」仍在使用，没有移除", { name: note.name });
    case "error": return note.message;
  }
}

function ValueTransition({
  from,
  to,
  fromUnit,
  toUnit,
  numeric = false,
  toMuted = false,
}: {
  from: string | number;
  to: string | number;
  fromUnit?: string;
  toUnit?: string;
  numeric?: boolean;
  toMuted?: boolean;
}) {
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${numeric ? "tabular-nums" : ""}`}>
      <span className="text-ink/45 line-through decoration-ink/30">
        {from}
        {fromUnit ? ` ${fromUnit}` : ""}
      </span>
      <ArrowRight size={12} className="shrink-0 text-ink/35" aria-hidden="true" />
      <span
        className={`rounded-md px-1.5 py-0.5 text-xs font-semibold leading-tight ${
          toMuted ? "bg-ink/[0.06] text-ink/65" : "bg-mint/10 text-mint"
        }`}
      >
        {to}
        {toUnit ? ` ${toUnit}` : ""}
      </span>
    </span>
  );
}

function ChangeTag({
  tone,
  children,
}: {
  tone: "mint" | "emerald" | "coral" | "sky" | "neutral";
  children: ReactNode;
}) {
  const styles =
    tone === "emerald"
      ? "bg-emerald-500/15 text-[#23815d] dark:text-emerald-400"
      : tone === "coral"
        ? "bg-coral/15 text-coral"
        : tone === "sky"
          ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
          : tone === "mint"
            ? "bg-mint/15 text-mint"
            : "bg-ink/[0.07] text-ink/65";
  return (
    <span className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-tight ${styles}`}>
      {children}
    </span>
  );
}

function ChangeItemRow({ item, names }: { item: PricingChangeItem; names: Names }) {
  const { t } = useI18n();
  const plan = (id: string | null) => (id ? names.plans[id] ?? id : null);
  const unitYuan = t("元");
  const unitMin = t("分钟");

  switch (item.kind) {
    case "plan-added":
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <ChangeTag tone="emerald">{t("新建")}</ChangeTag>
          <span className="font-medium text-ink">{item.name}</span>
        </span>
      );
    case "plan-archived":
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <ChangeTag tone="coral">{t("移除")}</ChangeTag>
          <span className="text-ink/55 line-through decoration-ink/30">{item.name}</span>
        </span>
      );
    case "plan-unarchived":
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <ChangeTag tone="mint">{t("恢复")}</ChangeTag>
          <span className="font-medium text-ink">{item.name}</span>
        </span>
      );
    case "plan-enabled":
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <ChangeTag tone="emerald">{t("启用")}</ChangeTag>
          <span className="font-medium text-ink">{item.name}</span>
        </span>
      );
    case "plan-disabled":
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <ChangeTag tone="neutral">{t("停用")}</ChangeTag>
          <span className="font-medium text-ink/75">{item.name}</span>
        </span>
      );
    case "plan-renamed":
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <ChangeTag tone="sky">{t("改名")}</ChangeTag>
          <ValueTransition from={item.from} to={item.to} />
        </span>
      );
    case "period-added":
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-ink">{item.name}</span>
          <ChangeTag tone="emerald">{t("新增时段")}</ChangeTag>
          <span className="rounded-md bg-ink/[0.06] px-1.5 py-0.5 text-xs text-ink/80">{item.period}</span>
        </span>
      );
    case "period-removed":
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-ink">{item.name}</span>
          <ChangeTag tone="coral">{t("删除时段")}</ChangeTag>
          <span className="rounded-md bg-ink/[0.05] px-1.5 py-0.5 text-xs text-ink/50 line-through">{item.period}</span>
        </span>
      );
    case "amount-changed":
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-ink">{item.name}</span>
          <span className="text-xs text-ink/55">{t("金额")}</span>
          <ValueTransition from={item.from} to={item.to} toUnit={unitYuan} numeric />
        </span>
      );
    case "period-changed":
      return (
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="font-medium text-ink">{item.name}</span>
          <span className="rounded-md bg-ink/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-ink/65">
            {item.period}
          </span>
          {item.fields.map((field, idx) => (
            <span key={idx} className="inline-flex flex-wrap items-center gap-1">
              {idx > 0 && <span className="text-ink/25" aria-hidden="true">·</span>}
              {field.field === "unitPrice" && (
                <>
                  <span className="text-xs text-ink/55">{t("收费")}</span>
                  <ValueTransition from={field.from!} to={field.to!} toUnit={unitYuan} numeric />
                </>
              )}
              {field.field === "unitMinutes" && (
                <>
                  <span className="text-xs text-ink/55">{t("计费间隔")}</span>
                  <ValueTransition from={field.from!} to={field.to!} toUnit={unitMin} numeric />
                </>
              )}
              {field.field === "roundGraceMinutes" && (
                <>
                  <span className="text-xs text-ink/55">{t("宽限")}</span>
                  <ValueTransition from={field.from!} to={field.to!} toUnit={unitMin} numeric />
                </>
              )}
              {field.field === "priceCap" && (
                <>
                  <span className="text-xs text-ink/55">{t("封顶")}</span>
                  <ValueTransition
                    from={field.from || t("不限")}
                    to={field.to || t("不限")}
                    fromUnit={field.from ? unitYuan : undefined}
                    toUnit={field.to ? unitYuan : undefined}
                    numeric
                    toMuted={!field.to}
                  />
                </>
              )}
              {field.field === "priority" && (
                <>
                  <span className="text-xs text-ink/55">{t("优先级")}</span>
                  <ValueTransition from={field.from!} to={field.to!} numeric />
                </>
              )}
              {field.field === "label" && (
                <>
                  <span className="text-xs text-ink/55">{t("改名为")}</span>
                  <span className="rounded-md bg-mint/10 px-1.5 py-0.5 text-xs font-semibold text-mint">
                    {field.to}
                  </span>
                </>
              )}
              {field.field === "status" && (
                <ChangeTag tone={field.to === "archived" ? "coral" : "emerald"}>
                  {t(field.to === "archived" ? "停用时段" : "启用时段")}
                </ChangeTag>
              )}
              {field.field === "schedule" && <ChangeTag tone="sky">{t("时间或日期调整")}</ChangeTag>}
            </span>
          ))}
        </span>
      );
    case "relations-changed": {
      const list = (ids: string[]) => ids.map((id) => plan(id)).join("、");
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-ink">{item.name}</span>
          {item.requires.added.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <ChangeTag tone="mint">{t("新增依赖")}</ChangeTag>
              <span className="text-xs font-medium text-ink/80">{list(item.requires.added)}</span>
            </span>
          )}
          {item.requires.removed.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <ChangeTag tone="neutral">{t("去掉依赖")}</ChangeTag>
              <span className="text-xs text-ink/55 line-through">{list(item.requires.removed)}</span>
            </span>
          )}
          {item.conflicts.added.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <ChangeTag tone="coral">{t("新增冲突")}</ChangeTag>
              <span className="text-xs font-medium text-ink/80">{list(item.conflicts.added)}</span>
            </span>
          )}
          {item.conflicts.removed.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <ChangeTag tone="neutral">{t("去掉冲突")}</ChangeTag>
              <span className="text-xs text-ink/55 line-through">{list(item.conflicts.removed)}</span>
            </span>
          )}
        </span>
      );
    }
    case "binding-changed": {
      const kindLabel =
        item.target === "group" ? t("资源组") : item.target === "resource" ? t("资源") : t("桌游");
      const targetName =
        item.target === "group" ? names.groups[item.targetId] ?? item.targetId : names.resources[item.targetId] ?? item.targetId;
      const none = t(item.target === "resource" ? "跟随资源组" : "不计费");
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <ChangeTag tone="neutral">{kindLabel}</ChangeTag>
          <span className="font-medium text-ink">{targetName}</span>
          <ValueTransition
            from={plan(item.from) ?? none}
            to={plan(item.to) ?? none}
            toMuted={!item.to}
          />
        </span>
      );
    }
  }
}

export function ItemList({
  items,
  names,
  limit,
  dense = false,
}: {
  items: PricingChangeItem[];
  names: Names;
  limit?: number;
  dense?: boolean;
}) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  if (!items.length) return <p className="text-xs text-ink/45">{t("没有改动")}</p>;
  const shown = all || !limit ? items : items.slice(0, limit);
  return (
    <ul className={`grid ${dense ? "gap-1.5" : "gap-2"} text-[13px] leading-snug text-ink/80`}>
      {shown.map((item, index) => (
        <li key={index} className="min-w-0">
          <ChangeItemRow item={item} names={names} />
        </li>
      ))}
      {limit && items.length > limit && (
        <li>
          <button
            type="button"
            className="focus-ring rounded-md px-1.5 py-0.5 text-xs font-medium text-mint transition-colors hover:bg-mint/10"
            onClick={() => setAll((value) => !value)}
          >
            {all ? t("收起详情") : t("还有 {count} 项", { count: items.length - limit })}
          </button>
        </li>
      )}
    </ul>
  );
}

function formatDateBadge(iso: string, timeZone: string, locale: string) {
  const { date, time } = billTime(iso, timeZone);
  if (!date) return { month: "—", day: "—", time: "—", year: "" };
  const [year, , day] = date.split("-");
  const month = new Date(`${date}T12:00:00Z`).toLocaleDateString(
    locale === "zh" ? "zh-CN" : "en-US",
    { timeZone: "UTC", month: "short" },
  );
  return { year: year ?? "", month, day: day ?? "—", time };
}

/**
 * The price list's versions for the pricing workbench: the one in place, the
 * scheduled ones and the ones before, with the names and bindings they use.
 */
export function usePricingChanges(reloadPlans: () => void) {
  const request = useStaffApi();
  const { timeZone } = useMerchant();
  const timeline = useResource<Timeline>("pricing-configs/changes");
  const [older, setOlder] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const data = timeline.data;
  useEffect(() => {
    setOlder([]);
    setCursor(data?.nextBefore ?? null);
  }, [data]);
  const applied = useMemo(() => [...(data?.applied ?? []), ...older], [data, older]);
  const reload = () => {
    timeline.reload();
    reloadPlans();
  };
  const more = async () => {
    if (!cursor) return;
    const page = await request<Timeline>(`pricing-configs/changes?before=${encodeURIComponent(cursor)}`);
    setOlder((list) => [...list, ...page.applied]);
    setCursor(page.nextBefore);
  };
  return {
    data,
    loadError: timeline.error,
    zone: data?.timeZone || timeZone,
    names: data?.names ?? { plans: {}, groups: {}, resources: {} },
    bindings: data?.bindings ?? { groups: {}, resources: {}, tables: {} },
    pending: data?.pending ?? [],
    failed: data?.failed ?? [],
    applied,
    latestId: applied[0]?.id,
    cursor,
    more,
    reload,
  };
}

export type PricingChangesModel = ReturnType<typeof usePricingChanges>;

export type PricingBindingsView = Bindings;

/** Who bills through a plan in one version: groups, resources of their own, tables, by name. */
export function usersOfPlan(bindings: Bindings | null, names: Names, planId: string) {
  const of = (map: Record<string, string | null> | undefined) =>
    Object.entries(map ?? {}).filter(([, plan]) => plan === planId).map(([id]) => id);
  return {
    groups: of(bindings?.groups).map((id) => names.groups[id] ?? id),
    resources: of(bindings?.resources).map((id) => names.resources[id] ?? id),
    tables: of(bindings?.tables).map((id) => names.resources[id] ?? id),
  };
}

export function findChange(model: PricingChangesModel, id: string): Entry | null {
  return [...model.failed, ...model.pending, ...model.applied].find((entry) => entry.id === id) ?? null;
}

/** One line of a plan's own change, for the plan detail. */
export function PlanChangeLine({ item, names }: { item: PricingChangeItem; names: Names }) {
  return <span className="block text-[13px] leading-snug text-ink/80"><ChangeItemRow item={item} names={names} /></span>;
}

export { formatDateBadge };

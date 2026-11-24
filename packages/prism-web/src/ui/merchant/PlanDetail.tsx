import { useState, type ReactNode } from "react";
import { CopyPlus, History, Layers, Link2, Pencil, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n";
import { billTime } from "../bill-time";
import { planColor } from "../plan-colors";
import { PricingRing } from "./PricingRing";
import { kinds, type Pricing, type Rule } from "./Pricing";
import { pricingInZone, WEEKDAY_ORDER, weekdayKey } from "./pricing-clock";
import type { PricingChangeItem } from "@prism/core";
import { PlanChangeLine, usersOfPlan, type PricingBindingsView, type PricingNames } from "./PricingChanges";
import { money } from "./shared";

const actionButton =
  "focus-ring inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-ink/15 bg-panel px-3 py-1 text-xs font-medium text-ink transition-colors hover:border-mint/40 hover:text-mint sm:min-h-8";
const quietButton =
  "focus-ring inline-flex min-h-9 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium text-ink/60 transition-colors hover:bg-ink/5 hover:text-ink sm:min-h-8";

/** A titled block in the right pane. */
function Block({ title, icon, aside, children }: { title: string; icon: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid content-start gap-3 rounded-xl border border-ink/10 p-4">
      <div className="flex items-center gap-2">
        <span className="text-ink/45" aria-hidden="true">{icon}</span>
        <h4 className="text-sm font-semibold text-ink">{title}</h4>
        <span className="flex-1" />
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * One plan of one version of the price list: what it charges and when, what
 * bills through it and what it runs with in that version, and what that
 * version changed about it. Nothing from other versions shows here.
 */
export function PlanDetail({
  plan,
  index,
  all,
  bindings,
  names,
  zone,
  items,
  canWrite,
  onEdit,
  onRemove,
  onCopyToNow,
  onSelectPlan,
}: {
  plan: Pricing;
  /** Its place among the plans, for its color. */
  index: number;
  all: Pricing[];
  bindings: PricingBindingsView | null;
  names: PricingNames;
  zone: string;
  /** What this version changed about the plan against the one before; empty for the one in place. */
  items: PricingChangeItem[];
  /** False for a version that has passed: it is only read. */
  canWrite: boolean;
  onEdit: () => void;
  onRemove: () => void;
  /** Copy a rule from a historical version into the current version's draft. */
  onCopyToNow?: () => void;
  onSelectPlan: (id: string) => void;
}) {
  const { t } = useI18n();
  const [day, setDay] = useState(() => billTime(new Date().toISOString(), zone).date);
  const archived = plan.status === "archived";
  const local = plan.kind === "charge.fixed" ? plan : pricingInZone(plan, plan.provider.timeZone ?? "UTC", zone, day);
  const rules = local.provider.rules ?? [];
  const byId = new Map(all.map((item) => [item.id, item]));
  const relations = plan.relations ?? { requires: [], conflicts: [] };
  const requiredBy = all.filter((other) => other.status !== "archived" && other.relations?.requires.includes(plan.id));
  const conflictsWith = [
    ...relations.conflicts,
    ...all.filter((other) => other.relations?.conflicts.includes(plan.id)).map((other) => other.id),
  ].filter((id, position, list) => list.indexOf(id) === position);
  const users = usersOfPlan(bindings, names, plan.id);
  const usedBy = [
    ...users.groups.map((name) => ({ name, kind: t("资源组") })),
    ...users.resources.map((name) => ({ name, kind: t("资源") })),
    ...users.tables.map((name) => ({ name, kind: t("桌游") })),
  ];
  const unused = !archived && plan.kind !== "time.cap" && !usedBy.length && !requiredBy.length;
  const showRing = plan.kind !== "charge.fixed" && !archived;
  const planLink = (id: string) => {
    const other = byId.get(id);
    return (
      <button
        key={id}
        type="button"
        className="focus-ring rounded-full border border-ink/15 px-2.5 py-0.5 text-xs text-ink/75 transition-colors hover:border-mint/40 hover:text-mint"
        onClick={() => onSelectPlan(id)}
      >
        {other?.name ?? id}
      </button>
    );
  };

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className="mt-1.5 size-3 shrink-0 rounded-full"
            style={{ background: archived ? "#c3c8c6" : planColor(index) }}
            aria-hidden="true"
          />
          <div className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 break-words text-lg font-semibold leading-snug tracking-tight text-ink">{plan.name}</h3>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  archived ? "bg-ink/5 text-ink/50" : plan.enabled ? "bg-mint/10 text-mint" : "bg-coral/10 text-coral"
                }`}
              >
                <span className={`size-1.5 rounded-full ${archived ? "bg-ink/30" : plan.enabled ? "bg-mint" : "bg-coral"}`} aria-hidden="true" />
                {t(archived ? "已归档" : plan.enabled ? "启用" : "停用")}
              </span>
            </div>
            <p className="text-xs text-ink/55">
              {t(kinds[plan.kind])}
              {plan.kind === "charge.fixed"
                ? ` · ${money(plan.provider.amount)}`
                : ` · ${t("{count} 个时段", { count: plan.provider.rules?.length ?? 0 })}`}
            </p>
          </div>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap items-center gap-1">
            <button type="button" className={actionButton} onClick={onEdit}>
              <Pencil size={13} aria-hidden="true" />
              {t("编辑")}
            </button>
            <button type="button" className={`${quietButton} hover:bg-coral/10 hover:text-coral`} onClick={onRemove}>
              <Trash2 size={13} aria-hidden="true" />
              {t("移除")}
            </button>
          </div>
        ) : onCopyToNow ? (
          <button type="button" className={actionButton} onClick={onCopyToNow}>
            <CopyPlus size={13} aria-hidden="true" />
            {t("复制到现在")}
          </button>
        ) : null}
      </header>

      {unused && (
        <p className="rounded-xl bg-amber-500/[0.08] px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-200">
          {t("这条方案还没有被资源组、资源或其他方案的「依赖」引用，不会计费。")}
        </p>
      )}

      <div className={`grid items-start gap-4 ${showRing ? "xl:grid-cols-[minmax(0,1fr)_20rem]" : ""}`}>
        <div className="grid min-w-0 gap-4">
          {plan.kind === "charge.fixed" ? (
            <Block title={t("收费")} icon={<Layers size={14} />}>
              <p className="text-sm text-ink/75">
                {plan.provider.label} · <span className="font-semibold text-ink">{money(plan.provider.amount)}</span>
              </p>
            </Block>
          ) : (
            <Block title={t(plan.kind === "time.cap" ? "封顶设置" : "计费时段")} icon={<Layers size={14} />}>
              <PeriodTable rules={rules} kind={plan.kind} />
            </Block>
          )}

          {plan.kind === "time.priority" && (
            <Block title={t("关系与使用")} icon={<Link2 size={14} />}>
              <dl className="grid gap-2.5 text-sm sm:grid-cols-[5rem_minmax(0,1fr)]">
                <dt className="text-xs text-ink/50 sm:pt-1">{t("使用者")}</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {usedBy.length
                    ? usedBy.map((user) => (
                        <span key={`${user.kind}:${user.name}`} className="inline-flex items-center gap-1 rounded-full bg-ink/[0.05] px-2.5 py-0.5 text-xs text-ink/75">
                          <span className="text-ink/45">{user.kind}</span>
                          {user.name}
                        </span>
                      ))
                    : <span className="text-xs text-ink/40">—</span>}
                </dd>
                <dt className="text-xs text-ink/50 sm:pt-1">{t("依赖")}</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {relations.requires.length ? relations.requires.map(planLink) : <span className="text-xs text-ink/40">—</span>}
                </dd>
                <dt className="text-xs text-ink/50 sm:pt-1">{t("被依赖")}</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {requiredBy.length ? requiredBy.map((other) => planLink(other.id)) : <span className="text-xs text-ink/40">—</span>}
                </dd>
                <dt className="text-xs text-ink/50 sm:pt-1">{t("冲突")}</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {conflictsWith.length ? conflictsWith.map(planLink) : <span className="text-xs text-ink/40">—</span>}
                </dd>
              </dl>
            </Block>
          )}

          {items.length > 0 && (
            <Block title={t("这份计划的改动")} icon={<History size={14} />}>
              <div className="grid gap-1.5">
                {items.map((item, position) => <PlanChangeLine key={position} item={item} names={names} />)}
              </div>
            </Block>
          )}
        </div>
        {/* The day at a glance stays beside everything else while the pane scrolls. */}
        {showRing && (
          <div className="min-w-0 xl:sticky xl:top-0">
            <PricingRing value={local} localDate={day} onDateChange={setDay} title="当日预览" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Every period of a plan, one row each: when it applies and what it charges.
 * Clocks are in the shop's zone; archived periods stay listed, struck out.
 */
function PeriodTable({ rules, kind }: { rules: Rule[]; kind: Pricing["kind"] }) {
  const { t } = useI18n();
  const cap = kind === "time.cap";
  const days = (rule: Rule) => {
    if (rule.specificDates?.length) return rule.specificDates.join("、");
    if (rule.weekdays?.length && rule.weekdays.length < 7)
      return WEEKDAY_ORDER.filter((day) => rule.weekdays!.includes(day)).map((day) => t(weekdayKey(day))).join(" ");
    return t("每天");
  };
  const time = (rule: Rule) => {
    if (rule.dateTimeRange) return t("一次性时段");
    if (!rule.timeRange || rule.timeRange.start === rule.timeRange.end) return t("全天");
    return `${rule.timeRange.start}–${rule.timeRange.end}`;
  };
  const head = "px-3 py-2 text-left text-[11px] font-medium text-ink/50";
  const td = "px-3 py-2.5 align-top";
  return (
    <div className="overflow-x-auto rounded-lg border border-ink/10">
      <table className="w-full min-w-[30rem] text-sm">
        <thead className="bg-ink/[0.03]">
          <tr>
            <th className={head}>{t("时段")}</th>
            <th className={head}>{t("时间")}</th>
            <th className={head}>{t("日期")}</th>
            {cap ? (
              <th className={`${head} text-right`}>{t("封顶金额")}</th>
            ) : (
              <>
                <th className={`${head} text-right`}>{t("收费")}</th>
                <th className={`${head} text-right`}>{t("宽限")}</th>
                <th className={`${head} text-right`}>{t("时段封顶")}</th>
              </>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink/[0.06]">
          {[...rules].sort((a, b) => b.priority - a.priority).map((rule) => {
            const off = rule.status === "archived";
            return (
              <tr key={rule.id} className={off ? "text-ink/35 line-through" : "text-ink/80"}>
                <td className={`${td} font-medium text-ink`}>
                  {rule.label || t("未命名时段")}
                  {rule.priority !== 0 && <span className="ml-1.5 text-[11px] font-normal text-ink/40">P{rule.priority}</span>}
                </td>
                <td className={`${td} tabular-nums`}>{time(rule)}</td>
                <td className={`${td} text-xs text-ink/60`}>{days(rule)}</td>
                {cap ? (
                  <td className={`${td} text-right tabular-nums`}>{money(rule.priceCap ?? 0)}</td>
                ) : (
                  <>
                    <td className={`${td} whitespace-nowrap text-right tabular-nums`}>
                      {rule.pricing ? `${money(rule.pricing.unitPrice)} / ${rule.pricing.unitMinutes} ${t("分钟")}` : "—"}
                    </td>
                    <td className={`${td} whitespace-nowrap text-right tabular-nums text-ink/60`}>
                      {rule.pricing?.roundGraceMinutes ? `${rule.pricing.roundGraceMinutes} ${t("分钟")}` : "—"}
                    </td>
                    <td className={`${td} whitespace-nowrap text-right tabular-nums text-ink/60`}>
                      {rule.pricing?.priceCap ? money(rule.pricing.priceCap) : t("不限")}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

import { PricingRing } from "./PricingRing";
import { pricingInZone, toggleWeekday, WEEKDAY_ORDER, weekdayKey } from "./pricing-clock";
import { billTime, displayDateTime } from "../bill-time";
import { useState } from "react";
import { BillingManualButton } from "./BillingExplainer";
import { ChevronDown, Plus } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  ActionForm,
  Field,
  NumberInput,
  buttonQuiet,
  input,
  money,
  segment,
  useMerchant,
  useStaffApi,
} from "./shared";

/**
 * The plan editor and the shapes it edits. The pricing page itself, version
 * by version, is in PricingWorkbench.tsx.
 */

type Unit = {
  unitMinutes: number;
  unitPrice: number;
  roundGraceMinutes: number;
  priceCap: number;
};
export type Rule = {
  id: string;
  label: string;
  priority: number;
  status?: string;
  weekdays?: number[];
  specificDates?: string[];
  timeRange?: { start: string; end: string };
  dateTimeRange?: { start: string; end: string };
  displayDateTimeRange?: { start: string; end: string };
  pricing?: Unit;
  priceCap?: number;
};
export type Pricing = {
  id: string;
  kind: "time.priority" | "time.cap" | "charge.fixed";
  name: string;
  enabled: boolean;
  status: string;
  provider: {
    id: string;
    label?: string;
    amount?: number;
    timeZone?: string;
    rules?: Rule[];
    includedPricingConfigIds?: string[];
  };
  /** How a time plan runs alongside others; only `time.priority` carries it. */
  relations?: { requires: string[]; conflicts: string[] };
  createdAt?: string;
};
/** A scheduled change that will override a direct save, as the server reports it. */
export type PendingConflict = { changeId: string; effectiveAt: string; plans: string[]; bindings: string[] };

export const kinds = {
  "time.priority": "按时计费",
  "charge.fixed": "固定收费",
  "time.cap": "消费封顶",
};
/** A time-plan period: it has a price and the plan's cap. */
export const newRule = (): Rule => ({
  id: crypto.randomUUID(),
  label: "",
  priority: 0,
  timeRange: { start: "00:00", end: "00:00" },
  pricing: {
    unitMinutes: 60,
    unitPrice: 10,
    roundGraceMinutes: 0,
    priceCap: 0,
  },
  priceCap: 0,
});

/**
 * A cap period: it states only how much may be charged in it. A price here
 * would make it a time plan's period, which the server refuses.
 */
const newCapRule = (): Rule => ({
  id: crypto.randomUUID(),
  label: "",
  priority: 0,
  timeRange: { start: "00:00", end: "00:00" },
  priceCap: 10,
});

/** A period of the right shape for the kind being edited. */
const newRuleFor = (kind: Pricing["kind"]): Rule => (kind === "time.cap" ? newCapRule() : newRule());

/** The one line a collapsed period shows, so its settings stay readable. */
export function ruleSummary(rule: Rule, kind: Pricing["kind"], t: (key: string) => string) {
  const time = rule.timeRange
    ? `${rule.timeRange.start}–${rule.timeRange.end}`
    : null;
  if (kind === "time.cap")
    return [
      rule.label || t("未命名时段"),
      time,
      money(rule.priceCap ?? 0),
    ]
      .filter(Boolean)
      .join(" · ");
  const pricing = rule.pricing;
  return [
    rule.label || t("未命名时段"),
    time,
    pricing
      ? `${money(pricing.unitPrice)} / ${pricing.unitMinutes} ${t("分钟")}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function PricingEditor({
  value,
  all,
  done,
  onSave,
  submitLabel,
  onConflicts,
  onSaved,
}: {
  value: Pricing;
  all: Pricing[];
  done: () => void;
  /**
   * Keeps the plan instead of saving it: the workbench stages edits across
   * rules and saves the whole version at once. Gets the plan as stored (UTC
   * clocks), with an ID even when new.
   */
  onSave?: (plan: Pricing) => void | Promise<unknown>;
  submitLabel?: string;
  /** Scheduled changes that will override this save, from the server. */
  onConflicts?: (conflicts: PendingConflict[]) => void;
  /** The saved plan's ID, once the server has it. */
  onSaved?: (id: string | undefined) => void;
}) {
  const { t } = useI18n();
  const request = useStaffApi();
  const { timeZone } = useMerchant();
  const displayTimeZone =
    timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [day, setDay] = useState(() =>
    billTime(new Date().toISOString(), displayTimeZone).date,
  );
  const [draft, setDraft] = useState(() =>
    pricingInZone(
      value,
      value.id ? (value.provider.timeZone ?? "UTC") : displayTimeZone,
      displayTimeZone,
      day,
    ),
  );
  // Periods start collapsed: a rule with four periods used to be a 2000px
  // form. Opening one at a time keeps the current period in view.
  const [openRule, setOpenRule] = useState<number | null>(null);
  const rules = draft.provider.rules ?? [];
  const changeDay = (nextDay: string) => {
    setDraft(
      pricingInZone(
        pricingInZone(draft, displayTimeZone, "UTC", day),
        "UTC",
        displayTimeZone,
        nextDay,
      ),
    );
    setDay(nextDay);
  };
  const update = (patch: Partial<Pricing>) => setDraft({ ...draft, ...patch });
  const provider = (patch: Partial<Pricing["provider"]>) =>
    update({ provider: { ...draft.provider, ...patch } });
  const changeRule = (index: number, patch: Partial<Rule>) =>
    provider({
      rules: rules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    });
  const openPeriod = (index: number) => {
    setOpenRule(index);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-period="${index}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    });
  };
  /** Returns the first reason the draft cannot be saved. */
  const firstProblem = (): { message: string; period?: number } | null => {
    if (!draft.name.trim()) return { message: t("请填写方案名称") };
    if (draft.kind === "charge.fixed") {
      if (!draft.provider.label?.trim())
        return { message: t("请填写账单名称") };
      if ((draft.provider.amount ?? 0) < 0)
        return { message: t("金额不能为负数") };
      return null;
    }
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index]!;
      if (!rule.label.trim())
        return { message: t("请填写时段名称"), period: index };
      if (draft.kind === "time.cap") {
        if (!((rule.priceCap ?? 0) > 0))
          return { message: t("封顶金额需要大于 0"), period: index };
      } else if (rule.pricing) {
        if (!(rule.pricing.unitMinutes > 0))
          return { message: t("每隔分钟数需要大于 0"), period: index };
      }
    }
    return null;
  };
  return (
    <ActionForm
      sticky
      noValidate
      label={submitLabel}
      done={done}
      submit={() => {
        const problem = firstProblem();
        if (problem) {
          // Browsers cannot focus a field in a collapsed period, so the check
          // runs here and opens the period that needs attention.
          if (problem.period !== undefined) openPeriod(problem.period);
          throw new Error(problem.message);
        }
        const body = {
          kind: draft.kind,
          name: draft.name.trim(),
          enabled: draft.enabled,
          provider: pricingInZone(draft, displayTimeZone, "UTC", day).provider,
          ...(draft.kind === "time.priority"
            ? { relations: draft.relations ?? { requires: [], conflicts: [] } }
            : {}),
        };
        if (onSave) {
          return Promise.resolve(onSave({ ...draft, ...body, id: draft.id || crypto.randomUUID(), status: draft.status || "active" }));
        }
        return request<{ pendingConflicts?: PendingConflict[]; pricingConfig?: { id: string } }>(
          `pricing-configs${draft.id ? `/${segment(draft.id)}` : ""}`,
          draft.id ? "PATCH" : "POST",
          body,
        ).then((result) => {
          if (result?.pendingConflicts?.length) onConflicts?.(result.pendingConflicts);
          onSaved?.(result?.pricingConfig?.id);
          return result;
        });
      }}
    >
      {/* Name, kind and whether it bills, on one line; the periods below are the work. */}
      <section className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto]">
          <Field label="名称">
            <input
              className={input}
              required
              maxLength={80}
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          </Field>
          <Field label="计费方式">
            <select
              className={input}
              value={draft.kind}
              disabled={!!draft.id}
              onChange={(e) => {
                const kind = e.target.value as Pricing["kind"];
                update({
                  kind,
                  provider:
                    kind === "charge.fixed"
                      ? { id: draft.provider.id, label: draft.name, amount: 10 }
                      : { id: draft.provider.id, rules: [newRuleFor(kind)] },
                });
                setOpenRule(null);
              }}
            >
              {Object.entries(kinds).map(([key, label]) => (
                <option key={key} value={key}>
                  {t(label)}
                </option>
              ))}
            </select>
          </Field>
        <label className="flex min-h-11 items-center gap-3 self-end text-sm">
          <input
            type="checkbox"
            role="switch"
            className="peer sr-only"
            checked={draft.enabled}
            disabled={draft.status === "archived"}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          <span
            aria-hidden="true"
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              draft.enabled ? "bg-mint" : "bg-ink/20"
            } after:absolute after:left-0.5 after:top-0.5 after:size-5 after:rounded-full after:bg-white after:transition-transform ${
              draft.enabled ? "after:translate-x-5" : ""
            } peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-mint`}
          />
          <span className="font-medium">
            {t(draft.enabled ? "启用" : "停用")}
          </span>
        </label>
      </section>

      {draft.kind === "charge.fixed" ? (
        <section className="grid gap-3">
          <h3 className="text-sm font-semibold">{t("收费")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="账单名称">
              <input
                className={input}
                required
                value={draft.provider.label ?? ""}
                onChange={(e) => provider({ label: e.target.value })}
              />
            </Field>
            <Field label="金额">
              <NumberInput
                className={input}
                required
                value={draft.provider.amount ?? 0}
                onChange={(amount) => provider({ amount })}
              />
            </Field>
          </div>
        </section>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start">
          <section className="grid gap-3">
            <div className="flex items-center gap-1">
              <h3 className="text-sm font-semibold">
                {t(draft.kind === "time.cap" ? "封顶设置" : "计费时段")}
              </h3>
              <BillingManualButton section="fields" />
            </div>

          <div className="grid gap-2">
            {rules.map((rule, index) => (
              <PeriodCard
                key={rule.id}
                index={index}
                rule={rule}
                kind={draft.kind}
                open={openRule === index}
                onToggle={() => setOpenRule(openRule === index ? null : index)}
                canRemove={rules.length > 1}
                onRemove={() =>
                  provider({
                    rules: rules.filter((_, i) => i !== index),
                  })
                }
                onChange={(patch) => changeRule(index, patch)}
                weekdaysLabel={(day) => t(weekdayKey(day))}
                t={t}
              />
            ))}
            <button
              type="button"
              className={`${buttonQuiet} min-h-10 justify-self-start px-2 text-sm`}
              onClick={() => {
                provider({ rules: [...rules, newRuleFor(draft.kind)] });
                setOpenRule(rules.length);
              }}
            >
              <Plus size={15} />
              {t("添加时段")}
            </button>
          </div>
          </section>
          {/* The day at a glance stays beside the periods; a segment opens its period. */}
          <div className="lg:sticky lg:top-0">
            <PricingRing
              value={draft}
              localDate={day}
              onDateChange={changeDay}
              title="当日预览"
              onSelect={(id) => {
                const index = rules.findIndex((r) => r.id === id);
                if (index >= 0) openPeriod(index);
              }}
            />
          </div>
        </div>
      )}

      {draft.kind === "time.priority" && (
        <PlanRelations
          draft={draft}
          all={all}
          change={(relations) => update({ relations })}
        />
      )}
    </ActionForm>
  );
}

/**
 * One period: the header states the rule in one line, and the fields only
 * exist while the period is open.
 */
/**
 * Which other time plans must run with this one, and which may never run with
 * it. A conflict holds both ways, so one declared by the other plan shows here
 * as fixed rather than as a choice.
 */
function PlanRelations({
  draft,
  all,
  change,
}: {
  draft: Pricing;
  all: Pricing[];
  change: (relations: { requires: string[]; conflicts: string[] }) => void;
}) {
  const { t } = useI18n();
  const relations = draft.relations ?? { requires: [], conflicts: [] };
  const others = all.filter(
    (p) => p.id !== draft.id && p.kind === "time.priority" && p.status !== "archived",
  );
  const declaredBy = (p: Pricing) => !!draft.id && (p.relations?.conflicts ?? []).includes(draft.id);
  const toggle = (field: "requires" | "conflicts", id: string, on: boolean) =>
    change({
      ...relations,
      [field]: on ? [...relations[field], id] : relations[field].filter((item) => item !== id),
    });
  if (!others.length) return null;
  const row = (field: "requires" | "conflicts", label: string) => (
    <div className="grid gap-2 sm:grid-cols-[4rem_minmax(0,1fr)] sm:items-start">
      <span className="pt-1.5 text-sm font-medium">{t(label)}</span>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t(label)}>
        {others.map((p) => {
          const fixed = field === "conflicts" && declaredBy(p);
          const on = relations[field].includes(p.id) || fixed;
          // A plan cannot be both needed and excluded.
          const blocked = field === "requires" ? relations.conflicts.includes(p.id) || declaredBy(p) : relations.requires.includes(p.id);
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              disabled={fixed || (blocked && !on)}
              title={fixed ? t("由该方案设置") : undefined}
              className={`focus-ring rounded-full border px-3 py-1 text-sm transition-colors disabled:opacity-40 ${
                on
                  ? field === "requires"
                    ? "border-mint/50 bg-mint/15 text-ink"
                    : "border-coral/50 bg-coral/10 text-ink"
                  : "border-ink/15 text-ink/60 hover:border-ink/30 hover:text-ink"
              }`}
              onClick={() => toggle(field, p.id, !on)}
            >
              {p.name}
            </button>
          );
        })}
      </div>
    </div>
  );
  return (
    <section className="grid gap-3 border-t border-ink/10 pt-4">
      <h3 className="text-sm font-semibold">{t("方案关系")}</h3>
      {row("requires", "依赖")}
      {row("conflicts", "冲突")}
      <p className="text-xs leading-relaxed text-ink/55">
        {t("开始本方案时，依赖的方案会同时开始（已在计费的不重新计时），冲突的方案会结束（已产生的费用仍在账单里）。冲突是双向的。")}
      </p>
    </section>
  );
}

function PeriodCard({
  index,
  rule,
  kind,
  open,
  onToggle,
  canRemove,
  onRemove,
  onChange,
  weekdaysLabel,
  t,
}: {
  index: number;
  rule: Rule;
  kind: Pricing["kind"];
  open: boolean;
  onToggle: () => void;
  canRemove: boolean;
  onRemove: () => void;
  onChange: (patch: Partial<Rule>) => void;
  weekdaysLabel: (day: number) => string;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  const { timeZone } = useMerchant();
  return (
    <div
      data-period={index}
      className={`rounded-xl border transition-colors ${
        open ? "border-mint/40 bg-mint/[0.03]" : "border-ink/10 bg-panel"
      }`}
    >
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          className="focus-ring flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">
              {`${t("时段")} ${index + 1}`}
            </span>
            <span className="mt-0.5 block text-xs text-ink/55">
              {ruleSummary(rule, kind, t)}
            </span>
          </span>
          <ChevronDown
            size={16}
            className={`mt-0.5 shrink-0 text-ink/35 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
        {canRemove && (
          <button
            type="button"
            className={`${buttonQuiet} min-h-9 shrink-0 px-2 text-xs text-coral`}
            onClick={onRemove}
          >
            {t("移除")}
          </button>
        )}
      </div>
      {open && (
        <div className="grid gap-3 border-t border-ink/10 p-4">
          <Field label="名称">
            <input
              className={input}
              required
              value={rule.label}
              onChange={(e) => onChange({ label: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="开始">
              <input
                className={input}
                type="time"
                required
                value={rule.timeRange?.start ?? "00:00"}
                onChange={(e) =>
                  onChange({
                    timeRange: {
                      start: e.target.value,
                      end: rule.timeRange?.end ?? "00:00",
                    },
                  })
                }
              />
            </Field>
            <Field label="结束">
              <input
                className={input}
                type="time"
                required
                value={rule.timeRange?.end ?? "00:00"}
                onChange={(e) =>
                  onChange({
                    timeRange: {
                      start: rule.timeRange?.start ?? "00:00",
                      end: e.target.value,
                    },
                  })
                }
              />
            </Field>
          </div>
          <p className="text-xs text-ink/50">
            {t("开始与结束相同表示全天。")}
          </p>
          {kind === "time.cap" ? (
            <Field label="封顶金额" unit="元">
              <NumberInput
                className={input}
                required
                value={rule.priceCap ?? 0}
                onChange={(priceCap) => onChange({ priceCap })}
              />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  ["unitMinutes", "计费间隔", "分钟", true, false],
                  // A negative price is a discount on that period, so no floor.
                  ["unitPrice", "收费金额", "元", false, true],
                  ["roundGraceMinutes", "宽限时长", "分钟", true, false],
                  ["priceCap", "时段封顶", "元", false, false],
                ] as const
              ).map(([key, label, unit, integer, allowNegative]) => (
                <Field
                  key={key}
                  label={label}
                  unit={key === "priceCap" && !rule.pricing?.priceCap ? "不限" : unit}
                >
                  <NumberInput
                    className={input}
                    required
                    integer={integer}
                    allowNegative={allowNegative}
                    aria-describedby={key === "unitPrice" ? "negative-price-note" : undefined}
                    value={rule.pricing?.[key] ?? 0}
                    onChange={(next) =>
                      onChange({
                        pricing: {
                          ...rule.pricing!,
                          [key]: next,
                        },
                      })
                    }
                  />
                </Field>
              ))}
              <p id="negative-price-note" className="col-span-2 text-xs text-ink/50">
                {t("负数表示在该时段减免（例如活动价）。")}
              </p>
            </div>
          )}
          <details>
            <summary className="cursor-pointer py-2 text-sm text-ink/60">
              {t("日期与优先级")}
            </summary>
            <div className="mt-3 grid gap-3">
              <Field label="优先级">
                <NumberInput
                  className={input}
                  integer
                  allowNegative
                  required
                  value={rule.priority}
                  onChange={(priority) => onChange({ priority })}
                />
              </Field>
              <div className="flex flex-wrap gap-3">
                {WEEKDAY_ORDER.map((day) => (
                  <label className="flex gap-1 text-sm" key={day}>
                    <input
                      type="checkbox"
                      checked={rule.weekdays?.includes(day) ?? true}
                      onChange={(e) =>
                        onChange({
                          weekdays: toggleWeekday(
                            rule.weekdays,
                            day,
                            e.target.checked,
                          ),
                        })
                      }
                    />
                    {weekdaysLabel(day)}
                  </label>
                ))}
              </div>
              <Field label="指定日期">
                <input
                  className={input}
                  placeholder="2026-10-01, 2026-10-02"
                  value={rule.specificDates?.join(", ") ?? ""}
                  onChange={(e) =>
                    onChange({
                      specificDates: e.target.value
                        ? e.target.value.split(",").map((s) => s.trim())
                        : undefined,
                    })
                  }
                />
              </Field>
              {rule.dateTimeRange && (
                // Only prism-neo imports carry an absolute start and end. Dates a
                // price list changes from are a scheduled change now, so this
                // is shown, not edited; the period can still be removed.
                <p className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-ink/15 px-3 py-2 text-xs text-ink/60">
                  {t("旧系统导入的一次性时段：{start} – {end}", {
                    start: displayDateTime(rule.dateTimeRange.start, timeZone),
                    end: displayDateTime(rule.dateTimeRange.end, timeZone),
                  })}
                  {new Date(rule.dateTimeRange.end).getTime() < Date.now() && (
                    <span className="rounded-full bg-coral/10 px-2 py-0.5 text-coral">{t("已过期")}</span>
                  )}
                </p>
              )}
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={rule.status !== "archived"}
                  onChange={(e) =>
                    onChange({
                      status: e.target.checked ? "active" : "archived",
                    })
                  }
                />
                {t("启用时段")}
              </label>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

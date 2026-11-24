import { Fragment, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Clock3, CopyPlus, Lock, Plus, RotateCcw, Trash2, Zap } from "lucide-react";
import { parseLocalDateTime, type PricingChangeItem } from "@prism/core";
import { useI18n } from "../../i18n";
import { billTime, displayDateTime } from "../bill-time";
import { ItemList, describeNote, formatDateBadge, type PricingChangeEntry, type PricingChangesModel, type PricingNames } from "./PricingChanges";
import { ActionForm, Field, Modal, buttonQuiet, input } from "./shared";

/**
 * The price list as versions on one line: the one in place now, the ones
 * scheduled after it, and (on demand) the ones before it. Picking a version
 * shows that whole price list in the workbench below. See docs/pricing-changes.md.
 */

export type VersionRef = { kind: "now" } | { kind: "change"; id: string };
export type VersionMode = "now" | "future" | "past" | "failed";

export function versionMode(entry: PricingChangeEntry | null): VersionMode {
  if (!entry) return "now";
  if (entry.status === "pending") return "future";
  if (entry.status === "failed") return "failed";
  return "past";
}

/** Which plans and bindings a version changed against the one before it. */
export function versionMarks(items: PricingChangeItem[]) {
  const plans = new Map<string, "new" | "changed" | "archived">();
  const bindings = new Set<string>();
  for (const item of items) {
    if (item.kind === "binding-changed") {
      bindings.add(`${item.target === "group" ? "groups" : item.target === "resource" ? "resources" : "tables"}:${item.targetId}`);
      continue;
    }
    if (item.kind === "plan-added") plans.set(item.planId, "new");
    else if (item.kind === "plan-archived") plans.set(item.planId, "archived");
    else if (!plans.has(item.planId)) plans.set(item.planId, "changed");
  }
  return { plans, bindings };
}

function TrackSegment({ kind }: { kind: "solid" | "dashed" | "faint" }) {
  return (
    <li className="flex shrink-0 items-center" aria-hidden="true">
      <span
        className={
          kind === "solid"
            ? "h-px w-5 bg-ink/20"
            : kind === "dashed"
              ? "w-5 border-t border-dashed border-sky-500/45"
              : "w-4 border-t border-dashed border-ink/15"
        }
      />
    </li>
  );
}

function Node({
  label,
  caption,
  tone,
  selected,
  onClick,
  nodeRef,
}: {
  label: ReactNode;
  caption: string;
  tone: "past" | "now" | "future" | "failed";
  selected: boolean;
  onClick: () => void;
  nodeRef?: Ref<HTMLLIElement>;
}) {
  const dot = {
    past: selected ? "size-2 bg-ink/70" : "size-2 bg-ink/30",
    now: "size-2.5 bg-mint ring-[3px] ring-mint/20",
    future: selected
      ? "size-2 bg-sky-500 ring-[3px] ring-sky-500/20"
      : "size-2 border-[1.5px] border-sky-500 bg-panel",
    failed: selected
      ? "size-2 bg-coral ring-[3px] ring-coral/20"
      : "size-2 border-[1.5px] border-coral bg-panel",
  }[tone];
  const card = {
    past: selected
      ? "border-ink/35 bg-ink/[0.06] text-ink shadow-xs ring-1 ring-ink/15"
      : "border-ink/10 bg-panel text-ink/75 hover:border-ink/25 hover:text-ink",
    now: selected
      ? "border-mint/50 bg-mint/[0.08] text-mint shadow-xs ring-1 ring-mint/20"
      : "border-ink/12 bg-panel text-ink hover:border-mint/45",
    future: selected
      ? "border-sky-500/55 bg-sky-500/[0.08] text-sky-700 shadow-xs ring-1 ring-sky-500/20 dark:text-sky-300"
      : "border-ink/12 bg-panel text-ink hover:border-sky-500/45",
    failed: selected
      ? "border-coral/55 bg-coral/[0.08] text-coral shadow-xs ring-1 ring-coral/20"
      : "border-coral/30 bg-panel text-coral hover:border-coral/50",
  }[tone];
  return (
    <li ref={nodeRef} className="flex shrink-0 items-center">
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onClick}
        className={`focus-ring flex items-center gap-2.5 rounded-xl border px-3 py-1.5 text-left transition-all ${card}`}
      >
        <span className={`shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <span className="grid min-w-0 leading-tight">
          <span className="whitespace-nowrap text-xs font-semibold tabular-nums">{label}</span>
          <span
            className={`mt-0.5 max-w-[9rem] truncate text-[11px] ${
              selected && tone === "now"
                ? "text-mint/80"
                : selected && tone === "future"
                  ? "text-sky-700/75 dark:text-sky-300/80"
                  : tone === "failed"
                    ? "text-coral/80"
                    : "text-ink/50"
            }`}
          >
            {caption}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * Now, then what is scheduled, left to right along a single track. The pill at
 * the left of "now" expands historical schedules oldest-to-newest, scrolled so
 * "now" stays in view.
 */
export function VersionBar({
  model,
  selected,
  onSelect,
  onAddFuture,
  canWrite,
}: {
  model: PricingChangesModel;
  selected: VersionRef;
  onSelect: (version: VersionRef) => void;
  onAddFuture: () => void;
  canWrite: boolean;
}) {
  const { t, locale } = useI18n();
  const [history, setHistory] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const nowNode = useRef<HTMLLIElement>(null);
  const zone = model.zone;
  const past = model.applied.filter((entry) => entry.id !== model.latestId).reverse();
  const hasPast = past.length > 0 || Boolean(model.cursor);
  const future = [...model.failed, ...model.pending].sort((a, b) => (a.effectiveAt ?? "").localeCompare(b.effectiveAt ?? ""));
  const isSelected = (id: string) => selected.kind === "change" && selected.id === id;
  const pastSelected = selected.kind === "change" && past.some((entry) => entry.id === selected.id);
  const short = (iso: string) => {
    const badge = formatDateBadge(iso, zone, locale);
    return `${badge.month}${badge.day} ${badge.time}`;
  };
  // Opening history keeps "now" where the eye is, with the past to its left.
  useEffect(() => {
    if (!history) return;
    const box = scroller.current;
    const node = nowNode.current;
    if (box && node) box.scrollLeft = Math.max(0, node.offsetLeft - box.clientWidth / 3);
  }, [history]);
  // A selected schedule in the past opens the history it belongs to.
  useEffect(() => {
    if (pastSelected) setHistory(true);
  }, [pastSelected]);
  const toggleHistory = () => {
    if (history && pastSelected) onSelect({ kind: "now" });
    setHistory(!history);
  };

  return (
    <div className="border-b border-ink/10 bg-ink/[0.018]">
      <div ref={scroller} className="min-w-0 overflow-x-auto overscroll-x-contain [scrollbar-width:thin]">
        <ol className="flex w-max items-center px-3.5 py-2.5">
          <li className="flex shrink-0 items-center">
            <button
              type="button"
              disabled={!hasPast}
              aria-pressed={history}
              title={t(!hasPast ? "还没有历史计划" : history ? "收起历史计划" : "查看历史计划")}
              aria-label={t(!hasPast ? "还没有历史计划" : history ? "收起历史计划" : "查看历史计划")}
              onClick={toggleHistory}
              className={`focus-ring inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                history
                  ? "border-ink/20 bg-ink/[0.06] text-ink/80 hover:bg-ink/[0.1]"
                  : "border-ink/12 bg-panel text-ink/60 hover:border-ink/25 hover:text-ink"
              }`}
            >
              {history ? (
                <>
                  <span>{t("收起")}</span>
                  <ChevronRight size={13} aria-hidden="true" />
                </>
              ) : (
                <>
                  <ChevronLeft size={13} aria-hidden="true" />
                  <span>{t("历史")}</span>
                </>
              )}
            </button>
          </li>
          <TrackSegment kind={history && hasPast ? "solid" : "faint"} />
          {history && (
            <>
              {model.cursor && (
                <>
                  <li className="flex shrink-0 items-center">
                    <button
                      type="button"
                      className={`${buttonQuiet} min-h-8 rounded-full border border-ink/12 bg-panel px-2.5 text-xs`}
                      onClick={model.more}
                    >
                      {t("更早")}
                    </button>
                  </li>
                  <TrackSegment kind="solid" />
                </>
              )}
              {past.map((entry) => (
                <Fragment key={entry.id}>
                  <Node
                    label={short(entry.appliedAt!)}
                    caption={entry.note || entry.actorName || t("早期记录")}
                    tone="past"
                    selected={isSelected(entry.id)}
                    onClick={() => onSelect({ kind: "change", id: entry.id })}
                  />
                  <TrackSegment kind="solid" />
                </Fragment>
              ))}
            </>
          )}
          <Node
            nodeRef={nowNode}
            label={t("现在")}
            caption={t("生效中")}
            tone="now"
            selected={selected.kind === "now"}
            onClick={() => onSelect({ kind: "now" })}
          />
          {future.map((entry) => (
            <Fragment key={entry.id}>
              <TrackSegment kind="dashed" />
              <Node
                label={short(entry.effectiveAt!)}
                caption={entry.status === "failed" ? t("未生效") : entry.note || t("调价")}
                tone={entry.status === "failed" ? "failed" : "future"}
                selected={isSelected(entry.id)}
                onClick={() => onSelect({ kind: "change", id: entry.id })}
              />
            </Fragment>
          ))}
          {canWrite && (
            <>
              <TrackSegment kind="faint" />
              <li className="flex shrink-0 items-center">
                <button
                  type="button"
                  className="focus-ring inline-flex items-center gap-1 whitespace-nowrap rounded-xl border border-dashed border-sky-500/45 bg-panel/60 px-3 py-2 text-xs font-medium text-sky-700 transition-colors hover:border-sky-500 hover:bg-sky-500/[0.07] dark:text-sky-300"
                  onClick={onAddFuture}
                >
                  <Plus size={13} aria-hidden="true" />
                  {t("未来计划")}
                </button>
              </li>
            </>
          )}
        </ol>
      </div>
    </div>
  );
}

const bannerButton =
  "focus-ring inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-ink/15 bg-panel px-2.5 text-xs font-medium text-ink transition-colors hover:border-mint/40 hover:text-mint disabled:opacity-50";

/** What a non-current version is, what it changed, and what can be done with it. */
export function VersionBanner({
  model,
  entry,
  names = model.names,
  canWrite,
  busy,
  dirty = false,
  onEditTime,
  onApplyNow,
  onDelete,
  onCopyToFuture,
  onRestoreNow,
}: {
  model: PricingChangesModel;
  entry: PricingChangeEntry | null;
  names?: PricingNames;
  canWrite: boolean;
  busy: boolean;
  dirty?: boolean;
  onEditTime: () => void;
  onApplyNow: () => void;
  onDelete: () => void;
  onCopyToFuture: () => void;
  onRestoreNow: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [entry?.id]);
  const mode = versionMode(entry);
  if (mode === "now" || !entry) return null;
  const zone = model.zone;
  const tone = {
    future: "bg-sky-500/[0.06]",
    past: "bg-ink/[0.03]",
    failed: "bg-coral/[0.06]",
  }[mode];
  const icon = {
    future: <Clock3 size={15} className="text-sky-600 dark:text-sky-300" />,
    past: <Lock size={14} className="text-ink/45" />,
    failed: <AlertTriangle size={15} className="text-coral" />,
  }[mode];
  const title = mode === "past"
    ? t("{time} 的计划", { time: displayDateTime(entry.appliedAt!, zone) })
    : t("{time} 起生效的计划", { time: displayDateTime(entry.effectiveAt!, zone) });
  const items = entry.items;
  const meta = [entry.note, entry.actorName].filter(Boolean).join(" · ");

  return (
    <div className={`border-b border-ink/10 px-4 py-2 ${tone}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span aria-hidden="true">{icon}</span>
        <span className="text-sm font-semibold text-ink">{title}</span>
        {mode === "past" && <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-ink/55">{t("只读")}</span>}
        {meta && <span className="text-xs text-ink/55">{meta}</span>}
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-ink/60 hover:text-ink"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {t("相比上一份计划 {count} 项改动", { count: items.length })}
          <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
        <span className="flex-1" />
        {canWrite && mode === "future" && (
          <>
            <button
              type="button"
              className={bannerButton}
              disabled={busy || dirty}
              title={dirty ? t("请先保存或放弃未保存的修改") : undefined}
              onClick={onEditTime}
            >
              {t("改时间与备注")}
            </button>
            <button
              type="button"
              className={bannerButton}
              disabled={busy || dirty}
              title={dirty ? t("请先保存或放弃未保存的修改") : undefined}
              onClick={onApplyNow}
            >
              <Zap size={13} aria-hidden="true" />
              {t("立即生效")}
            </button>
            <button type="button" className={`${bannerButton} hover:border-coral/40 hover:text-coral`} disabled={busy} onClick={onDelete}>
              <Trash2 size={13} aria-hidden="true" />
              {t("删除此计划")}
            </button>
          </>
        )}
        {canWrite && mode === "failed" && (
          <button type="button" className={`${bannerButton} hover:border-coral/40 hover:text-coral`} disabled={busy} onClick={onDelete}>
            <Trash2 size={13} aria-hidden="true" />
            {t("删除此计划")}
          </button>
        )}
        {canWrite && mode === "past" && (
          <>
            <button type="button" className={bannerButton} onClick={onCopyToFuture}>
              <CopyPlus size={13} aria-hidden="true" />
              {t("以此创建未来计划")}
            </button>
            <button type="button" className={bannerButton} disabled={busy} onClick={onRestoreNow}>
              <RotateCcw size={13} aria-hidden="true" />
              {t("覆盖现在")}
            </button>
          </>
        )}
      </div>
      {(mode === "failed" || mode === "past") && entry.notes.length > 0 && (
        <ul className={`mt-1.5 grid gap-0.5 text-xs ${mode === "failed" ? "text-coral" : "text-amber-700 dark:text-amber-300"}`}>
          {entry.notes.map((note, index) => <li key={index}>{describeNote(note, names, t)}</li>)}
        </ul>
      )}
      {open && (
        <div className="mt-2 rounded-lg border border-ink/10 bg-panel px-3 py-2">
          <ItemList items={items} names={names} />
        </div>
      )}
    </div>
  );
}

/** Tomorrow 00:00 in the shop's zone, as a `datetime-local` value. */
export function tomorrowMidnight(timeZone: string): string {
  const today = billTime(new Date().toISOString(), timeZone).date;
  const next = new Date(`${today}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)}T00:00`;
}

export function localInput(iso: string, timeZone: string): string {
  const parts = billTime(iso, timeZone);
  return `${parts.date}T${parts.time.slice(0, 5)}`;
}

function toIso(local: string, timeZone: string): string | null {
  const [date, time] = local.split("T");
  if (!date || !time) return null;
  try {
    return parseLocalDateTime(date, time.slice(0, 5), timeZone).toISOString();
  } catch {
    return null;
  }
}

/** When a future version takes effect, and what it is for. */
export function VersionTimeDialog({
  title,
  label,
  timeZone,
  initial,
  close,
  submit,
}: {
  title: string;
  label: string;
  timeZone: string;
  initial: { at: string; note: string };
  close: () => void;
  submit: (value: { effectiveAt: string; note: string | null }) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [at, setAt] = useState(initial.at);
  const [note, setNote] = useState(initial.note);
  return (
    <Modal title={title} close={close}>
      <ActionForm
        label={label}
        done={close}
        submit={() => {
          const effectiveAt = toIso(at, timeZone);
          if (!effectiveAt) throw new Error(t("请选择生效时间"));
          return submit({ effectiveAt, note: note.trim() || null });
        }}
      >
        <Field label="生效时间">
          <input className={input} type="datetime-local" required value={at} onChange={(event) => setAt(event.target.value)} />
        </Field>
        <Field label="备注">
          <input
            className={input}
            maxLength={200}
            placeholder={t("例如：12 月调价、节假日计划")}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <p className="text-xs leading-relaxed text-ink/55">
          {t("到点时仍在店的玩家按原计划计费，结账后再入场才用新计划。")}
          {!at.endsWith("T00:00") && ` ${t("不在零点生效时，当天已封顶的玩家再次入场会重新累计封顶。")}`}
        </p>
      </ActionForm>
    </Modal>
  );
}

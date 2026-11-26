import type { StaffReportCheckout } from "@prism/application";
import { browserCheckoutPreview } from "../../browser-billing";
import { billTime, groupByDate, shortDateLabel } from "../bill-time";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Link2, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { shopApi } from "../BillingPages";
import { BillLegend, BillTimeline, BillTotal } from "../BillTimeline";
import { planColor } from "../plan-colors";
import { liveBilling, stayDuration } from "./live-billing";
import { payment, ReportDetail } from "./Reports";
import {
  ActionForm,
  button,
  buttonQuiet,
  date,
  Field,
  input,
  Modal,
  money,
  primary,
  segment,
  staffMessage,
  State,
  useMerchant,
  useResource,
  useStaffApi,
  type Asset,
  type LivePlayer,
  type Player,
  type Preview,
  type Roster,
} from "./shared";
import { useLiveBilling } from "./use-live-billing";

type EntryPlan = {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  status: string;
  billStatus?: string;
};

/** Stable identity for snapshots without live-player payloads. */
const NO_PLAYERS: LivePlayer[] = [];

type Row = Player & {
  stayMinutes?: number;
  estimatedTotal?: number | null;
  planNames?: string[];
  startedAt?: string;
  sessionCount?: number;
  billStatus?: string;
};

type HoldingItem = {
  id: string;
  assetType?: string;
  assetCode?: string;
  assetName: string | null;
  quantity: number;
  activeAt?: string | null;
  expiresAt: string | null;
  metadata?: Record<string, unknown> | null;
  availability?: "available" | "unavailable";
  unavailableReasons?: string[];
};

type LedgerItem = {
  id: string;
  assetType?: string;
  assetCode?: string;
  assetName: string;
  delta: number;
  reason: string;
  createdAt: string;
};

type Holdings = {
  holdings: HoldingItem[];
  ledgerEntries: LedgerItem[];
};

export type LiveSummary = {
  present: number;
  unpaid: number;
  shortBalanceCount: number;
  estimatedTotal: number;
  loaded: boolean;
};

type QuickFilter = "all" | "funded" | "disabled";
type ProfileTab = "bill" | "assets" | "checkouts" | "ledger" | "identity" | "settings";
type StatusTone = "mint" | "emerald" | "amber" | "coral" | "neutral";
type Translate = ReturnType<typeof useI18n>["t"];

const STATUS_DOT_TEXT: Record<StatusTone, string> = {
  mint: "text-mint",
  emerald: "text-[#23815d] dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  coral: "text-coral",
  neutral: "text-ink/55",
};

function identityProviderLabel(provider: string, t: Translate): string {
  return provider === "web-account" ? t("PRiSM 账号") : provider;
}

function identityValueLabel(identity: NonNullable<Player["identities"]>[number]): string {
  return identity.displayName ? `${identity.displayName} · ${identity.subject}` : identity.subject;
}

function formatIdentityText(
  identity: NonNullable<Player["identities"]>[number],
  t: Translate,
): string {
  return `${identityProviderLabel(identity.provider, t)}: ${identityValueLabel(identity)}`;
}

function shortfallAmount(player: Row, livePlayer: LivePlayer | null): number {
  if (player.paymentMode === "cashier") return 0;
  const due = livePlayer?.estimatedTotal ?? player.estimatedTotal;
  if (due == null || due <= player.walletTotal) return 0;
  return Math.round((due - player.walletTotal) * 100) / 100;
}

function playerStatusMeta(
  player: Row,
  live: boolean,
  livePlayer: LivePlayer | null,
): { label: string; tone: StatusTone; billing: boolean } {
  if (player.status === "banned") {
    return { label: "已封禁", tone: "coral", billing: false };
  }
  if (player.status !== "active") {
    return { label: "已停用", tone: "coral", billing: false };
  }
  const short = shortfallAmount(player, livePlayer) > 0;
  if (live || livePlayer) {
    const label = player.billStatus ?? (player.activeSessionId ? "计费中" : "待结账");
    const billing = !!player.activeSessionId;
    if (short) return { label, tone: "coral", billing };
    if (billing) return { label, tone: "mint", billing: true };
    return { label, tone: "amber", billing: false };
  }
  if (player.activeSessionId) {
    return { label: "计费中", tone: "mint", billing: true };
  }
  if (player.hasUnpaidSession) {
    return { label: "待结账", tone: "amber", billing: false };
  }
  return { label: "正常", tone: "emerald", billing: false };
}

function playerPriorityRank(player: Row): number {
  if (player.activeSessionId) return 0;
  if (player.hasUnpaidSession) return 1;
  if (player.status === "active") return 2;
  return 3;
}

function holdingAvailabilityMeta(holding: HoldingItem, t: Translate): {
  available: boolean;
  label: string;
  tone: StatusTone;
} {
  const reasons = holding.unavailableReasons ?? [];
  if (
    reasons.includes("holding_expired") ||
    reasons.includes("definition_expired") ||
    (!holding.availability && holding.expiresAt && Date.parse(holding.expiresAt) <= Date.now())
  ) {
    return { available: false, label: t("已过期"), tone: "coral" };
  }
  if (
    reasons.includes("holding_not_active") ||
    reasons.includes("definition_not_active") ||
    (!holding.availability && holding.activeAt && Date.parse(holding.activeAt) > Date.now())
  ) {
    return { available: false, label: t("未生效"), tone: "amber" };
  }
  if (reasons.includes("definition_archived")) {
    return { available: false, label: t("已归档"), tone: "neutral" };
  }
  if (holding.availability === "unavailable") {
    return { available: false, label: t("不可用"), tone: "coral" };
  }
  return { available: true, label: t("有效期内"), tone: "emerald" };
}

function holdingTypeLabel(assetType?: string): string | null {
  if (assetType === "currency") return "余额";
  if (assetType === "coupon") return "优惠券";
  if (assetType === "pass") return "通行证";
  if (assetType === "ticket") return "票券";
  return null;
}

function formatHoldingQuantity(holding: HoldingItem): string | number {
  if (holding.assetType === "currency") return money(holding.quantity);
  return holding.quantity;
}

function formatLedgerDelta(entry: LedgerItem): string {
  const prefix = entry.delta > 0 ? "+" : "";
  if (entry.assetType && entry.assetType !== "currency" && Number.isInteger(entry.delta)) {
    return `${prefix}${entry.delta}`;
  }
  return `${prefix}${money(entry.delta)}`;
}

const HISTORY_PAGE_SIZE = 10;

const LEDGER_REASON_KEYS: Record<string, string> = {
  "session.settlement": "结账",
  "session.settlement.coupon": "优惠券",
  "staff.checkout.recharge": "充值结账",
  "gift.redeem": "兑换码",
  "staff.asset.grant": "发放资产",
  "admin.grant": "发放资产",
  "staff.asset.deduct": "扣款",
  "staff.asset.expire": "已过期",
  "staff.asset.revoke": "已撤销",
  "legacy.ADD_WALLET": "充值",
  "legacy.DEDUCT_WALLET": "扣款",
};

function formatLedgerReason(reason: string, delta: number, t: Translate): string {
  const trimmed = reason.trim();
  if (!trimmed) return t(delta >= 0 ? "充值" : "扣款");
  const key = LEDGER_REASON_KEYS[trimmed];
  return key ? t(key) : trimmed;
}

function checkoutTimeRange(record: StaffReportCheckout, timeZone?: string): string {
  const settledBt = billTime(record.settledAt, timeZone);
  const endIso = record.endedAt || record.settledAt;
  const endBt = billTime(endIso, timeZone);
  if (!record.startedAt) return endBt.time;
  const startBt = billTime(record.startedAt, timeZone);
  const shortDay = (bt: typeof startBt) =>
    bt.date.slice(0, 4) === settledBt.date.slice(0, 4) ? bt.date.slice(5) : bt.date;
  const startLabel = startBt.date === settledBt.date ? startBt.time : `${shortDay(startBt)} ${startBt.time}`;
  const endLabel =
    endBt.date === settledBt.date || endBt.date === startBt.date
      ? endBt.time
      : `${shortDay(endBt)} ${endBt.time}`;
  return `${startLabel} – ${endLabel}`;
}

function HistoryPager({
  offset,
  pageSize,
  currentCount,
  totalCount,
  hasMore,
  onChange,
}: {
  offset: number;
  pageSize: number;
  currentCount: number;
  totalCount?: number;
  hasMore: boolean;
  onChange: (nextOffset: number) => void;
}) {
  const { t } = useI18n();
  if (offset === 0 && !hasMore) return null;
  const start = offset + 1;
  const end = offset + currentCount;
  const rangeText =
    totalCount != null ? `${start}–${end} / ${totalCount}` : `${start}–${end}`;
  return (
    <div className="mt-3 flex items-center justify-between gap-3 border-t border-ink/10 pt-3">
      <span className="text-xs text-ink/55 tabular-nums">{rangeText}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`${button} !min-h-9 !rounded-xl !px-3 !py-1.5 !text-[13px]`}
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - pageSize))}
        >
          <ChevronLeft size={15} aria-hidden="true" />
          {t("上一页")}
        </button>
        <button
          type="button"
          className={`${button} !min-h-9 !rounded-xl !px-3 !py-1.5 !text-[13px]`}
          disabled={!hasMore}
          onClick={() => onChange(offset + pageSize)}
        >
          {t("下一页")}
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/**
 * Shared master-detail player workspace used by Dashboard (live mode) and the
 * Players tab (full roster). Both panes sit inside one divided container with
 * independent scrolling, billing-active players pinned at the top, filter chips
 * replacing grouping dropdowns, and a Bento + timeline-unified right profile.
 */
export function PlayerWorkspace({
  live = false,
  embedded = false,
  refreshSignal = 0,
  onLiveSummary,
  onMutated,
}: {
  live?: boolean;
  embedded?: boolean;
  refreshSignal?: number;
  onLiveSummary?: (summary: LiveSummary) => void;
  onMutated?: () => void;
}) {
  const { t } = useI18n();
  const { canWrite, shopCode, cashierEnabled, timeZone } = useMerchant();
  const request = useStaffApi();
  const identityText = (identity: NonNullable<Player["identities"]>[number]) =>
    formatIdentityText(identity, t);
  const list = useResource<{ players: Player[] }>(live ? null : "players");
  const hasInShopPlayer = Boolean(
    list.data?.players?.some((p) => p.activeSessionId || p.hasUnpaidSession),
  );
  const onSite = useResource<{
    players: LivePlayer[];
    roster?: Roster;
    billingSnapshot?: unknown;
  }>(live || hasInShopPlayer ? "live-players" : null);
  const roster = onSite.data?.roster;
  const [search, setSearch] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => params.get("player") ?? undefined,
  );
  const linked = params.get("player");
  useEffect(() => {
    if (!linked) return;
    const players = live
      ? onSite.data?.players.map((player) => player.playerId)
      : list.data?.players.map((player) => player.id);
    if (!players) return;
    if (live && !players.includes(linked)) {
      navigate(`/merchant/${segment(shopCode)}/players?player=${segment(linked)}`, {
        replace: true,
      });
      return;
    }
    setSelectedId(linked);
    const next = new URLSearchParams(params);
    next.delete("player");
    setParams(next, { replace: true });
  }, [linked, live, onSite.data, list.data, navigate, params, setParams, shopCode]);

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [bulk, setBulk] = useState<null | "checkout" | "override">(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [binding, setBinding] = useState(false);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control" || event.key === "Shift") {
        setSelecting(true);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control" || event.key === "Shift") {
        setSelecting(false);
        setPicked(new Set());
      }
    };
    const blur = () => {
      setSelecting(false);
      setPicked(new Set());
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const liveRows: Row[] | undefined = onSite.data?.players.map((player) => {
    const bill = liveBilling(player);
    const activeSessionId =
      (player.sessions ?? []).find((session) => !session.endedAt)?.id ?? null;
    const hasUnpaidSession =
      !activeSessionId && (player.sessions ?? []).length > 0;
    return {
      id: player.playerId,
      paymentMode: player.paymentMode,
      displayName: player.displayName,
      status: player.status,
      walletTotal: player.walletTotal,
      identities: player.identities,
      activeSessionId,
      hasUnpaidSession,
      stayMinutes: player.stayDurationMinutes,
      estimatedTotal: player.estimatedTotal,
      planNames: bill.plans,
      billStatus: bill.status,
      startedAt: player.sessions?.[0]?.startedAt,
      sessionCount: player.sessions?.length ?? 0,
    };
  });
  const todayDate = billTime(new Date().toISOString(), timeZone || undefined).date;
  const clockAt = (value: string) => billTime(value, timeZone || undefined).time;
  const dayAt = (value: string) => {
    const localDate = billTime(value, timeZone || undefined).date;
    return localDate === todayDate ? "" : localDate.slice(5);
  };
  const rows: Row[] | undefined = live ? liveRows : list.data?.players;

  const filterCounts = useMemo(() => {
    const all = rows ?? [];
    let funded = 0;
    let disabled = 0;
    for (const player of all) {
      if (player.walletTotal > 0) funded += 1;
      if (player.status !== "active") disabled += 1;
    }
    return { total: all.length, funded, disabled };
  }, [rows]);

  const matched = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = (rows ?? []).filter((player) => {
      if (!live) {
        if (quickFilter === "funded" && player.walletTotal <= 0) {
          return false;
        }
        if (quickFilter === "disabled" && player.status === "active") {
          return false;
        }
      }
      if (!needle) return true;
      return `${player.displayName} ${player.id} ${player.identities?.map((i) => `${identityText(i)} ${i.provider}:${i.subject}`).join(" ")}`
        .toLowerCase()
        .includes(needle);
    });
    return [...filtered].sort((a, b) => playerPriorityRank(a) - playerPriorityRank(b));
  }, [rows, search, quickFilter, live]);

  const activeId =
    matched.find((row) => row.id === selectedId)?.id ?? matched[0]?.id;
  const liveSource = onSite.data?.players;
  const calculation = useLiveBilling(
    liveSource ?? NO_PLAYERS,
    onSite.data?.billingSnapshot,
    activeId,
  );
  const quoted = new Map(
    calculation.players.map((player) => [player.playerId, player]),
  );
  const visible = matched.map((row) => {
    const quote = quoted.get(row.id);
    if (!quote) return row;
    const bill = liveBilling(quote);
    return {
      ...row,
      stayMinutes: quote.stayDurationMinutes,
      estimatedTotal: quote.estimatedTotal,
      status: quote.status,
      billStatus: bill.status,
      planNames: bill.plans,
      startedAt: quote.sessions?.[0]?.startedAt ?? row.startedAt,
      sessionCount: quote.sessions?.length ?? row.sessionCount,
    };
  });
  const liveSelection = activeId ? quoted.get(activeId) ?? null : null;
  const present =
    roster?.total ?? visible.filter((player) => player.activeSessionId).length;
  const unpaid = visible.filter((player) => !player.activeSessionId).length;

  const liveSummary = useMemo<LiveSummary>(() => {
    let shortBalanceCount = 0;
    let estimatedTotal = 0;
    for (const player of calculation.players) {
      if (player.estimatedTotal != null) {
        estimatedTotal += player.estimatedTotal;
        if (
          player.paymentMode !== "cashier" &&
          player.walletTotal < player.estimatedTotal
        ) {
          shortBalanceCount += 1;
        }
      }
    }
    return {
      present,
      unpaid,
      shortBalanceCount,
      estimatedTotal: Math.round(estimatedTotal * 100) / 100,
      loaded: !!onSite.data,
    };
  }, [calculation.players, present, unpaid, onSite.data]);

  useEffect(() => {
    if (live) onLiveSummary?.(liveSummary);
  }, [live, liveSummary, onLiveSummary]);

  const lastRefreshSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === lastRefreshSignal.current) return;
    lastRefreshSignal.current = refreshSignal;
    list.reload();
    onSite.reload();
  }, [refreshSignal, list.reload, onSite.reload]);

  const selected =
    visible.find((player) => player.id === activeId) ?? visible[0];
  const pickedRows = visible.filter((player) => picked.has(player.id));
  const allPicked =
    visible.length > 0 && pickedRows.length === visible.length;
  const refresh = () => {
    list.reload();
    onSite.reload();
    onMutated?.();
  };

  const togglePick = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const openPlayer = (id: string) => {
    setSelectedId(id);
    setNotice("");
    setError("");
    if (window.innerWidth < 1280) {
      panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  async function runBulk(mode: "checkout" | "override", finalTotal?: number) {
    if (!pickedRows.length) return;
    setBusy(mode);
    setError("");
    setNotice("");
    const failed: string[] = [];
    let doneCount = 0;
    for (const player of pickedRows) {
      const base = `players/${segment(player.id)}/checkout`;
      try {
        if (mode === "override") {
          await request(`${base}/override`, "POST", {
            finalTotal: finalTotal ?? 0,
            reason: t("批量改价结账"),
          });
        } else {
          await request(`${base}/confirm`, "POST", {});
        }
        doneCount += 1;
      } catch (e) {
        failed.push(
          `${player.displayName}: ${e instanceof Error ? e.message : t("操作失败")}`,
        );
      }
    }
    setBusy("");
    setBulk(null);
    setPicked(new Set());
    refresh();
    if (failed.length) setError(failed.join(" · "));
    else setNotice(t("已结账 {count} 位玩家", { count: doneCount }));
  }

  const workspaceError = live ? onSite.error : list.error;

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        {embedded ? (
          <h3 className="text-lg font-semibold">
            {t(live ? "在店玩家" : "玩家")}
            {rows && (
              <span className="ml-2 text-sm font-normal text-ink/50 tabular-nums">
                {live ? present : visible.length}
              </span>
            )}
            {live && rows && unpaid > 0 && (
              <span className="ml-3 text-sm font-normal text-ink/50 tabular-nums">
                {t("待结账")} {unpaid}
              </span>
            )}
          </h3>
        ) : (
          <div className="flex flex-wrap items-baseline gap-2.5">
            <h2 className="text-xl font-semibold">
              {t(live ? "在店玩家" : "玩家")}
              {rows && (
                <span className="ml-2 text-base font-normal text-ink/50 tabular-nums">
                  {live ? present : visible.length}
                </span>
              )}
            </h2>
            {live && rows && unpaid > 0 && (
              <span className="text-sm text-ink/50 tabular-nums">
                {t("待结账")} {unpaid}
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          {!embedded && (
            <button
              type="button"
              className={button}
              onClick={refresh}
              aria-label={t("刷新")}
            >
              <RefreshCw size={15} aria-hidden="true" />
              {t("刷新")}
            </button>
          )}
          {canWrite && (
            <button
              type="button"
              className={button}
              onClick={() => setBinding(true)}
            >
              <Link2 size={15} aria-hidden="true" />
              {t("绑定账号")}
            </button>
          )}
        </div>
      </header>

      {live && cashierEnabled && <CashierSlot onChanged={refresh} />}

      {pickedRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-mint/40 bg-mint/[0.05] px-3.5 py-2.5">
          <span className="text-sm font-medium">
            {t("已选 {count} 人", { count: pickedRows.length })}
          </span>
          <button
            type="button"
            className={buttonQuiet}
            onClick={() =>
              setPicked(allPicked ? new Set() : new Set(visible.map((p) => p.id)))
            }
          >
            {t(allPicked ? "取消全选" : "全选")}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            className={primary}
            disabled={!!busy}
            onClick={() => setBulk("checkout")}
          >
            {t("批量结账")}
          </button>
          <button
            type="button"
            className={button}
            disabled={!!busy}
            onClick={() => setBulk("override")}
          >
            {t("批量改价结账")}
          </button>
        </div>
      )}

      {workspaceError ? (
        <State error={workspaceError} />
      ) : !rows ? (
        <State />
      ) : !rows.length ? (
        <div className="rounded-2xl border border-dashed border-ink/20 bg-panel px-6 py-14 text-center">
          <p className="font-medium">{t(live ? "现在没有在店玩家" : "还没有玩家")}</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink/55">
            {t(
              live
                ? "玩家扫码并确认开始计费后会出现在这里，可以看实时账单、替他们结账。"
                : "玩家第一次扫码登录后自动建档。从旧系统迁移的玩家可以在「设置 → 数据管理」导入。",
            )}
          </p>
          <Link
            className={`${button} mt-5`}
            to={`/merchant/${encodeURIComponent(shopCode)}/resources`}
          >
            {t("打开资源二维码")}
          </Link>
        </div>
      ) : (
        <div className="grid overflow-hidden rounded-2xl border border-ink/10 bg-panel xl:h-[min(78vh,50rem)] xl:grid-cols-[minmax(18.5rem,0.78fr)_minmax(0,1.22fr)] xl:divide-x xl:divide-ink/10">
          {/* Left Pane: fixed search + filter tabs and independently scrollable list */}
          <div className="flex min-h-0 flex-col border-b border-ink/10 xl:h-full xl:border-b-0">
            <div className="grid shrink-0 gap-2.5 border-b border-ink/10 p-3.5">
              <label className="relative block w-full min-w-0">
                <Search
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/35"
                  aria-hidden="true"
                />
                <input
                  className={`${input} pl-9 ${search ? "pr-9" : ""}`}
                  type="search"
                  placeholder={t("搜索昵称或平台身份")}
                  aria-label={t("搜索玩家")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    type="button"
                    className="focus-ring absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-ink/45 hover:bg-ink/5 hover:text-ink"
                    aria-label={t("清除搜索")}
                    onClick={() => setSearch("")}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </label>

              {!live && (
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("状态")}>
                  {(
                    [
                      ["all", "全部", filterCounts.total],
                      ["funded", "有余额", filterCounts.funded],
                      ["disabled", "已停用", filterCounts.disabled],
                    ] as const
                  )
                    .filter(([key, , count]) => key === "all" || count > 0)
                    .map(([key, label, count]) => (
                      <button
                        key={key}
                        type="button"
                        aria-current={quickFilter === key ? "true" : undefined}
                        onClick={() => setQuickFilter(key)}
                        className={`focus-ring inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                          quickFilter === key
                            ? "bg-ink/10 font-semibold text-ink"
                            : "bg-ink/[0.04] text-ink/60 hover:text-ink"
                        }`}
                      >
                        {t(label)}
                        <span className="opacity-65 tabular-nums">{count}</span>
                      </button>
                    ))}
                </div>
              )}
            </div>

            <div className="max-h-[42vh] min-h-0 flex-1 overflow-y-auto overscroll-contain xl:max-h-none">
              {!visible.length ? (
                <div className="grid justify-items-center gap-2 px-4 py-12 text-center">
                  <p className="text-sm font-medium text-ink/75">{t("没有匹配的玩家")}</p>
                  <p className="text-xs text-ink/50">{t("试试修改搜索关键词或切换筛选条件")}</p>
                  {(search || quickFilter !== "all") && (
                    <button
                      type="button"
                      className={`${button} mt-2 min-h-9 px-3 py-1 text-xs`}
                      onClick={() => {
                        setSearch("");
                        setQuickFilter("all");
                      }}
                    >
                      {t("重置筛选")}
                    </button>
                  )}
                </div>
              ) : (
                <div className="divide-y divide-ink/10">
                  {visible.map((player) => {
                    const isPicked = picked.has(player.id);
                    const active = player.id === selected?.id;
                    const quote = quoted.get(player.id) ?? null;
                    const meta = playerStatusMeta(player, live, quote);
                    const short = shortfallAmount(player, quote) > 0;
                    const rowIdentities = (player.identities ?? []).filter(
                      (identity) => identity.provider !== "web-account",
                    );
                    const entryDay = player.startedAt ? dayAt(player.startedAt) : "";
                    const showNonLiveStatus =
                      !live &&
                      (player.activeSessionId ||
                        player.hasUnpaidSession ||
                        player.status !== "active");
                    return (
                      <div
                        key={player.id}
                        className={`relative ${isPicked ? "bg-mint/[0.06]" : ""}`}
                      >
                        {(isPicked || active) && (
                          <span
                            className={`absolute inset-y-0 left-0 w-[3px] ${
                              isPicked ? "bg-mint" : "bg-primary"
                            }`}
                            aria-hidden="true"
                          />
                        )}
                        <button
                          type="button"
                          className={`focus-ring block w-full px-4 py-3 text-left transition-colors ${
                            active
                              ? "bg-mint/[0.05] dark:bg-mint/[0.08]"
                              : "hover:bg-ink/[0.025]"
                          }`}
                          aria-pressed={active}
                          onClick={(event) => {
                            if (
                              selecting ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey
                            ) {
                              setSelecting(true);
                              togglePick(player.id);
                              return;
                            }
                            openPlayer(player.id);
                          }}
                        >
                          <div className="flex items-baseline justify-between gap-2.5">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-[14.5px] font-medium text-ink">
                                {player.displayName}
                              </span>
                              {showNonLiveStatus && (
                                <span
                                  className={`inline-flex shrink-0 items-center text-[11.5px] font-medium ${STATUS_DOT_TEXT[meta.tone]}`}
                                >
                                  <i
                                    aria-hidden="true"
                                    className="bill-plan-dot !mr-1.5"
                                    style={{ background: "currentColor" }}
                                  />
                                  {t(meta.label)}
                                </span>
                              )}
                              {!live && player.paymentMode === "cashier" && (
                                <span className="shrink-0 text-[11px] text-ink/45">
                                  {t("现场收款")}
                                </span>
                              )}
                            </div>
                            {live ? (
                              <span
                                className={`inline-flex shrink-0 items-center text-xs font-medium ${
                                  short ? "text-coral" : STATUS_DOT_TEXT[meta.tone]
                                }`}
                              >
                                <i
                                  aria-hidden="true"
                                  className="bill-plan-dot !mr-1.5"
                                  style={{ background: "currentColor" }}
                                />
                                {t(meta.label)}
                              </span>
                            ) : (
                              <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">
                                {money(player.walletTotal)}
                              </span>
                            )}
                          </div>

                          {!live ? (
                            <p className="mt-1 truncate text-xs text-ink/50">
                              {rowIdentities.length
                                ? rowIdentities.map(identityText).join(" · ")
                                : t("无绑定身份")}
                            </p>
                          ) : (
                            <span className="mt-2 grid grid-cols-3 gap-2">
                              <span>
                                <span className="block text-[11px] text-ink/50">
                                  {t("入场时间")}
                                </span>
                                <span className="mt-0.5 block text-sm font-semibold leading-tight tabular-nums text-ink">
                                  {player.startedAt ? (
                                    <time dateTime={player.startedAt}>
                                      {clockAt(player.startedAt)}
                                    </time>
                                  ) : (
                                    "—"
                                  )}
                                </span>
                                {entryDay && (
                                  <span className="mt-0.5 block text-[11px] text-ink/45 tabular-nums">
                                    {entryDay}
                                  </span>
                                )}
                              </span>
                              <span>
                                <span className="block text-[11px] text-ink/50">
                                  {t("时长")}
                                </span>
                                <strong className="mt-0.5 block text-sm font-semibold leading-tight tabular-nums text-ink">
                                  {stayDuration(player.stayMinutes ?? 0)}
                                </strong>
                              </span>
                              <span className="text-right">
                                <span className="block text-[11px] text-ink/50">
                                  {t("应付")}
                                </span>
                                <strong
                                  className={`mt-0.5 block break-all text-sm font-semibold leading-tight tabular-nums ${
                                    short ? "text-coral" : "text-ink"
                                  }`}
                                >
                                  {money(player.estimatedTotal)}
                                </strong>
                                <span className="mt-0.5 block text-[11px] text-ink/45">
                                  {player.sessionCount ?? 0} {t("项")}
                                </span>
                              </span>
                            </span>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right Pane: Bento + Top-Docked Tabs + BillTimeline Design Language */}
          {selected ? (
            <PlayerPanel
              key={selected.id}
              player={selected}
              livePlayer={selected.id === activeId ? liveSelection : null}
              expectLive={!onSite.error && Boolean(selected.activeSessionId || selected.hasUnpaidSession)}
              panelRef={panel}
              onChanged={refresh}
            />
          ) : (
            <div className="grid min-h-[14rem] place-items-center p-8 text-center text-sm text-ink/50 xl:h-full">
              {t("选择左侧玩家查看余额、资产和计费")}
            </div>
          )}
        </div>
      )}

      {notice && (
        <p role="status" className="text-sm text-mint">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      )}
      {bulk && (
        <Modal
          title={bulk === "checkout" ? "批量结账" : "批量改价结账"}
          close={() => setBulk(null)}
        >
          <ActionForm
            sticky
            label={bulk === "checkout" ? "确认结账" : "确认改价结账"}
            done={() => setBulk(null)}
            submit={async (form) => {
              await runBulk(
                bulk,
                bulk === "override" ? Number(form.get("amount")) : undefined,
              );
            }}
          >
            <p className="text-sm">
              {t("将对 {count} 位玩家逐个结账。", {
                count: pickedRows.length,
              })}
            </p>
            {bulk === "override" && (
              <Field label="每人应付金额">
                <input
                  className={input}
                  name="amount"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  defaultValue="0"
                />
              </Field>
            )}
            <p className="text-xs text-ink/50">
              {pickedRows.map((player) => player.displayName).join("、")}
            </p>
          </ActionForm>
        </Modal>
      )}
      {binding && (
        <Modal title="绑定账号" close={() => setBinding(false)}>
          <BindForm
            done={() => {
              setBinding(false);
              refresh();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/** The cashier strip only exists on the in-shop tab. */
function CashierSlot({ onChanged }: { onChanged: () => void }) {
  const [cashier, setCashier] = useState<ReactNode>(null);
  useEffect(() => {
    void import("./Cashier").then((module) => {
      const Component = module.Cashier;
      setCashier(<Component onChanged={onChanged} />);
    });
  }, [onChanged]);
  return <>{cashier}</>;
}

function BindForm({ done }: { done: () => void }) {
  const request = useStaffApi();
  return (
    <ActionForm
      label="确认绑定"
      done={done}
      submit={(form) =>
        request("platform-binding/confirm", "POST", {
          code: String(form.get("code")).trim().toUpperCase(),
          provider: String(form.get("provider")).trim(),
          subject: String(form.get("subject")).trim(),
        })
      }
    >
      <Field label="玩家验证码">
        <input
          className={input}
          name="code"
          required
          maxLength={8}
          autoCapitalize="characters"
          autoComplete="off"
          pattern="[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjklmnpqrstuvwxyz]{8}"
        />
      </Field>
      <Field label="平台标识">
        <input
          className={input}
          name="provider"
          required
          pattern="[a-z][a-z0-9_-]{0,63}"
          placeholder="onebot"
        />
      </Field>
      <Field label="身份值">
        <input className={input} name="subject" required maxLength={256} />
      </Field>
    </ActionForm>
  );
}

function PlayerPanel({
  player,
  livePlayer,
  expectLive,
  panelRef,
  onChanged,
}: {
  player: Row;
  livePlayer: LivePlayer | null;
  expectLive: boolean;
  panelRef: React.RefObject<HTMLElement | null>;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { canWrite, shopCode, cashierEnabled, timeZone } = useMerchant();
  const request = useStaffApi();
  const base = `players/${segment(player.id)}`;
  const reportSettings = useResource<{ excluded: boolean; isStaff: boolean }>(`${base}/report-settings`);
  const assets = useResource<Holdings>(`${base}/assets`);
  const definitions = useResource<{ assetDefinitions: Asset[] }>("asset-definitions");
  const plans = useResource<{ pricingConfigs: EntryPlan[] }>("pricing-configs");

  const hasBillTab = Boolean(livePlayer || expectLive);
  const [action, setAction] = useState<
    null | "checkout" | "override" | "recharge" | "wallet" | "entry" | "grant"
  >(null);
  const [profileTab, setProfileTab] = useState<ProfileTab>(() =>
    hasBillTab ? "bill" : "assets",
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [reportSaving, setReportSaving] = useState(false);
  const [removingIdentity, setRemovingIdentity] = useState<
    { provider: string; subject: string; label: string } | null
  >(null);
  const [error, setError] = useState("");
  async function toggleReportExclusion(excluded: boolean) {
    setReportSaving(true);
    setError("");
    try {
      await request(`${base}/report-settings`, "PUT", { excluded });
      reportSettings.reload();
    } catch (e) { setError(staffMessage(e instanceof Error ? e : new Error(String(e)))); }
    finally { setReportSaving(false); }
  }
  const [overrideTotal, setOverrideTotal] = useState("");
  const [rechargeAmount, setRechargeAmount] = useState("");
  const [walletDirection, setWalletDirection] = useState<"plus" | "minus">("plus");
  const [ledgerOffset, setLedgerOffset] = useState(0);
  const quoteRequest = useRef<AbortController | null>(null);
  const checkoutsReload = useRef(() => {});

  useEffect(() => () => {
    quoteRequest.current?.abort();
  }, []);

  const effectiveTab: ProfileTab =
    profileTab === "bill" && !hasBillTab ? "assets" : profileTab;

  const done = () => {
    setAction(null);
    setPreview(null);
    assets.reload();
    checkoutsReload.current();
    onChanged();
  };

  const billing = Boolean(
    livePlayer?.sessions.length || player.activeSessionId || player.hasUnpaidSession,
  );
  const identities = player.identities ?? [];
  const externalIdentities = identities.filter(
    (identity) => identity.provider !== "web-account",
  );
  const holdings = assets.data?.holdings ?? [];
  const ledgerEntries = assets.data?.ledgerEntries ?? [];
  const safeLedgerOffset =
    ledgerEntries.length === 0
      ? 0
      : Math.min(
          ledgerOffset,
          Math.floor((ledgerEntries.length - 1) / HISTORY_PAGE_SIZE) * HISTORY_PAGE_SIZE,
        );
  const pagedLedger = ledgerEntries.slice(
    safeLedgerOffset,
    safeLedgerOffset + HISTORY_PAGE_SIZE,
  );
  const ledgerHasMore = safeLedgerOffset + HISTORY_PAGE_SIZE < ledgerEntries.length;
  const ledgerGroups = groupByDate(
    pagedLedger,
    (entry) => entry.createdAt,
    timeZone || undefined,
  );
  const activeDefinitions = (definitions.data?.assetDefinitions ?? []).filter(
    (a) => a.status !== "archived",
  );
  const currencyDefinitions = activeDefinitions.filter((a) => a.type === "currency");
  const entryPlans = (plans.data?.pricingConfigs ?? []).filter(
    (p) => p.enabled && p.status !== "archived" && p.kind !== "time.cap",
  );
  const statusMeta = playerStatusMeta(player, false, livePlayer);
  const shortfall = shortfallAmount(player, livePlayer);
  const hasActionButtons =
    canWrite && (player.paymentMode !== "cashier" || cashierEnabled);

  const todayDate = billTime(new Date().toISOString(), timeZone || undefined).date;
  const entryAt = livePlayer?.sessions[0]?.startedAt;
  const entryParts = entryAt ? billTime(entryAt, timeZone || undefined) : null;
  const entryDay = entryParts && entryParts.date !== todayDate ? entryParts.date.slice(5) : "";

  const tracks = livePlayer?.timeline?.tracks ?? [];
  const activeSessions = (livePlayer?.sessions ?? []).filter(
    (session) => session.status === "active",
  );

  async function checkout() {
    if (busy) return;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    quoteRequest.current = controller;
    try {
      const result = await browserCheckoutPreview(
        shopApi(shopCode, `staff/${base}/billing-inputs`),
        shopApi(shopCode, `staff/${base}/checkout/preview`),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setPreview(result);
      setAction("checkout");
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const toggleInlineAction = (next: "wallet" | "entry" | "grant") => {
    setError("");
    setAction((cur) => (cur === next ? null : next));
  };

  const compactButton = `${button} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-sm`;
  const compactPrimary = `${primary} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-sm`;
  const compactActive = `${compactButton} !border-mint/50 bg-mint/10 text-mint hover:bg-mint/15`;

  const tabItems: Array<readonly [ProfileTab, string, number | null]> = [
    ...(hasBillTab ? ([["bill", "账单", null]] as const) : []),
    ["assets", "资产", holdings.length],
    ["checkouts", "消费记录", null],
    ["ledger", "资产流水", ledgerEntries.length],
    ["identity", "身份与状态", identities.length],
    ["settings", "设置", null],
  ];

  return (
    <section
      ref={panelRef}
      className="min-h-0 min-w-0 max-h-[74vh] overflow-y-auto overscroll-contain xl:h-full xl:max-h-none"
      aria-label={t("玩家资料")}
    >
      {/* Layer 1: Compact Identity Header + Right-aligned Account Actions */}
      <header className="px-5 pt-5 pb-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-xl font-semibold tracking-tight text-ink">
                {player.displayName}
              </h3>
              <span
                className={`inline-flex items-center rounded-full bg-ink/[0.045] px-2.5 py-0.5 text-xs font-medium ${STATUS_DOT_TEXT[statusMeta.tone]}`}
              >
                <i
                  aria-hidden="true"
                  className="bill-plan-dot !mr-1.5"
                  style={{ background: "currentColor" }}
                />
                {t(statusMeta.label)}
              </span>
              {player.paymentMode === "cashier" && (
                <span className="rounded-full bg-ink/[0.045] px-2 py-0.5 text-xs text-ink/55">
                  {t("现场收款")}
                </span>
              )}
            </div>
            {externalIdentities.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {externalIdentities.map((identity) => (
                  <span
                    key={`${identity.provider}:${identity.subject}`}
                    className="inline-flex max-w-full items-center truncate rounded-lg bg-ink/[0.04] px-2.5 py-0.5 text-xs text-ink/65"
                  >
                    {formatIdentityText(identity, t)}
                  </span>
                ))}
              </div>
            )}
          </div>

          {hasActionButtons && (
            <div
              className="flex shrink-0 flex-wrap items-center gap-2"
              role="toolbar"
              aria-label={t("玩家操作")}
            >
              {player.paymentMode === "cashier" ? (
                cashierEnabled && (
                  <Link
                    className={compactPrimary}
                    to={`/merchant/${segment(shopCode)}/dashboard?cashierPlayer=${segment(player.id)}`}
                  >
                    {t("前台收款")}
                  </Link>
                )
              ) : (
                <>
                  {!billing && (
                    <button
                      type="button"
                      className={action === "entry" ? compactActive : compactPrimary}
                      disabled={busy || player.status !== "active"}
                      onClick={() => toggleInlineAction("entry")}
                    >
                      {t("开启计费")}
                    </button>
                  )}
                  <button
                    type="button"
                    className={action === "wallet" ? compactActive : compactButton}
                    aria-expanded={action === "wallet"}
                    onClick={() => {
                      setWalletDirection("plus");
                      toggleInlineAction("wallet");
                    }}
                  >
                    {t("充值 / 扣款")}
                  </button>
                  <button
                    type="button"
                    className={action === "grant" ? compactActive : compactButton}
                    aria-expanded={action === "grant"}
                    onClick={() => toggleInlineAction("grant")}
                  >
                    {t("发放资产")}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {(action === "entry" || action === "wallet" || action === "grant") && (
          <div className="bill-entry !mb-0 mt-4 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-ink">
                {t(
                  action === "entry"
                    ? "开启计费"
                    : action === "wallet"
                      ? "充值 / 扣款"
                      : "发放资产",
                )}
              </h4>
              <button
                type="button"
                className={`${buttonQuiet} px-2 py-1 text-xs`}
                onClick={() => {
                  setAction(null);
                  setPreview(null);
                }}
              >
                {t("取消")}
              </button>
            </div>

            {action === "entry" && (
              <PlanStart base={base} plans={entryPlans} done={done} />
            )}

            {action === "wallet" && (
              <ActionForm
                done={done}
                label="确认调整"
                submit={(f) =>
                  f.get("direction") === "minus"
                    ? request(`${base}/wallet/adjustment`, "POST", {
                        amount: -Number(f.get("amount")),
                        reason: f.get("reason"),
                      })
                    : request(`${base}/assets/grants`, "POST", {
                        reason: f.get("reason"),
                        grants: [
                          {
                            assetType: "currency",
                            assetCode: f.get("account"),
                            amount: Number(f.get("amount")),
                            mergeStrategy: "stack",
                            activeAt: null,
                            expiresAt: null,
                          },
                        ],
                      })
                }
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="操作">
                    <select
                      className={input}
                      name="direction"
                      value={walletDirection}
                      onChange={(e) =>
                        setWalletDirection(e.target.value as "plus" | "minus")
                      }
                    >
                      <option value="plus">{t("充值")}</option>
                      <option value="minus">{t("扣款")}</option>
                    </select>
                  </Field>
                  <Field label="金额">
                    <input
                      className={input}
                      name="amount"
                      type="number"
                      min="0.01"
                      step="0.01"
                      required
                    />
                  </Field>
                </div>
                {walletDirection === "plus" && (
                  <Field label="充值账户">
                    <select
                      className={input}
                      name="account"
                      required
                      defaultValue="paid"
                    >
                      {currencyDefinitions.map((a) => (
                        <option value={a.code} key={a.code}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label="备注">
                  <input className={input} name="reason" required maxLength={200} />
                </Field>
              </ActionForm>
            )}

            {action === "grant" && (
              <ActionForm
                done={done}
                label="确认发放"
                submit={(f) => {
                  const [assetType, assetCode] = String(f.get("asset")).split("|");
                  return request(`${base}/assets/grants`, "POST", {
                    reason: f.get("reason"),
                    grants: [
                      {
                        assetType,
                        assetCode,
                        amount: Number(f.get("amount")),
                        mergeStrategy: "stack",
                        activeAt: null,
                        expiresAt: null,
                      },
                    ],
                  });
                }}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="资产">
                    <select name="asset" className={input} required>
                      {activeDefinitions.map((a) => (
                        <option
                          key={`${a.type}:${a.code}`}
                          value={`${a.type}|${a.code}`}
                        >
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="数量">
                    <input
                      className={input}
                      type="number"
                      name="amount"
                      min="0.01"
                      step="0.01"
                      required
                      defaultValue="1"
                    />
                  </Field>
                </div>
                <Field label="备注">
                  <input className={input} name="reason" required />
                </Field>
              </ActionForm>
            )}
          </div>
        )}
      </header>

      {error && (
        <div
          role="alert"
          className="mx-5 mb-3 rounded-[14px] bg-coral/[0.08] px-3.5 py-2.5 text-sm text-coral sm:mx-6"
        >
          {error}
        </div>
      )}

      {/* Layer 2: Soft .bill-entry Bento Summary Card */}
      <div className="px-5 pb-4 sm:px-6">
        {livePlayer ? (
          <div className="bill-entry !mb-0 grid gap-3.5 p-4">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-ink/55">{t("应付")}</dt>
                <dd
                  className={`mt-1 break-all text-2xl font-semibold leading-tight tracking-tight tabular-nums ${
                    shortfall > 0 ? "text-coral" : "text-ink"
                  }`}
                >
                  {money(livePlayer.estimatedTotal)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink/55">
                  {t(player.paymentMode === "cashier" ? "现场收款" : "余额")}
                </dt>
                <dd className="mt-1 text-2xl font-semibold leading-tight tracking-tight tabular-nums text-ink">
                  {money(player.walletTotal)}
                </dd>
                {shortfall > 0 && (
                  <dd className="mt-0.5 text-[11px] font-medium text-coral tabular-nums">
                    {t("需补足")} ¥{money(shortfall)}
                  </dd>
                )}
              </div>
              <div>
                <dt className="text-xs text-ink/55">{t("时长")}</dt>
                <dd className="mt-1 text-2xl font-semibold leading-tight tracking-tight tabular-nums text-ink">
                  {stayDuration(livePlayer.stayDurationMinutes)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink/55">{t("入场时间")}</dt>
                <dd className="mt-1 text-2xl font-semibold leading-tight tracking-tight tabular-nums text-ink">
                  {entryAt ? (
                    <time dateTime={entryAt}>{entryParts!.time}</time>
                  ) : (
                    "—"
                  )}
                </dd>
                {entryDay && (
                  <dd className="mt-0.5 text-[11px] text-ink/50 tabular-nums">
                    {entryDay}
                  </dd>
                )}
              </div>
            </dl>

            {livePlayer.quoteState === "loading" && (
              <p role="status" className="text-xs text-ink/60">
                {t("正在计算账单")}
              </p>
            )}
            {livePlayer.quoteState === "error" && (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-coral/[0.08] px-3 py-2 text-xs text-coral"
              >
                <span>
                  {t(livePlayer.quoteError || "账单预估失败，请刷新后重试")}
                </span>
                <button
                  type="button"
                  className={compactButton}
                  onClick={onChanged}
                >
                  {t("重试")}
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink/10 pt-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {activeSessions.length > 0 ? (
                  activeSessions.map((session, index) => {
                    const planName =
                      (plans.data?.pricingConfigs ?? []).find(
                        (plan) => plan.id === session.pricingConfigId,
                      )?.name ??
                      ([...new Set(session.pricingCharges.map((c) => c.planName))].join(
                        " + ",
                      ) ||
                        t("计费"));
                    const track = tracks.find(
                      (tr) => tr.id === session.id || tr.name === planName,
                    );
                    const dotColor = planColor(track?.color ?? index);
                    return (
                      <div
                        key={session.id}
                        className="inline-flex max-w-full items-center gap-2 text-[13.5px] font-medium text-ink"
                      >
                        <span className="inline-flex min-w-0 items-center">
                          <i
                            aria-hidden="true"
                            className="bill-plan-dot !mr-1.5"
                            style={{ background: dotColor }}
                          />
                          <span className="truncate">{planName}</span>
                        </span>
                        {canWrite && (
                          <button
                            type="button"
                            className="focus-ring min-h-8 shrink-0 rounded-lg border border-ink/20 bg-panel px-2.5 py-1 text-xs font-medium text-ink/80 hover:bg-ink/5 hover:text-ink"
                            onClick={() =>
                              void request(
                                `players/${segment(player.id)}/sessions/${segment(session.id)}/stop`,
                                "POST",
                                {},
                              ).then(done)
                            }
                          >
                            {t("停止计费")}
                          </button>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <span className="text-xs text-ink/50">{t("待结账")}</span>
                )}
              </div>

              {canWrite && player.paymentMode !== "cashier" && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={compactPrimary}
                    disabled={busy || player.status !== "active"}
                    onClick={() => void checkout()}
                  >
                    {t("结账")}
                  </button>
                  <button
                    type="button"
                    className={compactButton}
                    disabled={busy || player.status !== "active"}
                    onClick={() => {
                      setOverrideTotal((player.estimatedTotal ?? 0).toFixed(2));
                      setAction("override");
                    }}
                  >
                    {t("改价结账")}
                  </button>
                  <button
                    type="button"
                    className={compactButton}
                    disabled={busy || player.status !== "active"}
                    onClick={() => {
                      const due = Math.max(
                        0,
                        (player.estimatedTotal ?? 0) - player.walletTotal,
                      );
                      setRechargeAmount(due.toFixed(2));
                      setAction("recharge");
                    }}
                  >
                    {t("充值结账")}
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="bill-entry !mb-0 p-4">
            <dl className="grid grid-cols-3 gap-3">
              <div>
                <dt className="text-xs text-ink/55">
                  {t(player.paymentMode === "cashier" ? "现场收款" : "余额")}
                </dt>
                <dd className="mt-1 text-2xl font-semibold leading-tight tracking-tight tabular-nums text-ink">
                  {money(player.walletTotal)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink/55">{t("资产")}</dt>
                <dd className="mt-1 text-2xl font-semibold leading-tight tracking-tight tabular-nums text-ink">
                  {assets.data ? holdings.length : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink/55">{t("已绑定身份")}</dt>
                <dd className="mt-1 text-2xl font-semibold leading-tight tracking-tight tabular-nums text-ink">
                  {externalIdentities.length}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </div>

      {/* Checkout Dialogs */}
      {action === "checkout" && preview && (
        <Modal title="结账" close={() => setAction(null)}>
          <ActionForm
            sticky
            label="确认结账"
            done={done}
            submit={() => request(`${base}/checkout/confirm`, "POST", {})}
          >
            <BillTotal preview={preview} />
            <BillTimeline preview={preview} timeZone={timeZone || undefined} />
            <p className="text-sm text-ink/60">
              {t("结账后余额")} {money(preview.wallet.balanceAfter)}
            </p>
          </ActionForm>
        </Modal>
      )}
      {action === "override" && (
        <Modal title="改价结账" close={() => setAction(null)}>
          <ActionForm
            sticky
            label="确认改价结账"
            done={done}
            submit={(form) =>
              request(`${base}/checkout/override`, "POST", {
                finalTotal: Number(form.get("amount")),
                reason: String(form.get("reason") ?? "").trim(),
              })
            }
          >
            <Field label="最终应收金额">
              <input
                className={input}
                name="amount"
                type="number"
                required
                min="0"
                step="0.01"
                defaultValue={overrideTotal}
              />
            </Field>
            <Field label="改价原因">
              <input className={input} name="reason" required maxLength={200} />
            </Field>
          </ActionForm>
        </Modal>
      )}
      {action === "recharge" && (
        <Modal title="充值结账" close={() => setAction(null)}>
          <ActionForm
            sticky
            label="确认充值并结账"
            done={done}
            submit={(form) =>
              request(`${base}/checkout/recharge`, "POST", {
                amount: Number(form.get("amount")),
              })
            }
          >
            <Field label="充值金额">
              <input
                className={input}
                name="amount"
                type="number"
                required
                min="0.01"
                step="0.01"
                defaultValue={rechargeAmount}
              />
            </Field>
            <p className="text-sm text-ink/60">
              {t("当前可用余额")} {money(player.walletTotal)}
            </p>
          </ActionForm>
        </Modal>
      )}

      {/* Layer 3: Top-Docked Single-Line Underline Tabs (always above timeline) */}
      <div
        role="tablist"
        aria-label={t("资料分类")}
        className="flex gap-1 overflow-x-auto overflow-y-hidden px-5 shadow-[inset_0_-1px_0_rgb(var(--color-ink)/0.1)] sm:px-6"
      >
        {tabItems.map(([key, label, count]) => {
          const activeTab = effectiveTab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={activeTab}
              aria-label={t(label)}
              onClick={() => setProfileTab(key)}
              className={`focus-ring inline-flex shrink-0 items-center gap-1 whitespace-nowrap border-b-2 px-2.5 py-2.5 text-sm transition-colors sm:gap-1.5 sm:px-3 sm:py-3 ${
                activeTab
                  ? "border-mint font-semibold text-ink"
                  : "border-transparent font-medium text-ink/55 hover:text-ink"
              }`}
            >
              <span>{t(label)}</span>
              {count !== null && count > 0 && (
                <span
                  aria-hidden="true"
                  className="text-xs font-normal text-ink/45 tabular-nums"
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Layer 4: BillTimeline-Aligned Content Views */}
      <div className="px-5 py-4 sm:px-6">
        {effectiveTab === "bill" && (
          <div role="tabpanel" className="grid gap-4">
            {!livePlayer ? (
              <State />
            ) : livePlayer.timeline ? (
              <>
                <BillLegend timeline={livePlayer.timeline} />
                <BillTimeline
                  timeZone={timeZone || undefined}
                  preview={{
                    settlementPreview: { total: livePlayer.estimatedTotal ?? 0 },
                    timeline: livePlayer.timeline,
                    chargeItems: [],
                    adjustments: [],
                  }}
                />
              </>
            ) : (
              <p className="py-8 text-center text-sm text-ink/50">
                {t(livePlayer.quoteState === "loading" ? "正在计算账单" : "暂无计费明细")}
              </p>
            )}
          </div>
        )}

        {effectiveTab === "assets" && (
          <div role="tabpanel" className="grid gap-1.5">
            {assets.error ? (
              <State error={assets.error} />
            ) : !assets.data ? (
              <State />
            ) : !holdings.length ? (
              <p className="py-8 text-center text-sm text-ink/50">
                {t("暂无资产")}
              </p>
            ) : (
              holdings.map((h) => {
                const avail = holdingAvailabilityMeta(h, t);
                const typeLabel = holdingTypeLabel(h.assetType);
                const dotColor = !avail.available
                  ? "rgb(var(--color-ink) / 0.35)"
                  : h.assetType === "currency"
                    ? "#23815d"
                    : "var(--color-mint)";
                return (
                  <div
                    key={h.id}
                    className={`bill-entry !mb-0 ${avail.available ? "" : "opacity-65"}`}
                  >
                    <div className="bill-entry-heading">
                      <span className="bill-plan-name flex flex-wrap items-center">
                        <i
                          aria-hidden="true"
                          className="bill-plan-dot"
                          style={{ background: dotColor }}
                        />
                        <span>{h.assetName || h.assetCode || t("资产")}</span>
                        {typeLabel && (
                          <small className="ml-1.5 font-normal text-ink/45">
                            {t(typeLabel)}
                          </small>
                        )}
                        {!avail.available && (
                          <small className={`ml-1.5 font-normal ${STATUS_DOT_TEXT[avail.tone]}`}>
                            · {avail.label}
                          </small>
                        )}
                      </span>
                      <strong>{formatHoldingQuantity(h)}</strong>
                    </div>
                    {(h.activeAt || h.expiresAt) && (
                      <p className="tabular-nums">
                        {h.activeAt && (
                          <span>
                            {t("生效时间")} {date(h.activeAt)}
                          </span>
                        )}
                        {h.activeAt && h.expiresAt && " · "}
                        {h.expiresAt && (
                          <span>
                            {t("到期时间")} {date(h.expiresAt)}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        <div
          role="tabpanel"
          className={effectiveTab === "checkouts" ? "grid gap-2" : "hidden"}
        >
          <PlayerCheckouts base={base} reload={checkoutsReload} todayDate={todayDate} />
        </div>

        {effectiveTab === "ledger" && (
          <div role="tabpanel">
            {assets.error ? (
              <State error={assets.error} />
            ) : !assets.data ? (
              <State />
            ) : !ledgerEntries.length ? (
              <p className="py-8 text-center text-sm text-ink/50">
                {t("暂无流水")}
              </p>
            ) : (
              <>
                <div className="grid gap-3">
                  {ledgerGroups.map((group) => (
                    <div key={group.localDate} className="grid gap-1.5">
                      <div className="px-1 text-xs font-medium text-ink/45">
                        {shortDateLabel(group.localDate, todayDate)}
                      </div>
                      <div className="bill-entry !mb-0 !p-0 divide-y divide-ink/[0.06] overflow-hidden">
                        {group.items.map((e) => {
                          const positive = e.delta > 0;
                          const typeLabel = holdingTypeLabel(e.assetType);
                          const dotColor = positive ? "#23815d" : "#4e7eaf";
                          const clock = billTime(e.createdAt, timeZone || undefined).time;
                          return (
                            <div
                              key={e.id}
                              className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 text-[14px] font-medium text-ink">
                                  <i
                                    aria-hidden="true"
                                    className="bill-plan-dot !mr-1"
                                    style={{ background: dotColor }}
                                  />
                                  <span className="truncate">{e.assetName}</span>
                                  {typeLabel && (
                                    <small className="shrink-0 text-xs font-normal text-ink/45">
                                      {t(typeLabel)}
                                    </small>
                                  )}
                                </div>
                                <div className="mt-0.5 pl-3.5 text-xs text-ink/55 tabular-nums">
                                  <time dateTime={e.createdAt}>{clock}</time>
                                  {` · ${formatLedgerReason(e.reason, e.delta, t)}`}
                                </div>
                              </div>
                              <strong
                                className={`shrink-0 text-[14.5px] font-semibold tabular-nums ${
                                  positive ? "bill-negative" : "text-ink"
                                }`}
                              >
                                {formatLedgerDelta(e)}
                              </strong>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <HistoryPager
                  offset={safeLedgerOffset}
                  pageSize={HISTORY_PAGE_SIZE}
                  currentCount={pagedLedger.length}
                  totalCount={ledgerEntries.length}
                  hasMore={ledgerHasMore}
                  onChange={setLedgerOffset}
                />
              </>
            )}
          </div>
        )}

        {effectiveTab === "identity" && (
          <div role="tabpanel" className="grid gap-3">
            <div className="grid gap-1.5">
              {identities.length ? (
                identities.map((identity) => {
                  const provider = identityProviderLabel(identity.provider, t);
                  const { displayName, subject } = identity;
                  const value = identity.provider === "aime" ? `•••• ${subject.slice(-4)}` : subject;
                  return (
                    <div
                      key={JSON.stringify([identity.provider, subject])}
                      className="bill-entry !mb-0 flex flex-wrap items-center justify-between gap-2 text-sm"
                    >
                      <span className="inline-flex items-center gap-2 font-medium text-ink">
                        <span className="text-xs font-medium text-ink/55">
                          {provider}
                          {displayName ? ":" : ""}
                        </span>
                        {displayName && <span>{displayName}</span>}
                      </span>
                      <span className="inline-flex items-center gap-2">
                        <code className="select-all break-all text-xs text-ink/60">
                          {value}
                        </code>
                        {canWrite && (
                          <button
                            type="button"
                            className="focus-ring grid size-7 shrink-0 place-items-center rounded-lg text-ink/45 hover:bg-coral/10 hover:text-coral"
                            aria-label={t("解绑 {identity}", { identity: `${provider} ${value}` })}
                            onClick={() => setRemovingIdentity({ ...identity, label: [provider, displayName, value].filter(Boolean).join(" · ") })}
                          >
                            <X size={15} aria-hidden="true" />
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })
              ) : (
                <p className="py-2 text-sm text-ink/50">{t("无绑定身份")}</p>
              )}
              {removingIdentity && (
                <Modal title="解除本店绑定" close={() => setRemovingIdentity(null)}>
                  <ActionForm
                    label="确认解绑"
                    done={() => {
                      setRemovingIdentity(null);
                      done();
                    }}
                    submit={() =>
                      request(
                        `${base}/identities`,
                        "DELETE",
                        { provider: removingIdentity.provider, subject: removingIdentity.subject },
                      )
                    }
                  >
                    <p className="text-sm leading-relaxed">
                      {t("确认将 {identity} 从玩家「{player}」的本店档案解绑？余额和消费记录仍归此档案。", {
                        identity: removingIdentity.label, player: player.displayName,
                      })}
                    </p>
                  </ActionForm>
                </Modal>
              )}
            </div>

            {canWrite && (
              <div className="grid gap-3 border-t border-ink/10 pt-3">
                <p className="text-xs text-ink/50">
                  {t("PRiSM 账号通过绑定码关联")}
                </p>
                <div className="bill-entry !mb-0 p-4">
                  <ActionForm
                    done={done}
                    label="绑定平台身份"
                    submit={(f) =>
                      request(`${base}/identities`, "POST", {
                        provider: String(f.get("provider")).trim(),
                        subject: String(f.get("subject")).trim(),
                      })
                    }
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="平台标识">
                        <input
                          className={input}
                          name="provider"
                          required
                          pattern="[a-z][a-z0-9_-]{0,63}"
                          placeholder="onebot"
                        />
                      </Field>
                      <Field label="身份值">
                        <input
                          className={input}
                          name="subject"
                          required
                          maxLength={256}
                        />
                      </Field>
                    </div>
                  </ActionForm>
                </div>
                <div className="bill-entry !mb-0 p-4">
                  <ActionForm
                    done={done}
                    label="更新状态"
                    submit={(f) =>
                      request(`${base}/status`, "PATCH", {
                        status: f.get("status"),
                      })
                    }
                  >
                    <Field label="状态">
                      <select
                        className={input}
                        name="status"
                        defaultValue={player.status}
                      >
                        <option value="active">{t("正常")}</option>
                        <option value="disabled">{t("停用")}</option>
                        <option value="banned">{t("封禁")}</option>
                      </select>
                    </Field>
                  </ActionForm>
                </div>
              </div>
            )}
          </div>
        )}

        {effectiveTab === "settings" && (
          <div role="tabpanel" className="grid gap-3">
            {reportSettings.error ? (
              <div className="bill-entry !mb-0 flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="text-xs text-ink/60">{t("排除经营统计")}</span>
                <button
                  type="button"
                  className={compactButton}
                  onClick={reportSettings.reload}
                >
                  {t("重试")}
                </button>
              </div>
            ) : !reportSettings.data ? (
              <State />
            ) : (
              <div className="bill-entry !mb-0 flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <label className="flex w-full cursor-pointer items-center justify-between gap-3">
                  <span className="text-ink">
                    {t(
                      reportSettings.data.isStaff
                        ? "店员自动排除统计"
                        : "排除经营统计",
                    )}
                  </span>
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--color-mint)]"
                    checked={reportSettings.data.excluded}
                    disabled={
                      !canWrite || reportSaving || reportSettings.data.isStaff
                    }
                    onChange={(e) => void toggleReportExclusion(e.target.checked)}
                  />
                </label>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

type PlanPreview = {
  pricingConfigId: string;
  planName: string;
  revision: string;
  started: string[];
  stopped: string[];
  kept: string[];
};

function PlanStart({
  base,
  plans,
  done,
}: {
  base: string;
  plans: EntryPlan[];
  done: () => void;
}) {
  const { t } = useI18n();
  const request = useStaffApi();
  const [planId, setPlanId] = useState(plans[0]?.id ?? "");
  const [plan, setPlan] = useState<PlanPreview | null>(null);
  const [previewError, setPreviewError] = useState("");

  useEffect(() => {
    if (plans.length && !plans.some((item) => item.id === planId)) {
      setPlanId(plans[0].id);
    }
  }, [plans, planId]);

  useEffect(() => {
    if (!planId) return;
    let active = true;
    setPlan(null);
    setPreviewError("");
    void request<PlanPreview>(`${base}/session/preview`, "POST", {
      pricingConfigId: planId,
    })
      .then((result) => {
        if (active) setPlan(result);
      })
      .catch((caught) => {
        if (active) {
          setPreviewError(
            caught instanceof Error ? caught.message : t("操作失败"),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [base, planId, request, t]);

  if (!plans.length) {
    return (
      <p className="text-sm text-ink/55">
        {t("暂无启用的入场规则，请先在计费管理中配置。")}
      </p>
    );
  }

  const rows: Array<[string, string[]]> = [
    [t("新增"), plan?.started ?? []],
    [t("保留"), plan?.kept ?? []],
    [t("结束"), plan?.stopped ?? []],
  ];

  return (
    <ActionForm
      label="开启计费"
      done={done}
      submit={() =>
        request(`${base}/session/start`, "POST", {
          pricingConfigId: planId,
          ...(plan?.revision ? { expectedRevision: plan.revision } : {}),
        })
      }
    >
      <Field label="计费方案">
        <select
          className={input}
          name="pricingConfigId"
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
        >
          {plans.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </Field>
      {previewError && (
        <p role="alert" className="text-xs text-coral">
          {previewError}
        </p>
      )}
      {rows.some(([, names]) => names.length) && (
        <dl className="grid gap-1.5 rounded-xl border border-ink/10 bg-panel p-3 text-xs">
          {rows
            .filter(([, names]) => names.length)
            .map(([label, names]) => (
              <div className="flex flex-wrap gap-x-2" key={label}>
                <dt className="text-ink/55">{label}</dt>
                <dd className="font-medium text-ink">{names.join("、")}</dd>
              </div>
            ))}
        </dl>
      )}
    </ActionForm>
  );
}

/**
 * Settled bills for the player, newest first, grouped by date in inset
 * .bill-entry cards with start–end time ranges and bounded per-page loading.
 */
function PlayerCheckouts({
  base,
  reload,
  todayDate,
}: {
  base: string;
  reload: React.MutableRefObject<() => void>;
  todayDate: string;
}) {
  const { t, errorText } = useI18n();
  const { timeZone } = useMerchant();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const checkouts = useResource<{
    records: StaffReportCheckout[];
    page: { hasMore: boolean };
  }>(`${base}/checkouts?limit=${HISTORY_PAGE_SIZE}&offset=${offset}`);
  reload.current = checkouts.reload;
  const records = checkouts.data?.records ?? [];
  const checkoutGroups = groupByDate(
    records,
    (record) => record.settledAt,
    timeZone || undefined,
  );
  return (
    <>
      {checkouts.error ? (
        <State error={errorText(checkouts.error)} />
      ) : !checkouts.data ? (
        <State />
      ) : !records.length ? (
        <p className="py-8 text-center text-sm text-ink/50">
          {t("暂无记录")}
        </p>
      ) : (
        <div className="grid gap-3">
          {checkoutGroups.map((group) => (
            <div key={group.localDate} className="grid gap-1.5">
              <div className="px-1 text-xs font-medium text-ink/45">
                {shortDateLabel(group.localDate, todayDate)}
              </div>
              <div className="bill-entry !mb-0 !p-0 divide-y divide-ink/[0.06] overflow-hidden">
                {group.items.map((record) => {
                  const endIso = record.endedAt || record.settledAt;
                  const endClock = billTime(endIso, timeZone || undefined).time;
                  const settledClock = billTime(record.settledAt, timeZone || undefined).time;
                  const discounted = record.subtotal > record.total + 0.005;
                  return (
                    <button
                      key={record.checkoutId}
                      type="button"
                      className={`focus-ring block w-full px-3.5 py-2.5 text-left transition-colors hover:bg-ink/[0.045] ${
                        record.archived ? "opacity-65" : ""
                      }`}
                      onClick={() => setSelected(record.checkoutId)}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[14px]">
                          <span className="font-semibold tabular-nums text-ink">
                            {checkoutTimeRange(record, timeZone || undefined)}
                          </span>
                          <span className="text-xs font-normal text-ink/55 tabular-nums">
                            ({stayDuration(record.durationMinutes)})
                          </span>
                          {record.archived && (
                            <span className="text-xs font-normal text-ink/45">
                              {t("已归档")}
                            </span>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {discounted && (
                            <del className="text-xs font-normal text-ink/40 tabular-nums">
                              {money(record.subtotal)}
                            </del>
                          )}
                          <strong className="text-[14.5px] font-semibold tabular-nums text-ink">
                            {money(record.total)}
                          </strong>
                          <ChevronRight
                            size={14}
                            className="text-ink/35"
                            aria-hidden="true"
                          />
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink/55 tabular-nums">
                        <span>{payment(record, t)}</span>
                        {record.sessionCount > 0 && (
                          <span>
                            · {record.sessionCount} {t("项")}
                          </span>
                        )}
                        {record.endedAt && settledClock !== endClock && (
                          <span>
                            · {t("结账时间")} {settledClock}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      <HistoryPager
        offset={offset}
        pageSize={HISTORY_PAGE_SIZE}
        currentCount={records.length}
        hasMore={Boolean(checkouts.data?.page.hasMore)}
        onChange={setOffset}
      />
      {selected && (
        <ReportDetail
          key={selected}
          checkoutId={selected}
          close={() => setSelected(null)}
          changed={() => {
            setSelected(null);
            checkouts.reload();
          }}
        />
      )}
    </>
  );
}

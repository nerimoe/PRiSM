import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AirVent,
  AlertTriangle,
  BarChart3,
  Bot,
  ChevronRight,
  Clock,
  Coins,
  Cpu,
  CreditCard,
  Gamepad2,
  LayoutGrid,
  Lock,
  Plus,
  Power,
  QrCode,
  RefreshCw,
  Timer,
  Users,
  Wallet,
} from "lucide-react";
import {
  Api,
  api,
  type Resource,
  type ResourceOccupancyView,
} from "../../api";
import { useI18n } from "../../i18n";
import { climateModeIcon, climateSummary } from "../ClimateControls";
import { billTime } from "../bill-time";
import {
  applyBoardAnswer,
  applyBoardFrame,
  applyBoardState,
  awaitingState,
  framedDevices,
  type BoardFrame,
  type BoardState,
  type BoardStates,
  type BoardWatchers,
} from "./board-state";
import { DeltaBadge } from "./DashboardCharts";
import {
  deltaIndicator,
  ioStatusLabel,
  summarizeDashboardDevices,
  type DashboardAnalytics,
  type DashboardDeviceItem,
} from "./dashboard-metrics";
import { PlayerWorkspace, type LiveSummary } from "./PlayerWorkspace";
import { resourceCapabilities } from "./resource-capabilities";
import { ResourceActionsModal } from "./ResourceActionsPanel";
import { button, money, segment, useMerchant, useResource } from "./shared";
import { useBoardLive } from "./use-board-live";

type DeviceFilter = "all" | "running" | "occupied" | "alert";

export function DashboardPage() {
  const { t } = useI18n();
  const { shopId, shopCode, canWrite, timeZone } = useMerchant();

  const [deviceFilter, setDeviceFilter] = useState<DeviceFilter>("all");
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // Reuse analytics summary strictly for today's live operational counters.
  const analyticsResource = useResource<{ analytics?: DashboardAnalytics }>(
    "reports/analytics?days=7",
  );
  const analytics = analyticsResource.data?.analytics ?? null;

  const [liveSummary, setLiveSummary] = useState<LiveSummary>({
    present: 0,
    unpaid: 0,
    shortBalanceCount: 0,
    estimatedTotal: 0,
    loaded: false,
  });

  // Live device inventory, HA states, occupancy, and idle shutdown schedules.
  const [devices, setDevices] = useState<Resource[] | null>(null);
  const [devicesError, setDevicesError] = useState("");
  const [states, setStates] = useState<BoardStates | null>(null);
  const [watchers, setWatchers] = useState<BoardWatchers | null>(null);
  const [statesFailed, setStatesFailed] = useState(false);
  const [occupancy, setOccupancy] = useState<Record<string, ResourceOccupancyView>>({});
  const [powerOffAt, setPowerOffAt] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<Resource | null>(null);
  const pushedAt = useRef<Record<string, number>>({});

  useEffect(() => {
    setDevices(null);
    setDevicesError("");
    setStates(null);
    setWatchers(null);
    setStatesFailed(false);
    setOccupancy({});
    setPowerOffAt({});
    pushedAt.current = {};
  }, [shopId]);

  const loadDevices = useCallback(async () => {
    try {
      const r = await Api.machines(shopId);
      setDevices(r.machines ?? []);
      setDevicesError("");
    } catch (e) {
      setDevicesError(e instanceof Error ? e.message : "读取失败");
    }
  }, [shopId]);

  const readStates = useCallback(async () => {
    const askedAt = Date.now();
    try {
      const r = await api<{ states?: BoardStates }>(
        `/api/v1/merchant/machines/states?shopId=${encodeURIComponent(shopId)}`,
      );
      setStates((previous) =>
        applyBoardAnswer(previous, r.states ?? {}, askedAt, pushedAt.current),
      );
      setStatesFailed(false);
    } catch {
      setStatesFailed(true);
    }
  }, [shopId]);

  const readOccupancy = useCallback(async () => {
    try {
      const r = await api<{
        resources?: ResourceOccupancyView[];
        powerOffAt?: Record<string, string>;
      }>(`/api/v1/merchant/machines/occupancy?shopId=${encodeURIComponent(shopId)}`);
      setOccupancy(
        Object.fromEntries(
          (r.resources ?? []).map((resource) => [resource.resourceId, resource]),
        ),
      );
      setPowerOffAt(r.powerOffAt ?? {});
    } catch {
      // Keep last known occupancy until the next poll.
    }
  }, [shopId]);

  useEffect(() => {
    void loadDevices();
    void readOccupancy();
    const timer = setInterval(() => {
      void readOccupancy();
    }, 30_000);
    return () => clearInterval(timer);
  }, [loadDevices, readOccupancy]);

  const hasStateDevices = (devices ?? []).some((device) => {
    const caps = resourceCapabilities(device);
    return caps.power || caps.climate;
  });

  useBoardLive(
    shopId,
    hasStateDevices,
    useCallback((frame: BoardFrame) => {
      if (frame.type === "watchers") {
        setWatchers(frame);
        return;
      }
      const now = Date.now();
      for (const id of framedDevices(frame)) pushedAt.current[id] = now;
      setStates((previous) => applyBoardFrame(previous, frame));
    }, []),
  );

  const unread = states === null;
  const awaiting =
    !unread &&
    (devices ?? []).some((device) => {
      const caps = resourceCapabilities(device);
      return (caps.power || caps.climate) && awaitingState(states[device.id] ?? null, caps);
    });

  useEffect(() => {
    if (!hasStateDevices || (!unread && !awaiting)) return;
    const timer = setTimeout(
      () => void readStates(),
      unread ? (statesFailed ? 15_000 : 3_000) : 20_000,
    );
    return () => clearTimeout(timer);
  }, [hasStateDevices, unread, awaiting, statesFailed, readStates]);

  const setDeviceState = useCallback(
    (id: string, next: Partial<BoardState>, askedAt: number) => {
      if ((pushedAt.current[id] ?? 0) > askedAt) return;
      setStates((previous) => ({
        ...(previous ?? {}),
        [id]: applyBoardState(previous?.[id], next),
      }));
    },
    [],
  );

  const deviceSummary = useMemo(
    () =>
      summarizeDashboardDevices(
        devices ?? [],
        states,
        occupancy,
        powerOffAt,
        statesFailed && states === null,
      ),
    [devices, states, occupancy, powerOffAt, statesFailed],
  );

  const filteredDevices = useMemo(() => {
    if (deviceFilter === "all") return deviceSummary.items;
    if (deviceFilter === "running") return deviceSummary.items.filter((item) => item.running);
    if (deviceFilter === "occupied")
      return deviceSummary.items.filter((item) => item.occupantCount > 0);
    return deviceSummary.items.filter((item) => item.alert);
  }, [deviceFilter, deviceSummary.items]);

  async function refreshAll() {
    setRefreshing(true);
    setRefreshSignal((value) => value + 1);
    analyticsResource.reload();
    await Promise.all([
      loadDevices(),
      readOccupancy(),
      hasStateDevices ? readStates() : Promise.resolve(),
    ]);
    setRefreshing(false);
  }

  const handlePlayerMutated = useCallback(() => {
    analyticsResource.reload();
    void readOccupancy();
  }, [analyticsResource.reload, readOccupancy]);

  const todayDelta = analytics
    ? deltaIndicator(analytics.today.revenueTotal, analytics.today.yesterdayRevenueTotal)
    : null;
  const displayZone = analytics?.range.timeZone || timeZone || "Asia/Shanghai";

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-xl font-semibold">{t("仪表板")}</h2>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
            {t("实时状态")}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/merchant/${segment(shopCode)}/history`}
            className={button}
          >
            <BarChart3 size={15} aria-hidden="true" />
            {t("历史与统计")}
          </Link>
          <button
            type="button"
            className={button}
            aria-label={t("刷新")}
            disabled={refreshing}
            onClick={() => void refreshAll()}
          >
            <RefreshCw
              size={15}
              className={refreshing ? "animate-spin" : ""}
              aria-hidden="true"
            />
            {t("刷新")}
          </button>
        </div>
      </header>

      {/* Live Operational KPI Strip */}
      <div data-tour="dashboard-kpi-strip" className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => scrollTo("dashboard-live-players")}
          className="focus-ring grid content-between gap-2.5 rounded-2xl border border-ink/10 bg-panel p-4 text-left shadow-soft transition-colors hover:border-mint/40"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink/60">{t("当前在店")}</span>
            <span className="grid size-7 place-items-center rounded-full bg-mint/10 text-mint">
              <Users size={15} aria-hidden="true" />
            </span>
          </div>
          <div className="flex items-baseline gap-1.5 tabular-nums">
            <strong className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {liveSummary.loaded ? liveSummary.present : "—"}
            </strong>
            <span className="text-xs text-ink/55">{t("人")}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {liveSummary.shortBalanceCount > 0 ? (
              <span className="rounded-full bg-coral/15 px-2 py-0.5 font-medium text-coral">
                {t("{count} 人余额不足", { count: liveSummary.shortBalanceCount })}
              </span>
            ) : liveSummary.unpaid > 0 ? (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400">
                {t("待结账")} {liveSummary.unpaid}
              </span>
            ) : (
              <span className="text-ink/55 tabular-nums">
                {analytics
                  ? `${t("今日到店")} ${analytics.today.visitCount} ${t("人次")}`
                  : t("查看在店玩家")}
              </span>
            )}
          </div>
        </button>

        <button
          type="button"
          onClick={() => scrollTo("dashboard-live-players")}
          className="focus-ring grid content-between gap-2.5 rounded-2xl border border-ink/10 bg-panel p-4 text-left shadow-soft transition-colors hover:border-mint/40"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink/60">{t("在店预估")}</span>
            <span className="grid size-7 place-items-center rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400">
              <Clock size={15} aria-hidden="true" />
            </span>
          </div>
          <div className="flex flex-wrap items-baseline gap-2 tabular-nums">
            <strong className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {liveSummary.loaded ? `¥${money(liveSummary.estimatedTotal)}` : "—"}
            </strong>
          </div>
          <p className="truncate text-xs text-ink/55 tabular-nums">
            {!liveSummary.loaded
              ? "—"
              : liveSummary.unpaid > 0
                ? `${t("待结账")} ${liveSummary.unpaid} ${t("笔")} · ${t("实时计费")}`
                : liveSummary.present > 0
                  ? t("当前计费中")
                  : t("当前暂无未结账单")}
          </p>
        </button>

        <Link
          to={`/merchant/${segment(shopCode)}/history`}
          className="focus-ring grid content-between gap-2.5 rounded-2xl border border-ink/10 bg-panel p-4 text-left shadow-soft transition-colors hover:border-mint/40"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink/60">{t("今日营收")}</span>
            <span className="grid size-7 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Wallet size={15} aria-hidden="true" />
            </span>
          </div>
          <div className="flex flex-wrap items-baseline gap-2 tabular-nums">
            <strong className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {analytics ? `¥${money(analytics.today.revenueTotal)}` : "—"}
            </strong>
            {todayDelta && <DeltaBadge delta={todayDelta} label={t("较昨日")} />}
          </div>
          <p className="truncate text-xs text-ink/55 tabular-nums">
            {analytics
              ? `${t("结账")} ${analytics.today.checkoutCount} ${t("笔")} · ${t("今日到店")} ${analytics.today.visitCount} ${t("人次")}`
              : "—"}
          </p>
        </Link>

        <button
          type="button"
          onClick={() => scrollTo("dashboard-devices")}
          className="focus-ring grid content-between gap-2.5 rounded-2xl border border-ink/10 bg-panel p-4 text-left shadow-soft transition-colors hover:border-mint/40"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink/60">{t("设备运行")}</span>
            <span
              className={`grid size-7 place-items-center rounded-full ${
                deviceSummary.alertCount > 0
                  ? "bg-coral/15 text-coral"
                  : "bg-mint/10 text-mint"
              }`}
            >
              <Cpu size={15} aria-hidden="true" />
            </span>
          </div>
          <div className="flex items-baseline gap-1.5 tabular-nums">
            <strong className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {devices ? `${deviceSummary.running} / ${deviceSummary.total}` : "—"}
            </strong>
            {deviceSummary.alertCount > 0 && (
              <span className="rounded-full bg-coral/15 px-2 py-0.5 text-xs font-medium text-coral">
                {t("{count} 台异常", { count: deviceSummary.alertCount })}
              </span>
            )}
          </div>
          <p className="truncate text-xs text-ink/55 tabular-nums">
            {devices
              ? `${t("开机")} ${deviceSummary.poweredOn} · ${t("占用")} ${deviceSummary.occupied} · ${t("今日投币")} ${analytics?.today.coinCount ?? 0}`
              : "—"}
          </p>
        </button>
      </div>

      {/* Live Devices Overview */}
      <section
        id="dashboard-devices"
        data-tour="dashboard-devices"
        className="grid min-w-0 content-start gap-3.5 scroll-mt-6 rounded-2xl border border-ink/10 bg-panel p-5 shadow-soft"
        aria-label={t("设备概览")}
      >
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Gamepad2 size={18} className="text-mint" aria-hidden="true" />
            <h3 className="text-base font-semibold">{t("设备概览")}</h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {watchers && (
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
                  watchers.watchers.some((w) => w.state === "unreachable") ||
                  watchers.watchers.length === 0
                    ? "bg-coral/15 text-coral"
                    : "bg-mint/10 text-mint"
                }`}
              >
                HA {watchers.watchers.filter((w) => w.state !== "confirming").length}/
                {watchers.limit}
              </span>
            )}
            <Link
              to={`/merchant/${segment(shopCode)}/resources`}
              className="focus-ring inline-flex items-center gap-0.5 rounded-lg px-2 py-1 text-xs font-medium text-mint hover:bg-mint/10"
            >
              {t("全部资源")}
              <ChevronRight size={14} aria-hidden="true" />
            </Link>
          </div>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-2.5">
          {deviceSummary.total > 0 ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("设备筛选")}>
              {(
                [
                  ["all", "全部", deviceSummary.total],
                  ["running", "运行中", deviceSummary.running],
                  ["occupied", "有人", deviceSummary.occupied],
                  ["alert", "异常", deviceSummary.alertCount],
                ] as const
              )
                .filter(([key, , count]) => key === "all" || count > 0)
                .map(([key, label, count]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={deviceFilter === key}
                    onClick={() => setDeviceFilter(key)}
                    className={`focus-ring inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      deviceFilter === key
                        ? key === "alert"
                          ? "bg-coral text-white"
                          : "bg-ink/10 font-semibold text-ink"
                        : key === "alert"
                          ? "bg-coral/10 text-coral hover:bg-coral/15"
                          : "bg-ink/[0.04] text-ink/60 hover:text-ink"
                    }`}
                  >
                    {t(label)}
                    <span className="opacity-70 tabular-nums">{count}</span>
                  </button>
                ))}
            </div>
          ) : (
            <span />
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs text-ink/65 tabular-nums">
            {deviceSummary.ioTotal > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-ink/[0.045] px-2.5 py-1">
                <CreditCard size={12} className="text-mint" aria-hidden="true" />
                {t("直连 IO")} {deviceSummary.ioOnline}/{deviceSummary.ioTotal}
              </span>
            )}
            {deviceSummary.botTotal > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-ink/[0.045] px-2.5 py-1">
                <Bot
                  size={12}
                  className={deviceSummary.botOnline < deviceSummary.botTotal ? "text-coral" : "text-mint"}
                  aria-hidden="true"
                />
                Bot {deviceSummary.botOnline}/{deviceSummary.botTotal}
              </span>
            )}
            {deviceSummary.countingDownCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-amber-600 dark:text-amber-400">
                <Timer size={12} aria-hidden="true" />
                {t("{count} 台将自动关机", { count: deviceSummary.countingDownCount })}
              </span>
            )}
            {deviceSummary.disabledCount > 0 && (
              <span className="text-ink/45">
                {t("已停用 {count} 台", { count: deviceSummary.disabledCount })}
              </span>
            )}
          </div>
        </div>

        {devicesError ? (
          <p role="alert" className="py-8 text-center text-sm text-coral">
            {devicesError}
          </p>
        ) : devices === null ? (
          <p role="status" className="py-10 text-center text-sm text-ink/50">
            {t("加载中...")}
          </p>
        ) : deviceSummary.total === 0 ? (
          <div className="grid justify-items-center gap-3 rounded-xl border border-dashed border-ink/15 px-4 py-8 text-center">
            <p className="text-sm text-ink/60">{t("还没有配置可用资源")}</p>
            {canWrite && (
              <Link
                to={`/merchant/${segment(shopCode)}/resources?add=1`}
                className={button}
              >
                <Plus size={15} aria-hidden="true" />
                {t("添加资源")}
              </Link>
            )}
          </div>
        ) : !filteredDevices.length ? (
          <p className="py-8 text-center text-sm text-ink/50">{t("当前筛选下没有设备")}</p>
        ) : (
          <div className="grid max-h-[304px] gap-2.5 overflow-y-auto pr-0.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredDevices.map((item) => (
              <CompactDeviceTile
                key={item.device.id}
                item={item}
                state={states?.[item.device.id] ?? null}
                timeZone={displayZone}
                canWrite={canWrite}
                onOpen={() => setActing(item.device)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Merged Live On-Site Players Workspace */}
      <section
        id="dashboard-live-players"
        className="scroll-mt-6"
        aria-label={t("在店玩家")}
      >
        <PlayerWorkspace
          live
          embedded
          refreshSignal={refreshSignal}
          onLiveSummary={setLiveSummary}
          onMutated={handlePlayerMutated}
        />
      </section>

      {acting && (() => {
        const activeActing = devices?.find((device) => device.id === acting.id) ?? acting;
        return (
          <ResourceActionsModal
            device={activeActing}
            state={states?.[activeActing.id] ?? null}
            onState={(next, askedAt) => setDeviceState(activeActing.id, next, askedAt)}
            onChanged={() => {
              void loadDevices();
              void readOccupancy();
            }}
            close={() => setActing(null)}
          />
        );
      })()}
    </div>
  );
}

function CompactDeviceTile({
  item,
  state,
  timeZone,
  canWrite,
  onOpen,
}: {
  item: DashboardDeviceItem;
  state: BoardState | null;
  timeZone: string;
  canWrite: boolean;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const { device, caps, view, hasControls, alert } = item;
  const TypeIcon = caps.bot
    ? Bot
    : caps.table
      ? LayoutGrid
      : caps.hinata_io
        ? Gamepad2
        : caps.door
          ? Lock
          : caps.power
            ? Power
            : caps.climate
              ? AirVent
              : QrCode;
  const ClimateIcon = (view.climate?.mode && climateModeIcon(view.climate.mode)) || AirVent;
  const interactive = canWrite && hasControls;
  const statusPieces: string[] = [];

  if (view.power) {
    statusPieces.push(
      t(
        view.power.tone === "on"
          ? "已开机"
          : view.power.tone === "off"
            ? "已关机"
            : "电源未知",
      ),
    );
  }
  if (view.climate) {
    statusPieces.push(climateSummary(state?.climate ?? null, t));
  }
  if (view.io) {
    statusPieces.push(t(ioStatusLabel(view.io)));
  }
  if (caps.bot) {
    statusPieces.push(t(device.botOnline ? "Bot 在线" : "Bot 离线"));
  }

  const content = (
    <div className="flex min-w-0 items-start gap-2.5">
      <span
        className={`grid size-8 shrink-0 place-items-center rounded-full ${
          alert
            ? "bg-coral text-white"
            : view.lit
              ? "bg-mint text-white"
              : "bg-ink/[0.08] text-ink/50"
        }`}
        aria-hidden="true"
      >
        <TypeIcon size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold">{device.name}</span>
          <div className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums">
            {alert && <AlertTriangle size={13} className="text-coral" aria-hidden="true" />}
            {view.coins && (
              <span
                className={`inline-flex items-center gap-0.5 font-medium ${
                  view.coins.old ? "text-ink/35" : "text-amber-600 dark:text-amber-400"
                }`}
                title={t("机内币数")}
              >
                <Coins size={12} aria-hidden="true" />
                {view.coins.value}
              </span>
            )}
            {view.climate && view.climate.temperature !== null && (
              <span className="inline-flex items-center gap-0.5 text-mint">
                <ClimateIcon size={12} aria-hidden="true" />
                {view.climate.temperature}°
              </span>
            )}
          </div>
        </div>

        <p className="mt-0.5 truncate text-xs text-ink/55">
          {statusPieces.join(" · ") || t("未配置硬件状态")}
        </p>

        {(view.seats?.occupants.length || view.powerOffAt) ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            {view.seats?.occupants.slice(0, 2).map((occupant) => (
              <span
                key={occupant.playerId}
                className="max-w-[7rem] truncate rounded-full bg-mint/12 px-2 py-0.5 font-medium text-mint"
              >
                {occupant.displayName ?? occupant.playerId}
              </span>
            ))}
            {(view.seats?.occupants.length ?? 0) > 2 && (
              <span className="text-ink/50">
                +{(view.seats?.occupants.length ?? 0) - 2}
              </span>
            )}
            {view.powerOffAt && (
              <span className="inline-flex items-center gap-0.5 font-medium text-amber-600 dark:text-amber-400 tabular-nums">
                <Timer size={11} aria-hidden="true" />
                {billTime(view.powerOffAt, timeZone).time}
              </span>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );

  const tileClass = `min-w-0 rounded-xl border p-3 text-left transition-colors ${
    alert
      ? "border-coral/35 bg-coral/[0.04]"
      : view.lit
        ? "border-ink/10 bg-canvas/70 dark:bg-surface/70"
        : "border-ink/10 bg-ink/[0.02]"
  }`;

  if (interactive) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={`focus-ring ${tileClass} hover:border-mint/45`}
        aria-label={`${device.name} · ${t("操作")}`}
      >
        {content}
      </button>
    );
  }
  return <div className={tileClass}>{content}</div>;
}

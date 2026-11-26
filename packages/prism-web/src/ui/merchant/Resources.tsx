import { keyTextFromVk } from "@prism/core";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  AirVent,
  Bot,
  Coins,
  Cpu,
  CreditCard,
  DoorOpen,
  Gamepad2,
  History,
  Keyboard,
  LayoutGrid,
  Lock,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  Printer,
  QrCode,
  RefreshCw,
  Timer,
  Ungroup,
} from "lucide-react";
import { Api, api, playerOperation, type DeviceEvent, type OccupancyHistoryEntry, type Resource, type ResourceGroup, type ResourceOccupancyView } from "../../api";
import { ClimateControls, climateModeIcon, climateModeName, climateSummary } from "../ClimateControls";
import { useI18n } from "../../i18n";
import { billTime, groupByDate, shortDateLabel } from "../bill-time";
import {
  input,
  segment,
  Modal,
  State,
  button,
  buttonQuiet,
  primary,
  useCopy,
  useMerchant,
  useResource,
  type Player,
} from "./shared";
import {
  capabilityOrder,
  deviceActionGroups,
  deviceActions,
  hasResourceLink,
  resourceCapabilities,
  isDirectConnect,
  type CapabilityId,
} from "./resource-capabilities";
import { ResourceEditor } from "./ResourceEditor";
import { ResourceGroupEditor, useBillablePlans, useResourceGroups } from "./ResourceGroups";
import { HostControls } from "./HostControls";
import {
  applyBoardAnswer,
  applyBoardFrame,
  applyBoardState,
  awaitingState,
  framedDevices,
  viewOf,
  type BoardFrame,
  type BoardState,
  type BoardStates,
  type BoardWatchers,
} from "./board-state";
import { HaWatchersPanel } from "./HaWatchers";
import { useBoardLive } from "./use-board-live";
import { useAuth } from "../AuthContext";
import { stayLength, tileView, type Tone } from "./resource-tile";

type Filter = "all" | CapabilityId | "unconfigured";

/** The type filter's label for each capability. */
const capabilityLabels: Record<CapabilityId, string> = {
  power: "电源",
  climate: "空调",
  hinata_io: "刷卡",
  keys: "按键",
  coin: "投币",
  host: "启动器",
  iot: "IoT 控制器",
  door: "门锁",
  table: "桌游",
  bot: "Bot",
};

/**
 * The device list is cached per shop so returning to the tab shows the last
 * known cards instead of a loading line. Every mount still refetches.
 */
const machineCache = new Map<string, Resource[]>();

export function ResourcesPage() {
  const { shopId, shopCode, canWrite } = useMerchant();
  const { user } = useAuth();
  const plans = useBillablePlans(shopCode);
  const { t } = useI18n();
  const [devices, setDevices] = useState<Resource[] | null>(
    () => machineCache.get(shopId) ?? null,
  );
  const [error, setError] = useState("");
  // A resource being edited, or the group a new one is added to.
  const [editing, setEditing] = useState<Resource | { groupId: string } | null>(null);
  const [groupEditing, setGroupEditing] = useState<ResourceGroup | "new" | null>(null);
  const [qr, setQR] = useState<Resource | null>(null);
  const [acting, setActing] = useState<Resource | null>(null);
  const [history, setHistory] = useState<Resource | null>(null);
  const [editorLocked, setEditorLocked] = useState(false);
  const [editorWide, setEditorWide] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const resourceGroups = useResourceGroups(shopId);
  const [params, setParams] = useSearchParams();
  // The setup guide links here with `?add=1` to open the editor directly.
  useEffect(() => {
    if (params.get("add") !== "1") return;
    if (canWrite) setEditing({ groupId: "default" });
    const next = new URLSearchParams(params);
    next.delete("add");
    setParams(next, { replace: true });
  }, [params, setParams, canWrite]);
  const [states, setStates] = useState<BoardStates | null>(null);
  // Who is watching Home Assistant, as the hub last said. Not part of any device's state.
  const [watchers, setWatchers] = useState<BoardWatchers | null>(null);
  const [statesFailed, setStatesFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** When the hub last said each device's values; an HTTP answer to an older question loses to it. */
  const pushedAt = useRef<Record<string, number>>({});
  // Another shop's states are not this one's.
  useEffect(() => {
    setStates(null);
    setWatchers(null);
    setStatesFailed(false);
    pushedAt.current = {};
  }, [shopId]);
  /**
   * The state of the whole shop over HTTP, read by the backend as everywhere else. For the refresh
   * button, and as the fallback while the hub's connection gives the board nothing.
   */
  const readStates = useCallback(async () => {
    const askedAt = Date.now();
    try {
      const r = await api<{ states: BoardStates }>(`/api/v1/merchant/machines/states?shopId=${encodeURIComponent(shopId)}`);
      setStates((previous) => applyBoardAnswer(previous, r.states, askedAt, pushedAt.current));
      setStatesFailed(false);
    } catch {
      setStatesFailed(true);
    }
  }, [shopId]);
  /** Who is on each resource now; read with the states and every half minute. */
  const [occupancy, setOccupancy] = useState<Record<string, ResourceOccupancyView>>({});
  /** When the idle rules will switch each device off, for devices counting down. */
  const [powerOffAt, setPowerOffAt] = useState<Record<string, string>>({});
  const readOccupancy = useCallback(async () => {
    try {
      const r = await api<{ resources: ResourceOccupancyView[]; powerOffAt?: Record<string, string> }>(
        `/api/v1/merchant/machines/occupancy?shopId=${encodeURIComponent(shopId)}`,
      );
      setOccupancy(Object.fromEntries(r.resources.map((resource) => [resource.resourceId, resource])));
      setPowerOffAt(r.powerOffAt ?? {});
    } catch {
      // The cards simply show no occupancy until the next read.
    }
  }, [shopId]);
  useEffect(() => {
    setOccupancy({});
    setPowerOffAt({});
    void readOccupancy();
    const timer = setInterval(() => void readOccupancy(), 30_000);
    return () => clearInterval(timer);
  }, [readOccupancy]);
  /** What an action's answer said of one device, unless the hub has said something newer since. */
  const setDeviceState = useCallback(
    (id: string, next: Partial<BoardState>, askedAt: number) => {
      if ((pushedAt.current[id] ?? 0) > askedAt) return;
      setStates((previous) => ({ ...(previous ?? {}), [id]: applyBoardState(previous?.[id], next) }));
    },
    [],
  );
  async function refresh() {
    setRefreshing(true);
    await Promise.all([readStates(), readOccupancy(), load().catch((e) => setError(e.message))]);
    setRefreshing(false);
  }
  const load = useCallback(
    () =>
      Api.machines(shopId).then((r) => {
        machineCache.set(shopId, r.machines);
        setDevices(r.machines);
      }),
    [shopId],
  );
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  const hasConnections = (devices ?? []).some(
    (device) => device.bot || isDirectConnect(device) || device.host || device.iot,
  );
  useEffect(() => {
    if (!hasConnections) return;
    const timer = setInterval(() => void load().catch(() => {}), 15_000);
    return () => clearInterval(timer);
  }, [hasConnections, load]);
  const hasStateDevices = (devices ?? []).some((device) => {
    const caps = resourceCapabilities(device);
    return caps.power || caps.climate;
  });
  // The board shows what the hub sends: the whole shop when the connection opens and whenever which
  // devices are live changes, what Home Assistant said of the devices nothing watches, every change
  // of a live device, and what an action left a device in. Which of those a value was is the
  // backend's business.
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
  // If the hub gives the board no state (it cannot connect, or says nothing), read it over HTTP;
  // likewise if a device's values never follow its label.
  const unread = states === null;
  const awaiting = !unread && (devices ?? []).some((device) => {
    const caps = resourceCapabilities(device);
    return (caps.power || caps.climate) && awaitingState(states[device.id] ?? null, caps);
  });
  useEffect(() => {
    if (!hasStateDevices || (!unread && !awaiting)) return;
    const timer = setTimeout(() => void readStates(), unread ? (statesFailed ? 15_000 : 3_000) : 20_000);
    return () => clearTimeout(timer);
  }, [hasStateDevices, unread, awaiting, statesFailed, readStates]);
  // Card cabinets still behind an external relay: the page suggests moving them to a direct connection.
  const relayed = useMemo(
    () => (devices ?? []).filter((device) => resourceCapabilities(device).hinata_io && !isDirectConnect(device)),
    [devices],
  );
  const counts = useMemo(() => {
    const result: Record<string, number> = { all: devices?.length ?? 0 };
    for (const device of devices ?? []) {
      const caps = resourceCapabilities(device);
      for (const id of capabilityOrder) if (caps[id]) result[id] = (result[id] ?? 0) + 1;
      if (!Object.values(caps).some(Boolean))
        result.unconfigured = (result.unconfigured ?? 0) + 1;
    }
    return result;
  }, [devices]);
  const matches = (device: Resource) => {
    if (filter === "all") return true;
    const caps = resourceCapabilities(device);
    if (filter === "unconfigured") return !Object.values(caps).some(Boolean);
    return caps[filter];
  };
  const planName = (id: string | null) => plans.find((plan) => plan.id === id)?.name ?? null;
  // Every resource sits in its group; the shop's default group comes first. A resource whose
  // group is not listed (the groups could not be read) is shown in the default group.
  const listed = new Set((resourceGroups.groups ?? []).map((group) => group.id));
  const groupOf = (device: Resource) => {
    const id = device.resourceGroupId ?? "default";
    return listed.has(id) ? id : "default";
  };
  const sections = (resourceGroups.groups ?? []).map((group) => ({
    group,
    resources: (devices ?? []).filter((device) => groupOf(device) === group.id && matches(device)),
  }));
  const reloadAll = () => {
    void load();
    void resourceGroups.reload();
    window.dispatchEvent(new Event("prism-shop-settings"));
  };
  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("店内资源")}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {(hasStateDevices || hasConnections) && (
            <button
              type="button"
              className={button}
              disabled={refreshing || (hasStateDevices && states === null && !statesFailed)}
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
              {t("刷新设备状态")}
            </button>
          )}
          {canWrite && (
            <button data-tour="resources-add-group" className={primary} onClick={() => setGroupEditing("new")}>
              <Plus size={17} />
              {t("添加资源组")}
            </button>
          )}
        </div>
      </header>
      {canWrite && relayed.length > 0 && (
        <section className="grid gap-2 rounded-xl border border-mint/30 bg-mint/5 p-4 text-sm" aria-label={t("建议改为直连")}>
          <p className="font-medium">{t("这些刷卡机台还在用外部中继，建议改为直连本平台")}</p>
          <p className="text-ink/60">
            {t("直连不用另外部署和维护中继服务，刷卡、投币和在线状态都由平台直接处理。在资源的「刷卡 · HINATA IO」里选「直连本平台」，签发设备令牌后把它填进机台。")}
          </p>
          <div className="flex flex-wrap gap-2">
            {relayed.map((device) => (
              <button key={device.id} type="button" className={`${button} min-h-9 px-3 py-1`} onClick={() => setEditing(device)}>
                {device.name}
              </button>
            ))}
          </div>
        </section>
      )}
      {hasStateDevices && watchers && (
        <HaWatchersPanel
          shopId={shopId}
          watchers={watchers}
          devices={devices ?? []}
          // The number of watchers is the platform administrator's, for this one shop.
          canEdit={user?.role === "admin"}
          onLimit={(limit) => setWatchers((current) => (current ? { ...current, limit } : current))}
        />
      )}
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={t("资源类型")}
      >
        {(
          [
            ["all", "全部"],
            ...capabilityOrder.map((id) => [id, capabilityLabels[id]] as const),
            ["unconfigured", "未配置"],
          ] as [Filter, string][]
        ).filter(([key]) => key === "all" || counts[key]).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`${button} min-h-9 rounded-full px-4 py-1 ${
              filter === key
                ? "border-ink/25 bg-ink/10 font-semibold"
                : "border-transparent text-ink/55 hover:text-ink"
            }`}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {t(label)}
            {counts[key] ? (
              <span className="text-xs text-ink/45">{counts[key]}</span>
            ) : null}
          </button>
        ))}
      </div>
      {resourceGroups.error && (
        <p role="alert" className="flex flex-wrap items-center gap-3 text-sm text-coral">
          {t("资源组读取失败，资源暂按默认资源组显示")}
          <button type="button" className="underline" onClick={() => void resourceGroups.reload()}>{t("重试")}</button>
        </p>
      )}
      {!devices || !resourceGroups.groups ? (
        <State error={error} />
      ) : (
        sections
          .filter(({ resources }) => filter === "all" || resources.length > 0)
          .map(({ group, resources }) => {
            const plan = planName(group.defaultPricingConfigId);
            return (
              <section
                key={group.id}
                data-tour={group.isDefault ? "resources-default-group" : undefined}
                className="grid gap-3"
                aria-label={t(group.name)}
              >
                <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink/10 pb-2">
                  <h3 className="text-base font-semibold">{t(group.name)}</h3>
                  {/* Groups that could not be read are not described, nor edited from a stand-in. */}
                  {!resourceGroups.error && <span className="flex flex-wrap items-center gap-x-3 text-xs text-ink/55">
                    <span className={plan ? "" : "text-coral"}>{plan ?? t("未设置计费方案")}</span>
                    <span>{t("{count} 个资源", { count: group.resourceCount })}</span>
                    {!group.enabled && <span className="text-coral">{t("已停用")}</span>}
                  </span>}
                  {canWrite && (
                    <span className="ml-auto flex items-center gap-1">
                      {!resourceGroups.error && <button type="button" className={`${buttonQuiet} min-h-9 px-2 text-xs`} onClick={() => setGroupEditing(group)}>
                        <Pencil size={14} aria-hidden="true" />
                        {t("编辑")}
                      </button>}
                      <button
                        type="button"
                        data-tour={group.isDefault ? "resources-add-btn" : undefined}
                        className={`${button} min-h-9 px-3 py-1 text-xs`}
                        onClick={() => setEditing({ groupId: group.id })}
                      >
                        <Plus size={14} aria-hidden="true" />
                        {t("添加资源")}
                      </button>
                    </span>
                  )}
                </header>
                {resources.length ? (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {resources.map((device) => (
                      <ResourceCard
                        key={device.id}
                        device={device}
                        canWrite={canWrite}
                        state={states?.[device.id] ?? null}
                        occupancy={occupancy[device.id]}
                        powerOffAt={powerOffAt[device.id]}
                        stateFailed={statesFailed && states === null}
                        playerHref={(playerId) => `/merchant/${segment(shopCode)}/dashboard?player=${segment(playerId)}`}
                        onAct={() => setActing(device)}
                        onQR={() => setQR(device)}
                        onHistory={() => setHistory(device)}
                        onEdit={() => setEditing(device)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-ink/15 px-5 py-6 text-center text-sm text-ink/50">
                    {t(group.isDefault && !devices.length
                      ? "一个资源对应店里一样玩家扫码就能用的东西：一台机台、一扇门、一张桌游桌，或者只是墙上的一张二维码。"
                      : "没有资源")}
                  </p>
                )}
              </section>
            );
          })
      )}
      {acting && (
        <Modal
          title={`${acting.name} · ${t("操作")}`}
          close={() => setActing(null)}
        >
          <ResourceActions
            device={acting}
            state={states?.[acting.id] ?? null}
            onState={(next, askedAt) => setDeviceState(acting.id, next, askedAt)}
            onChanged={() => void load()}
          />
        </Modal>
      )}
      {history && (
        <Modal
          title={`${history.name} · ${t("记录")}`}
          close={() => setHistory(null)}
          xl
        >
          <ResourceRecords device={history} playerHref={(playerId) => `/merchant/${segment(shopCode)}/dashboard?player=${segment(playerId)}`} />
        </Modal>
      )}
      {editing && (() => {
        const isWide = editorWide ?? ("id" in editing && !!editing.bot);
        return (
          <Modal
            title={"id" in editing ? "编辑资源" : "添加资源"}
            close={() => {
              setEditing(null);
              setEditorWide(null);
            }}
            dismissDisabled={editorLocked}
            xl={isWide}
            lg={!isWide}
          >
            <ResourceEditor
              key={"id" in editing ? editing.id : `new:${editing.groupId}`}
              value={"id" in editing ? editing : undefined}
              groupId={"id" in editing ? undefined : editing.groupId}
              onLockChange={setEditorLocked}
              onWideChange={setEditorWide}
              done={() => {
                setEditing(null);
                setEditorWide(null);
                reloadAll();
              }}
            />
          </Modal>
        );
      })()}
      {groupEditing && (
        <Modal
          title={groupEditing === "new" ? "添加资源组" : t(groupEditing.name)}
          close={() => setGroupEditing(null)}
        >
          <ResourceGroupEditor
            group={groupEditing === "new" ? undefined : groupEditing}
            done={() => {
              setGroupEditing(null);
              reloadAll();
            }}
          />
        </Modal>
      )}
      {qr && (
        <Modal title="资源二维码" close={() => setQR(null)}>
          <ResourceQR device={qr} />
        </Modal>
      )}
    </div>
  );
}

function ResourceQR({ device }: { device: Resource }) {
  const { t } = useI18n();
  const [copied, copy] = useCopy();
  const code = useRef<HTMLDivElement>(null);
  const url = `${window.location.origin}/t/${device.shopPublicId}/${device.publicId}`;
  function print() {
    const svg = code.current?.querySelector("svg")?.outerHTML;
    const view = window.open("", "_blank", "width=480,height=640");
    if (!svg || !view) return;
    const name = document.createElement("h1");
    name.textContent = device.name;
    view.document.title = device.name;
    view.document.body.innerHTML = `<main style="display:grid;justify-items:center;gap:16px;padding:32px;font-family:system-ui,sans-serif">${svg}${name.outerHTML}</main>`;
    view.document.querySelector("svg")?.setAttribute("width", "320");
    view.document.querySelector("svg")?.setAttribute("height", "320");
    view.focus();
    view.print();
  }
  return (
    <div className="grid justify-items-center gap-5">
      <div ref={code} className="bg-white p-4">
        <QRCodeSVG value={url} size={224} level="M" />
      </div>
      <h3 className="text-lg font-semibold">{device.name}</h3>
      <div className="flex flex-wrap justify-center gap-2">
        <button type="button" className={primary} onClick={print}>
          <Printer size={16} aria-hidden="true" />
          {t("打印")}
        </button>
        <button type="button" className={button} onClick={() => copy(url)}>
          {t(
            copied === "copied"
              ? "已复制"
              : copied === "failed"
                ? "复制失败"
                : "复制链接 / 写入 NFC",
          )}
        </button>
        <a className={button} href={url} target="_blank" rel="noreferrer">
          {t("测试扫码入口")}
        </a>
      </div>
      <p className="max-w-sm text-center text-xs leading-relaxed text-ink/55">
        {t("NFC：用任意 NFC 写入工具把这个链接写进标签，记录类型选网址（NDEF URI）。iPhone 碰一下会直接打开 PRiSM Link（App Clip，免安装），其它手机用浏览器打开。")}
      </p>
    </div>
  );
}

/** Minutes are enough for a stay or a countdown; the tiles re-render on this. */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const toneClass: Record<Tone, string> = {
  on: "bg-mint/15 text-mint",
  off: "bg-ink/[0.06] text-ink/35",
  bad: "bg-coral/15 text-coral",
  unsure: "text-ink/35 ring-1 ring-inset ring-ink/20",
};

/** One small status capsule; a value that is not live keeps its colour but loses its fill. */
function StatusPill({ tone, live = true, label, children }: { tone: Tone; live?: boolean; label: string; children: React.ReactNode }) {
  const hollow = !live && tone !== "unsure";
  return (
    <span
      className={`inline-flex h-6 min-w-6 items-center justify-center gap-1 rounded-full px-1.5 text-xs font-semibold tabular-nums ${
        hollow ? `${tone === "on" ? "text-mint ring-mint/45" : "text-ink/35 ring-ink/20"} ring-1 ring-inset` : toneClass[tone]
      }`}
      role="img"
      title={label}
      aria-label={label}
    >
      {children}
    </span>
  );
}

/** Records and edit, behind the tile's ⋯. The QR code is the way in for players, so it stays out. */
function TileMenu({ name, canWrite, onHistory, onEdit }: {
  name: string;
  canWrite: boolean;
  onHistory: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof PointerEvent && event.target instanceof Node && menu.current?.contains(event.target)) return;
      if (menu.current) menu.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const item = "flex w-full items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm hover:bg-ink/5";
  const pick = (action: () => void) => () => {
    if (menu.current) menu.current.open = false;
    action();
  };
  return (
    <details ref={menu} className="relative z-10" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary
        role="button"
        className="focus-ring grid size-8 cursor-pointer list-none place-items-center rounded-lg text-ink/40 hover:bg-ink/5 hover:text-ink [&::-webkit-details-marker]:hidden"
        aria-label={`${t("更多")} ${name}`}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </summary>
      <div className="absolute bottom-full right-0 mb-1 grid min-w-36 rounded-xl border border-ink/10 bg-panel p-1 shadow-soft">
        <button type="button" className={item} onClick={pick(onHistory)}>
          <History size={15} aria-hidden="true" />
          {t("操作记录")}
        </button>
        {canWrite && (
          <button type="button" className={item} onClick={pick(onEdit)}>
            <Pencil size={15} aria-hidden="true" />
            {t("编辑")}
          </button>
        )}
      </div>
    </details>
  );
}

/**
 * A resource as a tile. It is lit while its power is on; the round icon says what it is, the
 * capsules on the right say power, air conditioner and IO, the pills are who is on it, and the
 * bottom row holds credits and the idle power-off. Clicking the tile opens its operations.
 */
function ResourceCard({
  device,
  canWrite,
  state,
  occupancy,
  powerOffAt,
  stateFailed,
  playerHref,
  onAct,
  onQR,
  onHistory,
  onEdit,
}: {
  device: Resource;
  canWrite: boolean;
  /** What the board knows of this device's power and air conditioner; null until it is read. */
  state: BoardState | null;
  /** Who is on it now; absent for a resource nobody occupies (capacity 0). */
  occupancy?: ResourceOccupancyView;
  /** When the idle rules will switch it off; absent unless it is counting down. */
  powerOffAt?: string;
  stateFailed: boolean;
  /** Where a player's own page is: their profile and, while they bill, their bill. */
  playerHref: (playerId: string) => string;
  onAct: () => void;
  onQR: () => void;
  onHistory: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const { timeZone } = useMerchant();
  const now = useMinuteClock();
  const caps = resourceCapabilities(device);
  const enabled = !!device.enabled;
  const configured = Object.values(caps).some(Boolean);
  // Seating a player is a table operation even though the catalog lists no device action for it.
  const hasControls = deviceActions(device).length > 0 || !!caps.table || !!caps.host;
  const view = tileView(device, state, occupancy, powerOffAt, stateFailed);
  const TypeIcon = caps.bot
    ? Bot
    : caps.table
      ? LayoutGrid
      : caps.hinata_io
        ? Gamepad2
        : caps.host
          ? Monitor
          : caps.iot
            ? Cpu
            : caps.door
              ? Lock
              : caps.power
                ? Power
                : caps.climate
                  ? AirVent
                  : caps.keys
                    ? Keyboard
                    : QrCode;
  const open = canWrite && hasControls && enabled ? onAct : onHistory;
  const first = view.seats?.occupants[0];
  const stay = first ? stayLength(first.startedAt, now) : null;
  const ClimateIcon = (view.climate?.mode && climateModeIcon(view.climate.mode)) || AirVent;
  // A value the backend has not said yet is being read; one it said as null is unknown.
  const powerLabel = view.power?.tone === "on" ? t("已开机") : view.power?.tone === "off" ? t("已关机")
    : !stateFailed && state?.power === undefined ? t("读取电源状态…") : t("电源状态未知");
  // Whether a value is followed live is drawn (hollow when not); it is said here, once the board has read it.
  const liveTag = (live: boolean) => (state ? ` · ${t(live ? "实时" : "非实时")}` : "");
  const powerName = view.power ? `${t("电源")} ${powerLabel}${liveTag(view.power.live)}` : "";
  // A power-only device's round icon already says on or off; its capsule would only repeat it.
  const powerPill = !!view.power && (TypeIcon !== Power || !view.power.live || view.power.tone === "unsure");
  const ioLabel = view.io?.tone === "on" ? t("机台在线") : view.io?.tone === "off" ? t("机台离线") : t("连接未知");
  return (
    <article
      className={`relative flex min-h-44 min-w-0 flex-col gap-2.5 rounded-2xl p-3.5 transition-colors ${
        view.lit ? "bg-panel shadow-soft ring-1 ring-ink/5 dark:bg-surface" : "bg-ink/[0.035] dark:bg-panel"
      } ${enabled ? "" : "opacity-45"}`}
    >
      {/* The whole tile opens its operations; the links and the menu sit above this. */}
      <button
        type="button"
        className="focus-ring absolute inset-0 rounded-2xl"
        aria-label={`${device.name} · ${t(canWrite && hasControls && enabled ? "操作" : "操作记录")}`}
        onClick={open}
      />
      <div className="pointer-events-none relative flex items-start justify-between gap-2">
        <span
          className={`grid size-10 shrink-0 place-items-center rounded-full ${
            view.tone === "bad" ? "bg-coral text-white" : view.tone === "on" ? "bg-mint text-white" : "bg-ink/[0.08] text-ink/50"
          }`}
          {...(view.power && !powerPill ? { role: "img", title: powerName, "aria-label": powerName } : { "aria-hidden": true })}
        >
          <TypeIcon size={19} aria-hidden="true" />
        </span>
        <span className="flex flex-wrap justify-end gap-1">
          {view.power && powerPill && (
            <StatusPill tone={view.power.tone} live={view.power.live} label={powerName}>
              <Power size={13} aria-hidden="true" />
            </StatusPill>
          )}
          {view.climate && (
            <StatusPill tone={view.climate.tone} live={view.climate.live} label={`${t("空调")} ${!stateFailed && state?.climate === undefined ? t("读取空调状态…") : climateSummary(state?.climate ?? null, t)}${liveTag(view.climate.live)}`}>
              <ClimateIcon size={13} aria-hidden="true" />
              {view.climate.temperature !== null && `${view.climate.temperature}°`}
            </StatusPill>
          )}
          {view.io && (
            <StatusPill
              tone={view.io.tone}
              label={view.io.tone === "on" && view.io.readers !== null ? `${ioLabel} · ${t("读卡器 {count}", { count: view.io.readers })}` : ioLabel}
            >
              <Cpu size={13} aria-hidden="true" />
              {view.io.tone === "on" && view.io.readers !== null && (
                <>
                  <span className="mx-0.5 h-3 w-px bg-current opacity-30" aria-hidden="true" />
                  {view.io.readers > 0 ? (
                    Array.from({ length: view.io.readers }, (_, index) => <CreditCard key={index} size={13} aria-hidden="true" />)
                  ) : (
                    <span className="flex items-center gap-0.5 text-coral">
                      <CreditCard size={13} aria-hidden="true" />0
                    </span>
                  )}
                </>
              )}
            </StatusPill>
          )}
        </span>
      </div>
      <div className="pointer-events-none relative min-w-0">
        <h3 className={`truncate text-[15px] font-semibold leading-5 ${view.lit ? "" : "text-ink/70"}`}>{device.name}</h3>
        <p className="min-h-4 text-xs leading-4 tabular-nums text-ink/50">
          {!enabled
            ? t("已停用")
            : stay
              ? stay.hours
                ? t("{hours} 时 {minutes} 分", stay)
                : t("{minutes} 分", stay)
              : ""}
        </p>
      </div>
      {view.seats && (
        <div className="relative flex flex-wrap gap-1.5">
          {view.seats.occupants.map((occupant) => (
            <Link
              key={occupant.playerId}
              className={`focus-ring inline-flex h-6 max-w-[7.5rem] items-center truncate rounded-full px-2.5 text-xs font-medium text-mint ${
                occupant.billing === false ? "ring-1 ring-inset ring-mint/45 hover:bg-mint/10" : "bg-mint/15 hover:bg-mint/25"
              }`}
              to={playerHref(occupant.playerId)}
              title={occupant.billing === false ? t("未计费") : undefined}
            >
              {occupant.displayName ?? occupant.playerId}
            </Link>
          ))}
          {Array.from({ length: Math.max(0, view.seats.capacity - view.seats.occupants.length) }, (_, index) => (
            <span key={index} className="pointer-events-none h-6 w-10 rounded-full border-[1.5px] border-dashed border-ink/15" aria-hidden="true" />
          ))}
        </div>
      )}
      {!configured && canWrite && (
        <button type="button" className={`${primary} relative z-10 min-h-8 justify-self-start px-3 py-1 text-xs`} onClick={onEdit}>
          {t("配置能力")}
        </button>
      )}
      <div className="relative mt-auto flex min-h-8 items-center gap-2.5 text-[13px] tabular-nums">
        {view.coins && (
          <span
            className={`pointer-events-none flex shrink-0 items-center gap-1.5 whitespace-nowrap font-semibold ${view.coins.old ? "text-ink/35" : ""}`}
            title={t("机内币数")}
          >
            <Coins size={15} className={view.coins.old ? "" : "text-amber-500"} aria-hidden="true" />
            {view.coins.value}
            {view.coins.cap !== null && <span className="font-normal text-ink/40">/ {view.coins.cap}</span>}
          </span>
        )}
        {view.powerOffAt && (
          <span className="pointer-events-none flex shrink-0 items-center gap-1 whitespace-nowrap font-semibold text-amber-600 dark:text-amber-400" title={t("闲置自动关机")}>
            <Timer size={14} aria-hidden="true" />
            {billTime(view.powerOffAt, timeZone || undefined).time}
          </span>
        )}
        <span className="relative z-10 ml-auto flex items-center gap-0.5">
          {/* Resources without a player link (e.g. a pure bot or pure IoT controller) are not scanned. */}
          {hasResourceLink(caps) && (
            <button
              type="button"
              data-tour="resource-qr-btn"
              className="focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs font-medium text-ink/70 ring-1 ring-inset ring-ink/15 hover:bg-ink/5 hover:text-ink"
              aria-label={`${t("资源二维码")} ${device.name}`}
              onClick={onQR}
            >
              <QrCode size={15} aria-hidden="true" />
              {t("二维码")}
            </button>
          )}
          <TileMenu name={device.name} canWrite={canWrite} onHistory={onHistory} onEdit={onEdit} />
        </span>
      </div>
    </article>
  );
}

/**
 * Pair each request with its result so an action is one line. A result whose
 * request fell outside the loaded page is shown on its own.
 */
function timeline(events: DeviceEvent[]) {
  const results = new Map(
    events.filter((e) => e.kind === "result" && e.operationId).map((e) => [e.operationId!, e]),
  );
  const requested = new Set(events.filter((e) => e.kind === "request").map((e) => e.operationId));
  return events
    .filter((e) => e.kind !== "result" || !requested.has(e.operationId))
    .map((event) => ({
      event: event.kind === "result" ? { ...event, kind: "request" as const } : event,
      result: event.kind === "result" ? event : event.operationId ? results.get(event.operationId) : undefined,
    }));
}

function changeLabel(event: DeviceEvent, t: (message: string, values?: Record<string, string | number>) => string): string {
  const to = event.payload.to;
  if (event.name === "power") return t(to === "on" ? "电源已开启" : "电源已关闭");
  if (event.name === "link") return t(to === "online" ? "机台已连接" : "机台已断开");
  if (event.name === "idle") return t(to === true ? "已闲置" : "恢复使用");
  if (event.name === "climate" && to && typeof to === "object") {
    const setting = to as { mode?: string; temperature?: number | null };
    const mode = t(climateModeName(String(setting.mode ?? "")));
    return setting.mode !== "off" && typeof setting.temperature === "number"
      ? t("空调：{mode} {value}°", { mode, value: setting.temperature })
      : t("空调：{mode}", { mode });
  }
  return event.name;
}

/**
 * Where a request came from, for the channels a person or a rule stands behind.
 * A machine's own reports (`relay`, `ha`) already say so by their direction.
 */
const viaLabels: Partial<Record<NonNullable<DeviceEvent["via"]>["channel"], string>> = {
  page: "扫码页",
  merchant: "商户后台",
  bot: "Bot",
  api: "接口",
  system: "平台规则",
};

const commandOutcomes: Record<string, string> = { answered: "已回复", refused: "已拒绝", failed: "出错" };

/** Who said a command to a bot, as the chat named them. */
function chatName(value: unknown): string {
  const who = (value ?? {}) as { name?: unknown; subject?: unknown };
  return typeof who.name === "string" && who.name ? who.name : typeof who.subject === "string" ? who.subject : "";
}

const actionLabels: Record<string, string> = {
  checkout: "结账",
  "power.on": "开机",
  "power.off": "关机",
  "power.keep": "延迟关机",
  "climate.on": "开空调",
  "climate.off": "关空调",
  "climate.set_mode": "切换空调模式",
  "climate.set_temperature": "设定温度",
  "climate.set_fan_mode": "调整风速",
  coin: "投币",
  "key.press": "按键",
  "door.open": "获取开门密码",
  "aime.scan": "刷卡",
  "card.state": "读卡状态变化",
  "card.consumed": "卡片已送入游戏",
  "led.set": "灯光",
  "cabinet.coin": "机台投币",
  "cabinet.credit": "机内加币",
  "cabinet.consumed": "机内扣币",
  "cabinet.activity": "机台活动",
  "cabinet.reset": "投币计数清零",
  "host.switch": "切换游戏",
  "host.key": "远程按键",
  "host.text": "文字输入",
  "host.screenshot": "截取画面",
  "host.reboot": "重启主机",
  "host.shutdown": "关闭主机",
  "host.fs.list": "列出目录",
  "host.fs.read": "读取文件",
  "host.fs.write": "写入文件",
  "host.fs.mkdir": "创建目录",
  "host.fs.rename": "重命名路径",
  "host.fs.delete": "删除路径",
  "host.powershell": "执行 PowerShell",
  "reader.connected": "读卡器插入",
  "reader.disconnected": "读卡器拔出",
  // What happened at the shop without a device doing anything (capability `shop`).
  "session.started": "入场",
  "session.stopped": "停止计费",
  "checkout.settled": "结账",
  "checkout.refused": "结账失败",
  "resource.visited": "访问资源链接",
  "wallet.adjusted": "调整余额",
  "assets.adjusted": "调整资产",
  "gift.redeemed": "兑换礼物",
  "card.bound": "添加卡片",
  "occupancy.started": "上机",
  "seat.changed": "上下桌",
};

/** Why a request was turned away, for the reasons a shop meets most; otherwise the platform's own words or code. */
const refusalReasons: Record<string, string> = {
  DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION: "玩家未入场",
  COIN_COMMAND_COOLDOWN_ACTIVE: "投币冷却中",
  COIN_COOLDOWN: "投币冷却中",
  COIN_CABINET_FULL: "达到机台投币上限",
  COIN_VIA_SWIPE: "请通过刷卡投币",
  DEVICE_POWER_OFF: "设备未开机",
  DEVICE_NOT_FOUND: "没有这个设备",
  DEVICE_DISABLED: "资源已停用",
  DEVICE_ACTION_UNSUPPORTED: "这里不支持此操作",
  SCAN_IDENTITY_NOT_BOUND_TO_PLAYER: "玩家没有绑定的卡片",
  INSUFFICIENT_BALANCE: "余额不足",
};

type Books = {
  players: Array<{ credit: number; remain: number }>;
  bookkeeping: { totalCoin: number };
} | { error: string };

/**
 * What the cabinet's own books say (an IO the platform has asked to report them), with a way
 * to have the IO read them again when they look out of date.
 */
function CabinetBooks({ deviceId }: { deviceId: string }) {
  const { t } = useI18n();
  const [books, setBooks] = useState<Books | null | undefined>(undefined);
  const [io, setIo] = useState<IoFacts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ cabinet: Books | null; io?: IoFacts }>(`/api/v1/merchant/machines/${deviceId}/cabinet`)
      .then((r) => {
        setBooks(r.cabinet);
        setIo(r.io ?? null);
      })
      .catch(() => setBooks(null));
  }, [deviceId]);
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ cabinet: Books }>(`/api/v1/merchant/machines/${deviceId}/cabinet/refresh`, { method: "POST" });
      setBooks(r.cabinet);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("读取失败"));
    } finally {
      setBusy(false);
    }
  }
  const summary =
    books === undefined ? t("读取中…")
    : books === null ? t("未上报币数（游戏没有 sysfile.dat，或 IO 版本太旧）")
    : "error" in books ? t("币数读取失败：{error}", { error: books.error })
    : t("当前 {credit} 币 · 累计投币 {coins}", {
        credit: books.players[0]?.credit ?? 0,
        coins: books.bookkeeping.totalCoin,
      });
  return (
    <div className="grid gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink/70">{summary}</span>
        <button type="button" className={button} disabled={busy} onClick={() => void refresh()}>
          {t("刷新机台状态")}
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
      {io && <IoStatus io={io} />}
    </div>
  );
}

type IoReader = { chipId: string | null; firmwareTimestamp: number | null; commitHash: string | null };
type IoFacts = { version: string | null; readers: IoReader[] | null; online: boolean };

/** A reader's firmware version: `timestamp-commithash`. */
const firmwareText = (reader: Pick<IoReader, "firmwareTimestamp" | "commitHash">) =>
  [reader.firmwareTimestamp, reader.commitHash].filter(Boolean).join("-") || "—";

/** What the IO says it is and has connected; while offline, what it last said. */
function IoStatus({ io }: { io: IoFacts }) {
  const { t } = useI18n();
  if (io.version === null && io.readers === null)
    return <p className="text-xs text-ink/55">{t("这个 IO 没有上报版本和读卡器，需要更新 IO")}</p>;
  return (
    <div className="grid gap-1 text-xs text-ink/70">
      <p>
        {t("IO 版本")} {io.version ?? "—"}
        {!io.online && ` · ${t("离线，显示最后上报的信息")}`}
      </p>
      {io.readers?.length ? io.readers.map((reader, index) => (
        <p key={reader.chipId ?? index} className="tabular-nums">
          {t("读卡器固件")} {firmwareText(reader)}
        </p>
      )) : <p>{t("没有连接读卡器")}</p>}
    </div>
  );
}

type TableSeat = { playerId: string; name: string; playing: boolean };
type TableState = { capacity: number; seats: TableSeat[] };

const capabilityMeta: Record<
  CapabilityId,
  { icon: typeof Power; title: string }
> = {
  power: { icon: Power, title: "电源控制" },
  climate: { icon: AirVent, title: "空调" },
  hinata_io: { icon: CreditCard, title: "刷卡 · HINATA IO" },
  keys: { icon: Keyboard, title: "机台按键" },
  coin: { icon: Coins, title: "投币" },
  host: { icon: Monitor, title: "启动器" },
  iot: { icon: Cpu, title: "IoT 控制器" },
  door: { icon: DoorOpen, title: "开门密码" },
  table: { icon: Ungroup, title: "桌游" },
  bot: { icon: Bot, title: "Bot" },
};

/**
 * Sending commands is a separate surface from reading the log: one is an
 * action with consequences, the other is history. Keeping them in one modal
 * made the destructive buttons look like part of the record.
 *
 * Actions are grouped by the capability that owns them, and each group shows
 * the state that decides what those actions will do.
 */
export function ResourceActions({
  device,
  state,
  onState,
  onChanged,
}: {
  device: Resource;
  /** Power and air conditioner as the board has them. */
  state: BoardState | null;
  /** Hands the board what an action's answer said of the device, with when it was asked. */
  onState: (next: Partial<BoardState>, askedAt: number) => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const caps = resourceCapabilities(device);
  const groups = deviceActionGroups(device);
  const players = useResource<{ players: Player[] }>(
    caps.table ? "players" : null,
  );
  const [selectedPlayer, setSelectedPlayer] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const power = state?.power ?? null;
  const climate = state?.climate ?? null;
  const [table, setTable] = useState<TableState | null>(null);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  /** The table is not Home Assistant state and nothing pushes it, so it is read on its own. */
  const readTable = useCallback(
    () =>
      api<{ table: TableState | null }>(`/api/v1/merchant/machines/${device.id}/table`)
        .then((r) => setTable(r.table))
        .catch(() => {}),
    [device.id],
  );
  // Opening the panel reads nothing about power or the air conditioner; the board already has it.
  useEffect(() => {
    if (caps.table) void readTable();
  }, [caps.table, readTable]);
  async function send(action: string, extra?: Record<string, unknown>) {
    if (busy) return;
    setBusy(action);
    setError("");
    setResult("");
    try {
      const askedAt = Date.now();
      const r = await playerOperation<{
        temporaryPassword?: string;
        table?: TableState;
        device?: Record<string, unknown>;
      }>(`/api/v1/merchant/machines/${device.id}/actions`, {
        action,
        ...extra,
      });
      setResult(
        r?.temporaryPassword
          ? `${t("开门密码")} ${r.temporaryPassword}`
          : t("已发送"),
      );
      if (r?.table) setTable(r.table);
      else if (action.startsWith("table.")) void readTable();
      // A power or climate action answers with what the device shows now; the board shows it.
      if (r?.device) onStateRef.current(viewOf(r.device), askedAt);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("操作失败"));
    } finally {
      setBusy("");
    }
  }
  // Staff may confirm billing and seat any active player registered at this shop.
  const playerOptions = (players.data?.players ?? []).filter(player => player.status === "active").map((player) => ({
    id: player.id,
    name: player.displayName,
  }));
  const seated = new Set(table?.seats.map((seat) => seat.playerId));
  const full = !!table && table.seats.length >= table.capacity;
  /** The state each capability's actions act on, shown in its header. */
  const stateLabel = (id: CapabilityId): string => {
    if (id === "power")
      return power === "on"
        ? t("已开机")
        : power === "off"
          ? t("已关机")
          : t("未知");
    if (id === "climate") return climateSummary(climate, t);
    if (id === "hinata_io")
      return device.relayOnline === true
        ? t("已连接")
        : device.relayOnline === false
          ? t("未连接")
          : isDirectConnect(device)
            ? t("未知")
            : t("外部中继");
    if (id === "keys") {
      const count = (device.keys ?? []).filter((one) => one.id !== device.coinKeyId).length;
      return count > 0 ? t("{count} 个按键", { count }) : "";
    }
    if (id === "coin") {
      const btn = (device.keys ?? []).find((one) => one.id === device.coinKeyId);
      if (!btn) return "";
      if (btn.mode === "gpio") return t("GPIO {pin}", { pin: btn.pin });
      return keyTextFromVk(btn.key);
    }
    if (id === "host") return t("PRiSM Launcher");
    if (id === "iot") {
      return device.iotOnline === true ? t("在线") : device.iotOnline === false ? t("离线") : "";
    }
    if (id === "door")
      return device.ttlockLockId ? `TTLock · ${device.ttlockLockId}` : "";
    return table ? `${table.seats.length} / ${table.capacity}` : "";
  };
  const sections = capabilityOrder.filter(
    (id) =>
      groups.some((group) => group.capability === id) ||
      (id === "table" && caps.table) ||
      (id === "host" && caps.host),
  );
  return (
    <div className="grid gap-4">
      {sections.map((id) => {
        const meta = capabilityMeta[id];
        const Icon = meta.icon;
        const actionNames =
          groups.find((group) => group.capability === id)?.actions ?? [];
        return (
          <section key={id} className="rounded-xl border border-ink/10 p-4">
            <header className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon size={16} className="text-ink/45" />
                {t(meta.title)}
              </span>
              <span className="text-xs text-ink/55">{stateLabel(id)}</span>
            </header>
            <div className="mt-3 grid gap-3">
              {(id === "power" || id === "door") && (
                <div className="flex flex-wrap gap-2">
                  {actionNames.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={`${button} min-h-11 justify-center`}
                      // The click is the intent; pressing the button again is
                      // easier than confirming a second time.
                      disabled={!device.enabled || !!busy}
                      onClick={() => void send(name)}
                    >
                      {t(actionLabels[name] ?? name)}
                    </button>
                  ))}
                </div>
              )}
              {id === "climate" && (
                <ClimateControls
                  state={climate}
                  busy={busy}
                  disabled={!device.enabled}
                  send={(action, extra) => void send(action, extra)}
                  powerClass={`${button} min-h-11 justify-self-start`}
                />
              )}
              {id === "hinata_io" && actionNames.includes("aime.scan") && (
                <div className="flex items-center gap-2">
                  <input
                    className={`${input} min-h-9 min-w-0 flex-1 font-mono`}
                    inputMode="numeric"
                    maxLength={20}
                    placeholder={t("20 位卡号")}
                    aria-label={t("卡号")}
                    value={cardNumber}
                    disabled={!device.enabled}
                    onChange={(e) =>
                      setCardNumber(
                        e.target.value.replace(/\D/g, "").slice(0, 20),
                      )
                    }
                  />
                  <button
                    type="button"
                    className={`${button} min-h-9 shrink-0`}
                    disabled={
                      !device.enabled || cardNumber.length !== 20 || !!busy
                    }
                    onClick={() => void send("aime.scan", { cardNumber })}
                  >
                    {t("刷卡")}
                  </button>
                </div>
              )}
              {/* A coin, the cabinet's own way; staff are not held to the cooldown. */}
              {id === "coin" && actionNames.includes("coin") && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={`${button} min-h-9`}
                    disabled={!device.enabled || !!busy}
                    onClick={() => void send("coin")}
                  >
                    {t("投币")}
                  </button>
                </div>
              )}
              {/* The shop's named cabinet buttons (keyboard via Launcher/IO or GPIO pulse via IoT).
                  The coin button is shown in the 投币 section with its cooldown and limit. */}
              {id === "keys" && actionNames.includes("key.press") && (() => {
                const pressable = (device.keys ?? []).filter((one) => one.id !== device.coinKeyId);
                if (!pressable.length) return null;
                return (
                  <div className="flex flex-wrap gap-2">
                    {pressable.map((one) => (
                      <button
                        key={one.id}
                        type="button"
                        className={`${button} min-h-9 px-3`}
                        disabled={!device.enabled || !!busy}
                        onClick={() => void send("key.press", { keyId: one.id })}
                      >
                        <span>{one.name}</span>
                        <kbd className="rounded border border-ink/15 bg-ink/[0.04] px-1.5 font-mono text-[11px] font-normal text-ink/60">
                          {one.mode === "gpio" ? `GPIO ${one.pin}` : keyTextFromVk(one.key)}
                        </kbd>
                      </button>
                    ))}
                  </div>
                );
              })()}
              {id === "hinata_io" && device.relayConnection === "embedded" && <CabinetBooks deviceId={device.id} />}
              {id === "host" && (
                <HostControls
                  device={device}
                  disabled={!device.enabled}
                  onChanged={onChanged}
                />
              )}
              {id === "table" && (
                <>
                  <div className="grid gap-1">
                    {table?.seats.map((seat) => (
                      <div
                        key={seat.playerId}
                        className="flex items-center justify-between gap-2 rounded-lg bg-ink/5 px-3 py-2 text-sm"
                      >
                        <span>{seat.name}</span>
                        <button
                          type="button"
                          className={`${buttonQuiet} min-h-8 px-2 text-xs`}
                          disabled={!device.enabled || !!busy}
                          onClick={() =>
                            void send("table.unseat", {
                              playerId: seat.playerId,
                            })
                          }
                        >
                          {t("下桌")}
                        </button>
                      </div>
                    ))}
                    {table && !table.seats.length && (
                      <p className="text-sm text-ink/55">{t("空位")}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className={`${input} min-h-9 max-w-56`}
                      aria-label={t("选择玩家")}
                      value={selectedPlayer}
                      onChange={(e) => setSelectedPlayer(e.target.value)}
                    >
                      <option value="">{t("选择玩家")}</option>
                      {playerOptions
                        .filter((player) => !seated.has(player.id))
                        .map((player) => (
                          <option key={player.id} value={player.id}>
                            {player.name}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      className={button}
                      disabled={
                        !device.enabled || full || !selectedPlayer || !!busy
                      }
                      onClick={() =>
                        void send("table.seat", {
                          playerId: selectedPlayer,
                        })
                      }
                    >
                      {t("上桌")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        );
      })}
      {!device.enabled && (
        <p className="text-sm text-coral">
          {t("资源已停用，操作不可用。")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="select-all text-sm">
          {result}
        </p>
      )}
    </div>
  );
}

const END_REASONS: Record<NonNullable<OccupancyHistoryEntry["endReason"]>, string> = {
  timeout: "超时",
  replaced: "被替换",
  left: "离开",
  billing_ended: "计费结束",
};

/** Who was on the resource, then what the platform asked of it and what it reported. */
function ResourceRecords({ device, playerHref }: { device: Resource; playerHref: (playerId: string) => string }) {
  const [hideOccupancy, setHideOccupancy] = useState(false);
  useEffect(() => {
    setHideOccupancy(false);
  }, [device.id]);
  return (
    <div
      className={
        hideOccupancy
          ? "-m-5"
          : "-m-5 grid divide-y divide-ink/10 md:grid-cols-[minmax(19rem,22rem)_minmax(0,1fr)] md:divide-x md:divide-y-0"
      }
    >
      {!hideOccupancy && (
        <OccupancyHistory
          device={device}
          playerHref={playerHref}
          onEmptyChange={(empty) => {
            if (empty && (device.capacity ?? 0) <= 0) setHideOccupancy(true);
          }}
        />
      )}
      <ResourceHistory device={device} />
    </div>
  );
}

const OCCUPANCY_BATCH_LIMIT = 20;

/** Triggers incremental loading when a column scrolls close to its bottom sentinel. */
function useScrollLazyLoad({
  canLoadMore,
  onLoadMore,
}: {
  canLoadMore: boolean;
  onLoadMore: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    if (!canLoadMore || typeof IntersectionObserver === "undefined") return;
    const sentinel = sentinelRef.current;
    const root = containerRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreRef.current();
        }
      },
      { root, rootMargin: "96px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadMore]);

  const onScroll = useCallback(() => {
    if (!canLoadMore) return;
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 96) {
      onLoadMoreRef.current();
    }
  }, [canLoadMore]);

  return { containerRef, sentinelRef, onScroll };
}

/** Scrollable pane shared by the left occupancy column and right operation history column. */
function HistoryColumn({
  title,
  action,
  canLoadMore,
  onLoadMore,
  loadingMore,
  error,
  children,
}: {
  title: string;
  action?: ReactNode;
  canLoadMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
  error?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { containerRef, sentinelRef, onScroll } = useScrollLazyLoad({ canLoadMore, onLoadMore });
  return (
    <section className="flex min-w-0 flex-col" aria-label={t(title)}>
      <div className="flex min-h-12 items-center justify-between gap-2 border-b border-ink/[0.06] px-5 py-2.5">
        <h3 className="text-sm font-semibold">{t(title)}</h3>
        {action}
      </div>
      <div
        ref={containerRef}
        className="max-h-[65dvh] overflow-y-auto px-5 py-4"
        onScroll={onScroll}
      >
        {children}
        {loadingMore && <p className="py-2 text-center text-xs text-ink/45">{t("读取中…")}</p>}
        {error && <p role="alert" className="py-2 text-center text-xs text-coral">{error}</p>}
        <div ref={sentinelRef} aria-hidden="true" className="h-1" />
      </div>
    </section>
  );
}

/** Who was on the resource and for how long, grouped by date with scroll lazy-loading. */
function OccupancyHistory({
  device,
  playerHref,
  onEmptyChange,
}: {
  device: Resource;
  playerHref: (playerId: string) => string;
  onEmptyChange?: (empty: boolean) => void;
}) {
  const { t } = useI18n();
  const { timeZone } = useMerchant();
  const [entries, setEntries] = useState<OccupancyHistoryEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const deviceRef = useRef(device.id);
  const inFlightRef = useRef(false);
  const onEmptyRef = useRef(onEmptyChange);
  deviceRef.current = device.id;
  onEmptyRef.current = onEmptyChange;

  useEffect(() => {
    let current = true;
    inFlightRef.current = false;
    setEntries(null);
    setHasMore(false);
    setBusy(false);
    setError("");
    api<{ entries: OccupancyHistoryEntry[] }>(
      `/api/v1/merchant/machines/${encodeURIComponent(device.id)}/occupancy?limit=${OCCUPANCY_BATCH_LIMIT}`,
    )
      .then((r) => {
        if (!current) return;
        setEntries(r.entries);
        setHasMore(r.entries.length >= OCCUPANCY_BATCH_LIMIT);
        onEmptyRef.current?.(r.entries.length === 0);
      })
      .catch((e) => {
        if (!current) return;
        setEntries([]);
        setError(e instanceof Error ? e.message : t("读取失败"));
        onEmptyRef.current?.(false);
      });
    return () => {
      current = false;
    };
  }, [device.id, t]);

  const loadMore = useCallback(async () => {
    if (!hasMore || inFlightRef.current || !entries?.length) return;
    const targetDeviceId = device.id;
    const before = entries.at(-1)!.startedAt;
    inFlightRef.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ entries: OccupancyHistoryEntry[] }>(
        `/api/v1/merchant/machines/${encodeURIComponent(targetDeviceId)}/occupancy?limit=${OCCUPANCY_BATCH_LIMIT}&before=${encodeURIComponent(before)}`,
      );
      if (deviceRef.current !== targetDeviceId) return;
      const seen = new Set(entries.map((entry) => entry.id));
      const added = r.entries.filter((entry) => !seen.has(entry.id));
      if (added.length) {
        setEntries((previous) => {
          const base = previous ?? entries;
          const baseSeen = new Set(base.map((entry) => entry.id));
          const merged = r.entries.filter((entry) => !baseSeen.has(entry.id));
          return merged.length ? [...base, ...merged] : base;
        });
      }
      setHasMore(r.entries.length >= OCCUPANCY_BATCH_LIMIT && added.length > 0);
    } catch (e) {
      if (deviceRef.current === targetDeviceId) {
        setError(e instanceof Error ? e.message : t("读取失败"));
      }
    } finally {
      inFlightRef.current = false;
      if (deviceRef.current === targetDeviceId) {
        setBusy(false);
      }
    }
  }, [device.id, entries, hasMore, t]);

  const todayDate = billTime(new Date().toISOString(), timeZone || undefined).date;
  const groups = useMemo(
    () => (entries ? groupByDate(entries, (entry) => entry.startedAt, timeZone || undefined) : []),
    [entries, timeZone],
  );

  return (
    <HistoryColumn
      title="占用记录"
      canLoadMore={hasMore && !busy && !error && Boolean(entries?.length)}
      onLoadMore={() => void loadMore()}
      loadingMore={Boolean(entries && busy)}
      error={entries?.length ? error : ""}
    >
      {!entries ? (
        <State error={error} />
      ) : !entries.length ? (
        <State empty />
      ) : (
        <div className="grid gap-3">
          {groups.map((group) => (
            <div key={group.localDate} className="grid gap-1.5">
              <div className="px-1 text-xs font-medium text-ink/45">
                {shortDateLabel(group.localDate, todayDate)}
              </div>
              <div className="bill-entry !mb-0 !p-0 divide-y divide-ink/[0.06] overflow-hidden">
                {group.items.map((entry) => {
                  const startClock = billTime(entry.startedAt, timeZone || undefined);
                  const endClock = entry.endedAt ? billTime(entry.endedAt, timeZone || undefined) : null;
                  const timeRange = !endClock
                    ? `${startClock.time} – ${t("进行中")}`
                    : endClock.date === startClock.date
                      ? `${startClock.time} – ${endClock.time}`
                      : `${startClock.time} – ${endClock.date.slice(5)} ${endClock.time}`;
                  return (
                    <div
                      className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-sm"
                      key={entry.id}
                    >
                      <Link
                        className="inline-flex min-w-0 items-center font-medium text-ink underline-offset-2 hover:underline"
                        to={playerHref(entry.playerId)}
                      >
                        <i
                          aria-hidden="true"
                          className="bill-plan-dot !mr-2"
                          style={{
                            background: entry.endedAt ? "rgb(var(--color-ink) / 0.35)" : "var(--color-mint)",
                          }}
                        />
                        <span className="truncate">{entry.displayName ?? entry.playerId}</span>
                      </Link>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-ink/55 tabular-nums">
                        <span>{timeRange}</span>
                        {entry.endReason && (
                          <span className="rounded-full bg-ink/[0.05] px-2 py-0.5 text-[11px] font-medium text-ink/60">
                            {t(END_REASONS[entry.endReason])}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </HistoryColumn>
  );
}

/** Read-only history: what the platform asked for and what the device reported. */
function ResourceHistory({ device }: { device: Resource }) {
  const { t } = useI18n();
  const { timeZone } = useMerchant();
  const [events, setEvents] = useState<DeviceEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const deviceRef = useRef(device.id);
  const inFlightRef = useRef(false);
  deviceRef.current = device.id;

  const load = useCallback(
    async (before?: string) => {
      if (inFlightRef.current) return;
      const targetDeviceId = device.id;
      inFlightRef.current = true;
      setBusy(true);
      setError("");
      try {
        const r = await api<{ events: DeviceEvent[]; nextCursor: string | null }>(
          `/api/v1/merchant/machines/${targetDeviceId}/events${before ? `?before=${encodeURIComponent(before)}` : ""}`,
        );
        if (deviceRef.current !== targetDeviceId) return;
        if (!before) {
          setEvents(r.events);
          setNextCursor(r.nextCursor);
        } else {
          let addedCount = 0;
          setEvents((previous) => {
            const existing = previous ?? [];
            const seen = new Set(existing.map((item) => item.id));
            const added = r.events.filter((item) => !seen.has(item.id));
            addedCount = added.length;
            return added.length ? [...existing, ...added] : existing;
          });
          setNextCursor(addedCount > 0 || r.events.length > 0 ? r.nextCursor : null);
        }
      } catch (e) {
        if (deviceRef.current === targetDeviceId) {
          setError(e instanceof Error ? e.message : t("读取失败"));
        }
      } finally {
        inFlightRef.current = false;
        if (deviceRef.current === targetDeviceId) {
          setBusy(false);
        }
      }
    },
    [device.id, t],
  );
  useEffect(() => {
    inFlightRef.current = false;
    setEvents(null);
    setNextCursor(null);
    void load();
  }, [load]);

  const todayDate = billTime(new Date().toISOString(), timeZone || undefined).date;
  const groups = useMemo(
    () => (events ? groupByDate(timeline(events), (item) => item.event.at, timeZone || undefined) : []),
    [events, timeZone],
  );

  return (
    <HistoryColumn
      title="操作记录"
      action={
        <button
          type="button"
          className={`${button} !min-h-8 !rounded-lg !px-3 !py-1 !text-xs`}
          disabled={busy}
          onClick={() => {
            inFlightRef.current = false;
            void load();
          }}
        >
          {t("刷新记录")}
        </button>
      }
      canLoadMore={Boolean(nextCursor) && !busy && !error && Boolean(events?.length)}
      onLoadMore={() => {
        if (nextCursor) void load(nextCursor);
      }}
      loadingMore={Boolean(events && busy)}
      error={events ? error : ""}
    >
      {!events ? (
        <State error={error} />
      ) : !events.length ? (
        <State empty />
      ) : (
        <div className="grid gap-3">
          {groups.map((group) => (
            <div key={group.localDate} className="grid gap-1.5">
              <div className="px-1 text-xs font-medium text-ink/45">
                {shortDateLabel(group.localDate, todayDate)}
              </div>
              <div className="bill-entry !mb-0 !p-0 divide-y divide-ink/[0.06] overflow-hidden">
                {group.items.map(({ event: e, result }) => {
                  const inbound = e.kind === "signal";
                  const outcome = result ? String(result.payload.outcome) : null;
                  const detail: string[] = [];
                  if (e.kind === "signal" && e.name.startsWith("cabinet.")) {
                    const { coins, credits, credit, previousCredit, previousTotalCoin, totalCoin } = e.payload;
                    if (e.name === "cabinet.coin" && typeof coins === "number") detail.push(t("投入 {coins} 枚", { coins }));
                    if (e.name === "cabinet.credit" && typeof credits === "number") detail.push(t("增加 {credits} 币", { credits }));
                    if (e.name === "cabinet.consumed" && typeof credits === "number") detail.push(t("消耗 {credits} 币", { credits }));
                    if (typeof credit === "number") detail.push(typeof previousCredit === "number"
                      ? t("本次读数：{before} → {after} 币", { before: previousCredit, after: credit })
                      : t("机内剩余 {credit} 币", { credit }));
                    if (e.name === "cabinet.reset" && typeof previousTotalCoin === "number" && typeof totalCoin === "number") {
                      detail.push(t("累计投币：{before} → {after} 枚", { before: previousTotalCoin, after: totalCoin }));
                    }
                  }
                  if (result && typeof result.payload.message === "string") detail.push(result.payload.message);
                  // A card sent from a page or a bot, and a coin the cabinet's rule added: the rest are the usual kind.
                  if (e.kind === "signal" && e.payload.card && e.payload.cardFrom === "platform") detail.push(t("虚拟刷卡"));
                  if (e.kind === "request" && e.name === "coin" && e.payload.cause === "card") detail.push(t("自动投币"));
                  if (e.name === "card.bound" && typeof e.payload.type === "string") detail.push(e.payload.type);
                  const command = e.name === "bot.command" ? e.payload : null;
                  // A request turned away before it reached the device, and what happened at the shop itself.
                  const refusedAction = e.kind === "signal" && e.name.endsWith(".refused") ? e.name.slice(0, -".refused".length) : null;
                  const ours = e.kind === "signal" && e.origin === "platform";
                  if (e.player && !command) detail.unshift(t("玩家：{name}", { name: e.player.name ?? e.player.id }));
                  if (refusedAction) {
                    const code = String(e.payload.code ?? "");
                    const message = typeof e.payload.message === "string" ? e.payload.message : "";
                    detail.push(refusalReasons[code] ? t(refusalReasons[code]) : message || code);
                  }
                  if (command) {
                    const from = chatName(command.from);
                    const target = chatName(command.target);
                    if (from) detail.push(target ? t("{from} 代 {target}", { from, target }) : from);
                  } else {
                    // Something done through this resource happened to another one.
                    if (e.device) detail.push(t("设备：{name}", { name: e.device.name ?? e.device.id }));
                    const source = e.via && e.kind !== "change" ? viaLabels[e.via.channel] : undefined;
                    if (source) detail.push(t("来自：{source}", { source: e.via!.resource?.name ? `${t(source)} ${e.via!.resource.name}` : t(source) }));
                  }
                  const statusText = command
                    ? t(commandOutcomes[String(command.outcome)] ?? "已回复")
                    : refusedAction
                      ? t("已拒绝")
                      : ours
                        ? t("已完成")
                        : e.kind === "signal"
                          ? t("机台回报")
                          : e.kind === "change"
                            ? t(e.origin === "observer" ? "检测到" : "机台回报")
                            : outcome === "ok"
                              ? t("已完成")
                              : outcome === "failed"
                                ? t("失败")
                                : t("结果待确认");
                  const statusBadgeTone =
                    refusedAction || outcome === "failed"
                      ? "bg-coral/10 text-coral"
                      : ours || outcome === "ok"
                        ? "bg-emerald-500/10 text-[#23815d] dark:text-emerald-400"
                        : "bg-ink/[0.05] text-ink/60";
                  return (
                    <div
                      className="flex items-start justify-between gap-3 px-3.5 py-2.5 text-sm"
                      key={e.id}
                    >
                      <div className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5 font-medium text-ink">
                          {/* Direction is the difference between "we asked" and
                              "the machine reported", which is what makes a card event
                              worth logging at all. */}
                          {e.kind !== "change" && !command && !ours && (
                            <span
                              className={inbound ? "text-mint" : "text-ink/45"}
                              title={inbound ? t("机台回报") : t("平台下发")}
                            >
                              {inbound ? "←" : "→"}
                            </span>
                          )}
                          {command
                            ? `/${[String(command.command ?? ""), ...(Array.isArray(command.args) ? command.args.map(String) : [])].join(" ")}`
                            : refusedAction
                            ? t("{action}被拒绝", { action: t(actionLabels[refusedAction] ?? refusedAction) })
                            : e.kind === "change"
                            ? changeLabel(e, t)
                            : e.name === "card.login"
                              ? t(e.payload.result === "ok" ? "游戏登录成功" : "游戏拒绝了卡片")
                              : t(actionLabels[e.name] ?? e.name)}
                        </span>
                        {detail.length > 0 && (
                          <p className="mt-0.5 text-xs text-ink/65">{detail.join(" · ")}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusBadgeTone}`}
                        >
                          {statusText}
                        </span>
                        <time
                          dateTime={e.at}
                          className="text-[11px] text-ink/45 tabular-nums"
                        >
                          {billTime(e.at, timeZone || undefined).time}
                        </time>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </HistoryColumn>
  );
}

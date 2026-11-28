import { keyTextFromVk } from "@prism/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AirVent,
  Bot,
  Coins,
  Cpu,
  CreditCard,
  DoorOpen,
  Keyboard,
  Monitor,
  Power,
  Ungroup,
} from "lucide-react";
import { api, playerOperation, type Resource } from "../../api";
import { ClimateControls, climateSummary } from "../ClimateControls";
import { useI18n } from "../../i18n";
import { viewOf, type BoardState } from "./board-state";
import { HostControls } from "./HostControls";
import { actionLabels } from "./OperationHistory";
import {
  partitionDeviceSections,
  resolveResourceActionsLayout,
} from "./resource-actions-layout";
import {
  deviceActionGroups,
  isDirectConnect,
  resourceCapabilities,
  type CapabilityId,
} from "./resource-capabilities";
import {
  Modal,
  button,
  buttonQuiet,
  input,
  useResource,
  type Player,
} from "./shared";

type Books =
  | {
      players: Array<{ credit: number; remain: number }>;
      bookkeeping: { totalCoin: number };
    }
  | { error: string };

type IoReader = {
  chipId: string | null;
  firmwareTimestamp: number | null;
  commitHash: string | null;
};
type IoFacts = {
  version: string | null;
  readers: IoReader[] | null;
  online: boolean;
};

/** A reader's firmware version: `timestamp-commithash`. */
const firmwareText = (reader: Pick<IoReader, "firmwareTimestamp" | "commitHash">) =>
  [reader.firmwareTimestamp, reader.commitHash].filter(Boolean).join("-") || "—";

/** What the IO says it is and has connected; while offline, what it last said. */
function IoStatus({ io }: { io: IoFacts }) {
  const { t } = useI18n();
  if (io.version === null && io.readers === null) {
    return (
      <p className="text-xs text-ink/55">
        {t("这个 IO 没有上报版本和读卡器，需要更新 IO")}
      </p>
    );
  }
  return (
    <div className="grid gap-1 text-xs text-ink/65">
      <p>
        {t("IO 版本")} {io.version ?? "—"}
        {!io.online && ` · ${t("离线，显示最后上报的信息")}`}
      </p>
      {io.readers?.length ? (
        io.readers.map((reader, index) => (
          <p key={reader.chipId ?? index} className="tabular-nums">
            {t("读卡器固件")} {firmwareText(reader)}
          </p>
        ))
      ) : (
        <p>{t("没有连接读卡器")}</p>
      )}
    </div>
  );
}

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
    api<{ cabinet: Books | null; io?: IoFacts }>(
      `/api/v1/merchant/machines/${deviceId}/cabinet`,
    )
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
      const r = await api<{ cabinet: Books }>(
        `/api/v1/merchant/machines/${deviceId}/cabinet/refresh`,
        { method: "POST" },
      );
      setBooks(r.cabinet);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("读取失败"));
    } finally {
      setBusy(false);
    }
  }
  const summary =
    books === undefined
      ? t("读取中…")
      : books === null
        ? t("未上报币数（游戏没有 sysfile.dat，或 IO 版本太旧）")
        : "error" in books
          ? t("币数读取失败：{error}", { error: books.error })
          : t("当前 {credit} 币 · 累计投币 {coins}", {
              credit: books.players[0]?.credit ?? 0,
              coins: books.bookkeeping.totalCoin,
            });
  return (
    <div className="grid gap-2 border-t border-ink/[0.08] pt-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ink/70">{summary}</span>
        <button
          type="button"
          className={`${button} min-h-8 px-2.5 py-1 text-xs`}
          disabled={busy}
          onClick={() => void refresh()}
        >
          {t("刷新机台状态")}
        </button>
      </div>
      {error && <span className="text-xs text-coral">{error}</span>}
      {io && <IoStatus io={io} />}
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
 * Adaptive modal wrapper for `ResourceActions`: expands cleanly from compact
 * (`max-w-xl`) to two-column (`max-w-4xl`) or a split cabinet + Launcher
 * workbench (`max-w-7xl`) depending on the resource's enabled capabilities.
 */
export function ResourceActionsModal({
  device,
  state,
  onState,
  onChanged,
  close,
}: {
  device: Resource;
  state: BoardState | null;
  onState: (next: Partial<BoardState>, askedAt: number) => void;
  onChanged: () => void;
  close: () => void;
}) {
  const { t } = useI18n();
  const layout = resolveResourceActionsLayout(device);
  return (
    <Modal
      title={`${device.name} · ${t("操作")}`}
      close={close}
      xl={layout.modalSize === "xl"}
      lg={layout.modalSize === "lg"}
    >
      <ResourceActions
        key={device.id}
        device={device}
        state={state}
        onState={onState}
        onChanged={onChanged}
      />
    </Modal>
  );
}

/**
 * Sending commands is a separate surface from reading the log: one is an
 * action with consequences, the other is history.
 *
 * Actions are grouped by capability and laid out adaptively: compact single
 * column for 1–2 simple capabilities, balanced two-column grid for 3+
 * non-Launcher capabilities, or a split workbench pairing device controls on
 * the left with the 3-tab PRiSM Launcher workbench on the right.
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
  const layout = resolveResourceActionsLayout(device);
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
      api<{ table: TableState | null }>(
        `/api/v1/merchant/machines/${device.id}/table`,
      )
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
  const playerOptions = (players.data?.players ?? [])
    .filter((player) => player.status === "active")
    .map((player) => ({
      id: player.id,
      name: player.displayName,
    }));
  const seated = new Set(table?.seats.map((seat) => seat.playerId));
  const full = !!table && table.seats.length >= table.capacity;

  /** The state each capability's actions act on, shown in its header. */
  const stateLabel = (id: CapabilityId): string => {
    if (id === "power") {
      return power === "on"
        ? t("已开机")
        : power === "off"
          ? t("已关机")
          : t("未知");
    }
    if (id === "climate") return climateSummary(climate, t);
    if (id === "hinata_io") {
      return device.relayOnline === true
        ? t("已连接")
        : device.relayOnline === false
          ? t("未连接")
          : isDirectConnect(device)
            ? t("未知")
            : t("外部中继");
    }
    if (id === "keys") {
      const count = (device.keys ?? []).filter(
        (one) => one.id !== device.coinKeyId,
      ).length;
      return count > 0 ? t("{count} 个按键", { count }) : "";
    }
    if (id === "coin") {
      const btn = (device.keys ?? []).find(
        (one) => one.id === device.coinKeyId,
      );
      if (!btn) return "";
      if (btn.mode === "gpio") return t("GPIO {pin}", { pin: btn.pin });
      return keyTextFromVk(btn.key);
    }
    if (id === "host") return t("PRiSM Launcher");
    if (id === "iot") {
      return device.iotOnline === true
        ? t("在线")
        : device.iotOnline === false
          ? t("离线")
          : "";
    }
    if (id === "door") {
      return device.ttlockLockId ? `TTLock · ${device.ttlockLockId}` : "";
    }
    return table ? `${table.seats.length} / ${table.capacity}` : "";
  };

  const renderStateBadge = (id: CapabilityId) => {
    const label = stateLabel(id);
    if (!label) return null;
    if (id === "power") {
      const tone =
        power === "on"
          ? "bg-emerald-500/10 text-[#23815d] dark:text-emerald-400"
          : power === "off"
            ? "bg-ink/[0.06] text-ink/60"
            : "text-ink/50";
      return (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
          {label}
        </span>
      );
    }
    if (id === "hinata_io") {
      const tone =
        device.relayOnline === true
          ? "bg-emerald-500/10 text-[#23815d] dark:text-emerald-400"
          : device.relayOnline === false
            ? "bg-coral/10 text-coral"
            : "text-ink/55";
      return (
        <span
          className={`rounded-full text-xs ${
            device.relayOnline !== null && device.relayOnline !== undefined
              ? "px-2 py-0.5 font-medium"
              : ""
          } ${tone}`}
        >
          {label}
        </span>
      );
    }
    if (id === "iot") {
      const tone =
        device.iotOnline === true
          ? "bg-emerald-500/10 text-[#23815d] dark:text-emerald-400"
          : "bg-coral/10 text-coral";
      return (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
          {label}
        </span>
      );
    }
    return <span className="text-xs tabular-nums text-ink/55">{label}</span>;
  };

  const renderDeviceCard = (id: CapabilityId) => {
    const meta = capabilityMeta[id];
    const Icon = meta.icon;
    const actionNames =
      groups.find((group) => group.capability === id)?.actions ?? [];

    if (id === "coin" && actionNames.includes("coin")) {
      const keyLabel = stateLabel("coin");
      return (
        <section
          key={id}
          className="flex items-center justify-between gap-3 rounded-xl border border-ink/10 bg-panel px-3.5 py-3"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <Icon size={16} className="shrink-0 text-ink/45" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-sm font-medium">{t(meta.title)}</div>
              {keyLabel && (
                <div className="truncate font-mono text-[11px] text-ink/50">
                  {keyLabel}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            className={`${button} min-h-9 shrink-0 px-3.5`}
            disabled={!device.enabled || !!busy}
            onClick={() => void send("coin")}
          >
            {t("投币")}
          </button>
        </section>
      );
    }

    return (
      <section key={id} className="rounded-xl border border-ink/10 bg-panel p-3.5">
        <header className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Icon size={16} className="text-ink/45" aria-hidden="true" />
            {t(meta.title)}
          </span>
          {renderStateBadge(id)}
        </header>
        <div className="mt-3 grid gap-3">
          {(id === "power" || id === "door") && (
            <div className="flex flex-wrap gap-2">
              {actionNames.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`${button} min-h-10 flex-1 justify-center`}
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
              powerClass={`${button} min-h-10 justify-self-start`}
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
                  setCardNumber(e.target.value.replace(/\D/g, "").slice(0, 20))
                }
              />
              <button
                type="button"
                className={`${button} min-h-9 shrink-0`}
                disabled={!device.enabled || cardNumber.length !== 20 || !!busy}
                onClick={() => void send("aime.scan", { cardNumber })}
              >
                {t("刷卡")}
              </button>
            </div>
          )}
          {/* The shop's named cabinet buttons (keyboard via Launcher/IO or GPIO pulse via IoT).
              The coin button is shown in the 投币 section. */}
          {id === "keys" &&
            actionNames.includes("key.press") &&
            (() => {
              const pressable = (device.keys ?? []).filter(
                (one) => one.id !== device.coinKeyId,
              );
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
                        {one.mode === "gpio"
                          ? `GPIO ${one.pin}`
                          : keyTextFromVk(one.key)}
                      </kbd>
                    </button>
                  ))}
                </div>
              );
            })()}
          {id === "hinata_io" && device.relayConnection === "embedded" && (
            <CabinetBooks deviceId={device.id} />
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
  };

  const disabledBanner = !device.enabled ? (
    <p className="rounded-lg border border-coral/25 bg-coral/[0.06] px-3 py-2 text-xs text-coral">
      {t("资源已停用，操作不可用。")}
    </p>
  ) : null;

  const feedbackBanners = (error || result) ? (
    <div className="grid gap-1.5">
      {error && (
        <p role="alert" className="rounded-lg border border-coral/25 bg-coral/[0.06] px-3 py-2 text-xs text-coral">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="select-all rounded-lg border border-mint/25 bg-mint/[0.06] px-3 py-2 text-xs text-ink">
          {result}
        </p>
      )}
    </div>
  ) : null;

  if (layout.mode === "split-host") {
    return (
      <div className="-m-5 grid divide-y divide-ink/10 lg:grid-cols-[minmax(20rem,23.5rem)_minmax(0,1fr)] lg:divide-x lg:divide-y-0">
        <section
          aria-label={t("机台控制")}
          className="flex min-w-0 flex-col bg-ink/[0.02] lg:max-h-[calc(90dvh-4.75rem)] lg:overflow-y-auto lg:overscroll-contain"
        >
          <div className="flex items-center justify-between gap-2 border-b border-ink/[0.08] px-4 py-3">
            <span className="text-sm font-semibold">{t("机台控制")}</span>
            <span className="text-xs tabular-nums text-ink/50">
              {t("{count} 项", { count: layout.deviceSections.length })}
            </span>
          </div>
          <div className="grid content-start gap-3 p-4">
            {disabledBanner}
            {layout.deviceSections.map(renderDeviceCard)}
            {feedbackBanners}
          </div>
        </section>
        <section
          aria-label={t("PRiSM Launcher")}
          className="flex min-w-0 flex-col lg:max-h-[calc(90dvh-4.75rem)] lg:overflow-y-auto lg:overscroll-contain"
        >
          <HostControls
            device={device}
            disabled={!device.enabled}
            onChanged={onChanged}
            embedded
          />
        </section>
      </div>
    );
  }

  if (layout.mode === "host-only") {
    return (
      <div className="-m-5 flex min-w-0 flex-col lg:max-h-[calc(90dvh-4.75rem)] lg:overflow-y-auto lg:overscroll-contain">
        {disabledBanner && <div className="mx-5 mt-4">{disabledBanner}</div>}
        <HostControls
          device={device}
          disabled={!device.enabled}
          onChanged={onChanged}
          embedded
        />
      </div>
    );
  }

  if (layout.mode === "two-column") {
    const [leftSections, rightSections] = partitionDeviceSections(
      layout.deviceSections,
    );
    return (
      <div className="grid gap-4">
        {disabledBanner}
        <div className="grid gap-3.5 md:grid-cols-2 md:items-start">
          <div className="grid min-w-0 gap-3.5">
            {leftSections.map(renderDeviceCard)}
          </div>
          <div className="grid min-w-0 gap-3.5">
            {rightSections.map(renderDeviceCard)}
          </div>
        </div>
        {feedbackBanners}
      </div>
    );
  }

  return (
    <div className="grid gap-3.5">
      {disabledBanner}
      {layout.deviceSections.map(renderDeviceCard)}
      {feedbackBanners}
    </div>
  );
}

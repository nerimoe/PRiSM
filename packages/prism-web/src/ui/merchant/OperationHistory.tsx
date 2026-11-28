import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type DeviceEvent, type Resource } from "../../api";
import { useI18n } from "../../i18n";
import { billTime, groupByDate, shortDateLabel } from "../bill-time";
import { climateModeName } from "../ClimateControls";
import { State, button, buttonQuiet, date, input, money, segment } from "./shared";

export type OperationScopeFilter = "all" | "non_resource" | "resource";
export type OperationCategoryFilter = "all" | "checkout" | "session" | "wallet" | "redeem" | "device" | "shop";

/**
 * Pair each request with its result so an action is one line. A result whose
 * request fell outside the loaded page is shown on its own.
 */
export function timeline(events: DeviceEvent[]) {
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

export const actionLabels: Record<string, string> = {
  checkout: "结账",
  entry: "入场",
  "wallet.adjust": "调整余额",
  redeem: "兑换",
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
  "host.update.check": "检查更新",
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
  "entry.refused": "入场被拒绝",
  "wallet.adjust.refused": "调整余额被拒绝",
  "redeem.refused": "兑换被拒绝",
  "resource.visited": "访问资源链接",
  "wallet.adjusted": "调整余额",
  "assets.adjusted": "调整资产",
  "gift.redeemed": "兑换礼物",
  "order.changed": "商品订单",
  "player.changed": "玩家档案",
  "shop.changed": "店铺配置",
  "idle.settings.changed": "闲置关机设置",
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
  INSUFFICIENT_RECHARGE_BALANCE: "余额不足以覆盖充值后账单",
  CASHIER_PAYMENT_REQUIRED: "请在前台确认现场收款",
  CASHIER_PROFILE_REQUIRED: "前台卡片档案不能余额结账",
  LOCATION_REQUIRED: "定位被拒：需要定位",
  LOCATION_LOW_ACCURACY: "定位精度不足",
  LOCATION_STILL_INSIDE: "仍在店内范围，不能自助结账",
  LOCATION_OUT_OF_RANGE: "不在店内范围",
};

const shopChangeLabels: Record<string, string> = {
  pricing: "计费规则",
  assets: "资产定义",
  effects: "计费效果",
  settings: "店铺设置",
};

const playerStatusLabels: Record<string, string> = {
  active: "已启用",
  disabled: "已停用",
  banned: "已封禁",
};

function OperationEventRow({
  event: e,
  result,
  showGlobalTags,
  playerHref,
  timeZone,
}: {
  event: DeviceEvent;
  result?: DeviceEvent;
  showGlobalTags: boolean;
  playerHref?: (playerId: string) => string;
  timeZone?: string;
}) {
  const { t } = useI18n();
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

  if (e.name === "checkout.settled" && typeof e.payload.total === "number") {
    detail.push(t("实付 ¥{amount}", { amount: money(e.payload.total / 100) }));
  }
  if (e.name === "wallet.adjusted") {
    if (typeof e.payload.amount === "number") {
      const signed = `${e.payload.amount > 0 ? "+" : ""}${e.payload.amount}`;
      detail.push(t("金额 {amount}", { amount: signed }));
    }
    if (typeof e.payload.reason === "string" && e.payload.reason) {
      detail.push(t("原因：{reason}", { reason: e.payload.reason }));
    }
    if (typeof e.payload.balanceBefore === "number" && typeof e.payload.balanceAfter === "number") {
      detail.push(t("余额：{before} → {after}", { before: e.payload.balanceBefore, after: e.payload.balanceAfter }));
    }
  }
  if (e.name === "assets.adjusted" && typeof e.payload.reason === "string" && e.payload.reason) {
    detail.push(t("原因：{reason}", { reason: e.payload.reason }));
  }
  if (e.name === "gift.redeemed" && Array.isArray(e.payload.granted)) {
    const items = (e.payload.granted as Array<{ name?: unknown; quantity?: unknown }>)
      .filter((item) => typeof item.name === "string")
      .map((item) => `${String(item.name)} × ${String(item.quantity ?? 1)}`)
      .join("、");
    if (items) detail.push(t("发放：{items}", { items }));
  }
  if (e.name === "player.changed") {
    if (e.payload.action === "cashier.register") detail.push(t("前台建档"));
    else if (typeof e.payload.status === "string") {
      detail.push(t("状态：{status}", { status: t(playerStatusLabels[e.payload.status] ?? e.payload.status) }));
    }
  }
  if (e.name === "order.changed" && typeof e.payload.orderId === "string") {
    detail.push(t("订单：{id}", { id: e.payload.orderId }));
  }
  if (e.name === "shop.changed" && typeof e.payload.what === "string") {
    detail.push(t("变更：{what}", { what: t(shopChangeLabels[e.payload.what] ?? e.payload.what) }));
  }

  const command = e.name === "bot.command" ? e.payload : null;
  // A request turned away before it reached the device, and what happened at the shop itself.
  const refusedAction = e.kind === "signal" && e.name.endsWith(".refused") ? e.name.slice(0, -".refused".length) : null;
  const ours = e.kind === "signal" && e.origin === "platform";

  if (e.staff) {
    detail.unshift(t("员工：{name}", { name: e.staff.name ?? e.staff.id }));
  }
  if (e.player && !command) {
    detail.unshift(t("玩家：{name}", { name: e.player.name ?? e.player.id }));
  }
  if (refusedAction) {
    const code = String(e.payload.code ?? "");
    const message = typeof e.payload.message === "string" ? e.payload.message : "";
    detail.push(refusalReasons[code] ? t(refusalReasons[code]) : message || code);
    const bill = e.payload.bill as { settlementPreview?: { total?: unknown } } | undefined;
    if (typeof bill?.settlementPreview?.total === "number") {
      detail.push(t("应付 ¥{amount}", { amount: money(bill.settlementPreview.total) }));
    }
  }
  if (command) {
    const from = chatName(command.from);
    const target = chatName(command.target);
    if (from) detail.push(target ? t("{from} 代 {target}", { from, target }) : from);
  } else {
    if (e.device) detail.push(t(showGlobalTags ? "资源：{name}" : "设备：{name}", { name: e.device.name ?? e.device.id }));
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

  const isBad = Boolean(refusedAction) || outcome === "failed" || Boolean(command && String(command.outcome) !== "answered");
  const isOk = outcome === "ok" || (ours && !refusedAction);

  const titleNode = (
    <span className="flex flex-wrap items-center gap-1.5">
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
      <span className="font-medium text-ink">
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
      {playerHref && e.player && !command && (
        <Link
          to={playerHref(e.player.id)}
          className="text-xs text-mint underline-offset-2 hover:underline"
        >
          {e.player.name ?? e.player.id}
        </Link>
      )}
    </span>
  );

  if (timeZone !== undefined) {
    const statusBadgeTone = isBad
      ? "bg-coral/10 text-coral"
      : isOk
        ? "bg-emerald-500/10 text-[#23815d] dark:text-emerald-400"
        : "bg-ink/[0.05] text-ink/60";
    return (
      <div className="flex items-start justify-between gap-3 px-3.5 py-2.5 text-sm">
        <div className="min-w-0 flex-1">
          {titleNode}
          {detail.length > 0 && (
            <p className="mt-0.5 break-words text-xs text-ink/65">{detail.join(" · ")}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusBadgeTone}`}>
            {statusText}
          </span>
          <time dateTime={e.at} className="text-[11px] text-ink/45 tabular-nums">
            {billTime(e.at, timeZone || undefined).time}
          </time>
        </div>
      </div>
    );
  }

  const statusTone = isBad ? "text-coral" : isOk ? "text-mint" : "text-ink/55";
  return (
    <div className="flex items-start justify-between gap-3 py-3 text-sm">
      <div className="min-w-0">
        {titleNode}
        {detail.length > 0 && <p className="mt-1 break-words text-xs text-ink/70">{detail.join(" · ")}</p>}
        <p className="mt-1 text-xs text-ink/50 tabular-nums">{date(e.at)}</p>
      </div>
      <span className={`shrink-0 text-xs font-medium ${statusTone}`}>
        {statusText}
      </span>
    </div>
  );
}

/** Shared timeline renderer for both single-resource history and shop-wide operation history. */
export function OperationEventList({
  events,
  showGlobalTags = false,
  playerHref,
  grouped = false,
  timeZone,
}: {
  events: DeviceEvent[];
  showGlobalTags?: boolean;
  playerHref?: (playerId: string) => string;
  grouped?: boolean;
  timeZone?: string;
}) {
  const paired = useMemo(() => timeline(events), [events]);
  const todayDate = useMemo(
    () => (grouped ? billTime(new Date().toISOString(), timeZone || undefined).date : ""),
    [grouped, timeZone],
  );
  const groups = useMemo(
    () => (grouped ? groupByDate(paired, (item) => item.event.at, timeZone || undefined) : []),
    [grouped, paired, timeZone],
  );

  if (grouped) {
    return (
      <div className="grid gap-3">
        {groups.map((group) => (
          <div key={group.localDate} className="grid gap-1.5">
            <div className="px-1 text-xs font-medium text-ink/45">
              {shortDateLabel(group.localDate, todayDate)}
            </div>
            <div className="bill-entry !mb-0 !p-0 divide-y divide-ink/[0.06] overflow-hidden">
              {group.items.map(({ event, result }) => (
                <OperationEventRow
                  key={event.id}
                  event={event}
                  result={result}
                  showGlobalTags={showGlobalTags}
                  playerHref={playerHref}
                  timeZone={timeZone ?? ""}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="divide-y divide-ink/10">
      {paired.map(({ event, result }) => (
        <OperationEventRow
          key={event.id}
          event={event}
          result={result}
          showGlobalTags={showGlobalTags}
          playerHref={playerHref}
        />
      ))}
    </div>
  );
}

/** Shop-wide operation history covering both resource operations and non-resource shop operations. */
export function ShopOperationHistory({
  shopId,
  shopCode,
  devices,
  refreshSignal = 0,
}: {
  shopId: string;
  shopCode: string;
  devices: readonly Resource[];
  refreshSignal?: number;
}) {
  const { t } = useI18n();
  const [scope, setScope] = useState<OperationScopeFilter>("all");
  const [category, setCategory] = useState<OperationCategoryFilter>("all");
  const [resourceId, setResourceId] = useState("");
  const [events, setEvents] = useState<DeviceEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    async (before?: string) => {
      setBusy(true);
      setError("");
      try {
        const params = new URLSearchParams({ shopId, scope, category });
        if (scope !== "non_resource" && resourceId) params.set("resourceId", resourceId);
        if (before) params.set("before", before);
        const r = await api<{ events: DeviceEvent[]; nextCursor: string | null }>(
          `/api/v1/merchant/events?${params.toString()}`,
        );
        setEvents((previous) => (before ? [...(previous ?? []), ...r.events] : r.events));
        setNextCursor(r.nextCursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : t("读取失败"));
      } finally {
        setBusy(false);
      }
    },
    [shopId, scope, category, resourceId, t],
  );

  useEffect(() => {
    setEvents(null);
    setNextCursor(null);
    void load();
  }, [load]);

  const handledRefresh = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === handledRefresh.current) return;
    handledRefresh.current = refreshSignal;
    void load();
  }, [refreshSignal, load]);

  return (
    <div className="grid gap-4">
      <p className="text-xs leading-relaxed text-ink/60">
        {t("包含设备动作与不绑定单个资源的全局操作（如结账尝试、结账失败、余额调整、兑换与店铺变更）。")}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label={t("操作范围")}
          className="inline-flex flex-wrap rounded-xl bg-ink/[0.045] p-0.5 text-xs"
        >
          {(
            [
              ["all", "全部操作"],
              ["non_resource", "非资源操作"],
              ["resource", "资源操作"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => {
                setScope(value);
                if (value === "non_resource") setResourceId("");
              }}
              className={`focus-ring rounded-[10px] px-3 py-1.5 font-medium transition-colors ${
                scope === value
                  ? "bg-primary text-primary-foreground"
                  : "text-ink/65 hover:text-ink"
              }`}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t("操作分类")}
            className={`${input} min-h-9 w-auto py-1`}
            value={category}
            onChange={(e) => setCategory(e.target.value as OperationCategoryFilter)}
          >
            <option value="all">{t("全部类型")}</option>
            <option value="checkout">{t("结账")}</option>
            <option value="session">{t("入场与计时")}</option>
            <option value="wallet">{t("余额与资产")}</option>
            <option value="redeem">{t("兑换与商品")}</option>
            <option value="device">{t("设备操作")}</option>
            <option value="shop">{t("玩家与店铺")}</option>
          </select>
          {scope !== "non_resource" && devices.length > 0 && (
            <select
              aria-label={t("按资源筛选")}
              className={`${input} min-h-9 w-auto max-w-48 py-1`}
              value={resourceId}
              onChange={(e) => setResourceId(e.target.value)}
            >
              <option value="">{t("所有资源")}</option>
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {!events ? (
        <State error={error} />
      ) : !events.length ? (
        <State empty />
      ) : (
        <OperationEventList
          events={events}
          showGlobalTags
          playerHref={(playerId) => `/merchant/${segment(shopCode)}/players?player=${segment(playerId)}`}
        />
      )}
      {events && error && <p role="alert" className="text-sm text-coral">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className={buttonQuiet} disabled={busy} onClick={() => void load()}>
          {t("刷新记录")}
        </button>
        {nextCursor && (
          <button type="button" className={button} disabled={busy} onClick={() => void load(nextCursor)}>
            {t(busy ? "读取中…" : "加载更多")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * What a shop's bot answers its commands with, written here so new wording
 * needs no bot release. Each reply is a `BotMessage` built from the same view
 * the route returns; the bot only names the players in it as its chat knows
 * them. A bot that predates `message` formats the view itself.
 *
 * Times are shown at the shop's clock: the views carry UTC instants, which
 * the API boundary would otherwise convert only in the JSON, not in the words.
 */
import { botMessage, formatOffsetTimestamp, type BotMessage, type BotMessagePlayer } from "@prism/core";

type R = Record<string, any>;

/** Who a command was for: the player, and the chat identity it named. */
export type Addressee = { player: BotMessagePlayer | null; provider: string; subject: string };

/** `玩家名（provider:subject）`, as a bot names whom it acted for. */
function reference(who: Addressee): Array<string | BotMessagePlayer> {
  return [who.player ?? "未知昵称", `（${who.provider}:${who.subject}）`];
}

/* ------------------------------- numbers --------------------------------- */

function toNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  const parsed = Number.parseFloat(String(value).trim());
  return Number.isNaN(parsed) ? 0 : parsed;
}

const amount = (value: unknown) => String(toNumber(value));

function duration(minutes: number): string {
  const total = Math.floor(minutes);
  return total >= 60 ? `${Math.floor(total / 60)}小时${total % 60}分钟` : `${total}分钟`;
}

/* -------------------------------- times ---------------------------------- */

function clock(timeZone: string) {
  const local = (value: unknown): string | null => {
    if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) return null;
    return formatOffsetTimestamp(value, timeZone);
  };
  const offset = (value: unknown) => `UTC${local(value)?.match(/[+-]\d{2}:\d{2}$/)?.[0] ?? "+00:00"}`;
  return {
    hm: (value: unknown) => local(value)?.slice(11, 16) ?? "—",
    md: (value: unknown) => local(value)?.slice(5, 10) ?? "—",
    offset,
    dateTime: (value: unknown) => {
      const text = local(value);
      return text ? `${text.slice(0, 10).replaceAll("-", "/")} ${text.slice(11, 19)}（${offset(value)}）` : value ? "时间无效" : "永不过期";
    },
  };
}

/* ------------------------------- receipts -------------------------------- */

/** What the shop's default plan is called when a session names no plan. */
const DEFAULT_PLAN_LABEL = "入场计费";

const adjustmentKey = (adjustment: R) => (adjustment?.id ? `id:${adjustment.id}` : JSON.stringify([adjustment?.source ?? "", adjustment?.label ?? "", toNumber(adjustment?.amount)]));

const isPricingCap = (adjustment: R) =>
  adjustment?.pricingCapHistory != null || String(adjustment?.source ?? "").startsWith("time.cap:") || String(adjustment?.id ?? "").startsWith("time-cap:");

/** A settled checkout (`toPlayerCheckoutResultView`) in the shape of a preview, to word both alike. */
export function settledAsPreview(result: R): R {
  const checkoutKeys = new Set((result.checkoutAdjustments as R[]).map(adjustmentKey));
  const capKeys = new Set((result.pricingCapAdjustments as R[]).map(adjustmentKey));
  return {
    settlementPreview: { playerId: result.playerSettlement.playerId, subtotal: result.playerSettlement.subtotal, total: result.playerSettlement.total },
    sessionPreviews: (result.settlements as R[]).map((record) => {
      const s = record.settlement;
      const adjustments = (record.adjustments as R[]).filter((adjustment) => {
        const key = adjustmentKey(adjustment);
        return !checkoutKeys.has(key) && !capKeys.has(key) && !isPricingCap(adjustment);
      });
      const subtotal = toNumber(s.subtotal);
      return {
        label: s.label, startedAt: s.startedAt, endedAt: s.endedAt, status: "closed",
        total: subtotal + adjustments.reduce((sum, adjustment) => sum + toNumber(adjustment.amount), 0),
        adjustments,
      };
    }),
    checkoutAdjustments: result.checkoutAdjustments,
    pricingCapAdjustments: result.pricingCapAdjustments,
    globalCapWindows: result.globalCapWindows,
    wallet: result.wallet,
  };
}

/**
 * A bill: `preview` is what checking out now would charge, otherwise what was
 * charged (`settledAsPreview`).
 */
export function receiptMessage(view: R, options: { title: string; preview: boolean; currency: string; who: Addressee; timeZone: string; now?: Date }): BotMessage {
  const { currency, preview: isPreview } = options;
  const time = clock(options.timeZone);
  const preview = view.settlementPreview;
  const sessions = (view.sessionPreviews ?? []) as R[];
  const checkoutAdjustments = (view.checkoutAdjustments ?? []) as R[];
  const capAdjustments = (view.pricingCapAdjustments ?? []) as R[];
  const balanceBefore = toNumber(view.wallet?.balanceBefore);
  const balanceAfter = toNumber(view.wallet?.balanceAfter);
  const nowIso = (options.now ?? new Date()).toISOString();
  const lines: string[] = [];
  const head = [`${options.title}\n玩家：`, ...reference(options.who)];
  const done = () => botMessage(...head, lines.length ? `\n${lines.join("\n")}` : "");

  const charged = sessions.some((session) => toNumber(session.total) !== 0);
  const adjusted = checkoutAdjustments.some((adjustment) => toNumber(adjustment.amount) !== 0)
    || sessions.some((session) => ((session.adjustments ?? []) as R[]).some((adjustment) => toNumber(adjustment.amount) !== 0));
  if (!charged && !adjusted) {
    lines.push("", "本次未产生费用", `余额：${amount(isPreview ? balanceBefore : balanceAfter)}${currency}`);
    return done();
  }

  const valid = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));
  const ends = (session: R) => session.endedAt || (session.status === "active" ? preview.previewedAt : null);
  const starts = sessions.map((session) => session.startedAt).filter(valid) as string[];
  const endings = sessions.map(ends).filter(valid) as string[];
  if (starts.length) {
    const start = starts.reduce((a, b) => (Date.parse(a) < Date.parse(b) ? a : b));
    const end = endings.length ? endings.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b)) : nowIso;
    lines.push(`⏰ 游玩时间：${time.hm(start)}–${time.hm(end)}（${[...new Set([time.offset(start), time.offset(end)])].join(" / ")}）`);
  }

  for (const session of sessions) {
    const label = session.label === "entry" ? DEFAULT_PLAN_LABEL : session.label || "计时区间";
    const end = valid(session.endedAt) ? session.endedAt : session.status === "active" ? (preview.previewedAt ?? nowIso) : null;
    lines.push("", label);
    if (valid(session.startedAt) && end) {
      const minutes = Math.floor((Date.parse(end) - Date.parse(session.startedAt)) / 60_000);
      lines.push(`游玩时段：${time.hm(session.startedAt)}-${time.hm(end)}`);
      lines.push(`游玩时长：${duration(minutes)}｜计价：${amount(session.total)}${currency}`);
    } else if (valid(session.startedAt)) {
      lines.push(`入场：${time.hm(session.startedAt)}  （${(session.status ?? "active") === "active" ? "计费中" : "已关闭"}）`);
    }
    for (const adjustment of (session.adjustments ?? []) as R[]) {
      if (toNumber(adjustment.amount) === 0) continue;
      lines.push(`  └ ${adjustment.label || adjustment.source || "优惠"}：${amount(adjustment.amount)}${currency}`);
    }
  }

  const capped = ((view.globalCapWindows ?? []) as R[]).filter((window) => toNumber(window.currentAmount) !== toNumber(window.amountApplied));
  if (capped.length) {
    lines.push("", "封顶：");
    for (const window of capped) {
      const label = window.ruleLabel || "封顶时段";
      const dated = valid(window.windowStartedAt) ? `${time.md(window.windowStartedAt)} ${label}` : label;
      const details = [`上限${amount(window.priceCap)}`, ...(toNumber(window.paidBefore) > 0 ? [`已计${amount(window.paidBefore)}`] : [])];
      lines.push(`- ${dated}：${amount(window.currentAmount)} → ${amount(window.amountApplied)}${currency}（${details.join("，")}）`);
    }
  }

  const isOverride = (adjustment: R) => String(adjustment?.source ?? "").startsWith("staff.override:");
  const shown = checkoutAdjustments.filter((adjustment) => toNumber(adjustment.amount) !== 0 && !isOverride(adjustment));
  const cappedTotal = Math.max(0, toNumber(preview.subtotal) + capAdjustments.reduce((sum, adjustment) => sum + toNumber(adjustment.amount), 0));
  lines.push("", `计费总价：${amount(cappedTotal)}${currency}`);
  if (shown.length) {
    lines.push("");
    for (const adjustment of shown) lines.push(`${adjustment.label || adjustment.source || "优惠"}：${amount(adjustment.amount)}${currency}`);
  }
  if (adjusted) {
    if (shown.length) lines.push("");
    lines.push(`${checkoutAdjustments.some(isOverride) ? "调整后价格" : "优惠后价格"}：${amount(preview.total)}${currency}`);
  }
  if (isPreview) {
    lines.push(`当前余额：${amount(balanceBefore)}${currency}`);
    lines.push(balanceAfter >= 0
      ? `预计结账后余额：${amount(balanceAfter)}${currency}`
      : `预计结账后余额：余额不足（还差 ${amount(-balanceAfter)}${currency}）`);
  } else {
    lines.push(`扣款后余额：${amount(balanceAfter)}${currency}`);
  }
  return done();
}

/* ------------------------------ the player -------------------------------- */

/** Paid and free money together, then each. */
export function walletMessage(rows: R[], currency: string): BotMessage {
  const sum = (test: (code: string) => boolean) =>
    rows.filter((row) => test(String(row.assetCode).toLowerCase())).reduce((total, row) => total + toNumber(row.quantity), 0);
  const paid = sum((code) => code.includes("paid"));
  const free = sum((code) => code.includes("free"));
  const total = paid + free + sum((code) => !code.includes("paid") && !code.includes("free"));
  return botMessage(["💰 --- 钱包余额 ---", `可用: ${amount(total)} ${currency} (共 ${amount(total)})`, `  - 付费: ${amount(paid)}`, `  - 免费: ${amount(free)}`].join("\n"));
}

export function itemsMessage(holdings: R[], timeZone: string): BotMessage {
  if (!holdings.length) return botMessage("您当前没有任何物品。");
  const time = clock(timeZone);
  return botMessage(["🎒 --- 您拥有的物品 ---", ...holdings.map((row) =>
    `- ${row.assetName || row.assetCode || "资产"} (x${amount(row.quantity)})${row.expiresAt ? `\n  到期: ${time.dateTime(row.expiresAt)}` : ""}`)].join("\n"));
}

export function historyMessage(sessions: R[], currency: string, timeZone: string): BotMessage {
  if (!sessions.length) return botMessage("暂无历史记录");
  const time = clock(timeZone);
  return botMessage([`📜 最近 ${sessions.length} 条记录:`, ...sessions.map((session) => {
    const end = session.endedAt ? time.dateTime(session.endedAt) : "进行中";
    const cost = session.total == null ? "未结算" : `${amount(session.total)} ${currency}`;
    return `- [${session.sessionId}] ${time.dateTime(session.startedAt)} -> ${end} (${cost})`;
  })].join("\n"));
}

export function redeemMessage(granted: R[]): BotMessage {
  if (!granted.length) return botMessage("兑换成功，但没有获得任何物品。");
  return botMessage(["✅ 兑换成功！您获得了以下物品：", ...granted.map((row) => `- ${row.assetName || row.assetCode || "资产"} x${amount(row.quantity)}`)].join("\n"));
}

/** Money a staff member added or took through the bot. */
export function walletAdjustedMessage(who: Addressee, delta: number, currency: string): BotMessage {
  return botMessage("✅ 已为用户 ", ...reference(who), `${delta >= 0 ? "增加" : "扣除"} ${amount(Math.abs(delta))} ${currency}`);
}

/**
 * Entering through the bot. `onBehalf`: a staff member entered someone else.
 * `created: false` is a player already in, the plan naming where.
 */
export function entryMessage(result: { created: boolean; planName: string | null; stopped: string[] }, who: Addressee, onBehalf: boolean): BotMessage {
  if (!result.created) {
    const where = result.planName ? `「${result.planName}」` : "场";
    return onBehalf ? botMessage("用户 ", ...reference(who), ` 已在${where}中，无需重复入场`) : botMessage(`您已在${where}中，无需重复入场`);
  }
  const ended = result.stopped.length ? `\n结束方案：${result.stopped.join("、")}` : "";
  return onBehalf ? botMessage("✅ 已为用户 ", ...reference(who), ` 入场成功${ended}`) : botMessage(`✅ 入场成功${ended}`);
}

/* ------------------------------- mahjong --------------------------------- */

type Table = { name: string; aliases?: string[]; capacity: number; seats: Array<{ playing: boolean; mine?: boolean }> };

export function mahjongTablesMessage(tables: Table[]): BotMessage {
  if (!tables.length) return botMessage("当前没有配置任何麻将机。");
  return botMessage([`🀄️ 麻将机列表（${tables.length} 台）`, ...tables.map((table) => {
    const playing = table.seats.filter((seat) => seat.playing).length;
    const waiting = table.seats.length - playing;
    const status = [...(playing ? [`游玩中 ${playing}/${table.capacity}`] : []), ...(waiting ? [`等位 ${waiting}/${table.capacity}`] : [])].join("；") || "空闲";
    return `- ${table.name}｜别名：${table.aliases?.length ? table.aliases.join("、") : "无"}｜${status}`;
  })].join("\n"));
}

/** What a staff member did for someone says who that was. */
export function forPlayer(who: Addressee, message: BotMessage): BotMessage {
  return botMessage("玩家 ", ...reference(who), "\n", message);
}

export function mahjongJoinedMessage(table: Table): BotMessage {
  const seated = table.seats.length;
  if (table.seats.find((seat) => seat.mine)?.playing) return botMessage(`已加入 ${table.name}，麻将计费已开始。当前 ${seated}/${table.capacity} 人。`);
  return botMessage(`已加入 ${table.name}，当前 ${seated}/${table.capacity} 人，满 ${table.capacity} 人开始计费。`);
}

/** Getting up does not check out: what still bills is said, so leaving the shop means /logout. */
export function mahjongLeftMessage(table: Table, wasPlaying: boolean, remaining: string[]): BotMessage {
  return botMessage(`已离开 ${table.name}${wasPlaying ? "，麻将计费已停止" : ""}。当前还剩 ${table.seats.length}/${table.capacity} 人。`
    + (remaining.length ? `\n仍在计费：${remaining.join("、")}` : ""));
}

/* ------------------------------- devices --------------------------------- */

/** The line that rides along with an entry when the door code could not be had. */
const ENTRY_DOOR_FAILED = "🔑 门锁临时密码没有生成，可以在入场后用 lock 再取一次";

/**
 * What a player may be told about a device that would not act. Only facts about
 * the device itself — whether it exists, is connected, is off, answered — never
 * how the shop configured it or what went wrong inside the platform.
 */
const DEVICE_REASONS: Array<[RegExp, string]> = [
  [/设备不存在|没有找到这个资源/, "没有这个设备"],
  [/机台未在线|没有在线客户端|设备未连接|直连中继尚未配置/, "设备未连接"],
  [/设备已关机/, "设备已关机"],
  [/设备未响应|机台未响应/, "设备没有响应"],
];

const FAILED: Record<string, string> = {
  "power.on": "启动失败，",
  "power.off": "关闭失败，",
  "power.keep": "延迟失败，",
  coin: "投币失败，",
  "aime.scan": "刷卡失败，",
  "door.open": "🔑 开门失败，",
};

/**
 * A device action the bot asked for: done, or why not. `onEntry` marks the
 * door code that rides along with an entry, whose failure is one soft line.
 */
export function deviceActionMessage(action: R, request: { type: string; ref: string; count?: number; onEntry?: boolean }): BotMessage {
  const failed = action.status === "expired" || action.status === "rejected" || action.status === "pending";
  const label = String(action.payload?.deviceLabel ?? "").trim() || request.ref;
  if (request.type === "door.open") {
    if (failed) return botMessage(request.onEntry ? ENTRY_DOOR_FAILED : `${FAILED["door.open"]}${deviceReason(action)}`);
    if (action.executorKind && action.executorKind !== "ttlock") return botMessage("🔑 门锁指令已发送");
    const password = String(action.payload?.temporaryPassword ?? "").trim();
    if (!password) return botMessage(request.onEntry ? ENTRY_DOOR_FAILED : "🔑 临时门锁密码生成失败，请稍后再试");
    return botMessage(`🔑 临时门锁密码：${password}\n有效期：3 分钟`);
  }
  if (failed) return botMessage(`${FAILED[request.type] ?? "操作失败，"}${deviceReason(action)}`);
  switch (request.type) {
    case "power.on": return botMessage(`✅ ${label} 启动成功`);
    case "power.off": return botMessage(`🛑 ${label} 关闭成功`);
    case "power.keep": return botMessage(`✅ ${label} 已延迟关机`);
    case "coin": return botMessage(`🪙 ${label} 投币成功（${request.count ?? 1} 币）`);
    case "aime.scan": return botMessage(`💳 ${label} 刷卡成功`);
    default: return botMessage(`✅ ${label} 已完成`);
  }
}

function deviceReason(action: R): string {
  const message = String(action.payload?.executorFailure?.message ?? "");
  return DEVICE_REASONS.find(([pattern]) => pattern.test(message))?.[1] ?? "操作没有完成，请找店员";
}

/* -------------------------------- errors --------------------------------- */

const BILLING_DISABLED = "本店未启用计费";

/** What any command says for these, whichever command it was. */
const ERRORS: Record<string, string> = {
  BOT_DISABLED: "Bot 已被店铺停用",
  BILLING_DISABLED,
  RESOURCE_NOT_BILLED: "这里不计费，无需入场",
  PLAYER_HAS_NO_UNSETTLED_SESSIONS: "您当前没有未结算的账单，无需结账。",
  ACTIVE_SESSION_NOT_FOUND: "您当前没有进行中的计费场次。",
  DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION: "操作失败，玩家未入场",
  PLAYER_IDENTITY_NOT_FOUND: "未找到您的玩家身份，请先注册或绑定账号。",
  INSUFFICIENT_BALANCE: "余额不足，暂时不能结账。请先充值，或由店员在后台改价后再结账。",
};

/** Why a device action was refused, after its command's 「…失败，」. */
const POWER_REASONS: Record<string, string> = {
  DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION: "玩家未入场",
  PLAYER_IDENTITY_NOT_FOUND: "玩家未注册",
  BILLING_DISABLED,
  DEVICE_NOT_FOUND: "没有这个设备",
};
const ACTION_REASONS: Record<string, string> = {
  DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION: "玩家未入场",
  DEVICE_NOT_FOUND: "设备不存在",
  SCAN_IDENTITY_NOT_BOUND_TO_PLAYER: "玩家未绑定 Aime 卡",
  COIN_COMMAND_COOLDOWN_ACTIVE: "投币冷却中，请稍后再试",
  COIN_CABINET_FULL: "达到机台投币上限",
  BILLING_DISABLED,
  OPERATION_IN_PROGRESS: "其他操作正在处理中，请稍后再试。",
  REDEEM_CODE_NOT_FOUND: "兑换码无效，请检查后再试。",
  REDEEM_CODE_NOT_ACTIVE: "兑换码尚未生效。",
  REDEEM_CODE_EXPIRED: "兑换码已过期。",
  PRESENT_EXPIRED: "兑换码已过期。",
  PRESENT_NOT_ACTIVE: "这份礼物当前无法兑换。",
  PRESENT_ARCHIVED: "这份礼物当前无法兑换。",
  REDEEM_CODE_MAX_USE_REACHED: "兑换码已被领完。",
  PRESENT_ONCE_PER_PLAYER_REDEEMED: "您已经领取过这份礼物，无需重复兑换。",
  PRESENT_GRANT_LIMIT_REACHED: "您已达到这份礼物的领取上限。",
};

const GENERIC = "操作失败，请稍后再试。";

/** The device action a command asks for, whose refusal is said after its 「…失败，」. */
const DEVICE_COMMANDS: Record<string, string> = { on: "power.on", off: "power.off", keep: "power.keep", coin: "coin", scan: "aime.scan", lock: "door.open" };

/** A refusal as the platform knows it: the code it was raised with, its own words, an HTTP-like status. */
export type Refusal = { code: string; message: string; status: number };

/**
 * What the bot says when a command was refused, by the command and what it
 * named (`args`). `checkInUrl` is where a player proves they are at the shop.
 */
export function errorReply(command: string, args: string[], error: Refusal, checkInUrl: string): BotMessage {
  const said = (text: string) => botMessage(text);
  if (error.code.startsWith("LOCATION_")) return said(`请在网页完成到店校验：${checkInUrl}`);
  const platformSaid = error.status >= 400 && error.status < 500 && error.message.trim() ? error.message.trim() : null;
  const type = DEVICE_COMMANDS[command];
  if (type) {
    const reason = (type.startsWith("power.") ? POWER_REASONS : ACTION_REASONS)[error.code] ?? "请稍后再试";
    return said(`${FAILED[type]}${reason}`);
  }
  if (command === "mahjong" || command === "上桌" || command === "下桌") {
    const ref = args[0] ?? "";
    const joining = command !== "下桌";
    if (error.code === "MAHJONG_TABLE_NOT_FOUND") return said(joining || ref ? `未找到麻将桌「${ref}」。可先使用 /麻将列表 查看可用桌位。` : "你当前未在任何麻将桌上。");
    if (error.code === "MAHJONG_TABLE_FULL") return said(`「${ref}」已满桌，请等待本局结束后再上桌。`);
    if (error.code === "MAHJONG_ALREADY_SEATED") return said("你已经在另一张麻将桌上，请先 /下桌。");
    if (error.code === "MAHJONG_NOT_SEATED") return said(error.message);
    if (platformSaid) return said(`${joining ? "上桌" : "下桌"}失败，${platformSaid}`);
  }
  if (command === "bind" || command === "prism.bind") {
    return said(error.code === "VALIDATION_FAILED" ? "绑定失败，请重新生成验证码" : platformSaid ?? "绑定失败，请重新生成验证码");
  }
  if (error.code === "ROSTER_TARGET_NOT_FOUND" || error.code === "INVALID_PLATFORM_IDENTITY") return said(error.message);
  return said(ERRORS[error.code] ?? GENERIC);
}

/** The line that rides along with an entry when the door code could not be had. */
export { ENTRY_DOOR_FAILED };

/* ------------------------------ device power ------------------------------ */

const POWER_WORDS: Record<string, string> = { on: "🟢 开机", off: "⚫ 关机" };

/**
 * `show`: every device with power, or the one named by id, name or alias
 * (`named`; null when nothing has that name).
 */
export function deviceStatesMessage(states: Array<{ label?: string; deviceId: string; state: unknown }>, named?: string): BotMessage {
  if (named !== undefined && !states.length) return botMessage(`找不到设备: ${named}`);
  if (!states.length) return botMessage("没有找到任何设备状态。");
  return botMessage(states.map((device) =>
    `${device.label || device.deviceId}：${POWER_WORDS[String(device.state)] ?? "❔ 未知"}`).join("\n"));
}

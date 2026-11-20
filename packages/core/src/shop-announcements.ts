/**
 * What a shop's bots may say, named by the events themselves.
 *
 * The platform keeps two kinds of event apart, and so does this catalog:
 *
 * - an **attempt**: someone (or the platform's own rule) asked for something,
 *   and how that went: sent (the hardware took it), refused (the shop's rules
 *   said no) or failed (the hardware did not answer, or said no);
 * - a **fact**: something that happened, as the shop's hardware or its books
 *   say: a machine came on, a game took a card, a bill was settled.
 *
 * They are never tied together: a machine can come on with nobody asking, and
 * a request can be taken without the machine coming on. A shop that wants
 * "the machine came on" listens for the fact; one that wants "this player
 * switched it on" listens for the attempt. Each key is the event's own type
 * (`power.on.sent`, `card.consumed`), or a named slice of one where the shop
 * thinks of it as its own thing (`power.off.idle.sent`, `coin.auto.sent`).
 *
 * Notices are neither: the platform's own warnings (an idle power-off ahead,
 * a deployment).
 */

export type AnnouncementTopic = "power" | "card" | "coin" | "billing" | "system";
export type AnnouncementKind = "attempt" | "fact" | "notice";
export type AttemptOutcome = "sent" | "refused" | "failed";

/** The topics a shop finds its announcements under, in order. */
export const announcementTopics: ReadonlyArray<{ topic: AnnouncementTopic; label: string }> = [
  { topic: "power", label: "开关机" },
  { topic: "card", label: "刷卡与上机" },
  { topic: "coin", label: "投币" },
  { topic: "billing", label: "账单" },
  { topic: "system", label: "其他" },
];

export const attemptOutcomes: ReadonlyArray<{ outcome: AttemptOutcome; label: string }> = [
  { outcome: "sent", label: "已发出" },
  { outcome: "refused", label: "被拒绝" },
  { outcome: "failed", label: "失败" },
];

/**
 * One thing a shop may listen for. `text` is what is said unless the shop
 * wrote its own; `{…}` are filled in from the event (`announcementSamples`
 * lists them). An attempt's outcomes are separate entries sharing `action`.
 */
export type AnnouncementEntry = {
  key: string;
  topic: AnnouncementTopic;
  kind: AnnouncementKind;
  /** What the shop calls it; an attempt's outcome adds its own word. */
  label: string;
  /** For an attempt: what was asked for, and how it went. */
  action?: string;
  outcome?: AttemptOutcome;
  text: string;
  /** What a fact needs from the shop's hardware to be known at all. */
  needs?: string;
};

const attempt = (topic: AnnouncementTopic, action: string, label: string, texts: Partial<Record<AttemptOutcome, string>>): AnnouncementEntry[] =>
  attemptOutcomes.filter(({ outcome }) => texts[outcome]).map(({ outcome }) => ({
    key: `${action}.${outcome}`, topic, kind: "attempt", label, action, outcome, text: texts[outcome]!,
  }));
const fact = (topic: AnnouncementTopic, key: string, label: string, text: string, needs?: string): AnnouncementEntry =>
  ({ key, topic, kind: "fact", label, text, ...(needs ? { needs } : {}) });
const notice = (topic: AnnouncementTopic, key: string, label: string, text: string): AnnouncementEntry =>
  ({ key, topic, kind: "notice", label, text });

/** Refused and failed read alike for every attempt: who, what, and why. */
const refused = (what: string) => `⛔ {player} {where}${what}被拒绝：{reason}`;
const failed = (what: string) => `⚠️ {player} {where}${what}没有成功：{reason}`;

export const announcementCatalog: readonly AnnouncementEntry[] = [
  ...attempt("power", "power.on", "开机", {
    sent: "✅ {player} {where}开启了 {device}", refused: refused("开机"), failed: failed("开启 {device} "),
  }),
  ...attempt("power", "power.off", "关机", {
    sent: "🛑 {player} {where}关闭了 {device}", refused: refused("关机"), failed: failed("关闭 {device} "),
  }),
  ...attempt("power", "power.keep", "延迟关机", {
    sent: "⏳ {player} {where}延迟了 {device} 的自动关机", refused: refused("延迟关机"), failed: failed("延迟 {device} 关机"),
  }),
  ...attempt("power", "power.off.idle", "闲置自动关机", { sent: "💤 {device} 闲置，已自动关机" }),
  fact("power", "power.changed.on", "设备开机", "✅ {device} 已开机", "Home Assistant 实时连接"),
  fact("power", "power.changed.off", "设备关机", "🛑 {device} 已关机", "Home Assistant 实时连接"),
  notice("power", "idle.reminder", "闲置关机提醒", "{devices} 闲置中，{minutes} 分钟后关机"),

  ...attempt("card", "aime.scan", "虚拟刷卡", {
    sent: "💳 {player} {where}给 {device} 虚拟刷卡", refused: refused("虚拟刷卡"), failed: failed("给 {device} 虚拟刷卡"),
  }),
  fact("card", "card.consumed", "刷卡", "💳 {player} 在 {device} {verb}", "直连的 HINATA IO"),
  fact("card", "occupancy.started", "上机", "🎮 {player} 在 {device} 上机"),
  fact("card", "card.bound", "添加卡片", "💳 {player} 添加了一张 {card} 卡"),

  ...attempt("coin", "coin", "投币", {
    sent: "🪙 {player} {where}给 {device} 投币", refused: refused("投币"), failed: failed("给 {device} 投币"),
  }),
  ...attempt("coin", "coin.auto", "自动投币", { sent: "🪙 {player} 刷卡后，{device} 自动投了一枚币" }),
  fact("coin", "cabinet.coin", "机台入币", "🪙 {device} 投币 {coins} 个，当前 {credit} 币", "直连的 HINATA IO"),
  fact("coin", "cabinet.consumed", "开局扣币", "🎮 {device} 开局消耗 {credits} 币，剩余 {credit} 币", "直连的 HINATA IO"),
  fact("coin", "cabinet.reset", "投币计数清零", "🧾 {device} 投币计数已清零", "直连的 HINATA IO"),

  ...attempt("billing", "entry", "入场", { refused: refused("入场") }),
  ...attempt("billing", "checkout", "结账", { refused: "{bill}" }),
  ...attempt("billing", "wallet.adjust", "调整余额", { refused: refused("调整余额") }),
  ...attempt("billing", "redeem", "兑换", { refused: refused("兑换") }),
  fact("billing", "session.started", "入场", "🚪 {player} {where}入场"),
  fact("billing", "session.stopped", "停止计费", "⏹ {player} 停止了一项计费"),
  fact("billing", "checkout.settled", "结账", "{bill}"),
  fact("billing", "wallet.adjusted", "调整余额", "💰 {player} 余额调整 {amount}"),
  fact("billing", "gift.redeemed", "兑换礼物", "🎁 {player} 兑换了礼物"),

  notice("system", "platform.maintenance", "系统维护", "🛠 {minutes} 分钟后开始后端维护，预计 {expected} 分钟内完成，期间暂停服务"),
];

/** Example values for every `{…}` an announcement may use, for previews and checks. */
export const announcementSamples: Readonly<Record<string, string>> = {
  player: "小明", device: "舞萌", where: "在扫码页", reason: "玩家未入场", amount: "+20", coins: "2", credits: "1", credit: "3",
  card: "Aime", verb: "刷卡", devices: "舞萌、中二", minutes: "5", expected: "3",
  bill: "🧾 结算账单\n玩家：小明\n游玩时长：1小时｜计价：20元",
};

const entries = new Map(announcementCatalog.map((entry) => [entry.key, entry]));

export function announcementEntry(key: string): AnnouncementEntry | undefined {
  return entries.get(key);
}

export function isAnnouncementKey(value: string): boolean {
  return entries.has(value);
}

/** What an entry is called on its own: an attempt's outcome after its action. */
export function announcementLabel(key: string): string {
  const entry = entries.get(key);
  if (!entry) return key;
  if (entry.kind !== "attempt") return entry.label;
  const outcomes = announcementCatalog.filter((other) => other.action === entry.action);
  return outcomes.length > 1 ? `${entry.label} · ${attemptOutcomes.find((o) => o.outcome === entry.outcome)!.label}` : entry.label;
}

/** Results of an action, as an attempt's outcome. A request nobody answered failed. */
const OUTCOMES: Record<string, AttemptOutcome> = { sent: "sent", failed: "failed", unanswered: "failed", refused: "refused" };

/**
 * The entry an event is told under, if any. `type` is the event's type
 * (`deviceEventType`); a request itself is not news, only how it went.
 */
export function announcementKeyOf(event: { type: string; via?: string | null; payload?: Record<string, unknown> }): string | null {
  const { type } = event;
  const payload = event.payload ?? {};
  // A machine's power or an air conditioner switching, as a current watcher saw it happen.
  if (type === "power.changed" || type === "climate.changed") {
    const switched = payload.switched as { to?: unknown } | undefined;
    return switched?.to === "on" ? "power.changed.on" : switched?.to === "off" ? "power.changed.off" : null;
  }
  const dot = type.lastIndexOf(".");
  const outcome = OUTCOMES[type.slice(dot + 1)];
  if (outcome) {
    const action = type.slice(0, dot);
    // The platform's own: its idle rule switching off, its coin after a card.
    if (action === "power.off" && event.via === "system") return outcome === "sent" ? "power.off.idle.sent" : null;
    if (action === "coin" && payload.cause === "card") return outcome === "sent" ? "coin.auto.sent" : null;
    const key = `${action}.${outcome}`;
    return entries.has(key) ? key : null;
  }
  return entries.has(type) ? type : null;
}

/** How where something came from reads before its verb: 小明 在扫码页开启了 舞萌. */
export function announcementWhere(via: string | null | undefined): string {
  switch (via) {
    case "page": return "在扫码页";
    case "merchant": return "在后台";
    case "bot": return "通过 Bot ";
    case "api": return "通过接口";
    default: return "";
  }
}

/**
 * Where what an announcement tells came into the platform, as a shop names it.
 * The same channels a device event records (`DeviceEventChannel`).
 */
export const shopAnnouncementSources = [
  { channel: "page", label: "扫码页" },
  { channel: "merchant", label: "后台" },
  { channel: "bot", label: "Bot" },
  { channel: "api", label: "接口" },
  { channel: "relay", label: "机台" },
  { channel: "ha", label: "Home Assistant" },
  { channel: "system", label: "自动" },
] as const;

export type ShopAnnouncementSource = (typeof shopAnnouncementSources)[number]["channel"];

const sources = new Set<string>(shopAnnouncementSources.map((entry) => entry.channel));

export function isShopAnnouncementSource(value: string): value is ShopAnnouncementSource {
  return sources.has(value);
}

/**
 * One way a shop's bot announces: a whole table of what it says and where.
 * A shop may have several, each its own audience: the staff group hearing
 * every bill in full, a players' group hearing that a machine came on.
 *
 * - `to`: wherever the bot can say something, written as the bot addresses
 *   it; a group (`onebot:42`) and a person (`onebot:private:10001`) are the
 *   same kind of thing; a staff member's private chat is written like any
 *   other person's.
 * - `events`: by catalog key, whether it is said (`on`) and only when it came
 *   from one of `sources` (anywhere, when empty). A key that is not here is
 *   off.
 * - `templates`: this group's own words, keyed as the catalog's templates
 *   (`announce.<key>.message`, and the notices' own); anything not here is
 *   said in the catalog's words.
 */
export type AnnouncementGroup = {
  id: string;
  name: string;
  to: readonly string[];
  events: Readonly<Record<string, { on: boolean; sources: readonly string[] }>>;
  templates: Readonly<Record<string, string>>;
};

/** Whether a group says an announcement from where it came. */
export function groupHears(group: AnnouncementGroup, event: { key: string; via?: string | null }): boolean {
  const setting = group.events[event.key];
  if (!setting?.on) return false;
  return !setting.sources.length || (!!event.via && setting.sources.includes(event.via));
}

/**
 * How a bot says an announcement: once per group that hears it, in that
 * group's words, at that group's destinations. A destination two groups name
 * hears it once, in the words of the group listed first. Empty when no group
 * hears it.
 */
export function announcementDeliveries(
  groups: readonly AnnouncementGroup[],
  event: { key: string; via?: string | null },
): Array<{ to: string[]; templates: Readonly<Record<string, string>> }> {
  const said = new Set<string>();
  const deliveries: Array<{ to: string[]; templates: Readonly<Record<string, string>> }> = [];
  for (const group of groups) {
    if (!groupHears(group, event)) continue;
    const to = group.to.filter((one) => !said.has(one));
    for (const one of to) said.add(one);
    if (to.length) deliveries.push({ to: [...new Set(to)], templates: group.templates });
  }
  return deliveries;
}

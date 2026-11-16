/**
 * What a shop's bots may announce, and the rules by which a bot says it.
 *
 * Four families:
 *
 * - **events**: something happened at the shop, as its own hardware told it
 *   (Home Assistant saw a machine come on, a game took a card, a cabinet's coin
 *   count moved). Each is told once, whoever caused it.
 * - **requests**: someone asked the platform to do something and the call to the
 *   hardware went through. That is all a request says.
 * - **notices**: the platform's own warnings, such as an idle power-off ahead.
 * - **shop**: what happened at the shop without a device doing anything: a
 *   player entering, a bill settled, a balance changed, a request turned away.
 *
 * A shop that wants "the machine came on" picks the event; one that wants "this
 * player switched it on" picks the request.
 */
export const shopAnnouncementCatalog = [
  { type: "power.on", label: "开机", family: "event" },
  { type: "power.off", label: "关机", family: "event" },
  { type: "card", label: "刷卡", family: "event" },
  { type: "start", label: "上机", family: "event" },
  { type: "cabinet.coin", label: "机台投币", family: "event" },
  { type: "cabinet.consumed", label: "开局扣币", family: "event" },
  { type: "cabinet.reset", label: "投币计数清零", family: "event" },
  { type: "request.power.on", label: "通过平台开机", family: "request" },
  { type: "request.power.off", label: "通过平台关机", family: "request" },
  { type: "request.power.idle_off", label: "闲置自动关机", family: "request" },
  { type: "request.card", label: "通过平台刷卡", family: "request" },
  { type: "request.coin", label: "通过平台投币", family: "request" },
  { type: "idle.reminder", label: "闲置关机提醒", family: "notice" },
  { type: "session.started", label: "入场", family: "shop" },
  { type: "session.stopped", label: "停止计费", family: "shop" },
  { type: "checkout.settled", label: "结账", family: "shop" },
  { type: "wallet.adjusted", label: "调整余额", family: "shop" },
  { type: "gift.redeemed", label: "兑换礼物", family: "shop" },
  { type: "request.refused", label: "操作被拒绝", family: "shop" },
] as const;

export type ShopAnnouncementType = (typeof shopAnnouncementCatalog)[number]["type"];
export type ShopAnnouncementFamily = (typeof shopAnnouncementCatalog)[number]["family"];

const labels = new Map<string, string>(shopAnnouncementCatalog.map((entry) => [entry.type, entry.label]));

export function shopAnnouncementLabel(type: ShopAnnouncementType): string {
  return labels.get(type)!;
}

export function isShopAnnouncementType(value: string): value is ShopAnnouncementType {
  return labels.has(value);
}

/**
 * Where what an announcement tells came into the platform, as a shop names it.
 * The same channels a device event records (`DeviceEventChannel`).
 */
export const shopAnnouncementSources = [
  { channel: "page", label: "扫码页" },
  { channel: "merchant", label: "商户后台" },
  { channel: "bot", label: "Bot" },
  { channel: "api", label: "接口" },
  { channel: "relay", label: "机台" },
  { channel: "ha", label: "Home Assistant" },
  { channel: "system", label: "平台规则" },
] as const;

export type ShopAnnouncementSource = (typeof shopAnnouncementSources)[number]["channel"];

const sources = new Set<string>(shopAnnouncementSources.map((entry) => entry.channel));

export function isShopAnnouncementSource(value: string): value is ShopAnnouncementSource {
  return sources.has(value);
}

/**
 * One thing a bot listens for and what it does about it: when any of `events`
 * happens, having come from one of `sources` (anywhere, when none is named), it
 * is said at every destination in `to`, and with `staff` to each staff member.
 *
 * A destination is wherever the bot can say something, written as the bot
 * addresses it: a group (`onebot:42`) and a person (`onebot:private:10001`)
 * are the same kind of thing. `staff` stands for the private chats of whoever
 * is staff when the event happens, so the rule need not be edited as they
 * come and go.
 *
 * This list is all a bot announces by: there is no place it says things in
 * besides what its rules name.
 */
export type ShopAnnouncementRule = {
  events: readonly string[];
  sources: readonly string[];
  to: readonly string[];
  staff: boolean;
};

/** A staff member's private chat, as a bot is told where to say something. */
export const staffDestination = (identity: { provider: string; subject: string }) =>
  `${identity.provider}:private:${identity.subject}`;

/**
 * Where a bot says an announcement: every destination its rules send it to,
 * each once, in the order the rules name them. Empty when no rule listens for it.
 */
export function announcementDestinations(
  rules: readonly ShopAnnouncementRule[],
  event: { type: string; via?: string | null },
  staff: readonly { provider: string; subject: string }[],
): string[] {
  const to: string[] = [];
  for (const rule of rules) {
    if (!rule.events.includes(event.type)) continue;
    if (rule.sources.length && !(event.via && rule.sources.includes(event.via))) continue;
    to.push(...rule.to);
    if (rule.staff) to.push(...staff.map(staffDestination));
  }
  return [...new Set(to)];
}

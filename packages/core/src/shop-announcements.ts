/**
 * What a shop's bots may announce, and which of it a bot is set to say.
 *
 * Three families:
 *
 * - **events**: something happened at the shop, as its own hardware told it
 *   (Home Assistant saw a machine come on, a game took a card, a cabinet's coin
 *   count moved). Each is told once, whoever caused it.
 * - **requests**: someone asked the platform to do something and the call to the
 *   hardware went through. That is all a request says.
 * - **notices**: the platform's own warnings, such as an idle power-off ahead.
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
 * The five switches bots had before the catalog, as the types they meant. A bot
 * set with switches keeps announcing what it did; one set with a list is also
 * told the switches it amounts to, for bots that only know switches.
 */
export const legacyAnnounceSwitches = {
  announceIdle: ["idle.reminder"],
  announcePower: ["request.power.on", "request.power.off", "request.power.idle_off"],
  announceStarts: ["start"],
  announceCards: ["card"],
  announceCoins: ["request.coin"],
} as const satisfies Record<string, readonly ShopAnnouncementType[]>;

export type LegacyAnnounceSwitch = keyof typeof legacyAnnounceSwitches;
export type LegacyAnnounceSwitches = Record<LegacyAnnounceSwitch, boolean>;

/** What a bot announces: its list when it has one, otherwise what its switches meant. */
export function announcedTypes(
  config: Partial<LegacyAnnounceSwitches> & { announceEvents?: readonly string[] | null },
): ShopAnnouncementType[] {
  if (config.announceEvents) return [...new Set(config.announceEvents.filter(isShopAnnouncementType))];
  return (Object.keys(legacyAnnounceSwitches) as LegacyAnnounceSwitch[])
    .filter((key) => config[key] === true)
    .flatMap((key) => legacyAnnounceSwitches[key]);
}

/** The switches a list amounts to: a switch is on when every type it stood for is announced. */
export function switchesFor(types: readonly string[]): LegacyAnnounceSwitches {
  const chosen = new Set(types);
  return Object.fromEntries(
    (Object.keys(legacyAnnounceSwitches) as LegacyAnnounceSwitch[]).map((key) => [
      key,
      legacyAnnounceSwitches[key].every((type) => chosen.has(type)),
    ]),
  ) as LegacyAnnounceSwitches;
}

import type { Locale } from "../notices.js";

/**
 * The page a player sees after scanning a resource, whole. This is the only
 * place that decides what it shows: clients draw these blocks and hold nothing
 * back, so an everyday change here needs no App Clip release.
 *
 * Clients skip a `kind` they do not know, and match blocks by `id` from one read
 * to the next so what the player is in the middle of (a ticked box, a spinner)
 * survives. A block's `label` and `text` are already in the player's language.
 */
export type PageButton = {
  kind: "button";
  id: string;
  label: string;
  /** Replaces `label` once the action has answered with a `code`. */
  againLabel?: string;
  icon?: "coin" | "power" | "door";
  style?: "primary";
  enabled: boolean;
  action: string;
  /** The answer shows on the button for a moment instead of under it. */
  answerOnButton?: boolean;
  /** Sent back as they are with the action. */
  payload?: Record<string, unknown>;
  /** The block that must be agreed to first; the action then carries `consent: true`. */
  requires?: string;
  needsLocation: boolean;
};

export type PageBlock =
  | PageButton
  | { kind: "text"; id: string; text: string; style?: "heading"; level?: "error" }
  | { kind: "signin"; id: string }
  | { kind: "binding"; id: string }
  | { kind: "pricing"; id: string; rules: unknown; changes: unknown }
  | { kind: "consent"; id: string; text: string }
  | { kind: "climate"; id: string; state: unknown; needsLocation: boolean }
  | {
      kind: "mahjong"; id: string; title: string; status: string; capacity: number;
      emptyLabel: string; mineLabel: string; seats: Array<{ name: string; mine: boolean }>;
    }
  /** Where the player's cards go. The cards themselves are read when the page opens, not with it. */
  | { kind: "cards"; id: string; enabled: boolean; capture: boolean; action: string; needsLocation: boolean };

export type Page = {
  shop: string;
  shopCode: string;
  heroUrl: string | null;
  resource: string;
  publicId: string;
  /** The player has something billing at this shop, here or elsewhere. */
  billingActive: boolean;
  blocks: PageBlock[];
};

/** A door code, shown above the button that asked for it until it expires. It exists only in that action's answer. */
export type PageCode = { title: string; value: string; expiresAt: string; expiresLabel: string; hint: string };

export type PageInput = {
  locale: Locale;
  head: Omit<Page, "blocks" | "billingActive">;
  billingActive: boolean;
  /** What the resource can do, as players are shown it. */
  capabilities: { power: boolean; climate: boolean; card: boolean; coin: boolean; door: boolean; mahjong: boolean };
  billed: boolean;
  coinAfterSwipe: boolean;
  cardCapture: boolean;
  /** Which of the shop's location checks apply: the door and entry are "checkin", the rest "machine". */
  geo: { checkin: boolean; machine: boolean };
  signedIn: boolean;
  gate: "ready" | "binding" | "entry" | "disabled";
  billing: {
    error?: { message: string };
    rules?: unknown;
    preview?: { revision?: unknown } | undefined;
  } | null;
  power: "on" | "off" | null;
  climate: unknown;
  coinFull: boolean;
  /** A direct-connected IO has not connected, so nothing can reach the machine yet. */
  ioWaiting: boolean;
  mahjong: { capacity: number; seats: Array<{ name: string; mine: boolean; playing: boolean }> } | null;
};

const EN: Record<string, string> = {
  "这里没有可操作的设备": "Nothing to operate here",
  "你在本店的玩家资格已停用，请联系店员": "Your membership at this shop is suspended. Please ask the staff.",
  "暂时无法使用": "Not available right now",
  "计费规则": "Pricing",
  "确认开始计费，离店前请结账。关闭页面不会停止计费。": "Billing starts when you confirm. Please check out before you leave; closing this page does not stop billing.",
  "确认": "Confirm",
  "入场并获取开门密码": "Enter and get door code",
  "获取开门密码": "Get door code",
  "重新获取密码": "Get a new code",
  "开门密码": "Door code",
  "有效期至": "Valid until",
  "在门锁上输入密码后按 #": "Enter the code on the lock, then press #",
  "设备尚未开机": "The device is off",
  "开机": "Turn on",
  "麻将桌": "Mahjong table",
  "麻将计费中": "Billing",
  "等待玩家": "Waiting for players",
  "空位": "Empty",
  "你": "You",
  "已满桌": "The table is full",
  "上桌": "Sit down",
  "下桌": "Leave the table",
  "等待机台连接": "Waiting for the machine to connect",
  "投币": "Insert coin",
  "达到机台投币上限": "Coin limit reached",
};

const translator = (locale: Locale) => (text: string) => (locale === "en" ? EN[text] ?? text : text);

export function renderPage(input: PageInput): Page {
  const { head, billingActive } = input;
  return { ...head, billingActive, blocks: pageBlocks(input) };
}

function pageBlocks(input: PageInput): PageBlock[] {
  const t = translator(input.locale);
  const { capabilities: cap, geo } = input;
  // A resource with no hardware and no plan has nothing to sign in for.
  if (!Object.values(cap).some(Boolean) && !input.billed) return [nothingHere(t)];
  if (!input.signedIn) return [{ kind: "signin", id: "signin" }];
  if (input.gate === "disabled")
    return [{ kind: "text", id: "disabled", text: t("你在本店的玩家资格已停用，请联系店员"), level: "error" }];
  if (input.gate === "binding") return [{ kind: "binding", id: "binding" }];
  if (input.gate === "entry") return entryBlocks(input, t);

  const blocks: PageBlock[] = [];
  if (cap.door) blocks.push(doorButton(t, geo.checkin));
  if (cap.climate) blocks.push({ kind: "climate", id: "climate", state: input.climate, needsLocation: geo.machine });
  if (cap.power && input.power === "off") {
    blocks.push(
      { kind: "text", id: "power-off", text: t("设备尚未开机"), style: "heading" },
      { kind: "button", id: "power", label: t("开机"), icon: "power", style: "primary", enabled: true, action: "power.on", needsLocation: geo.machine },
    );
    return blocks;
  }
  if (cap.mahjong && input.mahjong) blocks.push(...mahjongBlocks(input.mahjong, t, geo.machine));
  if ((cap.card || cap.coin) && input.ioWaiting) {
    blocks.push({ kind: "text", id: "io-waiting", text: t("等待机台连接"), style: "heading" });
    return blocks;
  }
  if (cap.card)
    blocks.push({ kind: "cards", id: "cards", enabled: true, capture: input.cardCapture, action: "card.swipe", needsLocation: geo.machine });
  if (cap.coin && !input.coinAfterSwipe)
    blocks.push({
      kind: "button", id: "coin", label: t(input.coinFull ? "达到机台投币上限" : "投币"), icon: "coin",
      enabled: !input.coinFull, action: "coin", answerOnButton: true, needsLocation: geo.machine,
    });
  return blocks.length ? blocks : [nothingHere(t)];
}

const nothingHere = (t: (text: string) => string): PageBlock =>
  ({ kind: "text", id: "empty", text: t("这里没有可操作的设备") });

const doorButton = (t: (text: string) => string, needsLocation: boolean): PageButton => ({
  kind: "button", id: "door", label: t("获取开门密码"), againLabel: t("重新获取密码"), icon: "door", style: "primary",
  enabled: true, action: "door.open", needsLocation,
});

function entryBlocks(input: PageInput, t: (text: string) => string): PageBlock[] {
  const { billing, capabilities: cap, geo } = input;
  if (billing?.error)
    return [
      { kind: "text", id: "entry-title", text: t("暂时无法使用"), style: "heading" },
      { kind: "text", id: "entry-error", text: billing.error.message, level: "error" },
    ];
  // Confirming a state that has changed since this page was read is refused, not applied.
  const revision = billing?.preview?.revision;
  const payload = { ...(revision !== undefined ? { expectedRevision: revision } : {}), ...(cap.door ? { openDoor: true } : {}) };
  // Confirming at a table is sitting down: the seat and its billing move together.
  const action = cap.mahjong ? "mahjong.join" : "entry";
  return [
    { kind: "text", id: "entry-title", text: t("计费规则"), style: "heading" },
    ...(billing?.rules ? [{ kind: "pricing", id: "pricing", rules: billing.rules, changes: billing.preview ?? null } as const] : []),
    { kind: "consent", id: "consent", text: t("确认开始计费，离店前请结账。关闭页面不会停止计费。") },
    {
      kind: "button", id: cap.door ? "door" : "entry", label: t(cap.door ? "入场并获取开门密码" : "确认"),
      ...(cap.door ? { icon: "door" as const, againLabel: t("重新获取密码") } : {}),
      style: "primary", enabled: true, action, payload, requires: "consent",
      needsLocation: geo.checkin || (cap.mahjong && geo.machine),
    },
  ];
}

function mahjongBlocks(table: NonNullable<PageInput["mahjong"]>, t: (text: string) => string, needsLocation: boolean): PageBlock[] {
  const mine = table.seats.some((seat) => seat.mine);
  return [
    {
      kind: "mahjong", id: "mahjong", title: t("麻将桌"), status: t(table.seats.some((seat) => seat.playing) ? "麻将计费中" : "等待玩家"),
      capacity: table.capacity, emptyLabel: t("空位"), mineLabel: t("你"),
      seats: table.seats.map((seat) => ({ name: seat.name, mine: seat.mine })),
    },
    !mine && table.seats.length >= table.capacity
      ? { kind: "text", id: "seat-full", text: t("已满桌") }
      : {
          kind: "button", id: "seat", label: t(mine ? "下桌" : "上桌"), ...(mine ? {} : { style: "primary" as const }),
          enabled: true, action: mine ? "mahjong.leave" : "mahjong.join", needsLocation,
        },
  ];
}

/** A door code as a page shows it. */
export function pageCode(locale: Locale, door: { temporaryPassword: string; expiresAt: string }): PageCode {
  const t = translator(locale);
  return {
    title: t("开门密码"), value: door.temporaryPassword, expiresAt: door.expiresAt,
    expiresLabel: t("有效期至"), hint: t("在门锁上输入密码后按 #"),
  };
}

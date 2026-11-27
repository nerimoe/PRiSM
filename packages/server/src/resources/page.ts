import type { ClimateState, Page, PageBlock, PageCode } from "@prism/page-protocol";
import type { Locale } from "../notices.js";
import { accountMenuFor, bindingBlock, signInBlock } from "./page-blocks/account.js";
import { cardsBlock } from "./page-blocks/cards.js";
import { climateBlock } from "./page-blocks/climate.js";
import { coinButton, doorButton, nothingHere, powerOffBlocks, tableBlocks } from "./page-blocks/controls.js";
import { entryBlocks } from "./page-blocks/entry.js";
import { translator } from "./page-text.js";
import { pageUi } from "./page-ui.js";

/**
 * The page a player sees after scanning a resource, whole. This is the only
 * place that decides what it shows: clients draw these blocks and hold nothing
 * back, so an everyday change here needs no App Clip release. What a block is
 * made of is in `@prism/page-protocol`; how each business block is filled in is
 * in `page-blocks/`.
 */
export type PageInput = {
  locale: Locale;
  head: Omit<Page, "blocks" | "billingActive" | "offerPasskeySetup">;
  billingActive: boolean;
  shopBills?: boolean;
  identityBindingRequired?: boolean;
  privacyModeEnabled?: boolean;
  needsBinding?: boolean;
  /** What the resource can do, as players are shown it. */
  capabilities: { power: boolean; climate: boolean; card: boolean; coin: boolean; door: boolean; table: boolean };
  billed: boolean;
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
  climate: ClimateState | null;
  coinFull: boolean;
  /** A direct-connected IO has not connected, so nothing can reach the machine yet. */
  ioWaiting: boolean;
  table: { capacity: number; seats: Array<{ name: string; mine: boolean; playing: boolean }> } | null;
};

export function renderPage(input: PageInput): Page {
  const { head, billingActive } = input;
  const blocks = pageBlocks(input);
  // Only offered to a player who can use the shop: not while signing in, binding, or disabled.
  const offerPasskeySetup =
    input.gate !== "binding" && input.gate !== "disabled" && !input.needsBinding &&
    !blocks.some((block) => block.kind === "signin" || block.id === "empty");
  const accountMenu = input.signedIn
    ? accountMenuFor(translator(input.locale), {
      billingActive,
      shopBills: input.shopBills ?? (input.billed || billingActive),
      identityBindingRequired: input.identityBindingRequired,
      includeBillTab: true,
      privacyModeEnabled: input.privacyModeEnabled,
      shopMenuAvailable: input.gate !== "binding" && input.gate !== "disabled" && !input.needsBinding,
    })
    : undefined;
  return { ...head, billingActive, offerPasskeySetup, ...(accountMenu ? { accountMenu } : {}), blocks };
}

function pageBlocks(input: PageInput): PageBlock[] {
  const t = translator(input.locale);
  const { capabilities: cap, geo } = input;
  // A resource with no hardware and no plan has nothing to sign in for.
  if (!Object.values(cap).some(Boolean) && !input.billed) return [nothingHere(t)];
  if (!input.signedIn) return [signInBlock(t)];
  if (input.gate === "disabled") return [pageUi.text("disabled", t("你在本店的玩家资格已停用，请联系店员"), { level: "error" })];
  if (input.gate === "binding") return [bindingBlock(t)];
  if (input.gate === "entry") return entryBlocks(input, t);

  const blocks: PageBlock[] = [];
  if (cap.door) blocks.push(doorButton(t, geo.checkin));
  if (cap.climate) blocks.push(climateBlock(input.climate, geo.machine, input.locale, t));
  if (cap.power && input.power === "off") return [...blocks, ...powerOffBlocks(t, geo.machine)];
  if (cap.table && input.table) blocks.push(...tableBlocks(input.table, t, geo.machine));
  if ((cap.card || cap.coin) && input.ioWaiting)
    return [...blocks, pageUi.text("io-waiting", t("等待机台连接"), { style: "heading" })];
  if (cap.card) blocks.push(cardsBlock(input, t));
  // Auto coin adds a coin after a card; a player can still coin by hand.
  if (cap.coin) blocks.push(coinButton(t, input.coinFull, geo.machine));
  return blocks.length ? blocks : [nothingHere(t)];
}

/** A door code as a page shows it. */
export function pageCode(locale: Locale, door: { temporaryPassword: string; expiresAt: string }): PageCode {
  const t = translator(locale);
  return {
    title: t("开门密码"), value: door.temporaryPassword, expiresAt: door.expiresAt,
    expiresLabel: t("有效期至"), hint: t("在门锁上输入密码后按 #"),
  };
}

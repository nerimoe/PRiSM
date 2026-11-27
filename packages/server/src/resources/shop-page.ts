import { formatOffsetTimestamp, timestampDisplayParts, visiblePlayerOptionDefinitions, type PlayerOptionKey } from "@prism/core";
import type { Page, PageBlock, PageKeyValueIcon, PageKeyValueItem, PageListItem, PageTone } from "@prism/page-protocol";
import type { CheckoutHistoryRecord } from "@prism/application";
import type { Locale } from "../notices.js";
import type { AccountPlatformIdentity } from "./platform-identities.js";
import { accountMenuFor, bindingBlock, disabledBlock, signInBlock } from "./page-blocks/account.js";
import { checkoutButton, liveBillBlock, settledBillBlock, type SettledBillReceipt } from "./page-blocks/bill.js";
import { translator, type Translate } from "./page-text.js";
import { pageUi } from "./page-ui.js";

export const SHOP_PAGE_VIEWS = ["shop", "bill", "redeem", "history", "wallet", "bindings", "options"] as const;
export type ShopPageView = (typeof SHOP_PAGE_VIEWS)[number];

export type ShopPageHead = {
  shop: string;
  shopCode: string;
  heroUrl: string | null;
  timeZone?: string;
};

export type LiveBillInput = {
  billingInputs?: { playerId: string; billingSnapshot: unknown };
  preview?: unknown;
};

export type ShopPageInput = {
  locale: Locale;
  head: ShopPageHead;
  signedIn: boolean;
  needsBinding: boolean;
  /** The player's standing in this shop has been revoked by staff. */
  disabled?: boolean;
  shopBills: boolean;
  identityBindingRequired?: boolean;
  privacyModeEnabled?: boolean;
  checkoutGeo: boolean;
  liveBill: LiveBillInput | null;
  settledReceipt: SettledBillReceipt | null;
};

export type AccountSheetInput = {
  locale: Locale;
  view: Exclude<ShopPageView, "shop">;
  head: ShopPageHead;
  checkoutGeo: boolean;
  liveBill?: LiveBillInput | null;
  settledReceipt?: SettledBillReceipt | null;
  redeemed?: boolean;
  history?: { records: CheckoutHistoryRecord[]; nextOffset: number | null };
  detailReceipt?: SettledBillReceipt | null;
  now?: Date;
  holdings?: Array<{ id: string; assetType?: string; assetName?: string | null; assetCode: string; quantity: number }>;
  bindings?: AccountPlatformIdentity[];
  privacyModeEnabled?: boolean;
  playerOptions?: Partial<Record<PlayerOptionKey, boolean>>;
};

type WalletHolding = NonNullable<AccountSheetInput["holdings"]>[number];

function walletHoldingType(holding: WalletHolding): { type: string; code: string } {
  const code = holding.assetCode.trim().toLowerCase();
  const inferred = code === "paid" || code === "free" ? "currency" : "";
  return { type: (holding.assetType ?? inferred).trim().toLowerCase(), code };
}

function walletHoldingRank(holding: WalletHolding): number {
  const { type, code } = walletHoldingType(holding);
  if (type === "currency") return code === "paid" ? 0 : code === "free" ? 1 : 2;
  if (type === "coupon") return 10;
  if (type === "pass") return 11;
  if (type === "ticket") return 12;
  return 20;
}

const WALLET_TYPE_STYLES: Record<string, { icon: PageKeyValueIcon; label: string; badgeTone: PageTone }> = {
  coupon: { icon: "coupon", label: "优惠券", badgeTone: "warning" },
  pass: { icon: "pass", label: "通行证", badgeTone: "purple" },
  ticket: { icon: "ticket", label: "票券", badgeTone: "accent" },
};

function walletHoldingVisual(
  holding: WalletHolding,
  t: Translate,
): Pick<PageKeyValueItem, "icon" | "badge" | "badgeTone"> {
  const { type, code } = walletHoldingType(holding);
  if (type === "currency") {
    if (code === "paid") return { icon: "wallet", badge: t("充值余额"), badgeTone: "success" };
    if (code === "free") return { icon: "gift", badge: t("赠送余额"), badgeTone: "accent" };
    return { icon: "coins", badge: t("余额"), badgeTone: "success" };
  }
  const style = WALLET_TYPE_STYLES[type];
  if (style) return { icon: style.icon, badge: t(style.label), badgeTone: style.badgeTone };
  return type ? { icon: "asset", badge: holding.assetType ?? type, badgeTone: "muted" } : { icon: "asset" };
}

function walletKeyValueItems(holdings: readonly WalletHolding[], t: Translate): PageKeyValueItem[] {
  return [...holdings]
    .sort((left, right) => walletHoldingRank(left) - walletHoldingRank(right))
    .map((holding) => ({
      id: holding.id,
      label: holding.assetName || holding.assetCode,
      value: String(holding.quantity),
      ...walletHoldingVisual(holding, t),
    }));
}

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PAYMENT_METHOD_KEYS: Record<string, string> = {
  wechat: "微信",
  alipay: "支付宝",
  cash: "现金",
  other: "其他",
};

type LocalDateTimeParts = NonNullable<ReturnType<typeof timestampDisplayParts>>;

function localDateTimeParts(iso: string, timeZone?: string): LocalDateTimeParts | null {
  return timestampDisplayParts(formatOffsetTimestamp(iso, timeZone || "UTC"));
}

function formatHistoryGroupDate(localDate: string, todayYear: string | undefined, locale: Locale): string {
  const year = Number(localDate.slice(0, 4));
  const month = Number(localDate.slice(5, 7));
  const day = Number(localDate.slice(8, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return localDate;
  const crossYear = Boolean(todayYear && localDate.slice(0, 4) !== todayYear);
  if (locale === "en") {
    const monthLabel = EN_MONTHS[month - 1] ?? String(month);
    return crossYear ? `${monthLabel} ${day}, ${year}` : `${monthLabel} ${day}`;
  }
  return crossYear ? `${year}年${month}月${day}日` : `${month}月${day}日`;
}

function formatHistoryDuration(startedAt: string, endedAt: string, locale: Locale): string | undefined {
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(endedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  const minutes = Math.floor((endMs - startMs) / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (locale === "en") {
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return m > 0 ? `${m}m` : "<1m";
  }
  if (h > 0 && m > 0) return `${h}小时${m}分`;
  if (h > 0) return `${h}小时`;
  return m > 0 ? `${m}分钟` : "不足1分钟";
}

function formatHistoryTimeRange(
  startedAt: string | null,
  settledParts: LocalDateTimeParts,
  endParts: LocalDateTimeParts,
  timeZone?: string,
): string {
  if (!startedAt) return endParts.time;
  const startParts = localDateTimeParts(startedAt, timeZone);
  if (!startParts) return endParts.time;
  const shortDay = (parts: LocalDateTimeParts) =>
    parts.date.slice(0, 4) === settledParts.date.slice(0, 4) ? parts.date.slice(5) : parts.date;
  const startLabel = startParts.date === settledParts.date ? startParts.time : `${shortDay(startParts)} ${startParts.time}`;
  const endLabel =
    endParts.date === settledParts.date || endParts.date === startParts.date
      ? endParts.time
      : `${shortDay(endParts)} ${endParts.time}`;
  return `${startLabel} – ${endLabel}`;
}

function formatHistoryPayment(method: string | null | undefined, t: Translate): string {
  if (!method) return t("资产结算");
  return `${t("现场收款")} · ${t(PAYMENT_METHOD_KEYS[method] ?? method)}`;
}

function historyListItem(
  record: CheckoutHistoryRecord,
  locale: Locale,
  t: Translate,
  timeZone: string | undefined,
  todayYear: string | undefined,
): PageListItem {
  const settledParts = localDateTimeParts(record.settledAt, timeZone);
  const endIso = record.endedAt ?? record.settledAt;
  const endParts = localDateTimeParts(endIso, timeZone) ?? settledParts;
  if (!settledParts || !endParts) {
    return {
      id: record.id,
      title: "",
      titleTimestamp: record.startedAt ?? record.settledAt,
      ...(record.startedAt ? { subtitlePrefix: "→ ", subtitleTimestamp: endIso } : {}),
      trailing: record.total.toFixed(2),
      open: { view: "history", item: record.id },
    };
  }
  const group = formatHistoryGroupDate(settledParts.date, todayYear, locale);
  const title = formatHistoryTimeRange(record.startedAt, settledParts, endParts, timeZone);
  const titleMeta = record.startedAt ? formatHistoryDuration(record.startedAt, endIso, locale) : undefined;
  const subtitleParts = [formatHistoryPayment(record.paymentMethod, t)];
  if (record.sessionCount > 1) subtitleParts.push(`${record.sessionCount} ${t("项")}`);
  if (record.endedAt && (settledParts.date !== endParts.date || settledParts.time !== endParts.time)) {
    subtitleParts.push(`${t("结账时间")} ${settledParts.time}`);
  }
  const discounted = typeof record.subtotal === "number" && record.subtotal > record.total + 0.005;
  return {
    id: record.id,
    group,
    title,
    ...(titleMeta ? { titleMeta } : {}),
    subtitle: subtitleParts.join(" · "),
    trailing: record.total.toFixed(2),
    ...(discounted ? { trailingStrikethrough: record.subtotal!.toFixed(2) } : {}),
    open: { view: "history", item: record.id },
  };
}

export function renderShopPage(input: ShopPageInput): Page {
  const t = translator(input.locale);
  const { head, signedIn, needsBinding, shopBills, identityBindingRequired, privacyModeEnabled, checkoutGeo, liveBill, settledReceipt } = input;
  const disabled = signedIn && !!input.disabled;
  const billingActive = !!liveBill;
  const timeZone = head.timeZone;

  let subtitle = "";
  let blocks: PageBlock[];
  let footer: PageBlock[] | undefined;

  if (!signedIn) {
    blocks = [signInBlock(t)];
  } else if (disabled) {
    blocks = [disabledBlock(t)];
  } else if (needsBinding) {
    // Checking out needs a bound identity: binding comes first, a running bill is shown under it, read-only.
    subtitle = liveBill ? t("计费中") : t("未入场");
    blocks = liveBill
      ? [bindingBlock(t), liveBillBlock("bill", { ...(timeZone ? { timeZone } : {}), ...liveBill }, t)]
      : [bindingBlock(t)];
  } else if (liveBill) {
    subtitle = t("计费中");
    blocks = [liveBillBlock("bill", { ...(timeZone ? { timeZone } : {}), ...liveBill }, t)];
    footer = [checkoutButton(t, checkoutGeo)];
  } else if (settledReceipt) {
    subtitle = t("结账成功");
    blocks = [settledBillBlock("bill", settledReceipt, t, timeZone)];
  } else {
    subtitle = t("未入场");
    blocks = [pageUi.status("shop-empty", "scan", t("请碰一下 NFC 或扫描机台上的二维码"))];
  }

  const accountMenu = signedIn
    ? accountMenuFor(t, {
        billingActive,
        shopBills,
        identityBindingRequired,
        includeBillTab: false,
        privacyModeEnabled,
        shopMenuAvailable: !needsBinding && !disabled,
      })
    : undefined;

  return {
    shop: head.shop,
    shopCode: head.shopCode,
    heroUrl: head.heroUrl,
    resource: subtitle,
    publicId: "",
    billingActive,
    offerPasskeySetup: signedIn && !needsBinding && !disabled,
    ...(accountMenu ? { accountMenu } : {}),
    blocks,
    ...(footer ? { footer } : {}),
  };
}

export function renderAccountSheetPage(input: AccountSheetInput): Page {
  const t = translator(input.locale);
  const { view, head, checkoutGeo } = input;
  const timeZone = head.timeZone;

  let title = "";
  let backLabel: string | undefined;
  let blocks: PageBlock[] = [];
  let footer: PageBlock[] | undefined;
  let billingActive = false;

  switch (view) {
    case "bill": {
      title = t("账单");
      const liveBill = input.liveBill ?? null;
      const settledReceipt = input.settledReceipt ?? null;
      billingActive = !!liveBill;
      if (liveBill) {
        blocks = [liveBillBlock("bill", { ...(timeZone ? { timeZone } : {}), ...liveBill }, t)];
        footer = [checkoutButton(t, checkoutGeo)];
      } else if (settledReceipt) {
        blocks = [settledBillBlock("bill", settledReceipt, t, timeZone)];
      } else {
        blocks = [pageUi.status("bill-empty", "receipt", t("暂无待结账单"), { level: "muted" })];
      }
      break;
    }
    case "redeem": {
      title = t("兑换");
      if (input.redeemed) {
        blocks = [pageUi.banner("redeem-done", t("兑换成功"), { level: "success" })];
      } else {
        blocks = [
          pageUi.input("code", { name: "code", placeholder: t("兑换码"), required: true }),
          pageUi.button("redeem-submit", t("兑换"), "redeem.submit", { style: "primary", collect: ["code"] }),
        ];
      }
      break;
    }
    case "history": {
      if (input.detailReceipt) {
        title = t("账单详情");
        blocks = [settledBillBlock("history-detail", input.detailReceipt, t, timeZone)];
      } else {
        title = t("记录");
        const history = input.history ?? { records: [], nextOffset: null };
        const todayYear = localDateTimeParts((input.now ?? new Date()).toISOString(), timeZone)?.date.slice(0, 4);
        const items: PageListItem[] = history.records.map((record) =>
          historyListItem(record, input.locale, t, timeZone, todayYear),
        );
        blocks = [
          pageUi.list("history-list", items, {
            ...(timeZone ? { timeZone } : {}),
            emptyText: t("暂无结账记录"),
            emptyIcon: "receipt",
            ...(history.nextOffset != null
              ? { moreLabel: t("加载更多"), moreTarget: { view: "history", cursor: String(history.nextOffset) } }
              : {}),
          }),
        ];
      }
      break;
    }
    case "wallet": {
      title = t("钱包");
      const holdings = input.holdings ?? [];
      blocks = holdings.length
        ? [pageUi.kv("wallet-holdings", walletKeyValueItems(holdings, t))]
        : [pageUi.status("wallet-empty", "wallet", t("暂无资产"), { level: "muted" })];
      break;
    }
    case "bindings": {
      title = t("身份");
      const bindings = input.bindings ?? [];
      blocks = [
        bindings.length
          ? pageUi.kv(
              "bindings-list",
              bindings.map((binding) => ({
                id: `${binding.provider}:${binding.subject}`,
                label: `${binding.provider}${binding.displayName ? ` · ${binding.displayName}` : ""}`,
                value: binding.subject,
              })),
            )
          : pageUi.status("bindings-empty", "identity", t("暂无绑定身份"), { level: "muted" }),
      ];
      break;
    }
    case "options": {
      title = t("选项");
      {
        const visible = visiblePlayerOptionDefinitions({
          privacyModeEnabled: !!input.privacyModeEnabled,
        });
        blocks = visible.length
          ? [
              ...visible.map((option) =>
                pageUi.toggle(option.key, t(option.label), {
                  name: option.key,
                  description: t(option.description),
                  defaultValue: Boolean(input.playerOptions?.[option.key] ?? option.defaultValue),
                }),
              ),
              pageUi.button("options-save", t("保存"), "options.save", {
                style: "primary",
                collect: visible.map((option) => option.key),
              }),
            ]
          : [pageUi.status("options-empty", "options", t("暂无可用选项"), { level: "muted" })];
      }
      break;
    }
  }

  return {
    shop: head.shop,
    shopCode: head.shopCode,
    heroUrl: head.heroUrl,
    resource: "",
    publicId: "",
    billingActive,
    offerPasskeySetup: false,
    title,
    ...(backLabel ? { backLabel } : {}),
    blocks,
    ...(footer ? { footer } : {}),
  };
}

import type {
  PageBill,
  PageBillLabels,
  PageButton,
  PageCelebration,
} from "@prism/page-protocol";
import type { PlayerCheckoutReceipt } from "@prism/application";
import type { Translate } from "../page-text.js";
import { pageUi } from "../page-ui.js";

export type SettledBillReceipt = Pick<
  PlayerCheckoutReceipt,
  "playerSettlement" | "timeline" | "wallet" | "chargeItems" | "adjustments"
>;

export const billLabels = (t: Translate): PageBillLabels => ({
  totalLabel: t("合计"),
  legendLabel: t("图例"),
  billingLegend: t("计费"),
  cappedLegend: t("封顶中"),
  settledTitle: t("结账成功"),
  balanceAfterLabel: t("结账后余额"),
  headings: {
    current: t("现在"),
    end: t("结束计费"),
    start: t("开始计费"),
    switch: t("切换计费规则"),
    over: t("封顶结束"),
  },
  capFullSuffix: t("已满"),
  capUntilLabel: t("封顶到"),
  newDayLabel: t("新的一天"),
  hourUnit: t("小时"),
  minuteUnit: t("分钟"),
  billingUnitLabel: t("个计费单位"),
  estimateError: t("账单预估失败，请刷新后重试"),
  retryLabel: t("重试"),
});

export function liveBillBlock(
  id: string,
  opts: {
    timeZone?: string;
    billingInputs?: { playerId: string; billingSnapshot: unknown };
    preview?: unknown;
  },
  t: Translate,
): PageBill {
  return pageUi.bill(id, {
    mode: "live",
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    ...(opts.billingInputs ? { billingInputs: opts.billingInputs } : {}),
    ...(opts.preview !== undefined ? { preview: opts.preview } : {}),
    labels: billLabels(t),
  });
}

export function settledBillBlock(
  id: string,
  receipt: SettledBillReceipt,
  t: Translate,
  timeZone?: string,
): PageBill {
  const balanceAfter = receipt.wallet ? receipt.wallet.balanceAfter : undefined;
  return pageUi.bill(id, {
    mode: "settled",
    ...(timeZone ? { timeZone } : {}),
    preview: {
      timeline: receipt.timeline,
      settlementPreview: { total: receipt.playerSettlement.total },
      chargeItems: receipt.chargeItems,
      adjustments: receipt.adjustments,
    },
    settledAt: receipt.playerSettlement.settledAt,
    ...(balanceAfter !== undefined && balanceAfter !== null ? { balanceAfter } : {}),
    labels: billLabels(t),
  });
}

export function checkoutButton(t: Translate, needsLocation: boolean): PageButton {
  return pageUi.button("checkout", t("结账"), "checkout.confirm", {
    style: "primary",
    needsLocation,
  });
}

export function checkoutCelebration(t: Translate): PageCelebration {
  return {
    title: t("结账成功"),
    subtitle: t("计费已结束，离店前无需再做其他操作。"),
    effect: "checkout",
  };
}

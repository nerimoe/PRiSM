import type { PageBlock, PagePricingLabels } from "@prism/page-protocol";
import type { Locale } from "../../notices.js";
import type { PageInput } from "../page.js";
import type { Translate } from "../page-text.js";
import { pageUi } from "../page-ui.js";

const pricingLabels = (locale: Locale, t: Translate): PagePricingLabels => ({
  title: t("计费规则"),
  sharedCapsTitle: t("跨方案封顶"),
  stoppedTitle: t("确认后结束"),
  startedTag: t("新增"),
  keptTag: t("保留"),
  fixedFee: t("单次收取"),
  notBilled: t("不计费"),
  notCovered: t("未覆盖"),
  uncapped: t("不封顶"),
  capReached: t("已达封顶"),
  accumulated: t("累计"),
  cap: t("封顶"),
  minuteUnit: t("分钟"),
  listSeparator: locale === "en" ? ", " : "、",
});

/** What a player reads and agrees to before billing starts. */
export function entryBlocks(input: PageInput, t: Translate): PageBlock[] {
  const { billing, capabilities: cap, geo } = input;
  if (billing?.error)
    return [
      pageUi.text("entry-title", t("暂时无法使用"), { style: "heading" }),
      pageUi.text("entry-error", billing.error.message, { level: "error" }),
    ];
  // Confirming a state that has changed since this page was read is refused, not applied.
  const revision = billing?.preview?.revision;
  const payload = { ...(revision !== undefined ? { expectedRevision: revision } : {}), ...(cap.door ? { openDoor: true } : {}) };
  // Confirming at a table is sitting down: the seat and its billing move together.
  const action = cap.table ? "table.join" : "entry";
  return [
    pageUi.text("entry-title", t("计费规则"), { style: "heading" }),
    ...(billing?.rules
      ? [{
          kind: "pricing" as const,
          id: "pricing",
          rules: billing.rules,
          changes: billing.preview ?? null,
          labels: pricingLabels(input.locale, t),
        }]
      : []),
    pageUi.consent("consent", t("确认开始计费，离店前请结账。关闭页面不会停止计费。")),
    pageUi.button(cap.door ? "door" : "entry", t(cap.door ? "入场并获取开门密码" : "确认"), action, {
      ...(cap.door ? { icon: "door" as const, againLabel: t("重新获取密码") } : {}),
      style: "primary", payload, requires: "consent",
      needsLocation: geo.checkin || (cap.table && geo.machine),
    }),
  ];
}

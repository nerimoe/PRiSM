import type { PageCards, PageCardsAction } from "@prism/page-protocol";
import type { PageInput } from "../page.js";
import type { Translate } from "../page-text.js";

export function cardsBlock(input: PageInput, t: Translate): PageCards {
  const { locale, head, cardCapture, geo } = input;
  const reload: PageCardsAction = { id: "refresh", label: t("刷新"), action: "cards.reload" };
  return {
    kind: "cards",
    id: "cards",
    enabled: true,
    capture: cardCapture,
    action: "card.swipe",
    needsLocation: geo.machine,
    title: t("选择卡片"),
    loadingLabel: t("正在加载卡片"),
    locatingLabel: t("确认位置…"),
    swipingLabel: t("正在登录…"),
    endingTemplate: t("尾号 {digits}"),
    empty: cardCapture
      ? {
          text: t("还没有可用卡片，请先添加卡片"),
          actions: [{ id: "capture", label: t("添加卡片"), action: "cards.capture" }, reload],
        }
      : {
          text: t("还没有可用卡片"),
          actions: [reload],
        },
    // A page that could not read the cards offers nothing but reading them again.
    loadError: {
      title: t("无法加载卡片"),
      actions: [{ ...reload, style: "primary" }],
    },
    ...(cardCapture
      ? {
          captureUi: {
            title: t("添加卡片"),
            addLabel: t("添加卡片"),
            startingText: t("正在连接机台…"),
            waitingText: locale === "en"
              ? `Put your card on the reader of ${head.resource}`
              : `请把卡片放在「${head.resource}」的读卡器上`,
            cancelLabel: t("取消"),
            doneLabel: t("完成"),
            leftPageText: t("离开页面后已取消添加，请重新添加"),
            outcomes: {
              added: t("已添加卡片"),
              taken: t("这张卡已绑定到本店的其他玩家"),
              unsupported: t("不支持这种卡片"),
              expired: t("没有读到卡片"),
            },
          },
        }
      : {}),
  };
}

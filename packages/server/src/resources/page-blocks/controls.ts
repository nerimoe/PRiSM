import type { PageBlock, PageButton } from "@prism/page-protocol";
import type { PageInput } from "../page.js";
import type { Translate } from "../page-text.js";
import { pageUi } from "../page-ui.js";

export const nothingHere = (t: Translate): PageBlock => pageUi.text("empty", t("这里没有可操作的设备"));

export const doorButton = (t: Translate, needsLocation: boolean): PageButton =>
  pageUi.button("door", t("获取开门密码"), "door.open", {
    againLabel: t("重新获取密码"), icon: "door", style: "primary", needsLocation,
  });

export const powerOffBlocks = (t: Translate, needsLocation: boolean): PageBlock[] => [
  pageUi.text("power-off", t("设备尚未开机"), { style: "heading" }),
  pageUi.button("power", t("开机"), "power.on", {
    icon: "power", style: "primary", wait: { ms: 15_000, timeoutMessage: t("未检测到开机，请重试") }, needsLocation,
  }),
];

export const coinButton = (t: Translate, full: boolean, needsLocation: boolean): PageButton =>
  pageUi.button("coin", t(full ? "达到机台投币上限" : "投币"), "coin", {
    icon: "coin", enabled: !full, answerOnButton: true, hideDuringCapture: true, needsLocation,
  });

export function tableBlocks(table: NonNullable<PageInput["table"]>, t: Translate, needsLocation: boolean): PageBlock[] {
  const mine = table.seats.some((seat) => seat.mine);
  return [
    {
      kind: "table", id: "table", title: t("桌游"), status: t(table.seats.some((seat) => seat.playing) ? "桌游计费中" : "等待玩家"),
      capacity: table.capacity, emptyLabel: t("空位"), mineLabel: t("你"),
      seats: table.seats.map((seat) => ({ name: seat.name, mine: seat.mine })),
    },
    !mine && table.seats.length >= table.capacity
      ? pageUi.text("seat-full", t("已满桌"))
      : pageUi.button("seat", t(mine ? "下桌" : "上桌"), mine ? "table.leave" : "table.join", {
          ...(mine ? {} : { style: "primary" as const }), needsLocation,
        }),
  ];
}

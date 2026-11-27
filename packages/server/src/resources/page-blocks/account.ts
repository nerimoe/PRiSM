import { visiblePlayerOptionDefinitions } from "@prism/core";
import type { PageAccountMenu, PageBinding, PageBlock, PageSignIn } from "@prism/page-protocol";
import type { Translate } from "../page-text.js";
import { pageUi } from "../page-ui.js";

export const signInBlock = (t: Translate): PageSignIn => ({
  kind: "signin",
  id: "signin",
  methods: [
    { id: "munet", provider: "munet", label: t("使用 MuNET 登录"), busyLabel: t("正在连接 MuNET…"), style: "primary" },
    {
      id: "passkey", provider: "passkey", label: t("使用 Passkey 登录"), busyLabel: t("正在验证 Passkey…"),
      unsupportedText: t("当前浏览器不支持 Passkey，请使用 MuNET 登录"),
    },
  ],
});

export const bindingBlock = (t: Translate): PageBinding => ({
  kind: "binding",
  id: "binding",
  title: t("绑定身份"),
  expiresLabel: t("有效期至"),
  copyLabel: t("复制"),
  copiedLabel: t("已复制"),
  retryLabel: t("重试"),
});

/** A player whose standing in the shop staff revoked: said so, and nothing else offered. */
export const disabledBlock = (t: Translate): PageBlock =>
  pageUi.status("disabled", "blocked", t("玩家资格已停用"), { detail: t("请联系店员恢复后再使用"), level: "error" });

export function accountMenuFor(
  t: Translate,
  opts: {
    billingActive: boolean;
    shopBills: boolean;
    identityBindingRequired?: boolean;
    includeBillTab: boolean;
    privacyModeEnabled?: boolean;
    shopMenuAvailable?: boolean;
  },
): PageAccountMenu {
  // Unbound or disabled: nothing of this shop's is offered, only what is not about the shop.
  if (opts.shopMenuAvailable === false) {
    return {
      tabs: [],
      logoutLabel: t("退出登录"),
    };
  }
  const hasVisibleOptions = visiblePlayerOptionDefinitions({ privacyModeEnabled: !!opts.privacyModeEnabled }).length > 0;
  const optionsTab = hasVisibleOptions ? [{ id: "options", label: t("选项") }] : [];
  return {
    ...(opts.billingActive ? { billingBadge: t("计费中") } : {}),
    // A running session always gets its tabs, even where the shop has since stopped billing.
    tabs: opts.shopBills || opts.billingActive
      ? [
          ...(opts.includeBillTab ? [{ id: "bill", label: t("账单") }] : []),
          { id: "redeem", label: t("兑换") },
          { id: "history", label: t("记录") },
          { id: "wallet", label: t("钱包") },
          { id: "bindings", label: t("身份") },
          ...optionsTab,
        ]
      : [
          ...(opts.identityBindingRequired ? [{ id: "bindings", label: t("身份") }] : []),
          ...optionsTab,
        ],
    logoutLabel: t("退出登录"),
  };
}

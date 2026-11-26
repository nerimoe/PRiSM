import type { PageAccountMenu, PageBinding, PageSignIn } from "@prism/page-protocol";
import type { Translate } from "../page-text.js";

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

export function accountMenuFor(
  t: Translate,
  opts: { billingActive: boolean; shopBills: boolean; identityBindingRequired?: boolean; includeBillTab: boolean },
): PageAccountMenu {
  return {
    ...(opts.billingActive ? { billingBadge: t("计费中") } : {}),
    tabs: opts.shopBills
      ? [
          ...(opts.includeBillTab ? [{ id: "bill", label: t("账单") }] : []),
          { id: "redeem", label: t("兑换") },
          { id: "history", label: t("记录") },
          { id: "wallet", label: t("钱包") },
          { id: "bindings", label: t("身份") },
        ]
      : opts.identityBindingRequired
        ? [{ id: "bindings", label: t("身份") }]
        : [],
    logoutLabel: t("退出登录"),
  };
}

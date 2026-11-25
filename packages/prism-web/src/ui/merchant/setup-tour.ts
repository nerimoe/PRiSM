import type { SetupStatus, SetupStepId } from "./setup-guide";

export type TourDiagramId =
  | "store-hierarchy"
  | "store-example-override"
  | "store-example-zone"
  | "resource-abilities"
  | "pricing-workbench"
  | "identity-bot"
  | "money-flow"
  | "cashier-flow"
  | "qr-nfc-entry"
  | "ttlock-door"
  | "daily-dashboard";

export type TourStepId =
  | "resources-group"
  | "resources-add"
  | "pricing-assets"
  | "pricing-desk-resource"
  | "pricing-plans"
  | "pricing-bindings"
  | "cashier-reader"
  | "staff-invite"
  | "identity-policy"
  | "identity-bot-add"
  | "prepaid-gift"
  | "prepaid-code"
  | "door-ttlock"
  | "qr-trial"
  | "dashboard-overview";

export type TourModalHint = {
  title: string;
  body: string;
};

export type TourStep = {
  id: TourStepId;
  setupStep?: SetupStepId;
  chapter: string;
  title: string;
  concept: string;
  action: string;
  diagram: TourDiagramId;
  /** Route relative to `/merchant/:shopCode/`, e.g. `resources` or `assets?tab=gifts`. */
  route: string;
  /** Primary `data-tour` target value on that route. */
  target?: string;
  /** Fallback `data-tour` target when the primary target is absent or hidden. */
  fallbackTarget?: string;
  /** Contextual tip shown inside `<Modal>` while this tour step is active. */
  modalHint?: TourModalHint;
  /** Offers a shortcut to open the interactive billing diagram manual. */
  showBillingManual?: boolean;
  /** Automatically opens a `<details>` container when targeting it. */
  expandDetails?: boolean;
};

/**
 * Build the cross-page interactive tour for this shop's operating mode and
 * current setup diagnostics. Pure and deterministic so tests can verify both
 * routing and localization coverage.
 */
export function buildTourSteps(status: SetupStatus): TourStep[] {
  const steps: TourStep[] = [
    status.billing
      ? {
          id: "resources-group",
          chapter: "认识架构",
          title: "大多数店，像「月宫」一样只用默认组就够了",
          concept:
            "以音游店「月宫」为例：舞萌DX、中二、音击、门锁和空调全留在自带的「默认资源组」绑一套基础计划（¥4/30分），扫任一入口后全店通用；就算个别空调或桌游单独算钱，改单台「专属/对局方案」即可，只有多台设备成批分区时才需建新组。",
          action: "直接用下方的「默认资源组」即可；点「下一步」开始添加店里的设备。",
          diagram: "store-hierarchy",
          route: "resources",
          target: "resources-default-group",
          fallbackTarget: "resources-add-group",
        }
      : {
          id: "resources-group",
          chapter: "认识架构",
          title: "所有设备默认归在「默认资源组」",
          concept: "不使用计费时，默认组不绑方案，组内资源扫码即用完全免费，无需额外添加资源组。",
          action: "确认下方「默认资源组」即可，点「下一步」开始添加设备。",
          diagram: "store-hierarchy",
          route: "resources",
          target: "resources-default-group",
          fallbackTarget: "resources-add-group",
        },
    {
      id: "resources-add",
      setupStep: "devices",
      chapter: "接入设备",
      title: "添加资源，按需插上能力模块",
      concept: "机台、门锁、桌游或纯入场二维码都是资源，像插模块一样叠加电源、刷卡、投币等 10 种能力。",
      action: "点金框高亮的「添加资源」建一台设备或入场码；建好后点「下一步」。",
      diagram: "resource-abilities",
      route: "resources",
      target: "resources-add-btn",
      fallbackTarget: "resources-add-group",
      modalHint: {
        title: "配置资源要点",
        body: "填好名称即可保存为纯扫码入口；要控硬件就点左侧「添加能力」按需勾选。",
      },
    },
  ];

  if (status.billing) {
    if (status.pricingProblem === "assets") {
      steps.push({
        id: "pricing-assets",
        setupStep: "pricing",
        chapter: "设定计费",
        title: "先建一个「余额」资产",
        concept: "缺少余额资产时玩家结账无法扣款。",
        action: "点「新建资产」，类型选「余额」并保存。",
        diagram: "money-flow",
        route: "assets",
        target: "assets-create-btn",
        fallbackTarget: "assets-nav",
        modalHint: {
          title: "创建余额资产",
          body: "名称填「余额」，类型选「余额」后保存即可。",
        },
      });
    } else if (status.deskProblem === "missing") {
      steps.push({
        id: "pricing-desk-resource",
        setupStep: "pricing",
        chapter: "设定计费",
        title: "指定前台收银资源",
        concept: "前台刷实体卡入场会按该资源的方案计时。",
        action: "在下方「前台资源」选一个已启用资源并保存。",
        diagram: "cashier-flow",
        route: "settings?group=billing",
        target: "settings-billing-cashier",
      });
    }

    steps.push(
      {
        id: "pricing-plans",
        setupStep: "pricing",
        chapter: "设定计费",
        title: "核对计费方案与定时调价",
        concept: "支持按时阶梯、固定收费与全天封顶，顶部还能排未来调价计划。",
        action: "在左侧「方案」查看或新增规则，左下角可用模拟器试算。",
        diagram: "pricing-workbench",
        route: "pricing",
        target: "pricing-tab-plans",
        fallbackTarget: "pricing-workbench",
        showBillingManual: true,
      },
      {
        id: "pricing-bindings",
        setupStep: "pricing",
        chapter: "设定计费",
        title: "检查方案绑给了谁",
        concept:
          "像「月宫」这样全场通玩的店，只需确认「默认资源组」绑好方案；个别设备（如 ¥0 提前开空调、独立计费桌游）直接在「资源专属方案 / 桌游」单点覆盖，无需新建组。",
        action: "点金框高亮的「资源计费」核对绑定，改完点顶部「保存全部修改」。",
        diagram: "store-example-override",
        route: "pricing",
        target: "pricing-tab-bindings",
        fallbackTarget: "pricing-workbench",
      },
    );
  }

  if (status.mode === "desk") {
    steps.push(
      {
        id: "cashier-reader",
        setupStep: "reader",
        chapter: "前台准备",
        title: "连接 HINATA 读卡器",
        concept: "桌面 Chrome / Edge 授权一次后自动重连，刷卡即可入场与结账。",
        action: "点金框高亮的「连接读卡器」完成授权；暂未插设备可直接下一步。",
        diagram: "cashier-flow",
        route: "dashboard",
        target: "cashier-connect-btn",
        fallbackTarget: "cashier-panel",
      },
      {
        id: "staff-invite",
        setupStep: "staff",
        chapter: "前台准备",
        title: "邀请店员并开通「管理」权限",
        concept: "店员计费权限设为「管理」才能在前台收款。",
        action: "输入店员 MuNET 账号添加，再把右侧计费权限改为「管理」。",
        diagram: "cashier-flow",
        route: "settings?group=members",
        target: "members-invite-form",
        fallbackTarget: "members-panel",
      },
    );
  }

  if (status.identityMatters) {
    steps.push({
      id: "identity-policy",
      setupStep: "identity",
      chapter: "玩家身份",
      title: "确认玩家进店验证方式",
      concept: "推荐要求绑 Bot：首次发码给 Bot 自动同步群昵称，还可限群成员进店。",
      action: "确认进店策略并填好下方「绑定提示」（写明群号与命令）。",
      diagram: "identity-bot",
      route: "settings?group=players",
      target: "settings-identity-picker",
      fallbackTarget: "settings-binding-prompt",
    });

    if (status.identity !== "web" && !status.botConnected) {
      steps.push({
        id: "identity-bot-add",
        setupStep: "identity",
        chapter: "连接 Bot",
        title: "添加「店铺 Bot」签发凭据",
        concept: "开启绑定后需接入 Koishi Bot，只需复制地址与凭据两行配置。",
        action: "点「添加资源」→「添加能力」选「店铺 Bot」并签发凭据。",
        diagram: "identity-bot",
        route: "resources",
        target: "resources-add-btn",
        fallbackTarget: "resources-default-group",
        modalHint: {
          title: "快速接入店铺 Bot",
          body: "取名后点左侧「添加能力 → 店铺 Bot」，签发凭据填进 Koishi 插件即可。",
        },
      });
    }
  }

  if (status.mode === "self") {
    steps.push(
      {
        id: "prepaid-gift",
        setupStep: "prepaid",
        chapter: "玩家储值",
        title: "第 1 步：建充值礼物包",
        concept: "礼物决定每张兑换码发放多少本金、赠金或优惠券。",
        action: "点金框高亮的「新建礼物」（如充 50 送 2）；已有可直接下一步。",
        diagram: "money-flow",
        route: "assets?tab=gifts",
        target: "assets-create-btn",
        fallbackTarget: "assets-nav",
        modalHint: {
          title: "配置充值礼物",
          body: "添加发放项「充值余额」（可再加「赠送余额」），保存即可用来出码。",
        },
      },
      {
        id: "prepaid-code",
        setupStep: "prepaid",
        chapter: "玩家储值",
        title: "第 2 步：批量生成兑换码",
        concept: "导出 CSV / TXT 即可上架发卡平台或群内售卖，兑换即时到账。",
        action: "点「新建兑换码」批量出码；日常也可在「玩家」页手动加款。",
        diagram: "money-flow",
        route: "assets?tab=codes",
        target: "assets-create-btn",
        fallbackTarget: "assets-nav",
        modalHint: {
          title: "生成并导出兑换码",
          body: "选好刚才的礼物和数量，生成后点列表上方「导出兑换码」即可。",
        },
      },
    );
  }

  if (status.doorDevices > 0) {
    steps.push({
      id: "door-ttlock",
      setupStep: "door",
      chapter: "门锁对接",
      title: "连接 TTLock 门锁账号",
      concept: "玩家点开门时由 TTLock 账号实时下发一次性密码。",
      action: "在展开的面板填写 TTLock Client ID / Secret 与账号后保存。",
      diagram: "ttlock-door",
      route: "settings?group=devices",
      target: "settings-ttlock",
      fallbackTarget: "settings-devices-panel",
      expandDetails: true,
    });
  }

  steps.push(
    {
      id: "qr-trial",
      setupStep: "trial",
      chapter: "试跑验证",
      title: "扫一次二维码 / NFC 走通闭环",
      concept: "二维码与 NFC 共用同一链接，iPhone 碰一下直开灵动岛实时看账单。",
      action: "点卡片右下角「二维码」打印或测试扫码入口，用自己手机试跑一次。",
      diagram: "qr-nfc-entry",
      route: "resources",
      target: "resource-qr-btn",
      fallbackTarget: "resources-default-group",
      modalHint: {
        title: "试扫与写 NFC",
        body: "点「测试扫码入口」即可模拟进店；复制链接写进 NFC 标签（NDEF URI）即可一碰即开。",
      },
    },
    {
      id: "dashboard-overview",
      chapter: "日常营业",
      title: "日常看店看「仪表板」就够了",
      concept: "实时人数、营收曲线、设备远程开关与批量结账都在同一屏。",
      action: "引导完成！点「完成引导」回到指引页即可正式营业。",
      diagram: "daily-dashboard",
      route: "dashboard",
      target: "dashboard-kpi-strip",
      fallbackTarget: "dashboard-devices",
    },
  );

  return steps;
}

/**
 * Pick the starting tour step from an explicit step id, a checklist step id,
 * or the first incomplete checklist item.
 */
export function findTourStepIndex(
  steps: readonly TourStep[],
  options: {
    stepId?: TourStepId;
    setupStep?: SetupStepId;
    status?: SetupStatus;
    fromIncomplete?: boolean;
  } = {},
): number {
  if (!steps.length) return 0;
  if (options.stepId) {
    const idx = steps.findIndex((step) => step.id === options.stepId);
    if (idx >= 0) return idx;
  }
  if (options.setupStep) {
    const idx = steps.findIndex((step) => step.setupStep === options.setupStep);
    if (idx >= 0) return idx;
  }
  if (options.fromIncomplete && options.status) {
    const pending = options.status.steps.find((item) => !item.done)?.id;
    if (pending) {
      const idx = steps.findIndex((step) => step.setupStep === pending);
      if (idx >= 0) return idx;
    }
  }
  return 0;
}

/**
 * Split a relative merchant route such as `assets?tab=gifts` into router
 * comparison parts and the full navigation target.
 */
export function tourRouteParts(shopCode: string, route: string): {
  pathname: string;
  search: string;
  full: string;
} {
  const base = `/merchant/${encodeURIComponent(shopCode)}`;
  const q = route.indexOf("?");
  const relPath = q >= 0 ? route.slice(0, q) : route;
  const search = q >= 0 ? route.slice(q) : "";
  const pathname = relPath ? `${base}/${relPath}` : base;
  return { pathname, search, full: `${pathname}${search}` };
}

/**
 * Whether the checklist step associated with this tour step is already done.
 */
export function isStepDone(step: TourStep, status: SetupStatus): boolean {
  if (!step.setupStep) return false;
  return status.steps.some((item) => item.id === step.setupStep && item.done);
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import {
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  Coins,
  Compass,
  CreditCard,
  Database,
  Gift,
  Layers,
  MapPin,
  MessageCircle,
  Play,
  Receipt,
  RotateCcw,
  Ticket,
  Timer,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Api, api } from "../../api";
import { browserHid } from "../../card-reader";
import { useI18n } from "../../i18n";
import { shopApi, type Settings } from "../BillingPages";
import { BindingPrompt } from "../SessionContent";
import { BillingExplainer } from "./BillingExplainer";
import { GuideDiagram } from "./GuideDiagrams";
import { IdentityPolicyPicker } from "./IdentityPolicyPicker";
import { idlePath } from "./IdlePowerSettings";
import { Modal, button, buttonQuiet, primary, useCopy, useMerchant } from "./shared";
import {
  identityPolicySettings,
  setupStatus,
  shopBills,
  type IdentityPolicy,
  type OperatingMode,
  type SetupStatus,
  type SetupStepId,
} from "./setup-guide";
import { useSetupTour } from "./tour-context";

const trialKey = (shopCode: string) => `prism.setup.trial.${shopCode}`;
const SUPPORT_QQ_GROUP = "1135111765";
const statusCache = new Map<string, SetupStatus>();

function readTrial(shopCode: string) {
  try {
    return window.localStorage.getItem(trialKey(shopCode)) === "1";
  } catch {
    return false;
  }
}

/** Whether this browser has already been allowed to use a HINATA reader. */
async function readerAuthorized(): Promise<boolean | null> {
  const hid = browserHid();
  if (!hid) return null;
  try {
    return (await hid.getDevices()).some((device) => device.vendorId === 0xf822);
  } catch {
    return null;
  }
}

async function loadStatus(shopCode: string, shopId: string) {
  const optional = <T,>(request: Promise<T>) => request.catch(() => null);
  const [settings, machines, groups] = await Promise.all([
    api<Settings>(shopApi(shopCode, "settings")),
    Api.machines(shopId).then((r) => r.machines),
    Api.resourceGroups(shopId).then((r) => r.resourceGroups).catch(() => null),
  ]);
  const billing = shopBills(groups ?? [], machines);
  const [staffSettings, players, members, presents, codes, reader] =
    await Promise.all([
      optional(
        api<{
          settings: {
            ttLockConnection?: Record<string, string | undefined> | null;
            registration?: { defaultPresentId: string | null };
          };
        }>(shopApi(shopCode, "staff/settings")),
      ),
      billing
        ? optional(api<{ players: { walletTotal: number }[] }>(shopApi(shopCode, "staff/players")))
        : null,
      optional(Api.shopMembers(shopId)),
      optional(api<{ presents: { status: string }[] }>(shopApi(shopCode, "staff/presents"))),
      billing
        ? optional(
            api<{
              redeemCodes: { usageCount: number; maxUseCount: number; expiresAt: string | null }[];
            }>(shopApi(shopCode, "staff/redeem-codes")),
          )
        : null,
      settings.cashierEnabled ? readerAuthorized() : Promise.resolve(null),
    ]);
  const now = Date.now();
  return setupStatus({
    settings,
    billing,
    machines,
    ...(groups ? { groups } : {}),
    ttLock: staffSettings?.settings.ttLockConnection ?? null,
    players: players?.players ?? null,
    redeemCodes:
      codes?.redeemCodes.filter(
        (code) =>
          code.usageCount < code.maxUseCount &&
          (!code.expiresAt || Date.parse(code.expiresAt) > now),
      ).length ?? 0,
    reader,
    defaultPresent: !!staffSettings?.settings.registration?.defaultPresentId,
    members: members?.members.length ?? 0,
    presents: presents?.presents.filter((p) => p.status !== "archived").length ?? 0,
    trialConfirmed: readTrial(shopCode),
  });
}

/**
 * Setup progress for the owner. The workspace reads it to decide whether the
 * guide tab is shown and where a bare `/merchant/:shop` lands, so it loads
 * before the tabs render; the guide page reloads it whenever it mounts.
 */
export function useSetupStatus(
  shopCode: string,
  shopId: string,
  enabled: boolean,
) {
  const [status, setStatus] = useState<SetupStatus | null>(
    () => statusCache.get(shopCode) ?? null,
  );
  const [loaded, setLoaded] = useState(() => statusCache.has(shopCode));
  const current = useRef(0);
  const reload = useCallback(async () => {
    if (!enabled) return;
    const request = ++current.current;
    try {
      const next = await loadStatus(shopCode, shopId);
      statusCache.set(shopCode, next);
      if (request === current.current) setStatus(next);
    } catch {
      // The guide is advisory; a failed read must not block the workspace.
    } finally {
      if (request === current.current) setLoaded(true);
    }
  }, [enabled, shopCode, shopId]);
  useEffect(() => {
    if (!enabled) return;
    void reload();
    const refresh = () => void reload();
    window.addEventListener("prism-shop-settings", refresh);
    return () => window.removeEventListener("prism-shop-settings", refresh);
  }, [enabled, reload]);
  useEffect(() => {
    if (!enabled || !status?.botIssued || status.botConnected) return;
    const timer = setInterval(() => void reload(), 15_000);
    return () => clearInterval(timer);
  }, [enabled, status?.botIssued, status?.botConnected, reload]);
  return { status, loaded: !enabled || loaded, reload };
}

export const SetupContext = createContext<{
  status: SetupStatus | null;
  reload: () => Promise<void>;
}>({ status: null, reload: async () => {} });

const modeNames: Record<OperatingMode, [string, string]> = {
  self: ["自助计费（无前台）", "玩家扫码入场计时，离店用预存余额自助结账。"],
  desk: ["前台收银", "玩家在前台刷卡入场并现场付款；带手机的玩家也可自助。"],
  devices: ["不使用计费", "只运行 PRiSM 设备功能，收费在其它经营平台完成。"],
};

export function ShopGuide() {
  const { t } = useI18n();
  const { shopCode, shopId } = useMerchant();
  const { status, reload } = useContext(SetupContext);
  const tour = useSetupTour();
  const [explaining, setExplaining] = useState(false);
  const [idlePowerEnabled, setIdlePowerEnabled] = useState(false);
  const [haReadIssues, setHaReadIssues] = useState(0);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!shopId) return;
    let active = true;
    Promise.all([
      api<{ settings?: { shopEmpty?: { enabled?: boolean }; device?: { enabled?: boolean } } }>(
        idlePath(shopId),
      ).catch(() => null),
      api<{ connections?: { readAccess?: string | null }[] }>(
        `/api/v1/merchant/ha-connections?shopId=${encodeURIComponent(shopId)}`,
      ).catch(() => null),
    ]).then(([idle, ha]) => {
      if (!active) return;
      setIdlePowerEnabled(!!(idle?.settings?.shopEmpty?.enabled || idle?.settings?.device?.enabled));
      setHaReadIssues(
        (ha?.connections ?? []).filter(
          (c) => c.readAccess === "needs_admin" || c.readAccess === "failed",
        ).length,
      );
    });
    return () => {
      active = false;
    };
  }, [shopId]);

  if (!status)
    return (
      <p role="status" className="py-10 text-center text-sm text-ink/60">
        {t("加载中...")}
      </p>
    );

  const total = status.steps.length;
  const done = status.steps.filter((step) => step.done).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  const next = status.steps.find((step) => !step.done)?.id;
  const base = `/merchant/${encodeURIComponent(shopCode)}`;
  const [modeTitle, modeDescription] = modeNames[status.mode];

  return (
    <div className="grid gap-5">
      {/* Hero launchpad: progress, operating mode, and game-style tour entry */}
      <section className="grid gap-4 rounded-2xl border border-mint/30 bg-panel p-5 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold">{t("开店指引")}</h2>
              <span className="rounded-full bg-mint/15 px-2.5 py-0.5 text-xs font-semibold text-mint">
                {t(modeTitle)}
              </span>
              <Link
                className="text-xs text-ink/55 underline hover:text-ink"
                to={`${base}/settings?group=billing`}
              >
                {t("更改方式")}
              </Link>
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-ink/65">
              {t(modeDescription)}{" "}
              {t("可启动互动引导逐步跳转对应页面，或直接在下方逐项配置。")}
            </p>
          </div>
          <div className="text-right text-sm tabular-nums">
            <span className="font-semibold text-ink">
              {status.complete
                ? t("基础接入已完成")
                : t("已完成 {done} / {total}", { done, total })}
            </span>
          </div>
        </div>

        <div className="h-2 w-full overflow-hidden rounded-full bg-ink/10" aria-hidden="true">
          <div
            className="h-full rounded-full bg-mint transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            className={`${button} tour-btn`}
            onClick={() => tour.start({ fromIncomplete: !status.complete })}
          >
            <Play size={16} aria-hidden="true" />
            {t(
              status.complete
                ? "重新体验引导"
                : done > 0
                  ? "继续新手引导"
                  : "开始新手引导",
            )}
          </button>
          {done > 0 && !status.complete && (
            <button
              type="button"
              className={button}
              onClick={() => tour.start()}
            >
              <RotateCcw size={15} aria-hidden="true" />
              {t("从头引导")}
            </button>
          )}
          {status.billing && (
            <button type="button" className={button} onClick={() => setExplaining(true)}>
              <BookOpen size={15} aria-hidden="true" />
              {t("计费图解说明书")}
            </button>
          )}
        </div>
      </section>

      {/* Actionable setup checklist right below hero */}
      <section className="grid gap-3" aria-labelledby="setup-steps">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="setup-steps" className="font-semibold">
            {t("接入步骤")}
          </h3>
          <span className="text-xs text-ink/55">
            {t("可点「带我操作」自动跳页并高亮按钮，也可直接前往页面。")}
          </span>
        </div>
        <ol className="grid gap-2.5">
          {status.steps.map((step, index) => (
            <StepCard
              key={step.id}
              index={index + 1}
              id={step.id}
              done={step.done}
              next={step.id === next}
              status={status}
              haReadIssues={haReadIssues}
              shopCode={shopCode}
              reload={reload}
              onGuide={() => tour.start({ setupStep: step.id })}
            />
          ))}
        </ol>
      </section>

      {/* Visual concept gallery replacing wall-of-text sections */}
      <ConceptGallery
        mode={status.mode}
        billing={status.billing}
        onOpenBillingManual={() => setExplaining(true)}
      />

      {/* Collapsible optional configurations */}
      <Optional
        status={status}
        idlePowerEnabled={idlePowerEnabled}
        shopCode={shopCode}
      />

      <PlatformSupport />

      {explaining && (
        <Modal title="计费说明书" close={() => setExplaining(false)} xl>
          <BillingExplainer />
        </Modal>
      )}
    </div>
  );
}

type GalleryTab = "structure" | "player" | "money" | "daily";
type StoreExampleKey = "yuegong" | "override" | "zone";

function ConceptGallery({
  mode,
  billing,
  onOpenBillingManual,
}: {
  mode: OperatingMode;
  billing: boolean;
  onOpenBillingManual: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<GalleryTab>("structure");
  const [example, setExample] = useState<StoreExampleKey>("yuegong");
  const effectiveTab: GalleryTab = tab === "money" && !billing ? "structure" : tab;

  const storeExamples: [
    StoreExampleKey,
    string,
    "store-hierarchy" | "store-example-override" | "store-example-zone",
    string,
  ][] = [
    [
      "yuegong",
      "例 1：「月宫」实配（仅默认组）",
      "store-hierarchy",
      "真实音游店「月宫」没有新建任何资源组：舞萌DX、中二节奏-左/右、音击与门锁全留在「默认资源组」绑一套基础计划（¥4/30分 · 封顶¥40），扫门锁或任一机台入场后全店通用（若空调只供已入场玩家调，同样放默认组即可，不会多收钱）。",
    ],
    [
      "override",
      "例 2：单台例外（仍不用建组）",
      "store-example-override",
      "假如希望玩家未入场前也能免费开空调，或添 1 张不收音游门票的独立桌游桌：依然不用新建资源组——留在默认组里，直接给空调绑一条 ¥0 专属方案（桌游设 ¥0 等位专属方案 + 对局方案）即可单台覆盖。",
    ],
    [
      "zone",
      "例 3：多台分区（才需建新组）",
      "store-example-zone",
      "只有新辟出一整片包含多台设备的区域（如二楼 VIP 包间多台框体 + 门锁 + 空调统一按 ¥6/30分 计费，或公共休息区多件免入场设施），为了成批绑定方案、一键整组改价或暂停开放，才需要新建第 2 个资源组。",
    ],
  ];
  const activeExample =
    storeExamples.find(([key]) => key === example) ?? storeExamples[0]!;

  const tabs: [GalleryTab, string][] = [
    ["structure", "店铺与设备结构"],
    ["player", "玩家怎么用"],
    ...(billing ? [["money", "钱从哪来、怎么扣"] as [GalleryTab, string]] : []),
    ["daily", "日常后台怎么管"],
  ];

  const dailyChips: [string, string][] =
    mode === "devices"
      ? [
          ["资源", "控设备 · 管 Bot · 二维码"],
          ["设置", "位置校验 · 门锁 · 备份"],
        ]
      : [
          ["仪表板", "看在店 · 控设备 · 收银结账"],
          ["玩家", "查余额 · 手动充值 · 绑身份"],
          ["资源", "改设备 · 设资源组 · 二维码"],
          ["计费", "改价 · 定时计划 · 模拟器"],
          ...(mode === "self" ? [["资产", "建礼物 · 导出兑换码"] as [string, string]] : []),
          ["历史", "营收趋势 · 导出 Excel"],
        ];

  return (
    <section
      className="grid gap-4 rounded-xl border border-ink/10 bg-panel p-5"
      aria-labelledby="visual-gallery"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="visual-gallery" className="font-semibold">
            {t("系统结构与流程示意")}
          </h3>
          <p className="mt-0.5 text-xs text-ink/55">
            {t("切换右侧分类，对照查看店铺结构、玩家流程、扣款顺序与日常管理。")}
          </p>
        </div>
        <div
          className="flex flex-wrap gap-1 rounded-xl bg-ink/[0.04] p-1"
          role="tablist"
          aria-label={t("系统图解")}
        >
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={effectiveTab === key}
              className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                effectiveTab === key
                  ? "bg-panel text-ink shadow-sm"
                  : "text-ink/60 hover:text-ink"
              }`}
              onClick={() => setTab(key)}
            >
              {t(label)}
            </button>
          ))}
        </div>
      </div>

      {effectiveTab === "structure" &&
        (billing ? (
          <div className="grid gap-4">
            <div className="grid gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-ink/75">
                  {t("1. 计费组怎么用？以音游店「月宫」为例一步步看")}
                </p>
                <div
                  className="flex flex-wrap gap-1 rounded-lg bg-ink/[0.04] p-1"
                  role="tablist"
                  aria-label={t("开店分组示例")}
                >
                  {storeExamples.map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={activeExample[0] === key}
                      className={`focus-ring rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                        activeExample[0] === key
                          ? "bg-mint/15 text-mint"
                          : "text-ink/60 hover:text-ink"
                      }`}
                      onClick={() => setExample(key)}
                    >
                      {t(label)}
                    </button>
                  ))}
                </div>
              </div>
              <GuideDiagram id={activeExample[2]} mode={mode} />
              <p className="text-xs leading-relaxed text-ink/60">
                {t(activeExample[3])}
              </p>
            </div>
            <div className="grid gap-2">
              <p className="text-xs font-medium text-ink/75">
                {t("2. 每个资源按需插上 10 种硬件 / Bot 能力")}
              </p>
              <GuideDiagram id="resource-abilities" mode={mode} wide />
            </div>
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="grid gap-2">
              <p className="text-xs font-medium text-ink/70">
                {t("1. 默认资源组统一管理设备（Bot 独立无二维码）")}
              </p>
              <GuideDiagram id="store-hierarchy" mode={mode} />
            </div>
            <div className="grid gap-2">
              <p className="text-xs font-medium text-ink/70">
                {t("2. 单个资源按需叠加 10 种硬件/Bot 能力")}
              </p>
              <GuideDiagram id="resource-abilities" mode={mode} />
            </div>
          </div>
        ))}

      {effectiveTab === "player" && (
        <div className="grid gap-2">
          <GuideDiagram
            id={mode === "desk" ? "cashier-flow" : "qr-nfc-entry"}
            mode={mode}
          />
          <p className="text-xs leading-relaxed text-ink/60">
            {t(
              mode === "desk"
                ? "前台刷卡按「前台资源」方案计时，离店收款后停表；手机扫码也可走预存余额自助结账。"
                : mode === "self"
                  ? "资源二维码和 NFC 共用同一链接，iPhone 支持免安装灵动岛实时看账单；换桌或换区会自动说明计费变化。"
                  : "扫码或碰 NFC 即可操控设备、开关机、调空调、直连读卡器加卡或上桌游桌，不产生计费。",
            )}
          </p>
        </div>
      )}

      {effectiveTab === "money" && billing && (
        <div className="grid gap-3">
          <GuideDiagram id="money-flow" mode={mode} />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink/60">
            <span>
              {t("想看按单位计费、宽限时长与封顶的阶梯图？")}
            </span>
            <button
              type="button"
              className={`${buttonQuiet} px-2.5 py-1 text-xs font-medium text-mint`}
              onClick={onOpenBillingManual}
            >
              <BookOpen size={14} aria-hidden="true" />
              {t("打开计费说明书")}
            </button>
          </div>
        </div>
      )}

      {effectiveTab === "daily" && (
        <div className="grid gap-3">
          <GuideDiagram id="daily-dashboard" mode={mode} />
          <div className="flex flex-wrap gap-2">
            {dailyChips.map(([tabName, purpose]) => (
              <span
                key={tabName}
                className="inline-flex items-center gap-1.5 rounded-lg bg-ink/[0.04] px-2.5 py-1.5 text-xs"
              >
                <strong className="font-semibold text-ink">{t(tabName)}</strong>
                <span className="text-ink/60">{t(purpose)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function StepCard({
  index,
  id,
  done,
  next,
  status,
  haReadIssues,
  shopCode,
  reload,
  onGuide,
}: {
  index: number;
  id: SetupStepId;
  done: boolean;
  next: boolean;
  status: SetupStatus;
  haReadIssues: number;
  shopCode: string;
  reload: () => Promise<void>;
  onGuide: () => void;
}) {
  const { t } = useI18n();
  const base = `/merchant/${encodeURIComponent(shopCode)}`;
  const go = (to: string, text: string, quiet = true) => (
    <Link className={quiet ? `${buttonQuiet} min-h-9 px-3 py-1.5 text-xs` : button} to={to}>
      {t(text)}
    </Link>
  );
  const deviceWarns = [
    status.ioE2ee > 0
      ? t("{count} 台直连 HINATA IO 仍在发送加密消息，请清空机台 INI 里的 remotePassword 后重启", {
          count: status.ioE2ee,
        })
      : "",
    status.ioMissingToken > 0
      ? t("{count} 台直连 HINATA IO 还没有签发设备令牌", { count: status.ioMissingToken })
      : "",
    status.coinIncomplete > 0
      ? t("{count} 个资源的「投币」能力还没有选择投币按键", { count: status.coinIncomplete })
      : "",
    haReadIssues > 0
      ? t("{count} 条 Home Assistant 连接还没有启用只读账号，实时状态暂不可用", { count: haReadIssues })
      : "",
  ].filter(Boolean);

  const content: {
    title: string;
    why: string;
    fact?: string;
    warn?: string;
    warns?: string[];
    hint?: string;
    actions?: ReactNode;
    body?: ReactNode;
  } =
    id === "pricing"
      ? {
          title: "设定收费标准",
          why: "通常只需给「默认资源组」绑好入场方案即可全店通用（前台模式需确保「前台资源」有方案）；单台特价或桌游对局可单独指定。",
          warn:
            status.pricingProblem === "assets"
              ? "缺少可用的余额资产，玩家无法结账。"
              : status.deskProblem === "missing"
                ? "已开启前台收银，但还没有选择有效的前台资源。"
                : status.deskProblem === "unbilled"
                  ? "当前选定的前台资源没有计费方案，前台刷卡入场会失败。"
                  : undefined,
          actions: (
            <>
              {status.pricingProblem === "assets" && go(`${base}/assets`, "恢复余额资产", false)}
              {status.deskProblem === "missing" && go(`${base}/settings?group=billing`, "选择前台资源", false)}
              {status.deskProblem === "unbilled" && go(`${base}/resources`, "设置资源组方案", false)}
              {go(`${base}/pricing`, "前往计费页")}
            </>
          ),
        }
      : id === "reader"
        ? {
            title: "准备前台读卡器",
            why: "用桌面版 Chrome 或 Edge 打开「仪表板」，授权一次 HINATA 读卡器后自动重连。",
            fact:
              status.reader === null
                ? "当前浏览器不支持读卡器，请换桌面版 Chrome 或 Edge。"
                : status.reader
                  ? "已授权读卡器。"
                  : "还没有授权读卡器。",
            actions: go(`${base}/dashboard`, "前往仪表板"),
          }
        : id === "staff"
          ? {
              title: "给前台店员开账号",
              why: "邀请店员的 MuNET 账号并将计费权限设为「管理」即可收款（绑平台身份后自动成为 Bot 管理员）。",
              fact: t("成员：{count}", { count: status.members }),
              actions: go(`${base}/settings?group=members`, "前往成员设置"),
            }
          : id === "identity"
            ? {
                title: "确认玩家身份与 Bot",
                why:
                  status.mode === "devices"
                    ? "决定玩家开门或上桌游桌前是否需要通过 Bot 绑定群身份。"
                    : status.mode === "desk"
                      ? "前台刷卡不用绑；手机自助玩家建议通过 Bot 绑定并同步群昵称。"
                      : "推荐要求绑定平台身份，入场前用 Bot 核验群成员并同步昵称。",
                warn: done
                  ? undefined
                  : status.botIssued
                    ? "已创建 Bot 凭据，但还没有 Bot 连上来；玩家扫码会卡在绑定步骤。"
                    : "已开启绑定但还没接入店铺 Bot；玩家扫码会卡在绑定步骤。",
                body: (
                  <IdentityStep
                    value={status.identity}
                    prompt={status.bindingPrompt}
                    shopCode={shopCode}
                    reload={reload}
                  />
                ),
              }
            : id === "prepaid"
              ? {
                  title: "准备玩家储值",
                  why: "先建充值礼物并批量生成兑换码售卖，或在「玩家」页手动充值。",
                  fact:
                    status.redeemCodes || status.fundedPlayers
                      ? [
                          status.redeemCodes ? t("可用兑换码：{count}", { count: status.redeemCodes }) : "",
                          status.fundedPlayers ? t("有余额的玩家：{count}", { count: status.fundedPlayers }) : "",
                        ].filter(Boolean).join(" · ")
                      : undefined,
                  actions: (
                    <>
                      {go(`${base}/assets?tab=gifts`, "建礼物")}
                      {go(`${base}/assets?tab=codes`, "生成兑换码")}
                      {go(`${base}/players`, "玩家页")}
                    </>
                  ),
                }
              : id === "devices"
                ? {
                    title: "添加资源并配置能力",
                    why: "为机台、门锁、桌游桌或纯入场二维码创建资源，并按需叠加电源/空调/IO/按键/投币等能力。",
                    fact: !status.devices
                      ? "还没有资源"
                      : status.unconfigured
                        ? t("{count} 个资源既没有配置能力也没有计费方案", { count: status.unconfigured })
                        : t("已有 {count} 个资源", { count: status.devices }),
                    warns: deviceWarns,
                    hint:
                      status.ioExternal > 0
                        ? t("有 {count} 台刷卡机台仍在使用外部中继，可在「资源」页改为直连本平台，免维护中继服务。", {
                            count: status.ioExternal,
                          })
                        : undefined,
                    actions: go(
                      status.devices ? `${base}/resources` : `${base}/resources?add=1`,
                      status.devices ? "前往资源页" : "添加资源",
                    ),
                  }
                : id === "door"
                  ? {
                      title: "连接 TTLock 账号",
                      why: "配置 TTLock 开放平台应用凭据，以便生成一次性开门密码。",
                      fact: t("{count} 个资源启用了开门密码", { count: status.doorDevices }),
                      actions: go(`${base}/settings?group=devices`, "前往门锁设置"),
                    }
                  : {
                      title: "贴好二维码或 NFC，自己试一次",
                      why:
                        status.mode === "desk"
                          ? "在前台刷卡入场并收款，再用手机试扫一次资源二维码。"
                          : "打印资源二维码或写入 NFC，自己手机走一遍入场与操作流程。",
                      fact:
                        status.billing && status.players
                          ? t("已有 {count} 位玩家", { count: status.players })
                          : undefined,
                      actions: (
                        <>
                          {go(`${base}/resources`, "打开资源二维码")}
                          <TrialToggle shopCode={shopCode} reload={reload} />
                        </>
                      ),
                    };

  return (
    <li
      data-step={id}
      className={`rounded-xl border bg-panel p-4 transition-colors ${next ? "border-mint/60 ring-1 ring-mint/15" : "border-ink/10"}`}
    >
      <div className="flex items-start gap-3.5">
        <span
          aria-hidden="true"
          className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${done ? "bg-mint/15 text-mint" : next ? "bg-primary text-primary-foreground" : "bg-ink/5 text-ink/60"}`}
        >
          {done ? <CheckCircle2 size={16} /> : index}
        </span>
        <div className="grid min-w-0 flex-1 gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm font-semibold">
              {t(content.title)}
              <span className={`text-xs font-normal ${done ? "text-mint" : next ? "text-mint font-medium" : "text-ink/50"}`}>
                {t(done ? "已完成" : next ? "当前推荐" : "待完成")}
              </span>
            </h4>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={onGuide}
                className={
                  next
                    ? `${button} tour-btn !min-h-8 !rounded-lg !px-3 !py-1 !text-xs`
                    : `${button} !min-h-8 !rounded-lg !border-tour/35 !px-2.5 !py-1 !text-xs text-tour hover:bg-tour/10`
                }
              >
                <Compass size={13} aria-hidden="true" />
                {t("带我操作")}
              </button>
              {content.actions}
            </div>
          </div>
          <p className="text-xs leading-relaxed text-ink/65">{t(content.why)}</p>
          {content.fact && <p className="text-xs font-medium text-ink/80">{t(content.fact)}</p>}
          {content.warn && <p className="text-xs text-coral">{t(content.warn)}</p>}
          {content.warns?.map((warning) => (
            <p key={warning} className="text-xs text-coral">{warning}</p>
          ))}
          {content.hint && <p className="text-xs leading-relaxed text-ink/55">{content.hint}</p>}
          {content.body && <div className="pt-1">{content.body}</div>}
        </div>
      </div>
    </li>
  );
}

function IdentityStep({
  value,
  prompt,
  shopCode,
  reload,
}: {
  value: IdentityPolicy;
  prompt: string;
  shopCode: string;
  reload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [policy, setPolicy] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => setPolicy(value), [value]);
  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const current = await api<Settings>(shopApi(shopCode, "settings"));
      await api(shopApi(shopCode, "settings"), {
        method: "PUT",
        body: JSON.stringify({ ...current, locationEnabled: undefined, ...identityPolicySettings(policy) }),
      });
      setSaved(true);
      window.dispatchEvent(new Event("prism-shop-settings"));
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("保存失败"));
    } finally {
      setBusy(false);
    }
  }
  const base = `/merchant/${encodeURIComponent(shopCode)}`;
  return (
    <div className="grid gap-3">
      <IdentityPolicyPicker value={policy} change={(next) => { setPolicy(next); setSaved(false); }} />
      {policy !== "web" && (
        <div className="grid gap-2 rounded-lg bg-ink/[0.03] p-3 text-sm">
          <span className="text-xs text-ink/50">{t("玩家绑定时看到的提示")}</span>
          <div className="binding-code !p-3 text-ink">
            <BindingPrompt template={prompt} code="AB23CD45" />
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-coral">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {policy !== value && (
          <button type="button" className={primary} disabled={busy} onClick={save}>
            {t(busy ? "处理中…" : "保存")}
          </button>
        )}
        {policy !== "web" && (
          <>
            <Link className={button} to={`${base}/resources`}>
              {t("添加 Bot")}
            </Link>
            <Link className={button} to={`${base}/settings?group=players`}>
              {t("绑定提示")}
            </Link>
          </>
        )}
        {saved && <span role="status" className="text-sm text-mint">{t("已保存")}</span>}
      </div>
      {policy !== "web" && (
        <p className="text-xs leading-relaxed text-ink/55">
          {t("在「资源」页添加带「店铺 Bot」能力的资源并签发凭据；Koishi 插件只需填 API 地址和接入凭据两项，其余权限、播报组和回复模板都在后台设置并实时推送。")}
        </p>
      )}
    </div>
  );
}

function TrialToggle({
  shopCode,
  reload,
}: {
  shopCode: string;
  reload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [checked, setChecked] = useState(() => readTrial(shopCode));
  return (
    <label className="flex min-h-9 items-center gap-2 px-2 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          try {
            if (event.target.checked) window.localStorage.setItem(trialKey(shopCode), "1");
            else window.localStorage.removeItem(trialKey(shopCode));
          } catch {
            // Without storage the box still reflects this visit.
          }
          setChecked(event.target.checked);
          void reload();
        }}
      />
      {t("我已试过")}
    </label>
  );
}

function Optional({
  status,
  idlePowerEnabled,
  shopCode,
}: {
  status: SetupStatus;
  idlePowerEnabled: boolean;
  shopCode: string;
}) {
  const { t } = useI18n();
  const base = `/merchant/${encodeURIComponent(shopCode)}`;
  const items: {
    icon: LucideIcon;
    title: string;
    description: string;
    state?: string;
    to: string;
  }[] = [
    {
      icon: Bot,
      title: "Bot 播报组与命令回复",
      description: "按听众分组订阅事件提醒，自定义命令文案、入场自动发密码。",
      state: status.botConnected
        ? status.botAnnounceGroups > 0
          ? t("已连接 · {count} 个播报组", { count: status.botAnnounceGroups })
          : "已连接"
        : status.botIssued
          ? "已创建凭据，未连接"
          : undefined,
      to: `${base}/resources`,
    },
    {
      icon: Timer,
      title: "闲置自动关机",
      description: "按店内无人或单台闲置自动关闭机台与空调，支持提前提醒。",
      state: idlePowerEnabled ? "已开启" : undefined,
      to: `${base}/settings?group=devices`,
    },
    {
      icon: Coins,
      title: "投币上限、自动投币与后台按键",
      description: "全店投币冷却、单台投币上限、刷卡自动投币与店员专用按键。",
      to: `${base}/settings?group=devices`,
    },
    ...(status.billing
      ? [
          {
            icon: Layers,
            title: "资源组与分区计费",
            description:
              "单台特殊设备直接改「专属/对局方案」即可；只有多台设备组成独立区域（如 VIP 包间、多设施休息区）需要成批换价或整区启停时，再新建资源组。",
            to: `${base}/resources`,
          },
        ]
      : []),
    ...(status.mode !== "desk"
      ? [
          {
            icon: Users,
            title: "邀请店员",
            description: "添加店员帮玩家充值与控设备，绑定后自动同步为 Bot 管理员。",
            state: status.members > 1 ? t("成员：{count}", { count: status.members }) : undefined,
            to: `${base}/settings?group=members`,
          },
        ]
      : []),
    ...(status.billing
      ? [
          {
            icon: Gift,
            title: "新玩家礼物",
            description: "新玩家首次建档自动发放体验券或赠送余额。",
            state: status.defaultPresent ? "已设置" : undefined,
            to: `${base}/settings?group=players`,
          },
          {
            icon: Ticket,
            title: "优惠与活动",
            description: "配置满减/折扣优惠券或通过活动礼物兑换码发放。",
            to: `${base}/assets?tab=effects`,
          },
        ]
      : []),
    ...(status.mode === "self"
      ? [
          {
            icon: CreditCard,
            title: "开启前台收银",
            description: "店里有前台时，可同时支持刷实体卡入场、现场收款。",
            to: `${base}/settings?group=billing`,
          },
        ]
      : status.mode === "devices"
        ? [
            {
              icon: Receipt,
              title: "改用 PRiSM 计费",
              description: "按时长向玩家收费，管理余额与离店结账。",
              to: `${base}/settings?group=billing`,
            },
          ]
        : []),
    {
      icon: MapPin,
      title: "到店位置校验",
      description: "配置入场、离场与资源操作的位置校验；在线蓝牙信标优先，无信标时自动回退 GPS 围栏。",
      state: status.locationEnabled ? "已开启" : undefined,
      to: `${base}/settings?group=location`,
    },
    {
      icon: Database,
      title: "数据备份与从 prism-neo 迁移",
      description: "导出恢复 JSON 备份，或导入 prism-neo 的玩家余额与规则。",
      to: `${base}/settings?group=data`,
    },
  ];
  return (
    <details className="group rounded-xl border border-ink/10 bg-panel p-5" aria-labelledby="setup-optional">
      <summary
        id="setup-optional"
        className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 [&::-webkit-details-marker]:hidden"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{t("按需进阶功能")}</span>
          <span className="text-xs text-ink/55">
            {t("闲置关机 · Bot 播报 · 位置校验 · 优惠礼物 · 备份迁移")}
          </span>
        </div>
        <span className="inline-flex items-center gap-1 text-xs text-ink/55">
          {t("展开全部 {count} 项", { count: items.length })}
          <ChevronDown size={15} className="transition-transform group-open:rotate-180" aria-hidden="true" />
        </span>
      </summary>
      <ul className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <li key={item.title}>
            <Link
              to={item.to}
              className="focus-ring flex h-full gap-3 rounded-xl border border-ink/10 bg-ink/[0.015] p-3.5 transition-colors hover:border-ink/25"
            >
              <item.icon className="mt-0.5 shrink-0 text-ink/50" size={17} aria-hidden="true" />
              <span className="grid min-w-0 content-start gap-1">
                <strong className="text-sm">{t(item.title)}</strong>
                <span className="text-xs leading-relaxed text-ink/60">{t(item.description)}</span>
                {item.state && <span className="text-xs text-mint">{t(item.state)}</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

function PlatformSupport() {
  const { t } = useI18n();
  const [copyState, copy] = useCopy();
  return (
    <section
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink/10 bg-panel px-4 py-3"
      aria-labelledby="platform-support"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <MessageCircle className="shrink-0 text-mint" size={16} aria-hidden="true" />
        <p id="platform-support" className="text-xs leading-relaxed text-ink/65">
          <strong className="font-medium text-ink">{t("PRiSM 接入支持与反馈")}</strong>
          {" · "}
          {t("遇到问题欢迎加入官方 QQ 群 {group} 咨询。", {
            group: SUPPORT_QQ_GROUP,
          })}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <code className="select-all rounded-lg bg-ink/[0.04] px-2.5 py-1 text-xs font-medium tabular-nums">
          {SUPPORT_QQ_GROUP}
        </code>
        <button
          type="button"
          className={`${button} !min-h-8 !rounded-lg !px-2.5 !py-1 !text-xs`}
          onClick={() => void copy(SUPPORT_QQ_GROUP)}
        >
          {copyState === "copied"
            ? t("已复制")
            : copyState === "failed"
              ? t("复制失败")
              : t("复制群号")}
        </button>
      </div>
    </section>
  );
}

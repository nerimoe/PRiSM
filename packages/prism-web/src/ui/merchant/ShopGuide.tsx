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
  ArrowRight,
  Bot,
  CheckCircle2,
  Coins,
  CreditCard,
  Database,
  Gamepad2,
  Gift,
  Layers,
  LogIn,
  MapPin,
  MessageCircle,
  Nfc,
  Power,
  Receipt,
  ShieldCheck,
  Ticket,
  Timer,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Api, api } from "../../api";
import { browserHid } from "../../card-reader";
import { useI18n } from "../../i18n";
import { shopApi, type Settings } from "../BillingPages";
import { BindingPrompt } from "../SessionContent";
import { BillingExplainer } from "./BillingExplainer";
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
  self: ["自助计费（无前台）", "玩家在手机上入场计时、离店自助结账，从预存余额扣款。"],
  desk: ["前台收银", "玩家在前台刷实体卡入场，离店时在前台现场付款；带手机的玩家也可以自助。"],
  devices: ["不使用计费", "还没有资源组或资源设置计费方案：PRiSM 只运行设备，收费在你自己的其它经营平台完成。"],
};

export function ShopGuide() {
  const { t } = useI18n();
  const { shopCode, shopId } = useMerchant();
  const { status, reload } = useContext(SetupContext);
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
  const done = status.steps.filter((step) => step.done).length;
  const next = status.steps.find((step) => !step.done)?.id;
  const base = `/merchant/${encodeURIComponent(shopCode)}`;
  const [modeTitle, modeDescription] = modeNames[status.mode];
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("开店指引")}</h2>
        <p className="text-sm text-ink/60" role="status">
          {status.complete
            ? t("基础接入已完成")
            : t("已完成 {done} / {total}", { done, total: status.steps.length })}
        </p>
      </header>
      <PlatformSupport />
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink/10 bg-panel p-5">
        <div className="min-w-0">
          <p className="text-xs text-ink/50">{t("经营方式")}</p>
          <p className="mt-1 font-semibold">{t(modeTitle)}</p>
          <p className="mt-1 text-sm leading-relaxed text-ink/60">{t(modeDescription)}</p>
        </div>
        <Link className={buttonQuiet + " px-3 py-2"} to={`${base}/settings?group=billing`}>
          {t("更改")}
        </Link>
      </section>
      <StoreModel />
      <PlayerJourney mode={status.mode} identity={status.identity !== "web" && status.identityMatters} />
      <OwnerDaily mode={status.mode} />
      {status.billing && (
        <>
          <MoneyFlow mode={status.mode} />
          <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-ink/10 bg-panel p-5">
            <div className="min-w-0">
              <h3 className="font-semibold">{t("计费说明书")}</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink/60">
                {t("计费图解、字段说明与配置注意事项。")}
              </p>
            </div>
            <button type="button" className={button} onClick={() => setExplaining(true)}>
              {t("查看说明书")}
            </button>
          </section>
        </>
      )}
      <section className="grid gap-3" aria-labelledby="setup-steps">
        <h3 id="setup-steps" className="font-semibold">
          {t("接入步骤")}
        </h3>
        <ol className="grid gap-3">
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
            />
          ))}
        </ol>
      </section>
      <Optional status={status} idlePowerEnabled={idlePowerEnabled} shopCode={shopCode} />
      {explaining && (
        <Modal title="计费说明书" close={() => setExplaining(false)} xl>
          <BillingExplainer />
        </Modal>
      )}
    </div>
  );
}

function StoreModel() {
  const { t } = useI18n();
  const pillars: [LucideIcon, string, string][] = [
    [
      Layers,
      "资源组决定怎么收费",
      "默认资源组和自定义资源组（如游戏区、休息区、桌游区）各自绑定计费方案，不设方案即免费；店铺没有整店计费开关。单个资源也可以设专属方案覆盖资源组。",
    ],
    [
      Power,
      "资源与 7 种能力",
      "资源是玩家扫码或碰 NFC 使用的对象（机台、空调、门锁、桌游桌或纯入场二维码）。给它加上电源、空调、刷卡 · HINATA IO（默认直连，支持后台按键）、投币、开门密码或桌游能力，就能控制对应硬件。",
    ],
    [
      Bot,
      "Bot、占用与事件",
      "店铺 Bot 也是资源（不供扫码），负责群内命令、绑定身份、同步昵称和按听众分组的播报组。刷卡、投币和桌游座位会自动记录占用，用来查在店位置和触发闲置自动关机。",
    ],
  ];
  return (
    <section className="grid gap-3 rounded-xl border border-ink/10 bg-panel p-5" aria-labelledby="store-model">
      <h3 id="store-model" className="font-semibold">{t("这套系统怎么组织店铺")}</h3>
      <div className="grid gap-3 md:grid-cols-3">
        {pillars.map(([Icon, title, description]) => (
          <div key={title} className="grid content-start gap-2 rounded-lg bg-ink/[0.03] p-3.5 text-sm">
            <span className="flex items-center gap-2 font-semibold">
              <Icon size={16} className="shrink-0 text-mint" aria-hidden="true" />
              {t(title)}
            </span>
            <p className="leading-relaxed text-ink/60">{t(description)}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

type Stage = [LucideIcon, string, string];

function Flow({ stages }: { stages: Stage[] }) {
  const { t } = useI18n();
  return (
    <ol className="grid gap-2 sm:grid-cols-2 lg:grid-flow-col lg:grid-cols-none lg:auto-cols-fr">
      {stages.map(([Icon, title, description], index) => (
        <li key={title} className="relative flex gap-3 rounded-lg bg-ink/[0.03] p-3 lg:flex-col lg:gap-2">
          <span className="flex items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-mint/10 text-mint">
              <Icon size={16} aria-hidden="true" />
            </span>
            {index < stages.length - 1 && (
              <ArrowRight className="hidden text-ink/25 lg:block" size={16} aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0">
            <strong className="block text-sm">
              {index + 1}. {t(title)}
            </strong>
            <span className="mt-0.5 block text-sm leading-relaxed text-ink/60">{t(description)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function PlayerJourney({ mode, identity }: { mode: OperatingMode; identity: boolean }) {
  const { t } = useI18n();
  const scan: Stage = [
    Nfc,
    "碰 NFC 或扫码",
    "资源的 NFC 标签和二维码是同一个链接。iPhone 碰一下直接打开 PRiSM Link（App Clip，免安装，支持灵动岛实时看账单），其它手机用浏览器打开。",
  ];
  const login: Stage = [LogIn, "登录", "用 MuNET 或 Passkey 登录。"];
  const bind: Stage = [
    ShieldCheck,
    "第一次来：绑定身份",
    "按你写的绑定提示，把绑定码发给店铺 Bot；Bot 会自动同步玩家在聊天平台上的昵称。以后不用再绑。",
  ];
  const stages: Stage[] =
    mode === "desk"
      ? [
          [CreditCard, "前台刷卡", "第一次来由店员登记一个昵称，之后刷卡就能认出。"],
          [Receipt, "店员点入场", "按「前台资源」的计费方案开始计时（它自己的方案，否则所在资源组的方案）。"],
          [Gamepad2, "游玩", "计时进行中，店员可以在「仪表板」页按位置查人、随时看实时账单。"],
          [Wallet, "回前台付款", "店员按屏幕金额收微信、支付宝或现金，确认收款后结账。"],
        ]
      : mode === "self"
        ? [
            scan,
            login,
            ...(identity ? [bind] : []),
            [Receipt, "确认计费规则", "看到这里今天的计费规则和封顶进度，确认后开始计时；换到别的资源时，会说明要新增、保留或结束哪些计费。"],
            [Gamepad2, "用设备", "在手机上开机、调空调、刷卡（直连机台可在读卡器直接加卡，也可刷卡后自动投币）、投币、开门、延迟关机，或上桌游桌（扫另一桌直接换桌）。"],
            [Wallet, "离店结账", "一键结账，从余额扣款并停止计时；iPhone 灵动岛也会同步结束（店员或 Bot 代结账同样会同步）。"],
          ]
        : [
            scan,
            login,
            ...(identity ? [bind] : []),
            [Gamepad2, "操作设备", "开机、调空调、刷卡（直连机台可在读卡器直接加卡）、投币、开门或上桌游桌，不计费。"],
          ];
  return (
    <section className="grid gap-3 rounded-xl border border-ink/10 bg-panel p-5" aria-labelledby="player-journey">
      <h3 id="player-journey" className="font-semibold">{t("正常营业时，玩家这样用")}</h3>
      <Flow stages={stages} />
      {mode === "desk" && (
        <p className="text-sm leading-relaxed text-ink/60">
          {t("带手机的玩家也可以不经过前台：扫店内的二维码或碰 NFC 入场，离店时用余额自助结账。")}
        </p>
      )}
    </section>
  );
}

function OwnerDaily({ mode }: { mode: OperatingMode }) {
  const { t } = useI18n();
  const items: [string, string][] =
    mode === "desk"
      ? [
          ["仪表板", "前台用桌面 Chrome 或 Edge 连读卡器刷卡入场收款；也可按位置分组查人、看实时账单、代结账或按住 Ctrl/Shift 批量结账。"],
          ["玩家", "查档案、余额、绑定的平台身份（Bot 自动同步昵称）和历史结账记录；给预存余额的玩家充值。"],
          ["资源", "按资源组看实时状态磁贴、点磁贴远程操作（含后台自定义按键、免冷却投币、上下桌游桌）、查占用和完整操作记录。"],
          ["计费", "编辑分时段规则、消费封顶与规则间的依赖和冲突，并用计费模拟器试算。"],
          ["历史", "营收趋势、入场与在场分析及每笔结账记录，支持按时间导出 Excel；现场收款和余额结算分开统计，可归档测试账单。"],
        ]
      : mode === "self"
        ? [
            ["仪表板", "按位置分组看谁在店里、实时账单，必要时替玩家结账、充值结账或按住 Ctrl/Shift 批量结账。"],
            ["玩家", "余额不够时在这里充值；查档案、绑定的平台身份（Bot 自动同步昵称）和完整历史账单。"],
            ["资源", "看电源/空调实时状态、IO 在线与机内币数、闲置关机倒计时；远程操作、管理 Bot 与查操作记录。"],
            ["计费", "编辑分时段规则、消费封顶与规则间的依赖和冲突，并用计费模拟器试算。"],
            ["资产", "建充值礼物、优惠券，批量生成并导出兑换码，拿到群里或网店售卖。"],
            ["历史", "营收趋势、入场与在场分析及每笔结账记录，支持按时间导出 Excel；测试账单可归档，不计入营业额。"],
          ]
        : [
            ["资源", "看电源/空调实时状态、IO 在线与占用玩家；远程开关机、调空调、按后台按键、开门、管理 Bot 和查操作记录。"],
            ["设置", "位置与范围、玩家身份与绑定提示、投币冷却、闲置自动关机、门锁账号、成员和备份迁移。"],
          ];
  return (
    <section className="grid gap-3 rounded-xl border border-ink/10 bg-panel p-5" aria-labelledby="owner-daily">
      <h3 id="owner-daily" className="font-semibold">{t("你每天在后台做什么")}</h3>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {items.map(([tab, purpose]) => (
          <div key={tab} className="flex gap-3">
            <dt className="min-w-12 shrink-0 font-medium">{t(tab)}</dt>
            <dd className="leading-relaxed text-ink/60">{t(purpose)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function MoneyFlow({ mode }: { mode: OperatingMode }) {
  const { t } = useI18n();
  const sources: [LucideIcon, string, string][] = [
    [Ticket, "兑换码", "在「资产」建充值礼物、生成并导出兑换码，拿到任何渠道售卖。玩家在网页、App Clip 或 Bot 里兑换后到账。"],
    [Users, "店员充值", "在「玩家」页给玩家充值或扣款，可选充值余额或赠送余额。"],
    [Gift, "礼物与活动", "新玩家礼物、活动兑换码，发放赠送余额或优惠券。"],
  ];
  return (
    <section className="grid gap-4 rounded-xl border border-ink/10 bg-panel p-5" aria-labelledby="money-flow">
      <h3 id="money-flow" className="font-semibold">{t("钱从哪来、怎么扣")}</h3>
      {mode === "desk" && (
        <div className="flex gap-3 rounded-lg border border-mint/30 bg-mint/5 p-3 text-sm">
          <CreditCard className="mt-0.5 shrink-0 text-mint" size={18} aria-hidden="true" />
          <p className="leading-relaxed">
            <strong>{t("前台收银")}</strong>
            {"："}
            {t("刷卡入场的玩家在前台用微信、支付宝或现金付款，店员勾选「已收款」后结账。这笔钱不进玩家余额，系统只记录金额、收款方式和收银员。")}
          </p>
        </div>
      )}
      <p className="text-sm leading-relaxed text-ink/60">
        {t(mode === "desk"
          ? "用手机自助的玩家走预存余额。系统没有接入在线支付，余额只有下面几种来源："
          : "系统没有接入在线支付，玩家先预存余额，结账时从余额扣款。余额只有下面几种来源：")}
      </p>
      <div className="grid items-stretch gap-3 lg:grid-cols-[minmax(0,1.4fr)_auto_minmax(0,0.8fr)_auto_minmax(0,1fr)]">
        <ul className="grid gap-2">
          {sources.map(([Icon, title, description]) => (
            <li key={title} className="flex gap-3 rounded-lg bg-ink/[0.03] p-3 text-sm">
              <Icon className="mt-0.5 shrink-0 text-ink/50" size={16} aria-hidden="true" />
              <span>
                <strong className="block">{t(title)}</strong>
                <span className="mt-0.5 block leading-relaxed text-ink/60">{t(description)}</span>
              </span>
            </li>
          ))}
        </ul>
        <ArrowRight className="hidden self-center text-ink/25 lg:block" size={20} aria-hidden="true" />
        <div className="grid content-center gap-2 rounded-lg bg-ink/[0.03] p-3 text-sm">
          <strong>{t("玩家余额")}</strong>
          <span className="rounded-md bg-mint/10 px-3 py-2">{t("赠送余额")}</span>
          <span className="rounded-md bg-mint/20 px-3 py-2">{t("充值余额")}</span>
        </div>
        <ArrowRight className="hidden self-center text-ink/25 lg:block" size={20} aria-hidden="true" />
        <div className="grid content-center gap-2 rounded-lg bg-ink/[0.03] p-3 text-sm">
          <strong>{t("结账时")}</strong>
          <span className="leading-relaxed text-ink/70">{t("先抵扣优惠券，再扣赠送余额，最后扣充值余额。")}</span>
          <span className="leading-relaxed text-coral">{t("余额不够：结不了账，计时继续。店员可以在「仪表板」页用「充值结账」或「改价结账」处理，也可让 Bot 把结账失败播报给店员。")}</span>
        </div>
      </div>
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
}: {
  index: number;
  id: SetupStepId;
  done: boolean;
  next: boolean;
  status: SetupStatus;
  haReadIssues: number;
  shopCode: string;
  reload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const base = `/merchant/${encodeURIComponent(shopCode)}`;
  const action = next ? primary : button;
  const go = (to: string, text: string, quiet = done) => (
    <Link className={quiet ? buttonQuiet + " px-3 py-2" : action} to={to}>
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
    why?: string;
    points?: string[];
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
          why: "店铺按资源组和资源专属方案计费，没有整店计费开关。玩家或前台操作资源时，按资源自己的方案，否则按所在资源组的方案计时。",
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
              {status.pricingProblem === "assets" && go(`${base}/assets`, "恢复余额资产")}
              {status.deskProblem === "missing" && go(`${base}/settings?group=billing`, "选择前台资源")}
              {status.deskProblem === "unbilled" && go(`${base}/resources`, "设置资源组方案")}
              {go(`${base}/pricing`, "查看计费规则", true)}
            </>
          ),
        }
      : id === "reader"
        ? {
            title: "准备前台读卡器",
            why: "前台用 HINATA 读卡器读玩家的实体卡（IC 卡或 FeliCa 卡）。在前台电脑上用桌面版 Chrome 或 Edge 打开「仪表板」页，点「连接读卡器」授权一次，之后会自动连接。",
            fact:
              status.reader === null
                ? "这个浏览器不支持读卡器，需要桌面版 Chrome 或 Edge。"
                : status.reader
                  ? "这台电脑的浏览器已授权读卡器。"
                  : "这台电脑的浏览器还没有授权读卡器。",
            actions: go(`${base}/dashboard`, "打开「仪表板」页"),
          }
        : id === "staff"
          ? {
              title: "给前台店员开账号",
              why: "店员用自己的 MuNET 账号登录后台。要在前台收款，店员的计费权限需要设为「管理」；「只读」只能查看。店员绑定平台身份后会自动成为店铺 Bot 的管理员，不用单独填表。",
              fact: t("成员：{count}", { count: status.members }),
              actions: go(`${base}/settings?group=members`, "邀请店员"),
            }
          : id === "identity"
            ? {
                title: "确认玩家身份与 Bot",
                why:
                  status.mode === "devices"
                    ? "开门或上桌游桌前，平台需要确认玩家是本店玩家。"
                    : status.mode === "desk"
                      ? "前台刷卡的玩家不需要绑定；用手机自助入场的玩家需要先确认身份。"
                      : "入场前，平台需要确认玩家是谁。",
                warn: done
                  ? undefined
                  : status.botIssued
                    ? "已创建 Bot 凭据，但还没有 Bot 用它连接过。新玩家扫码后会卡在绑定身份这一步。"
                    : "当前要求绑定 Bot 身份，但店铺还没有接入 Bot。新玩家扫码后会卡在绑定身份这一步。",
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
                  why: "玩家自助结账从余额扣款，余额不够就结不了账。系统没有接入在线支付，余额靠这两种方式充进去：",
                  points: [
                    "兑换码：在「资产 → 礼物」建一个充值礼物（例如花 50 元得 52 元余额），在「兑换码」批量生成并导出售卖。",
                    "店员充值：在「玩家」页直接给玩家加余额，适合线上转账后手动到账。",
                  ],
                  fact:
                    status.redeemCodes || status.fundedPlayers
                      ? [
                          status.redeemCodes ? t("可用兑换码：{count}", { count: status.redeemCodes }) : "",
                          status.fundedPlayers ? t("有余额的玩家：{count}", { count: status.fundedPlayers }) : "",
                        ].filter(Boolean).join(" · ")
                      : undefined,
                  actions: (
                    <>
                      {go(`${base}/assets?tab=gifts`, "建充值礼物")}
                      {go(`${base}/assets?tab=codes`, "生成兑换码", true)}
                      {go(`${base}/players`, "打开玩家页", true)}
                    </>
                  ),
                }
              : id === "devices"
                ? {
                    title: "添加资源并配置能力",
                    why: "资源是玩家扫码使用的对象：机台、空调、门锁、桌游桌，或没有硬件、只用来开始计费的二维码（Bot 资源单独用于机器人，不供扫码）。给资源加上「电源控制」「空调」「刷卡 · HINATA IO」「投币」「开门密码」或「桌游」等能力即可联动硬件；想只用二维码计费时，把它放进有计费方案的资源组即可。",
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
                      status.devices ? "打开资源页" : "添加资源",
                    ),
                  }
                : id === "door"
                  ? {
                      title: "连接 TTLock 账号",
                      why: "开门密码由店铺的 TTLock 开放平台账号生成，没连接时开门会失败。",
                      fact: t("{count} 个资源启用了开门密码", { count: status.doorDevices }),
                      actions: go(`${base}/settings?group=devices`, done ? "查看 TTLock 设置" : "连接 TTLock"),
                    }
                  : {
                      title: "贴好二维码或 NFC，自己试一次",
                      why: "每个资源都有专属二维码，打印后贴在对应位置；同一个链接也可以写进 NFC 标签（NDEF 网址记录），iPhone 碰一下会直接打开 PRiSM Link（App Clip）。支持直连读卡器的机台，玩家还可以在扫码页点「+」直接加卡。",
                      points: [
                        status.mode === "desk"
                          ? "在前台刷一张卡，入场后再收一次款；再用手机扫一次码，走一遍自助流程。"
                          : status.mode === "self"
                            ? "用自己的手机走一遍：登录、绑定身份、入场、操作设备、结账。"
                            : "用自己的手机走一遍：登录并操作设备。",
                      ],
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
      className={`rounded-xl border bg-panel p-5 ${next ? "border-mint/50" : "border-ink/10"}`}
    >
      <div className="flex gap-4">
        <span
          aria-hidden="true"
          className={`grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold ${done ? "bg-mint/10 text-mint" : next ? "bg-primary text-primary-foreground" : "bg-ink/5 text-ink/60"}`}
        >
          {done ? <CheckCircle2 size={18} /> : index}
        </span>
        <div className="grid min-w-0 flex-1 gap-2">
          <h4 className="flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold">
            {t(content.title)}
            <span className={`text-xs font-normal ${done ? "text-mint" : "text-ink/50"}`}>
              {t(done ? "已完成" : "待完成")}
            </span>
          </h4>
          {content.why && <p className="text-sm leading-relaxed text-ink/60">{t(content.why)}</p>}
          {content.points && (
            <ul className="grid list-disc gap-1 pl-5 text-sm leading-relaxed text-ink/60">
              {content.points.map((point) => (
                <li key={point}>{t(point)}</li>
              ))}
            </ul>
          )}
          {content.fact && <p className="text-sm">{t(content.fact)}</p>}
          {content.warn && <p className="text-sm text-coral">{t(content.warn)}</p>}
          {content.warns?.map((warning) => (
            <p key={warning} className="text-sm text-coral">{warning}</p>
          ))}
          {content.hint && <p className="text-xs leading-relaxed text-ink/55">{content.hint}</p>}
          {content.body}
          {content.actions && (
            <div className="mt-1 flex flex-wrap items-center gap-2">{content.actions}</div>
          )}
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
        body: JSON.stringify({ ...current, ...identityPolicySettings(policy) }),
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
    <label className="flex min-h-11 items-center gap-2 px-2 text-sm">
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
      description:
        "在「资源」里配置 Bot 的播报组（按听众分组订阅尝试、事实和提醒事件，支持私聊店员）、自定义命令回复文案、入场自动给开门密码，以及用 Bot 优先监听 Home Assistant。",
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
      description:
        "按真实占用自动关闭闲置机台和空调，支持店内无人与单台闲置两条规则、keep 延迟关机、单台排除，以及 Bot 提前发送关机提醒。",
      state: idlePowerEnabled ? "已开启" : undefined,
      to: `${base}/settings?group=devices`,
    },
    {
      icon: Coins,
      title: "投币上限、自动投币与后台按键",
      description:
        "全店投币冷却在「设置」调整；直连 HINATA IO 可在资源的「投币」能力设置机内投币上限与刷卡后自动投币，并在「刷卡 · HINATA IO」添加仅店员可见的测试／服务按键。",
      to: `${base}/settings?group=devices`,
    },
    ...(status.billing
      ? [
          {
            icon: Layers,
            title: "资源组与分区计费",
            description:
              "按区域建资源组（如游戏区、休息区、桌游包间）并设置不同方案，配合规则「依赖 / 冲突」实现换区切换计费或叠加计费。",
            to: `${base}/resources`,
          },
        ]
      : []),
    ...(status.mode !== "desk"
      ? [
          {
            icon: Users,
            title: "邀请店员",
            description:
              status.mode === "self"
                ? "无前台的店也可以有店员：帮玩家充值、处理问题、远程操作设备；绑定平台身份后自动成为 Bot 管理员。"
                : "店员可以查看和远程操作设备；绑定平台身份后自动成为 Bot 管理员。",
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
            description: "玩家第一次建档时自动发放，例如一张满 10 减 6 的券或一点体验余额，用来拉新。",
            state: status.defaultPresent ? "已设置" : undefined,
            to: `${base}/settings?group=players`,
          },
          {
            icon: Ticket,
            title: "优惠与活动",
            description: "优惠券在结账时自动抵扣；活动礼物可以通过兑换码发放。",
            to: `${base}/assets?tab=effects`,
          },
        ]
      : []),
    ...(status.mode === "self"
      ? [
          {
            icon: CreditCard,
            title: "开启前台收银",
            description: "店里有前台时，可以让玩家刷实体卡入场、在前台现场付款。",
            to: `${base}/settings?group=billing`,
          },
        ]
      : status.mode === "devices"
        ? [
            {
              icon: Receipt,
              title: "改用 PRiSM 计费",
              description: "按时长向玩家收费，管理玩家余额和离店结账。",
              to: `${base}/settings?group=billing`,
            },
          ]
        : []),
    {
      icon: MapPin,
      title: "到店位置校验",
      description: "要求玩家在店铺范围内才能入场、开门、开关电源、调空调、刷卡和投币，离店结账须离开店铺范围。",
      state: status.locationEnabled ? "已开启" : undefined,
      to: `${base}/settings?group=devices`,
    },
    {
      icon: Database,
      title: "数据备份与从 prism-neo 迁移",
      description: "导出和恢复 JSON 店铺备份，或导入 prism-neo 的玩家、余额与计费规则（导入的规则默认停用，核对后再启用）。",
      to: `${base}/settings?group=data`,
    },
  ];
  return (
    <section className="grid gap-3" aria-labelledby="setup-optional">
      <h3 id="setup-optional" className="font-semibold">
        {t("按需配置")}
      </h3>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <li key={item.title}>
            <Link
              to={item.to}
              className="focus-ring flex h-full gap-3 rounded-xl border border-ink/10 bg-panel p-4 transition-colors hover:border-ink/25"
            >
              <item.icon className="mt-0.5 shrink-0 text-ink/50" size={18} aria-hidden="true" />
              <span className="grid min-w-0 content-start gap-1">
                <strong className="text-sm">{t(item.title)}</strong>
                <span className="text-sm leading-relaxed text-ink/60">{t(item.description)}</span>
                {item.state && <span className="text-xs text-mint">{t(item.state)}</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlatformSupport() {
  const { t } = useI18n();
  const [copyState, copy] = useCopy();
  return (
    <section
      className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-ink/10 bg-panel px-5 py-4"
      aria-labelledby="platform-support"
    >
      <div className="flex min-w-0 gap-3">
        <MessageCircle className="mt-0.5 shrink-0 text-mint" size={18} aria-hidden="true" />
        <div className="min-w-0">
          <h3 id="platform-support" className="font-semibold">
            {t("PRiSM 接入支持与反馈")}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-ink/60">
            {t("你在接入或日常使用 PRiSM 时遇到问题，或有功能建议，欢迎加入 PRiSM 官方 QQ 群 {group} 向我们咨询与反馈。", {
              group: SUPPORT_QQ_GROUP,
            })}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <code className="select-all rounded-lg bg-ink/[0.04] px-3 py-2 text-sm font-medium tabular-nums">
          {SUPPORT_QQ_GROUP}
        </code>
        <button
          type="button"
          className={button}
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

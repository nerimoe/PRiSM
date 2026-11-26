import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AirVent,
  Bot,
  Coins,
  Cpu,
  CreditCard,
  DoorOpen,
  Info,
  Keyboard,
  Monitor,
  Plus,
  Power,
  Trash2,
  Ungroup,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { botReplyTemplateError, keyTextFromVk, vkFromKeyText } from "@prism/core";
import {
  Api,
  api,
  type BotSettings,
  type CoinFeedbackEdge,
  type CoinFeedbackSignal,
  type HostProgram,
  type Resource,
  type ResourceLocationMode,
  type ShopNodeBinding,
} from "../../api";
import { useI18n } from "../../i18n";
import { ActionForm, Field, button, buttonQuiet, input, primary, useMerchant, useResource } from "./shared";
import { useBillablePlans, useResourceGroups } from "./ResourceGroups";
import {
  capabilityRequires,
  conflictingCapabilities,
  dependentCapabilities,
  hasResourceLink,
  resourceCapabilities,
  type CapabilityId,
} from "./resource-capabilities";
import { BotReplyEditor } from "./BotReplyEditor";
import { BotAnnouncementGroups } from "./BotAnnouncementGroups";
import { isScheduleRuleInvalid } from "./bot-schedules";
import { RotateTokenConfirm } from "./RotateTokenConfirm";
import { HaEntityFields, NEW_CONNECTION, haBody, useHaConnections, type HaDraft } from "./HaEntityFields";
import { idlePath, useIdleSettings } from "./IdlePowerSettings";

const SELF_IOT_REF = "__self__";

/** One unified cabinet button being edited (keyboard VK or IoT GPIO pulse). */
type ResourceButtonDraft = {
  id: string;
  name: string;
  mode: "keyboard" | "gpio";
  key: string;
  nodeId: string;
  pin: string;
  pulseMs: string;
  activeLow: boolean;
};

/** An id for a button added here; the server keeps it so `coin` can reference it before saving. */
const newKeyId = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const draftOf = (binding?: { connectionId?: string | null; url: string; entityId: string } | null): HaDraft => ({
  connection: binding?.connectionId ?? NEW_CONNECTION,
  url: binding?.url ?? "",
  token: "",
  entityId: binding?.entityId ?? "",
});
const POWER_DOMAINS = ["switch", "input_boolean"];
const CLIMATE_DOMAINS = ["climate"];

type IssuedCredential = {
  kind: "hinata" | "host" | "iot";
  token: string;
  url: string;
};

/**
 * Resource configuration, one section at a time: basics (including location
 * override), billing & occupancy, each enabled capability, and the capability
 * picker with declarative conflict/dependency rules.
 */
export function ResourceEditor({
  value,
  groupId: initialGroupId,
  done,
  onLockChange,
  onWideChange,
}: {
  value?: Resource;
  /** The group a new resource is added to. */
  groupId?: string;
  done: () => void;
  /** Locks the dialog while a one-time token is on screen. */
  onLockChange: (locked: boolean) => void;
  /** Widens the dialog to `xl` when editing a Bot workbench resource. */
  onWideChange?: (wide: boolean | null) => void;
}) {
  const { shopId, shopCode, owner, privacyModeEnabled } = useMerchant();
  const { t } = useI18n();
  const shopSettings = useResource<{
    settings: { ttLockConnection?: Record<string, string | undefined> | null };
  }>(owner ? "settings" : null);
  const lock = shopSettings.data?.settings.ttLockConnection;
  const ttLockMissing =
    !!shopSettings.data &&
    !(lock?.clientId && lock.clientSecret && (lock.accessToken || lock.appAccount));
  const shopPath = `/merchant/${encodeURIComponent(shopCode)}`;

  const initial = resourceCapabilities(
    value ?? {
      homeAssistant: null,
      climate: null,
      ttlockLockId: null,
      table: null,
      hasHinata: false,
      relayConnection: "external",
      coinEnabled: false,
      hasPassword: false,
    },
  );
  const [caps, setCaps] = useState(initial);
  const [pane, setPane] = useState<"basic" | "usage" | "add" | CapabilityId>("basic");
  const [name, setName] = useState(value?.name ?? "");
  const [aliases, setAliases] = useState<string[]>(value?.aliases ?? []);
  const [enabled, setEnabled] = useState(value ? !!value.enabled : true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<CapabilityId | null>(null);
  const [resourceCapacity, setResourceCapacity] = useState(value?.capacity === undefined ? "" : String(value.capacity));
  const [occupancyMinutes, setOccupancyMinutes] = useState(String(value?.occupancyMinutes ?? 15));

  // Resource-level location verification override
  const [locMode, setLocMode] = useState<ResourceLocationMode>(value?.locationOverride?.mode ?? "inherit");
  const [locBeaconNodeId, setLocBeaconNodeId] = useState<string>(value?.locationOverride?.beaconNodeId ?? "");
  const [locRssiThreshold, setLocRssiThreshold] = useState<number | null>(
    value?.locationOverride?.rssiThreshold ?? null,
  );

  // All resources in this shop (for IoT controller picker and Bot door picker)
  const [shopResources, setShopResources] = useState<Resource[]>([]);
  useEffect(() => {
    Api.machines(shopId)
      .then((r) => setShopResources(r.machines))
      .catch(() => setShopResources([]));
  }, [shopId]);

  const selfIotId = value?.iot?.nodeId ?? SELF_IOT_REF;
  const iotOptions: Array<{
    nodeId: string;
    label: string;
    isSelf: boolean;
    bleEnabled: boolean;
    beaconId: number | null;
    bindings: ShopNodeBinding[];
  }> = [
    ...(caps.iot
      ? [{
          nodeId: selfIotId,
          label: `${name.trim() || t("本资源")}（${t("本机控制器")}）`,
          isSelf: true,
          bleEnabled: true,
          beaconId: value?.iot?.ble.beaconId ?? null,
          bindings: value?.iotBindings ?? [],
        }]
      : []),
    ...shopResources
      .filter((r) => r.id !== value?.id && !!r.iot?.nodeId)
      .map((r) => ({
        nodeId: r.iot!.nodeId,
        label: `${r.name}${r.iotOnline ? ` · ${t("在线")}` : ""}`,
        isSelf: false,
        bleEnabled: r.iot!.ble.enabled,
        beaconId: r.iot!.ble.beaconId,
        bindings: r.iotBindings ?? [],
      })),
  ];

  const ha = useHaConnections(shopId);
  const idle = useIdleSettings(shopId);
  const ownIdle = value ? idle.settings?.devices[value.id] : undefined;
  const [idleExclude, setIdleExclude] = useState(false);
  useEffect(() => {
    setIdleExclude(!!ownIdle?.exclude);
  }, [ownIdle?.exclude]);
  const [power, setPower] = useState<HaDraft>(() => draftOf(value?.homeAssistant));
  const [ac, setAc] = useState<HaDraft>(() => draftOf(value?.climate));
  useEffect(() => {
    const list = ha.connections;
    if (!list?.length) return;
    const settle = (draft: HaDraft): HaDraft => {
      if (draft.connection !== NEW_CONNECTION || draft.token) return draft;
      const url = draft.url.trim().replace(/\/+$/, "");
      const match = url ? list.find((connection) => connection.url === url) : list[0];
      return match ? { ...draft, connection: match.id } : draft;
    };
    setPower(settle);
    setAc(settle);
  }, [ha.connections]);
  const acSharesPowerToken =
    caps.power && ac.connection === NEW_CONNECTION && power.connection === NEW_CONNECTION &&
    !!ac.url.trim() && ac.url.trim() === power.url.trim() && (!!value?.homeAssistant || !!power.token.trim());

  // HINATA IO state
  const [embedded, setEmbedded] = useState(
    initial.hinata_io ? value?.relayConnection === "embedded" : true,
  );
  const [hinataUrl, setHinataUrl] = useState(value?.hinataUrl ?? "");
  const [password, setPassword] = useState("");

  // Host (PRiSM Launcher) state
  const [hostPrograms, setHostPrograms] = useState<HostProgram[]>(value?.host?.programs ?? []);
  const [hostDefaultProgram, setHostDefaultProgram] = useState<string>(value?.host?.defaultProgram ?? "");

  // Unified cabinet buttons (`keys`) state
  const [buttons, setButtons] = useState<ResourceButtonDraft[]>(() =>
    (value?.keys ?? []).map((one) =>
      one.mode === "gpio"
        ? {
            id: one.id,
            name: one.name,
            mode: "gpio",
            key: "",
            nodeId: one.nodeId,
            pin: String(one.pin),
            pulseMs: String(one.pulseMs ?? 80),
            activeLow: one.activeLow ?? true,
          }
        : {
            id: one.id,
            name: one.name,
            mode: "keyboard",
            key: keyTextFromVk(one.key),
            nodeId: "",
            pin: "",
            pulseMs: "80",
            activeLow: true,
          },
    ),
  );

  // Coin state (picks a button in `keys` + direct-IO cap/afterSwipe + GPIO-only optional hardware feedback)
  const [coinKeyId, setCoinKeyId] = useState<string | null>(value?.coin?.keyId ?? value?.coinKeyId ?? null);
  const selectedCoinButton = coinKeyId ? buttons.find((one) => one.id === coinKeyId) ?? null : null;
  const coinChosen = !!selectedCoinButton;
  const isGpioCoin = selectedCoinButton?.mode === "gpio";
  const [coinAfterSwipe, setCoinAfterSwipe] = useState(
    value?.coin?.afterSwipe ?? value?.coinAfterSwipe ?? false,
  );
  const [coinCap, setCoinCap] = useState(
    (value?.coin?.cap ?? value?.coinCap) ? String(value?.coin?.cap ?? value?.coinCap) : "",
  );
  const [coinFeedbackEnabled, setCoinFeedbackEnabled] = useState<boolean>(
    !!(value?.coin?.feedbackNodeId && value?.coin?.feedbackPin !== undefined && value?.coin?.feedbackPin !== null),
  );
  const [coinFeedbackNodeId, setCoinFeedbackNodeId] = useState<string>(value?.coin?.feedbackNodeId ?? "");
  const [coinFeedbackPin, setCoinFeedbackPin] = useState<string>(
    value?.coin?.feedbackPin !== undefined && value?.coin?.feedbackPin !== null
      ? String(value.coin.feedbackPin)
      : "",
  );
  const [coinFeedbackEdge, setCoinFeedbackEdge] = useState<CoinFeedbackEdge>(
    value?.coin?.feedbackEdge ?? "falling",
  );
  const [coinFeedbackDebounceMs, setCoinFeedbackDebounceMs] = useState<string>(
    String(value?.coin?.feedbackDebounceMs ?? 50),
  );
  const [coinFeedbackSignal, setCoinFeedbackSignal] = useState<CoinFeedbackSignal>(
    value?.coin?.feedbackSignal ?? "cabinet.coin",
  );

  const [lockId, setLockId] = useState(value?.ttlockLockId ? String(value.ttlockLockId) : "");
  const [tableStart, setTableStart] = useState<"full" | "seated">(value?.table?.startWhen ?? "full");
  const [tablePricing, setTablePricing] = useState<string[]>(value?.table?.pricingConfigIds ?? []);
  const [pricing, setPricing] = useState<{ id: string; name: string; enabled: boolean }[]>([]);
  const [groupId, setGroupId] = useState(value?.resourceGroupId ?? initialGroupId ?? "default");
  const [overrideId, setOverrideId] = useState(value?.pricingConfigOverrideId ?? "");
  const { groups } = useResourceGroups(shopId);
  const billablePlans = useBillablePlans(shopCode);
  const groupPlanId = groups?.find((group) => group.id === groupId)?.defaultPricingConfigId ?? null;
  const groupPlanName = groupPlanId ? billablePlans.find((plan) => plan.id === groupPlanId)?.name ?? null : null;
  const billed = !!overrideId || !!groupPlanId;

  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [live, setLive] = useState<Resource | null>(value ?? null);
  const [botPane, setBotPane] = useState<"permissions" | "broadcasts" | "replies" | "connection">("permissions");
  const [bot, setBot] = useState<BotSettings>(() => ({ ...defaultBotSettings, ...(value?.bot ?? {}) }));
  const changeBot = (patch: Partial<BotSettings>) => setBot((current) => ({ ...current, ...patch }));
  const [botToken, setBotToken] = useState<string | null>(null);
  const doors = shopResources.filter((m) => m.ttlockLockId).map((m) => ({ id: m.id, name: m.name }));

  useEffect(() => {
    if (!caps.table) return;
    api<{ pricingConfigs: typeof pricing }>(
      `/api/v1/shops/${encodeURIComponent(shopCode)}/staff/pricing-configs`,
    )
      .then((r) => setPricing(r.pricingConfigs))
      .catch(() => setPricing([]));
  }, [caps.table, shopCode]);

  useEffect(() => {
    onLockChange(!!issued || !!botToken);
    return () => onLockChange(false);
  }, [issued, botToken, onLockChange]);

  useEffect(() => {
    onWideChange?.(!!caps.bot);
    return () => onWideChange?.(null);
  }, [caps.bot, onWideChange]);

  const hasKeyboardChannel = caps.host || (caps.hinata_io && (embedded || !!value?.hasPassword || !!password));
  const resourceHasPlayerLink = hasResourceLink(caps);

  const defaultIotOptionId = () => (caps.iot ? selfIotId : iotOptions[0]?.nodeId ?? "");

  /** Why a capability's own configuration is not complete yet. */
  const missingConfig = (id: CapabilityId): string | null => {
    if (id === "power") {
      if (power.connection === NEW_CONNECTION && !power.url.trim()) return t("请填写 Home Assistant 地址");
      if (!power.entityId.trim()) return t("请填写电源实体");
      if (power.connection === NEW_CONNECTION && !value?.homeAssistant && !power.token.trim())
        return t("请填写长期访问令牌");
    }
    if (id === "climate") {
      if (ac.connection === NEW_CONNECTION && !ac.url.trim()) return t("请填写 Home Assistant 地址");
      if (!/^climate\.[a-z0-9_]+$/.test(ac.entityId.trim()))
        return t("请填写 climate. 开头的空调实体");
      if (ac.connection === NEW_CONNECTION && !value?.climate && !ac.token.trim() && !acSharesPowerToken)
        return t("请填写长期访问令牌");
    }
    if (id === "hinata_io" && !embedded && !hinataUrl.trim())
      return t("请填写 HINATA IO 地址");
    if (id === "keys") {
      if (!buttons.length) return t("请至少添加一个按键");
      for (const btn of buttons) {
        if (!btn.name.trim()) return t("请填写按键名称");
        if (btn.mode === "gpio") {
          if (!btn.nodeId) return t("请为 GPIO 按键选择 IoT 控制器");
          const pin = Number(btn.pin);
          if (btn.pin.trim() === "" || !Number.isInteger(pin) || pin < 0 || pin > 255)
            return t("请填写有效的 GPIO 引脚编号（0–255）");
        } else {
          const code = btn.key.trim() ? vkFromKeyText(btn.key) : null;
          if (code === null) return t("请填写有效的键盘按键");
          if (!hasKeyboardChannel) return t("键盘按键需要启用「启动器」或「刷卡 · HINATA IO」");
        }
      }
    }
    if (id === "coin") {
      if (!coinChosen) return t("请选择投币按键");
      if (isGpioCoin && coinFeedbackEnabled) {
        if (!coinFeedbackNodeId) return t("配置硬件回报引脚时请选择 IoT 控制器");
        const fb = Number(coinFeedbackPin);
        if (coinFeedbackPin.trim() === "" || !Number.isInteger(fb) || fb < 0 || fb > 255)
          return t("回报引脚编号须为 0–255 的整数");
      }
    }
    if (id === "host") {
      const names = new Set<string>();
      for (const p of hostPrograms) {
        if (!p.name.trim() || !p.path.trim()) return t("程序名称和路径均不能为空");
        if (names.has(p.name.trim())) return t("程序名称不能重复");
        names.add(p.name.trim());
      }
      if (hostDefaultProgram && !names.has(hostDefaultProgram))
        return t("默认启动程序必须在程序列表中");
    }
    if (id === "door" && !(Number(lockId) > 0)) return t("请填写门锁 ID");
    if (id === "bot") {
      for (const [key, text] of Object.entries(bot.replyTemplates ?? {})) {
        const error = botReplyTemplateError(key, text);
        if (error) return `${key}：${error}`;
      }
      for (const group of bot.replyGroups ?? []) {
        for (const [key, text] of Object.entries(group.templates)) {
          const error = botReplyTemplateError(key, text);
          if (error) return `${group.name} · ${key}：${error}`;
        }
      }
      for (const group of bot.announceGroups ?? []) {
        if ((group.schedules ?? []).some(isScheduleRuleInvalid)) {
          return t("请填写定时播报的内容、时间和日期或星期");
        }
        for (const [key, text] of Object.entries(group.templates)) {
          const error = botReplyTemplateError(key, text);
          if (error) return `${group.name} · ${key}：${error}`;
        }
      }
    }
    if (id === "table" && billed && !tablePricing.length) return t("请选择一条桌游计费规则");
    return null;
  };

  /** Adding a capability automatically enables any required dependencies. */
  const enable = (id: CapabilityId) => {
    if (conflictingCapabilities(id, caps).length > 0) return;
    const reqs = capabilityRequires(id);
    if (id === "climate" && ac.connection === NEW_CONNECTION && !ac.url.trim())
      setAc({ ...ac, connection: power.connection, url: power.url });
    if (id === "keys" || reqs.includes("keys")) {
      if (buttons.length === 0) {
        const preferGpio = !caps.host && !caps.hinata_io && (caps.iot || iotOptions.length > 0);
        const firstId = newKeyId();
        setButtons([
          {
            id: firstId,
            name: "投币",
            mode: preferGpio ? "gpio" : "keyboard",
            key: preferGpio ? "" : "Space",
            nodeId: preferGpio ? defaultIotOptionId() : "",
            pin: "",
            pulseMs: "80",
            activeLow: true,
          },
        ]);
        if (id === "coin" && !coinKeyId) setCoinKeyId(firstId);
      } else if (id === "coin" && !coinChosen) {
        setCoinKeyId((buttons.find((one) => one.name.trim() === "投币") ?? buttons[0])?.id ?? null);
      }
    }
    setCaps((current) => {
      const next = { ...current, [id]: true };
      for (const req of reqs) next[req] = true;
      return next;
    });
    setPane(id);
  };

  const remove = (id: CapabilityId) => {
    if (dependentCapabilities(id, caps).length > 0) return;
    setCaps((current) => ({ ...current, [id]: false }));
    setPane("basic");
  };

  const incomplete = (id: CapabilityId): string | null =>
    caps[id] ? missingConfig(id) : null;

  const seatsFrom = capabilityList.find((id) => caps[id] && capabilityMeta[id].seats) ?? null;
  const sections: { id: typeof pane; label: string; icon: LucideIcon; problem?: boolean; capability?: CapabilityId }[] = [
    { id: "basic", label: "基本信息", icon: Info },
    { id: "usage", label: "计费与占用", icon: Users },
    ...capabilityList.filter((id) => caps[id]).map((id) => ({
      id, label: capabilityMeta[id].label, icon: capabilityMeta[id].icon, problem: !!incomplete(id), capability: id,
    })),
    ...(capabilityList.some((id) => !caps[id]) ? [{ id: "add" as const, label: "添加能力", icon: Plus }] : []),
  ];

  if (botToken) {
    const snippet = `baseUrl: ${window.location.origin}\nintegrationToken: ${botToken}`;
    return (
      <div className="grid gap-5">
        <div className="grid gap-1">
          <h3 className="text-sm font-semibold">{t("Bot 令牌已签发")}</h3>
          <p className="text-xs leading-relaxed text-ink/60">
            {t("这是唯一一次显示，离开后无法再次查看。")}
          </p>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{t("填入 Koishi 的 PRiSM 插件")}</span>
            <CopyButton value={snippet} label="复制配置" />
          </div>
          <pre className="overflow-x-auto whitespace-pre rounded-lg bg-ink/5 p-3 text-xs">{snippet}</pre>
          <p className="text-xs leading-relaxed text-ink/60">
            {t("插件只需要这两项：接入凭据自己知道是哪个店铺。其余设置都在这里修改，保存后会自动推送给 Bot。")}
          </p>
        </div>
        <button
          type="button"
          className={`${primary} justify-self-start`}
          onClick={() => {
            setBotToken(null);
            done();
          }}
        >
          {t("我已填入插件")}
        </button>
      </div>
    );
  }

  if (issued) {
    const isHinata = issued.kind === "hinata";
    const snippet = isHinata
      ? `serverUrl=${issued.url}\ndeviceToken=${issued.token}`
      : JSON.stringify({ url: issued.url, token: issued.token }, null, 2);
    const title =
      issued.kind === "hinata"
        ? "设备令牌已签发"
        : issued.kind === "host"
          ? "Launcher 令牌已签发"
          : "IoT 控制器令牌已签发";
    const sectionTitle =
      issued.kind === "hinata"
        ? "写入机台 INI"
        : issued.kind === "host"
          ? "写入 launcher.json"
          : "写入硬件控制器配置";
    const hintText =
      issued.kind === "hinata"
        ? "把这两行写入 hinata.ini 或 segatools.ini 的 [aimeio] 段，然后重启机台。"
        : issued.kind === "host"
          ? "把这段配置保存为 prism-launcher 同目录的 launcher.json 后启动即可；游戏列表会在连接后自动下发。"
          : "把地址和令牌写入 IoT 控制器（ESP32 / 树莓派 / RP2040 等）；信标与 GPIO 引脚会在连接后自动下发。";
    return (
      <div className="grid gap-5">
        <div className="grid gap-1">
          <h3 className="text-sm font-semibold">{t(title)}</h3>
          <p className="text-xs leading-relaxed text-ink/60">
            {t("这是唯一一次显示，离开后无法再次查看。")}
          </p>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{t("连接令牌")}</span>
            <CopyButton value={issued.token} label="复制令牌" />
          </div>
          <code className="break-all rounded-lg bg-ink/5 p-3 text-xs">
            {issued.token}
          </code>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{t(sectionTitle)}</span>
            <CopyButton value={snippet} label="复制配置" />
          </div>
          <pre className="overflow-x-auto whitespace-pre rounded-lg bg-ink/5 p-3 text-xs">
            {snippet}
          </pre>
          <p className="text-xs leading-relaxed text-ink/60">{t(hintText)}</p>
        </div>
        <button
          type="button"
          className={`${primary} justify-self-start`}
          onClick={() => {
            setIssued(null);
            done();
          }}
        >
          {t("我已保存配置")}
        </button>
      </div>
    );
  }

  if (value && confirmDelete) return (
    <ActionForm key="delete" label="确认删除资源" done={done} submit={() => Api.deleteResource(value.id)}>
      <p className="font-medium">{t("确定删除资源「{name}」？", { name: value.name })}</p>
      <p className="text-sm text-ink/60">{t("删除后，资源二维码和接入凭据将失效，无法恢复。已有使用记录的资源请改为停用。")}</p>
      <button type="button" className={`${buttonQuiet} justify-self-start`} onClick={() => setConfirmDelete(false)}>{t("取消")}</button>
    </ActionForm>
  );

  return (
    <ActionForm
      key="edit"
      sticky
      noValidate
      done={done}
      onResult={(result) => {
        const saved = result as {
          machine?: Resource;
          relayToken?: string;
          hostToken?: string;
          hostWsUrl?: string;
          iotToken?: string;
          iotWsUrl?: string;
          botToken?: string;
        } | null;
        if (saved?.machine) setLive(saved.machine);
        if (saved?.botToken) {
          setBotToken(saved.botToken);
          return true;
        }
        if (saved?.hostToken) {
          setIssued({ kind: "host", token: saved.hostToken, url: saved.hostWsUrl ?? saved.machine?.hostWsUrl ?? "" });
          return true;
        }
        if (saved?.iotToken) {
          setIssued({ kind: "iot", token: saved.iotToken, url: saved.iotWsUrl ?? saved.machine?.iotWsUrl ?? "" });
          return true;
        }
        if (saved?.relayToken) {
          setIssued({ kind: "hinata", token: saved.relayToken, url: saved.machine?.relayUrl ?? "" });
          return true;
        }
        setIssued(null);
        return false;
      }}
      submit={async (f) => {
        const intent = f.get("intent");
        const issuingRelay = intent === "issue";
        const issuingHost = intent === "issue-host";
        const issuingIot = intent === "issue-iot";
        if (!name.trim()) throw new Error(t("请填写资源名称"));
        for (const id of capabilityList) {
          const reason = incomplete(id);
          if (reason) {
            setPane(id);
            if (id === "bot") {
              const invalid = Object.entries(bot.replyTemplates ?? {}).find(([key, text]) => botReplyTemplateError(key, text))
                ?? (bot.replyGroups ?? []).some((group) => Object.entries(group.templates).some(([key, text]) => botReplyTemplateError(key, text)));
              if (invalid) setBotPane("replies");
              else if (
                (bot.announceGroups ?? []).some(
                  (group) =>
                    (group.schedules ?? []).some(isScheduleRuleInvalid) ||
                    Object.entries(group.templates).some(([key, text]) => botReplyTemplateError(key, text)),
                )
              )
                setBotPane("broadcasts");
            }
            throw new Error(reason);
          }
        }
        const seats = resourceCapacity.trim() === "" ? null : Number(resourceCapacity);
        if (caps.table && seats !== null && (!Number.isInteger(seats) || seats < 2 || seats > 8)) {
          setPane("table");
          throw new Error(t("桌游容量须为 2 到 8 人"));
        }
        if (caps.hinata_io && embedded && !live?.hasRelayToken && !issuingRelay) {
          setPane("hinata_io");
          throw new Error(t("请先签发设备令牌，或改为外部中继。"));
        }
        const saved = await api<{ machine: Resource }>(`/api/v1/merchant/machines${value ? `/${value.id}` : ""}`, {
          method: value ? "PATCH" : "POST",
          body: JSON.stringify({
            shopId,
            name: name.trim(),
            aliases: aliases.map((alias) => alias.trim()).filter(Boolean),
            kind: caps.door ? "door" : "machine",
            enabled,
            ...(resourceCapacity.trim() !== "" ? { capacity: Number(resourceCapacity) } : {}),
            occupancyMinutes: Number(occupancyMinutes) || 15,
            locationOverride: resourceHasPlayerLink
              ? {
                  mode: locMode,
                  beaconNodeId: locMode === "ble" ? (locBeaconNodeId || null) : null,
                  rssiThreshold: locMode === "ble" ? locRssiThreshold : null,
                }
              : null,
            bot: caps.bot ? bot : null,
            ...(caps.bot && intent === "rotate-bot" ? { rotateBotToken: true } : {}),
            resourceGroupId: groupId,
            pricingConfigOverrideId: overrideId || null,
            table: caps.table ? { pricingConfigIds: tablePricing, startWhen: tableStart } : null,
            relayConnection: caps.hinata_io && embedded ? "embedded" : "external",
            ...(caps.hinata_io && embedded && issuingRelay && live?.hasRelayToken ? { rotateRelayToken: true } : {}),
            hinataUrl: caps.hinata_io && !embedded ? hinataUrl.trim() : null,
            ...(caps.hinata_io && !embedded && password ? { hinataPassword: password } : {}),
            homeAssistant: caps.power ? haBody(power) : null,
            climate: caps.climate ? haBody(ac) : null,
            keysEnabled: caps.keys,
            keys: caps.keys
              ? buttons.map((one) =>
                  one.mode === "gpio"
                    ? {
                        id: one.id,
                        name: one.name.trim(),
                        mode: "gpio" as const,
                        nodeId: one.nodeId,
                        pin: Number(one.pin),
                        pulseMs: Math.min(5000, Math.max(10, Number(one.pulseMs) || 80)),
                        activeLow: one.activeLow,
                      }
                    : {
                        id: one.id,
                        name: one.name.trim(),
                        mode: "keyboard" as const,
                        key: one.key,
                      },
                )
              : null,
            host: caps.host
              ? {
                  defaultProgram: hostDefaultProgram || null,
                  programs: hostPrograms.map((p) => ({ name: p.name.trim(), path: p.path.trim() })),
                }
              : null,
            ...(caps.host && issuingHost ? { rotateHostToken: true } : {}),
            iot: caps.iot ? {} : null,
            ...(caps.iot && issuingIot ? { rotateIotToken: true } : {}),
            coin: caps.coin
              ? {
                  keyId: coinChosen ? coinKeyId : null,
                  cap: caps.hinata_io && embedded && Number(coinCap) > 0 ? Number(coinCap) : null,
                  afterSwipe: caps.hinata_io && embedded && Number(coinCap) > 0 && coinAfterSwipe,
                  feedbackNodeId:
                    isGpioCoin && coinFeedbackEnabled && coinFeedbackPin.trim() !== ""
                      ? coinFeedbackNodeId || null
                      : null,
                  feedbackPin:
                    isGpioCoin && coinFeedbackEnabled && coinFeedbackPin.trim() !== ""
                      ? Number(coinFeedbackPin)
                      : null,
                  feedbackEdge: coinFeedbackEdge,
                  feedbackDebounceMs: Math.min(2000, Math.max(1, Number(coinFeedbackDebounceMs) || 50)),
                  feedbackSignal: coinFeedbackSignal,
                }
              : null,
            ttlockLockId: caps.door ? Number(lockId) : null,
          }),
        });
        const own = idle.settings?.devices[saved.machine.id];
        if ((caps.power || caps.climate) && !!own?.exclude !== idleExclude) {
          await api(idlePath(shopId, `/devices/${encodeURIComponent(saved.machine.id)}`), {
            method: "PUT",
            body: JSON.stringify({ exclude: idleExclude }),
          });
        }
        return saved;
      }}
    >
      <div className="grid gap-5 sm:min-h-[28rem] sm:grid-cols-[12rem_minmax(0,1fr)] sm:divide-x sm:divide-ink/10">
        <nav aria-label={t("资源设置")} className="flex gap-1 overflow-x-auto pb-1 sm:flex-col sm:self-start sm:pr-3">
          {sections.map((section) => {
            const cap = section.capability;
            const blockedBy = cap ? dependentCapabilities(cap, caps).map((d) => t(capabilityMeta[d].label)) : [];
            const confirming = !!cap && confirmRemoveId === cap;
            const active = pane === section.id;
            return (
              <div
                key={section.id}
                className={`flex shrink-0 items-center rounded-xl transition-colors ${active ? "bg-mint/10" : "hover:bg-ink/5"}`}
              >
                {confirming ? (
                  <div role="alertdialog" aria-label={t("确认移除")} className="flex items-center gap-1.5 px-2 py-1.5">
                    <span className="whitespace-nowrap pl-1 text-sm text-coral">{t("移除{name}？", { name: t(section.label) })}</span>
                    <button
                      type="button"
                      autoFocus
                      className="focus-ring rounded-lg bg-coral px-2 py-1 text-xs font-medium text-white"
                      onClick={() => {
                        setConfirmRemoveId(null);
                        remove(cap);
                      }}
                    >
                      {t("确认")}
                    </button>
                    <button
                      type="button"
                      className="focus-ring rounded-lg px-2 py-1 text-xs text-ink/60 hover:bg-ink/5"
                      onClick={() => setConfirmRemoveId(null)}
                    >
                      {t("取消")}
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      aria-current={active ? "page" : undefined}
                      className={`focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm ${active ? "font-semibold text-ink" : "text-ink/60 hover:text-ink"}`}
                      onClick={() => setPane(section.id)}
                    >
                      <section.icon size={16} aria-hidden="true" />
                      <span className="truncate">{t(section.label)}</span>
                      {section.problem && <span className="ml-auto size-2 shrink-0 rounded-full bg-coral" aria-label={t("待配置")} />}
                    </button>
                    {cap && (
                      <button
                        type="button"
                        disabled={blockedBy.length > 0}
                        aria-label={`${t("移除")} ${t(section.label)}`}
                        title={blockedBy.length > 0 ? t("需先移除「{names}」", { names: blockedBy.join("、") }) : t("移除")}
                        className="focus-ring mr-1.5 grid size-7 shrink-0 place-items-center rounded-lg text-ink/40 transition-colors hover:bg-coral/10 hover:text-coral disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink/40"
                        onClick={() => setConfirmRemoveId(cap)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </nav>
        <div className="grid min-w-0 content-start gap-4 sm:pl-5">
      {pane === "basic" && (
        <div className="grid gap-4">
        <PaneHeader icon={Info} title="基本信息" />
        <div className="bill-entry !mb-0 grid gap-4">
        <Field label="资源名称">
          <input
            autoFocus
            className={input}
            value={name}
            required
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="grid gap-2">
          <div>
            <span className="text-sm font-medium">{t("资源别名")}</span>
            <p className="mt-1 text-xs text-ink/50">
              {t("玩家和 Bot 可以用任意一个别名找到这个资源。")}
            </p>
          </div>
          {[...aliases, ""].map((alias, index) => {
            const draft = index === aliases.length;
            return (
              <div className="flex items-center gap-2" key={index}>
                <input
                  className={input}
                  value={alias}
                  aria-label={`${t("资源别名")} ${index + 1}`}
                  maxLength={80}
                  autoComplete="off"
                  onChange={(e) => {
                    const next = e.target.value;
                    if (index < aliases.length) {
                      setAliases(aliases.map((current, i) => (i === index ? next : current)));
                    } else if (next) {
                      setAliases([...aliases, next]);
                    }
                  }}
                  onBlur={() => {
                    if (index < aliases.length && !aliases[index]?.trim()) {
                      setAliases(aliases.filter((_, i) => i !== index));
                    }
                  }}
                />
                {!draft && (
                  <button
                    type="button"
                    className={`${buttonQuiet} size-11 shrink-0 justify-center`}
                    aria-label={`${t("移除别名")} ${index + 1}`}
                    onClick={() => setAliases(aliases.filter((_, i) => i !== index))}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        </div>
        {resourceHasPlayerLink && (
          <div className="bill-entry !mb-0 grid gap-3">
            <Field label="定位设置覆盖">
              <select
                className={input}
                value={locMode}
                onChange={(e) => setLocMode(e.target.value as ResourceLocationMode)}
              >
                <option value="inherit">{t("跟随店铺")}</option>
                <option value="gps">{t("仅 GPS")}</option>
                <option value="ble">{t("仅蓝牙信标")}</option>
                <option value="none">{t("无定位")}</option>
              </select>
            </Field>
            {locMode === "ble" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="限定蓝牙信标">
                  <select
                    className={input}
                    value={locBeaconNodeId}
                    onChange={(e) => setLocBeaconNodeId(e.target.value)}
                  >
                    <option value="">{t("店内任意蓝牙信标")}</option>
                    {iotOptions.map((opt) => (
                      <option key={opt.nodeId} value={opt.nodeId}>
                        {opt.beaconId !== null ? `${opt.label} · #${opt.beaconId}` : opt.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="grid gap-1.5">
                  <span className="text-sm font-medium">{t("感应距离覆盖")}</span>
                  <div
                    role="group"
                    aria-label={t("感应距离覆盖")}
                    className="grid min-h-11 grid-cols-4 overflow-hidden rounded-lg border border-ink/20 bg-panel"
                  >
                    {(
                      [
                        { value: null, label: "跟随店铺" },
                        { value: -65, label: "近" },
                        { value: -75, label: "标准" },
                        { value: -85, label: "远" },
                      ] as const
                    ).map((preset, idx) => {
                      const active =
                        preset.value === null
                          ? locRssiThreshold === null
                          : locRssiThreshold !== null &&
                            (preset.value === -65
                              ? locRssiThreshold >= -70
                              : preset.value === -85
                                ? locRssiThreshold <= -80
                                : locRssiThreshold > -80 && locRssiThreshold < -70);
                      return (
                        <button
                          key={String(preset.value)}
                          type="button"
                          aria-pressed={active}
                          className={`focus-ring px-1.5 py-2 text-xs font-medium transition-colors ${
                            idx > 0 ? "border-l border-ink/15" : ""
                          } ${
                            active
                              ? "bg-primary text-primary-foreground"
                              : "text-ink/70 hover:bg-ink/5 hover:text-ink"
                          }`}
                          onClick={() => setLocRssiThreshold(preset.value)}
                        >
                          {t(preset.label)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
            <Hint>
              {t("默认跟随「设置 → 位置与设备」中的店铺位置校验；也可以为此资源单独指定 GPS、蓝牙信标或免定位校验。")}
            </Hint>
          </div>
        )}
        <label className="bill-entry !mb-0 flex cursor-pointer items-center justify-between gap-3 px-3.5 py-3 text-sm font-medium">
          <span>{t("启用")}</span>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        </label>
        {value && (
          <button type="button" className={`${dangerActionBtn} justify-self-start`} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={15} aria-hidden="true" />
            {t("删除资源")}
          </button>
        )}
        </div>
      )}
      {pane === "usage" && (
        <div className="grid gap-4">
          <PaneHeader icon={Users} title="计费与占用" />
          <div className="bill-entry !mb-0 grid gap-3 sm:grid-cols-2">
              <Field label="所属资源组">
                <select className={input} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  {(groups ?? [{ id: "default", name: "默认资源组" }]).map((group) => (
                    <option key={group.id} value={group.id}>{t(group.name)}</option>
                  ))}
                </select>
              </Field>
              <Field label="计费方案覆盖">
                <select className={input} value={overrideId} onChange={(e) => setOverrideId(e.target.value)}>
                  <option value="">
                    {groupPlanName ? t("跟随资源组（{plan}）", { plan: groupPlanName }) : t("跟随资源组（不计费）")}
                  </option>
                  {billablePlans.map((plan) => (
                    <option key={plan.id} value={plan.id}>{plan.name}</option>
                  ))}
                </select>
              </Field>
            </div>
          {resourceHasPlayerLink && (
            <div className="bill-entry !mb-0 grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="容量" unit="人">
                  <input
                    className={input}
                    type="number"
                    min={caps.table ? 2 : 0}
                    max={caps.table ? 8 : 16}
                    placeholder={t("按能力自动")}
                    value={resourceCapacity}
                    onChange={(e) => setResourceCapacity(e.target.value)}
                  />
                </Field>
                {seatsFrom ? (
                  <div className="grid gap-2">
                    <span className="text-sm font-medium">{t("占用时长")}</span>
                    <p className="rounded-lg border border-ink/10 bg-panel px-3 py-2.5 text-sm text-ink/60">{t("不适用")}</p>
                  </div>
                ) : (
                  <Field label="占用时长" unit="分钟">
                    <input
                      className={input}
                      type="number"
                      min="1"
                      max="1440"
                      required
                      value={occupancyMinutes}
                      onChange={(e) => setOccupancyMinutes(e.target.value)}
                    />
                  </Field>
                )}
              </div>
              {seatsFrom && (
                <Hint>{t("{capability}按座位判断占用：入座开始，下桌结束；占用时长不适用。", { capability: t(capabilityMeta[seatsFrom].label) })}</Hint>
              )}
            </div>
          )}
        </div>
      )}
      {pane === "power" && caps.power && (
        <CapabilityPane meta={capabilityMeta.power} problem={incomplete("power")}>
          <div className="bill-entry !mb-0 grid gap-3">
            <HaEntityFields
              shopId={shopId}
              connections={ha.connections ?? []}
              draft={power}
              change={setPower}
              domains={POWER_DOMAINS}
              entityLabel="电源实体"
              entityPlaceholder="switch.maimai"
              tokenOptional={!!value?.homeAssistant}
              reload={ha.reload}
            />
          </div>
          <label className="bill-entry !mb-0 flex cursor-pointer items-center gap-2.5 px-3.5 py-3 text-sm font-medium">
            <input type="checkbox" checked={idleExclude} onChange={(e) => setIdleExclude(e.target.checked)} />
            {t("从不自动关机")}
          </label>
        </CapabilityPane>
      )}
      {pane === "climate" && caps.climate && (
        <CapabilityPane meta={capabilityMeta.climate} problem={incomplete("climate")}>
          <div className="bill-entry !mb-0 grid gap-3">
            <HaEntityFields
              shopId={shopId}
              connections={ha.connections ?? []}
              draft={ac}
              change={setAc}
              domains={CLIMATE_DOMAINS}
              entityLabel="空调实体"
              entityPlaceholder="climate.living_room"
              tokenOptional={!!value?.climate || acSharesPowerToken}
              reload={ha.reload}
            />
            {acSharesPowerToken && !value?.climate && (
              <Hint>{t("与电源控制是同一个 Home Assistant，令牌可以留空，沿用电源的令牌。")}</Hint>
            )}
            <Hint>{t("可选的模式、风速和温度范围以空调实体自己上报的为准。")}</Hint>
          </div>
          <label className="bill-entry !mb-0 flex cursor-pointer items-center gap-2.5 px-3.5 py-3 text-sm font-medium">
            <input type="checkbox" checked={idleExclude} onChange={(e) => setIdleExclude(e.target.checked)} />
            {t("从不自动关机")}
          </label>
        </CapabilityPane>
      )}
      {pane === "hinata_io" && caps.hinata_io && (
        <CapabilityPane meta={capabilityMeta.hinata_io} problem={incomplete("hinata_io")}>
          <div className="bill-entry !mb-0 grid gap-4">
            <Segmented
              label={t("连接方式")}
              options={[
                ["embedded", t("直连本平台")],
                ["external", t("外部中继")],
              ]}
              value={embedded ? "embedded" : "external"}
              onChange={(next) => setEmbedded(next === "embedded")}
            />
            {embedded ? (
              <DirectConnectPanel live={live} hasRelayToken={!!live?.hasRelayToken} />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="HINATA IO 地址">
                  <input
                    className={input}
                    required
                    placeholder="https://io.example.com"
                    value={hinataUrl}
                    onChange={(e) => setHinataUrl(e.target.value)}
                  />
                </Field>
                <Field label="连接密码" unit={value?.hasPassword ? "已设置" : undefined}>
                  <input
                    className={input}
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    placeholder={value?.hasPassword ? "••••••••" : ""}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
              </div>
            )}
            <Hint>{t("如需配置投币、测试或服务等按键，请添加「机台按键」能力。")}</Hint>
          </div>
        </CapabilityPane>
      )}
      {pane === "keys" && caps.keys && (
        <CapabilityPane
          meta={capabilityMeta.keys}
          problem={incomplete("keys")}
        >
          <div className="bill-entry !mb-0 grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{t("按键列表")}</span>
                <span className="rounded-full bg-ink/[0.05] px-2 py-0.5 text-[11px] font-medium text-ink/55 tabular-nums">
                  {t("{count} / 16", { count: String(buttons.length) })}
                </span>
              </div>
              {buttons.length < 16 && (
                <button
                  type="button"
                  className={`${compactActionBtn} border-dashed`}
                  onClick={() => {
                    const preferGpio = !caps.host && !caps.hinata_io && iotOptions.length > 0;
                    setButtons([
                      ...buttons,
                      {
                        id: newKeyId(),
                        name: buttons.length ? "" : "投币",
                        mode: preferGpio ? "gpio" : "keyboard",
                        key: buttons.length ? "" : preferGpio ? "" : "Space",
                        nodeId: preferGpio ? defaultIotOptionId() : "",
                        pin: "",
                        pulseMs: "80",
                        activeLow: true,
                      },
                    ]);
                  }}
                >
                  <Plus size={14} aria-hidden="true" />
                  {t("添加按键")}
                </button>
              )}
            </div>

            {buttons.length > 0 && (
              <div className="grid gap-2.5">
                {buttons.map((one, index) => {
                  const code = one.mode === "keyboard" && one.key.trim() ? vkFromKeyText(one.key) : null;
                  const badKey = one.mode === "keyboard" && !!one.key.trim() && code === null;
                  const set = (patch: Partial<ResourceButtonDraft>) =>
                    setButtons(buttons.map((other, at) => (at === index ? { ...other, ...patch } : other)));
                  const selectedIot = one.mode === "gpio" ? iotOptions.find((o) => o.nodeId === one.nodeId) : undefined;
                  const occupiedPins = selectedIot?.bindings
                    .filter((b) => b.deviceId !== value?.id && b.pin !== undefined)
                    .map((b) => `GPIO ${b.pin} (${b.deviceName})`);
                  return (
                    <div key={one.id} className="grid gap-2 rounded-xl border border-ink/10 bg-panel p-3">
                      {caps.coin && one.id === coinKeyId && (
                        <span className="justify-self-start rounded-full bg-mint/10 px-2 py-0.5 text-[11px] font-medium text-mint">
                          {t("用作投币按键")}
                        </span>
                      )}

                      {one.mode === "keyboard" ? (
                        <div className="grid gap-1.5">
                          <div className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(0,1.1fr)_7.5rem_minmax(0,1fr)_auto]">
                            <input
                              className={`${input} min-h-9`}
                              aria-label={t("按键名称")}
                              placeholder={t("如 投币、服务、测试")}
                              maxLength={20}
                              value={one.name}
                              onChange={(e) => set({ name: e.target.value })}
                            />
                            <select
                              className={`${input} min-h-9`}
                              aria-label={t("触发方式")}
                              value={one.mode}
                              onChange={(e) => {
                                const mode = e.target.value as "keyboard" | "gpio";
                                set({
                                  mode,
                                  ...(mode === "gpio" && !one.nodeId ? { nodeId: defaultIotOptionId() } : {}),
                                });
                              }}
                            >
                              <option value="keyboard">{t("键盘按键")}</option>
                              <option value="gpio">{t("GPIO 脉冲")}</option>
                            </select>
                            <input
                              className={`${input} min-h-9 font-mono ${badKey ? "border-red-500/70" : ""}`}
                              aria-label={t("键")}
                              aria-invalid={badKey}
                              placeholder="Space / F1"
                              maxLength={12}
                              value={one.key}
                              onChange={(e) => set({ key: e.target.value })}
                            />
                            <button
                              type="button"
                              className={`${buttonQuiet} h-9 w-9 justify-center justify-self-end text-ink/55 hover:text-coral`}
                              aria-label={t("删除按键 {name}", { name: one.name || t("未命名") })}
                              onClick={() => {
                                setButtons(buttons.filter((_, at) => at !== index));
                                if (one.id === coinKeyId) setCoinKeyId(null);
                              }}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                          {badKey && (
                            <span className="text-xs text-red-600">{t("认不出这个键")}</span>
                          )}
                        </div>
                      ) : (
                        <div className="grid gap-2">
                          <div className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(0,0.9fr)_7.5rem_minmax(0,1.25fr)_5rem_auto]">
                            <input
                              className={`${input} min-h-9`}
                              aria-label={t("按键名称")}
                              placeholder={t("如 投币、服务、测试")}
                              maxLength={20}
                              value={one.name}
                              onChange={(e) => set({ name: e.target.value })}
                            />
                            <select
                              className={`${input} min-h-9`}
                              aria-label={t("触发方式")}
                              value={one.mode}
                              onChange={(e) => {
                                const mode = e.target.value as "keyboard" | "gpio";
                                set({
                                  mode,
                                  ...(mode === "gpio" && !one.nodeId ? { nodeId: defaultIotOptionId() } : {}),
                                });
                              }}
                            >
                              <option value="keyboard">{t("键盘按键")}</option>
                              <option value="gpio">{t("GPIO 脉冲")}</option>
                            </select>
                            <select
                              className={`${input} min-h-9`}
                              aria-label={t("IoT 控制器")}
                              value={one.nodeId}
                              onChange={(e) => set({ nodeId: e.target.value })}
                            >
                              <option value="">{t("请选择控制器")}</option>
                              {iotOptions.map((opt) => (
                                <option key={opt.nodeId} value={opt.nodeId}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                            <input
                              className={`${input} min-h-9 font-mono`}
                              aria-label={t("引脚 (GPIO)")}
                              type="number"
                              min={0}
                              max={255}
                              placeholder="GPIO"
                              value={one.pin}
                              onChange={(e) => set({ pin: e.target.value })}
                            />
                            <button
                              type="button"
                              className={`${buttonQuiet} h-9 w-9 justify-center justify-self-end text-ink/55 hover:text-coral`}
                              aria-label={t("删除按键 {name}", { name: one.name || t("未命名") })}
                              onClick={() => {
                                setButtons(buttons.filter((_, at) => at !== index));
                                if (one.id === coinKeyId) setCoinKeyId(null);
                              }}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                          <details className="text-xs text-ink/60">
                            <summary className="cursor-pointer select-none hover:text-ink">
                              {t("高级脉冲参数（{ms}ms · {level}）", {
                                ms: String(Number(one.pulseMs) || 80),
                                level: t(one.activeLow ? "低电平触发" : "高电平触发"),
                              })}
                            </summary>
                            <div className="mt-2.5 flex flex-wrap items-center gap-4 border-t border-dashed border-ink/10 pt-2.5">
                              <label className="flex items-center gap-2">
                                <span>{t("脉冲时长")}</span>
                                <input
                                  className={`${input} min-h-8 !w-20 font-mono text-xs`}
                                  type="number"
                                  min={10}
                                  max={5000}
                                  value={one.pulseMs}
                                  onChange={(e) => set({ pulseMs: e.target.value })}
                                />
                                <span>ms</span>
                              </label>
                              <label className="flex cursor-pointer items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={one.activeLow}
                                  onChange={(e) => set({ activeLow: e.target.checked })}
                                />
                                <span>{t("低电平触发（常用于光耦/集电极开路）")}</span>
                              </label>
                            </div>
                          </details>
                          {occupiedPins && occupiedPins.length > 0 && (
                            <Hint>{t("该控制器已被其它资源占用的引脚：{pins}", { pins: occupiedPins.join("、") })}</Hint>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <Hint>
              {t("按键显示在后台操作面板中（玩家页面不显示）。键盘按键优先由 PRiSM Launcher 执行，未配或离线时自动回落 HINATA IO；GPIO 脉冲可选择本机或店内任意启用了「IoT 控制器」的资源。")}
            </Hint>
          </div>
        </CapabilityPane>
      )}
      {pane === "coin" && caps.coin && (
        <CapabilityPane meta={capabilityMeta.coin} problem={incomplete("coin")}>
          <div className="grid gap-4">
            <div className="bill-entry !mb-0 grid gap-3">
              <Field label="投币按键">
                <select
                  className={input}
                  value={coinChosen ? coinKeyId! : ""}
                  onChange={(e) => setCoinKeyId(e.target.value || null)}
                >
                  <option value="">{t("请选择")}</option>
                  {buttons.filter((one) => one.name.trim()).map((one) => (
                    <option key={one.id} value={one.id}>
                      {one.mode === "gpio"
                        ? `${one.name} · GPIO ${one.pin || "?"}`
                        : `${one.name} · ${one.key || "?"}`}
                    </option>
                  ))}
                </select>
              </Field>
              <Hint>
                {t("从「机台按键」中选择一个按钮作为投币触发（支持键盘按键或 GPIO 脉冲）。")}{" "}
                <button type="button" className="underline" onClick={() => setPane("keys")}>
                  {t("去编辑机台按键")}
                </button>
              </Hint>
            </div>

            {caps.hinata_io && (
              <div className="bill-entry !mb-0 grid gap-3">
                <Field label="机台投币上限">
                  <input
                    className={input}
                    type="number"
                    min="1"
                    max="99"
                    placeholder={t("不限制")}
                    disabled={!embedded}
                    value={embedded ? coinCap : ""}
                    onChange={(e) => setCoinCap(e.target.value)}
                  />
                </Field>
                <label className={toggleRowClass}>
                  <input
                    type="checkbox"
                    disabled={!embedded || !(Number(coinCap) > 0)}
                    checked={embedded && Number(coinCap) > 0 && coinAfterSwipe}
                    onChange={(e) => setCoinAfterSwipe(e.target.checked)}
                  />
                  <span>{t("自动投币：游戏取走玩家的卡后自动投一枚币")}</span>
                </label>
                <Hint>
                  {embedded
                    ? t("机台内的币达到上限后，平台不再投币，自动投币也停在上限。需要直连的 HINATA IO 1.2.4 及以上；读不到币数时按投币冷却处理，自动投币不生效。")
                    : t("投币上限和自动投币要读机台的账本和刷卡回报，只有直连的 HINATA IO 能用。")}
                </Hint>
              </div>
            )}

            {isGpioCoin && (
              <div className="bill-entry !mb-0 grid gap-3">
                <label className={toggleRowClass}>
                  <input
                    type="checkbox"
                    checked={coinFeedbackEnabled}
                    onChange={(e) => {
                      const nextEnabled = e.target.checked;
                      setCoinFeedbackEnabled(nextEnabled);
                      if (nextEnabled && !coinFeedbackNodeId) {
                        setCoinFeedbackNodeId(selectedCoinButton?.nodeId || defaultIotOptionId());
                      }
                    }}
                  />
                  <span>{t("接入实体投币回报引脚")}</span>
                </label>
                {coinFeedbackEnabled ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="IoT 控制器">
                        <select
                          className={input}
                          value={coinFeedbackNodeId}
                          onChange={(e) => setCoinFeedbackNodeId(e.target.value)}
                        >
                          <option value="">{t("请选择控制器")}</option>
                          {iotOptions.map((opt) => (
                            <option key={opt.nodeId} value={opt.nodeId}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="回报引脚 (GPIO)">
                        <input
                          className={`${input} font-mono`}
                          type="number"
                          min={0}
                          max={255}
                          placeholder="13"
                          value={coinFeedbackPin}
                          onChange={(e) => setCoinFeedbackPin(e.target.value)}
                        />
                      </Field>
                    </div>
                    <details className="text-xs text-ink/60">
                      <summary className="cursor-pointer select-none hover:text-ink">
                        {t("高级回报设置（{edge} · {ms}ms · {signal}）", {
                          edge: t(
                            coinFeedbackEdge === "rising"
                              ? "上升沿"
                              : coinFeedbackEdge === "both"
                                ? "双边沿"
                                : "下降沿",
                          ),
                          ms: String(Number(coinFeedbackDebounceMs) || 50),
                          signal: t(
                            coinFeedbackSignal === "cabinet.consumed"
                              ? "扣币回报"
                              : coinFeedbackSignal === "cabinet.activity"
                                ? "机台活动"
                                : "投币回报",
                          ),
                        })}
                      </summary>
                      <div className="mt-2.5 grid gap-3 border-t border-dashed border-ink/10 pt-2.5 sm:grid-cols-3">
                        <Field label="触发边沿">
                          <select
                            className={`${input} min-h-9 text-xs`}
                            value={coinFeedbackEdge}
                            onChange={(e) => setCoinFeedbackEdge(e.target.value as CoinFeedbackEdge)}
                          >
                            <option value="falling">{t("下降沿 (falling)")}</option>
                            <option value="rising">{t("上升沿 (rising)")}</option>
                            <option value="both">{t("双边沿 (both)")}</option>
                          </select>
                        </Field>
                        <Field label="防抖时长" unit="ms">
                          <input
                            className={`${input} min-h-9 font-mono text-xs`}
                            type="number"
                            min={1}
                            max={2000}
                            value={coinFeedbackDebounceMs}
                            onChange={(e) => setCoinFeedbackDebounceMs(e.target.value)}
                          />
                        </Field>
                        <Field label="上报事件类型">
                          <select
                            className={`${input} min-h-9 text-xs`}
                            value={coinFeedbackSignal}
                            onChange={(e) => setCoinFeedbackSignal(e.target.value as CoinFeedbackSignal)}
                          >
                            <option value="cabinet.coin">{t("投币回报 (cabinet.coin)")}</option>
                            <option value="cabinet.consumed">{t("扣币回报 (cabinet.consumed)")}</option>
                            <option value="cabinet.activity">{t("机台活动 (cabinet.activity)")}</option>
                          </select>
                        </Field>
                      </div>
                    </details>
                  </>
                ) : (
                  <Hint>{t("仅实体框体需要检测投币计数器脉冲时开启。")}</Hint>
                )}
              </div>
            )}
          </div>
        </CapabilityPane>
      )}
      {pane === "host" && caps.host && (
        <CapabilityPane meta={capabilityMeta.host} problem={incomplete("host")}>
          <div className="grid gap-4">
            <EdgeTokenPanel
              live={live}
              online={live?.hostOnline ?? null}
              hasToken={!!live?.hasHostToken}
              wsUrl={live?.hostWsUrl ?? null}
              metaLine={[
                live?.hostVersion ? `v${live.hostVersion}` : null,
                live?.hostProgram ? t("当前：{name}", { name: live.hostProgram }) : null,
              ].filter(Boolean).join(" · ") || null}
              intent="issue-host"
              issueLabel="签发 Launcher 令牌"
              rotateLabel="轮换 Launcher 令牌"
              rotateConfirmLabel="确认轮换 Launcher 令牌"
              rotateWarn="轮换后旧令牌立即失效，机台上的 prism-launcher 会断线，需要更新 launcher.json 后重启。"
            />

            <div className="bill-entry !mb-0 grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{t("可切换的游戏 / 程序")}</span>
                <button
                  type="button"
                  className={`${compactActionBtn} border-dashed`}
                  onClick={() => setHostPrograms([...hostPrograms, { name: "", path: "" }])}
                >
                  <Plus size={14} aria-hidden="true" />
                  {t("添加程序")}
                </button>
              </div>
              {hostPrograms.length > 0 ? (
                <div className="grid gap-2">
                  {hostPrograms.map((prog, index) => (
                    <div key={index} className="grid gap-2 rounded-xl border border-ink/10 bg-panel p-2.5 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
                      <input
                        className={`${input} min-h-9`}
                        placeholder={t("程序名，如 maimai")}
                        maxLength={64}
                        value={prog.name}
                        onChange={(e) => {
                          const nextName = e.target.value;
                          if (hostDefaultProgram && hostDefaultProgram === prog.name) {
                            setHostDefaultProgram(nextName);
                          }
                          setHostPrograms(hostPrograms.map((p, i) => (i === index ? { ...p, name: nextName } : p)));
                        }}
                      />
                      <input
                        className={`${input} min-h-9 font-mono text-xs`}
                        placeholder="D:\Games\maimai\start.bat"
                        maxLength={512}
                        value={prog.path}
                        onChange={(e) =>
                          setHostPrograms(hostPrograms.map((p, i) => (i === index ? { ...p, path: e.target.value } : p)))
                        }
                      />
                      <button
                        type="button"
                        className={`${buttonQuiet} h-9 w-9 justify-center text-ink/55 hover:text-coral`}
                        aria-label={t("删除程序")}
                        onClick={() => {
                          if (hostDefaultProgram === prog.name) setHostDefaultProgram("");
                          setHostPrograms(hostPrograms.filter((_, i) => i !== index));
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                  <Field label="开机默认启动程序">
                    <select
                      className={input}
                      value={hostDefaultProgram}
                      onChange={(e) => setHostDefaultProgram(e.target.value)}
                    >
                      <option value="">{t("不自动启动")}</option>
                      {hostPrograms
                        .filter((p) => p.name.trim())
                        .map((p) => (
                          <option key={p.name} value={p.name.trim()}>
                            {p.name.trim()}
                          </option>
                        ))}
                    </select>
                  </Field>
                </div>
              ) : (
                <Hint>{t("还没有配置程序。也可以不填程序列表，仅用于远程截屏、发送文字或开关机；固定按键请在「机台按键」中配置。")}</Hint>
              )}
              <Hint>{t("保存后，程序列表会自动推送到机台上的 prism-launcher，无需在机台本地维护配置。")}</Hint>
            </div>
          </div>
        </CapabilityPane>
      )}
      {pane === "iot" && caps.iot && (
        <CapabilityPane meta={capabilityMeta.iot} problem={incomplete("iot")}>
          <div className="grid gap-4">
            <EdgeTokenPanel
              live={live}
              online={live?.iotOnline ?? null}
              hasToken={!!live?.hasIotToken}
              wsUrl={live?.iotWsUrl ?? null}
              metaLine={[
                live?.iotModel ?? null,
                live?.iotVersion ? `v${live.iotVersion}` : null,
                live?.iot?.ble.beaconId ? t("信标 #{id}", { id: String(live.iot.ble.beaconId) }) : null,
              ].filter(Boolean).join(" · ") || null}
              intent="issue-iot"
              issueLabel="签发 IoT 令牌"
              rotateLabel="轮换 IoT 令牌"
              rotateConfirmLabel="确认轮换 IoT 令牌"
              rotateWarn="轮换后旧令牌立即失效，控制器会断线，需要把新令牌重新写入设备配置。"
            />

            <Hint>
              {t("控制器上线后自动作为本店蓝牙近场信标与常驻 Home Assistant 监听器。")}
            </Hint>

            {live?.iotBindings && live.iotBindings.length > 0 && (
              <div className="bill-entry !mb-0 grid gap-2">
                <span className="text-sm font-medium">{t("GPIO 引脚占用")}</span>
                <ul className="grid gap-1.5 text-xs">
                  {live.iotBindings.map((b, i) => (
                    <li key={`${b.deviceId}-${b.pin}-${i}`} className="flex items-center justify-between gap-2 rounded-lg bg-ink/[0.03] px-3 py-2">
                      <span className="font-mono font-medium">
                        {`GPIO ${b.pin} · ${t(b.direction === "input" ? "输入" : "输出")}`}
                      </span>
                      <span className="text-ink/70">
                        {`${b.deviceName}${b.label ? ` · ${b.label}` : b.signal ? ` · ${b.signal}` : ""}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </CapabilityPane>
      )}
      {pane === "door" && caps.door && (
        <CapabilityPane meta={capabilityMeta.door} problem={incomplete("door")}>
          <div className="bill-entry !mb-0 grid gap-3">
            <Field label="TTLock 门锁 ID">
              <input
                className={input}
                type="number"
                min="1"
                step="1"
                required
                value={lockId}
                onChange={(e) => setLockId(e.target.value)}
              />
            </Field>
            {ttLockMissing ? (
              <p className="rounded-xl border border-coral/25 bg-coral/[0.06] px-3.5 py-2.5 text-xs font-medium text-coral">
                {t("店铺还没有连接 TTLock 账号，开门会失败。")}{" "}
                <Link className="underline" to={`${shopPath}/settings?group=devices`}>
                  {t("去连接")}
                </Link>
              </p>
            ) : (
              <Hint>{t("TTLock 账号在「设置 → 位置与设备」中连接。")}</Hint>
            )}
          </div>
        </CapabilityPane>
      )}
      {pane === "table" && caps.table && (
        <CapabilityPane meta={capabilityMeta.table} problem={incomplete("table")}>
          <div className="grid gap-4">
            <div className="bill-entry !mb-0 grid gap-2.5">
              <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-end">
                <Field label="桌位人数" unit="人">
                  <input
                    className={input}
                    type="number"
                    min={2}
                    max={8}
                    step={1}
                    placeholder="4"
                    value={resourceCapacity}
                    onChange={(e) => setResourceCapacity(e.target.value)}
                  />
                </Field>
                <div className="grid gap-1.5">
                  <span className="text-xs text-ink/55">{t("常用桌型")}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {[2, 3, 4, 6, 8].map((n) => (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={resourceCapacity === String(n)}
                        className={`focus-ring rounded-xl border px-3 py-1.5 text-xs transition-colors ${
                          resourceCapacity === String(n)
                            ? "border-mint bg-mint/[0.10] font-semibold text-ink"
                            : "border-ink/10 bg-panel text-ink/70 hover:bg-ink/[0.03] hover:text-ink"
                        }`}
                        onClick={() => setResourceCapacity(String(n))}
                      >
                        {t("{count} 人桌", { count: n })}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <Hint>{t("支持 2 到 8 人同桌；留空默认按 4 人桌计算。")}</Hint>
            </div>
            <fieldset className="bill-entry !mb-0 grid gap-2.5">
              <legend className="mb-0.5 text-sm font-medium">{t("对局方案")}</legend>
              {pricing.filter((r) => r.enabled).length === 0 ? (
                <p className="text-sm text-ink/55">
                  {t("还没有启用中的计费规则。")}{" "}
                  <Link className="underline" to={`${shopPath}/pricing`}>
                    {t("去「计费」页创建")}
                  </Link>
                </p>
              ) : (
                <div className="grid gap-2">
                  {pricing.filter((r) => r.enabled).map((r) => (
                    <label className={optionCardClass(tablePricing[0] === r.id)} key={r.id}>
                      <input
                        type="radio"
                        name="table-pricing"
                        checked={tablePricing[0] === r.id}
                        onChange={() => setTablePricing([r.id])}
                      />
                      <span className="truncate">{r.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <fieldset className="bill-entry !mb-0 grid gap-2.5">
              <legend className="mb-0.5 text-sm font-medium">{t("何时开始对局计费")}</legend>
              {([
                ["full", "人满后一起开始", "人没坐满之前算等位，按资源自己的计费方案（例如入场）计费；坐满后所有人一起切到对局方案。"],
                ["seated", "上桌立即开始", "没有等位：每个人一坐下就按对局方案计费。"],
              ] as const).map(([mode, label, hint]) => (
                <label
                  key={mode}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-2.5 text-sm transition-colors ${
                    tableStart === mode
                      ? "border-mint bg-mint/[0.08]"
                      : "border-ink/10 bg-panel hover:bg-ink/[0.02]"
                  }`}
                >
                  <input
                    type="radio"
                    className="mt-1 shrink-0"
                    name="table-start"
                    checked={tableStart === mode}
                    onChange={() => setTableStart(mode)}
                  />
                  <span className="grid gap-0.5">
                    <span className={tableStart === mode ? "font-medium" : undefined}>{t(label)}</span>
                    <span className="text-xs text-ink/55">{t(hint)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
        </CapabilityPane>
      )}
      {pane === "bot" && caps.bot && (
        <CapabilityPane meta={capabilityMeta.bot} problem={incomplete("bot")}>
          <nav aria-label={t("Bot 设置")} className="flex flex-wrap gap-1 rounded-xl border border-ink/10 bg-ink/[0.03] p-1">
            {([
              ["permissions", "使用权限"], ["broadcasts", "播报"], ["replies", "命令回复"], ["connection", "接入凭据"],
            ] as const).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={botPane === id}
                className={`focus-ring rounded-lg px-3 py-1.5 text-xs transition-colors ${botPane === id ? "bg-panel font-medium text-ink shadow-sm" : "text-ink/60 hover:text-ink"}`}
                onClick={() => setBotPane(id)}>{t(label)}</button>
            ))}
          </nav>
          <div hidden={botPane !== "permissions"}>
            <div className="grid gap-4">
            <fieldset className="bill-entry !mb-0 grid gap-2.5">
              <legend className="mb-0.5 text-sm font-medium">{t("玩家命令")}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(["all", "readonly"] as const).map((mode) => (
                  <label key={mode} className={optionCardClass(bot.playerCommands === mode)}>
                    <input
                      type="radio"
                      name="bot-player-commands"
                      checked={bot.playerCommands === mode}
                      onChange={() => changeBot({ playerCommands: mode })}
                    />
                    {t(mode === "all" ? "全部命令" : "只读")}
                  </label>
                ))}
              </div>
              <p className="text-xs text-ink/55">{t("只读时，玩家在 Bot 里只能绑定身份、查余额和账单、兑换。")}</p>
              {bot.playerCommands === "readonly" && (
                <Field label="只读提示">
                  <input
                    className={input}
                    maxLength={200}
                    value={bot.readOnlyNotice}
                    onChange={(e) => changeBot({ readOnlyNotice: e.target.value })}
                  />
                </Field>
              )}
            </fieldset>
            <fieldset className="bill-entry !mb-0 grid gap-2.5">
              <legend className="mb-0.5 text-sm font-medium">{t("店员权限")}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {([["staffCommands", "店员代为操作"], ["powerOffStaffOnly", "仅店员可关机"]] as const).map(([key, label]) => (
                  <label key={key} className={toggleRowClass}>
                    <input type="checkbox" checked={bot[key]} onChange={(e) => changeBot({ [key]: e.target.checked })} />
                    <span>{t(label)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="bill-entry !mb-0 grid gap-2.5">
              <legend className="mb-0.5 text-sm font-medium">{t("入场与门锁")}</legend>
              <label className={toggleRowClass}>
                <input
                  type="checkbox"
                  checked={bot.doorPasswordOnEntry}
                  onChange={(e) => changeBot({ doorPasswordOnEntry: e.target.checked })}
                />
                <span>{t("入场后自动获取门锁密码")}</span>
              </label>
              <Field label="默认门锁">
                <select
                  className={input}
                  value={bot.doorResourceId ?? ""}
                  onChange={(e) => changeBot({ doorResourceId: e.target.value || null })}
                >
                  <option value="">{t(doors.length === 1 ? "自动" : "未设置")}</option>
                  {doors.map((door) => (
                    <option key={door.id} value={door.id}>{door.name}</option>
                  ))}
                </select>
              </Field>
              {bot.doorPasswordOnEntry && (
                <p className="text-xs text-ink/55">
                  {t("玩家用 login／入场 进来时，Bot 会顺带生成一个门锁临时密码并回复；不下场也会在 3 分钟后失效。没有门锁时不生效。")}
                </p>
              )}
            </fieldset>
            </div>
          </div>
          <div hidden={botPane !== "broadcasts"}>
            <div className="grid gap-4">
              <BotAnnouncementGroups
                value={bot.announceGroups ?? []}
                onChange={(announceGroups) => changeBot({ announceGroups })}
                privacyModeEnabled={privacyModeEnabled}
              />
              <div className="bill-entry !mb-0 grid gap-3">
                <Field label="闲置关机提醒提前量" unit="分钟">
                  <input
                    className={input}
                    type="number"
                    min="0"
                    max="120"
                    value={bot.idleReminderMinutes}
                    onChange={(e) => changeBot({ idleReminderMinutes: Number(e.target.value) || 0 })}
                  />
                </Field>
                <details className="border-t border-ink/[0.06] pt-3 text-xs text-ink/55">
                  <summary className="cursor-pointer font-medium text-ink/70">{t("播报说明")}</summary>
                  <p className="mt-2 leading-relaxed">
                    {t("「尝试」是有人要求做某件事，以及结果：已发出表示机器接受了命令，不代表真的完成。「事实」是真的发生了的事，比如机器开了、游戏读到了卡。同时勾选会各播报一次。每个播报组各自决定播什么、怎么说、发到哪里；同一个地方被两个组都选中时只说一次。本 Bot 自己执行的命令不会再播报。提前量为 0 时不发闲置关机提醒。")}
                  </p>
                </details>
              </div>
            </div>
          </div>
          <div hidden={botPane !== "replies"}>
            <BotReplyEditor
              value={bot.replyTemplates ?? {}}
              onChange={(replyTemplates) => changeBot({ replyTemplates })}
              groups={bot.replyGroups ?? []}
              onGroupsChange={(replyGroups) => changeBot({ replyGroups })}
              privacyModeEnabled={privacyModeEnabled}
            />
          </div>
          <div hidden={botPane !== "connection"}>
            <BotTokenPanel live={live} hasBotToken={!!live?.hasBotToken} />
          </div>
        </CapabilityPane>
      )}
      {pane === "add" && (
        <div className="grid gap-4">
          <PaneHeader icon={Plus} title="添加能力" />
          <ul className="grid gap-2.5">
            {capabilityList.filter((id) => !caps[id]).map((id) => {
              const item = capabilityMeta[id];
              const conflicts = conflictingCapabilities(id, caps);
              const missingReqs = capabilityRequires(id).filter((req) => !caps[req]);
              const blocked = conflicts.length > 0;
              return (
                <li
                  key={id}
                  className={`flex items-center gap-3.5 rounded-2xl border border-ink/10 bg-ink/[0.015] p-3.5 transition-colors ${
                    blocked ? "opacity-55" : "hover:border-ink/20 hover:bg-ink/[0.03]"
                  }`}
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-mint/10 text-mint">
                    <item.icon size={18} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span>{t(item.label)}</span>
                      {blocked && (
                        <span className="rounded-full bg-coral/10 px-2 py-0.5 text-[11px] font-medium text-coral">
                          {t("与「{names}」冲突", {
                            names: conflicts.map((c) => t(capabilityMeta[c].label)).join("、"),
                          })}
                        </span>
                      )}
                      {!blocked && missingReqs.length > 0 && (
                        <span className="rounded-full bg-mint/10 px-2 py-0.5 text-[11px] font-medium text-mint">
                          {t("将同时启用「{names}」", {
                            names: missingReqs.map((r) => t(capabilityMeta[r].label)).join("、"),
                          })}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink/55">{t(item.description)}</span>
                  </span>
                  <button
                    type="button"
                    className={compactActionBtn}
                    disabled={blocked}
                    onClick={() => enable(id)}
                  >
                    <Plus size={14} aria-hidden="true" />
                    {t("添加")}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
        </div>
      </div>
    </ActionForm>
  );
}

const compactActionBtn = `${button} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-xs`;
const dangerActionBtn = `${compactActionBtn} border-coral/25 text-coral hover:bg-coral/5`;
const toggleRowClass = "flex cursor-pointer items-center gap-2.5 rounded-xl border border-ink/10 bg-panel px-3.5 py-2.5 text-sm";
const optionCardClass = (selected: boolean) =>
  `flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2.5 text-sm transition-colors ${
    selected ? "border-mint bg-mint/[0.08] font-medium" : "border-ink/10 bg-panel hover:bg-ink/[0.02]"
  }`;
const statusPill = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";

const defaultBotSettings: BotSettings = {
  playerCommands: "all",
  readOnlyNotice: "请扫描店内二维码或碰 NFC，在网页或 App Clip 里入场、结账和操作设备。",
  staffCommands: true,
  powerOffStaffOnly: false,
  doorResourceId: null,
  doorPasswordOnEntry: false,
  announceGroups: [],
  idleReminderMinutes: 5,
};

const capabilityList = [
  "power",
  "climate",
  "hinata_io",
  "keys",
  "coin",
  "host",
  "iot",
  "door",
  "table",
  "bot",
] as const satisfies readonly CapabilityId[];

const capabilityMeta: Record<CapabilityId, { icon: LucideIcon; label: string; description: string; seats?: true }> = {
  power: { icon: Power, label: "电源控制", description: "通过 Home Assistant 读取并开关电源。" },
  climate: { icon: AirVent, label: "空调", description: "通过 Home Assistant 控制空调。" },
  hinata_io: { icon: CreditCard, label: "刷卡 · HINATA IO", description: "读取卡片与卡簿，记录谁在玩。" },
  keys: { icon: Keyboard, label: "机台按键", description: "配置键盘按键（优先 Launcher、回落 IO）或 IoT GPIO 脉冲按键。" },
  coin: { icon: Coins, label: "投币", description: "绑定一个机台按键作为投币触发，配置上限、自动投币与硬件回报。" },
  host: { icon: Monitor, label: "启动器", description: "通过 PRiSM Launcher 切换游戏、远程文字输入、截屏与开关机。" },
  iot: { icon: Cpu, label: "IoT 控制器", description: "蓝牙近场信标广播、GPIO 脉冲与输入回报、常驻 Home Assistant 监听。" },
  door: { icon: DoorOpen, label: "开门密码", description: "通过 TTLock 生成一次性开门密码。" },
  table: { icon: Ungroup, label: "桌游", description: "按座位开桌计费，适用麻将、桌游等多人同桌场景。", seats: true },
  bot: { icon: Bot, label: "店铺 Bot", description: "Koishi 等聊天机器人。" },
};

function PaneHeader({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 pb-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-mint/10 text-mint">
          <Icon size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{t(title)}</h3>
          {description && (
            <p className="mt-0.5 text-xs text-ink/55">{t(description)}</p>
          )}
        </div>
      </div>
      {action}
    </header>
  );
}

function CapabilityPane({
  meta,
  problem,
  children,
}: {
  meta: { icon: LucideIcon; label: string; description: string };
  problem: string | null;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="grid gap-4" aria-label={t(meta.label)}>
      {problem && (
        <p role="alert" className="rounded-xl border border-coral/25 bg-coral/[0.06] px-3.5 py-2.5 text-xs font-medium text-coral">
          {problem}
        </p>
      )}
      {children}
    </section>
  );
}

function EdgeTokenPanel({
  live,
  online,
  hasToken,
  wsUrl,
  metaLine,
  intent,
  issueLabel,
  rotateLabel,
  rotateConfirmLabel,
  rotateWarn,
}: {
  live: Resource | null;
  online: boolean | null;
  hasToken: boolean;
  wsUrl: string | null;
  metaLine: string | null;
  intent: "issue-host" | "issue-iot";
  issueLabel: string;
  rotateLabel: string;
  rotateConfirmLabel: string;
  rotateWarn: string;
}) {
  const { t } = useI18n();
  const statusTone =
    online === true
      ? "bg-emerald-500/10 text-[#23815d] dark:text-emerald-400"
      : online === false
        ? "bg-coral/10 text-coral"
        : "bg-ink/[0.05] text-ink/60";
  return (
    <div className="bill-entry !mb-0 grid gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink/60">{t("连接状态")}</span>
        <span className={`${statusPill} ${statusTone}`}>
          {t(online === true ? "已连接" : online === false ? "未连接" : hasToken ? "未知" : "未签发")}
        </span>
        {metaLine && <span className="text-xs text-ink/55">{metaLine}</span>}
      </div>
      {live && wsUrl && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-ink/10 bg-ink/[0.025] px-2.5 py-1.5">
          <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink/70">{wsUrl}</code>
          <CopyButton value={wsUrl} label="复制" />
        </div>
      )}
      {hasToken ? (
        <RotateTokenConfirm label={rotateLabel} warn={rotateWarn}>
          <button
            type="submit"
            name="intent"
            value={intent}
            className={`${primary} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-xs justify-self-start`}
          >
            {t(rotateConfirmLabel)}
          </button>
        </RotateTokenConfirm>
      ) : (
        <button
          type="submit"
          name="intent"
          value={intent}
          className={`${compactActionBtn} justify-self-start`}
        >
          {t(issueLabel)}
        </button>
      )}
    </div>
  );
}

function BotTokenPanel({
  live: _live,
  hasBotToken,
}: {
  live: Resource | null;
  hasBotToken: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="bill-entry !mb-0 grid gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink/60">{t("接入凭据")}</span>
        <span className={`${statusPill} ${hasBotToken ? "bg-emerald-500/10 text-[#23815d] dark:text-emerald-400" : "bg-ink/[0.05] text-ink/60"}`}>
          {t(hasBotToken ? "已签发" : "未签发")}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-ink/60">
        {t("凭据自己指明店铺，Koishi 里只需要接口地址和凭据。")}
      </p>
      {hasBotToken ? (
        <RotateTokenConfirm
          label="轮换 Bot 凭据"
          warn="轮换后旧凭据立刻失效，正在用它的 Koishi 会断线，需要把新凭据重新填进去才能连上。"
        >
          <button type="submit" name="intent" value="rotate-bot" className={`${primary} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-xs justify-self-start`}>
            {t("确认轮换 Bot 凭据")}
          </button>
        </RotateTokenConfirm>
      ) : (
        <button type="submit" name="intent" value="rotate-bot" className={`${compactActionBtn} justify-self-start`}>
          {t("签发 Bot 凭据")}
        </button>
      )}
    </div>
  );
}

function DirectConnectPanel({
  live,
  hasRelayToken,
}: {
  live: Resource | null;
  hasRelayToken: boolean;
}) {
  const { t } = useI18n();
  const statusTone =
    live?.relayOnline === true
      ? "bg-emerald-500/10 text-[#23815d] dark:text-emerald-400"
      : live?.relayOnline === false
        ? "bg-coral/10 text-coral"
        : "bg-ink/[0.05] text-ink/60";
  return (
    <div className="grid gap-3 rounded-xl border border-ink/10 bg-panel p-3.5">
      {live && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink/60">{t("连接状态")}</span>
          <span className={`${statusPill} ${statusTone}`}>
            {t(live.relayOnline === true ? "已连接" : live.relayOnline === false ? "未连接" : "未知")}
          </span>
        </div>
      )}
      {live?.relayUrl && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-ink/10 bg-ink/[0.025] px-2.5 py-1.5">
          <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink/70">{`serverUrl=${live.relayUrl}`}</code>
          <CopyButton value={`serverUrl=${live.relayUrl}`} label="复制" />
        </div>
      )}
      {hasRelayToken ? (
        <RotateTokenConfirm
          label="轮换设备令牌"
          warn="轮换后机台上的旧令牌立即失效，机台会掉线，需要把新令牌重新写进 INI 并重启才能连上。"
        >
          <button type="submit" name="intent" value="issue" className={`${primary} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-xs justify-self-start`}>
            {t("确认轮换设备令牌")}
          </button>
        </RotateTokenConfirm>
      ) : (
        <button type="submit" name="intent" value="issue" className={`${compactActionBtn} justify-self-start`}>
          {t("签发设备令牌")}
        </button>
      )}
      {live?.relayE2ee === true && (
        <p className="rounded-xl border border-coral/25 bg-coral/[0.06] px-3 py-2 text-xs font-medium text-coral">
          {t("该机台仍在发送加密消息：请把机台 INI 里的 remotePassword 清空后重启，否则平台无法下发指令。")}
        </p>
      )}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`${buttonQuiet} min-h-8 shrink-0 px-2.5 text-xs`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard access can be denied; the value stays selectable.
        }
      }}
    >
      {t(copied ? "已复制" : label)}
    </button>
  );
}

function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [string, string][];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium">{label}</span>
      <div
        className="grid grid-cols-2 gap-1 rounded-xl border border-ink/10 bg-panel p-1"
        role="radiogroup"
        aria-label={label}
      >
        {options.map(([key, text]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={value === key}
            className={`focus-ring rounded-lg px-3 py-2 text-sm transition-colors ${
              value === key
                ? "bg-mint/[0.12] font-medium text-ink shadow-sm"
                : "text-ink/60 hover:text-ink"
            }`}
            onClick={() => onChange(key)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-ink/50">{children}</p>;
}

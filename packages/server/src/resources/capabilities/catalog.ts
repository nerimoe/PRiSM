/**
 * Capability catalog.
 *
 * Every capability a device can carry is declared here once: how its config is
 * validated, which actions it offers and whether they count as play, which
 * device signals it accepts, which state it keeps, and its declarative
 * conflict, dependency, and player-link rules (`needsLink`, `conflicts`,
 * `conflictsWithAll`, `requires`).
 *
 * State authority:
 * - owned     the platform is the source of truth; stored value is the fact
 * - external  the truth lives elsewhere (Home Assistant). While a watcher
 *             watches it, every change arrives as an event and the stored value
 *             is the fact; otherwise nothing is known and a reader asks Home
 *             Assistant itself, without recording the answer (see `device-state.ts`)
 */
import { z } from "zod";
import { botReplyTemplateError, isAnnouncementKey, isShopAnnouncementSource } from "@prism/core";
import { launcherProgramSchema, launcherRootSchema, programNameSchema } from "../../hardware/node-protocol.js";

export const botReplyTemplatesSchema = z.record(z.string(), z.string()).superRefine((templates, ctx) => {
  for (const [key, text] of Object.entries(templates)) {
    const message = botReplyTemplateError(key, text);
    if (message) ctx.addIssue({ code: "custom", path: [key], message });
  }
});

export type CapabilityId =
  | "power"
  | "climate"
  | "hinata_io"
  | "keys"
  | "coin"
  | "host"
  | "iot"
  | "door"
  | "table"
  | "bot";

/** What a player or staff member asks a device to do. Names are the public action names. */
export type ActionName =
  | "power.on"
  | "power.off"
  | "power.keep"
  | "climate.on"
  | "climate.off"
  | "climate.set_mode"
  | "climate.set_temperature"
  | "climate.set_fan_mode"
  | "aime.scan"
  | "coin"
  | "key.press"
  | "host.switch"
  | "host.key"
  | "host.text"
  | "host.screenshot"
  | "host.reboot"
  | "host.shutdown"
  | "host.fs.list"
  | "host.fs.read"
  | "host.fs.write"
  | "host.fs.mkdir"
  | "host.fs.rename"
  | "host.fs.delete"
  | "host.powershell"
  | "door.open";

export type ActionSpec = {
  /** Billing treats a player who requested this as having used the device. */
  countsAsPlay: boolean;
  /** Only staff may request this from the player QR page. */
  staffOnly?: boolean;
  /** In a shop that bills, the resource's plan must be billing for the player. */
  requiresBilling?: boolean;
  /**
   * What a caller may wait for after asking (`perform({ wait: true })`): the
   * first device signal of this name that names the operation, for at most
   * `timeoutMs`. Nothing about it is recorded; it only shapes that caller's
   * answer, and the signal is an event like any other either way.
   */
  awaits?: { signal: string; timeoutMs: number };
  /** Do not persist the action's result payload (e.g. a temporary door code). */
  sensitiveResult?: boolean;
};

export type SignalSpec = {
  /** The signal shows a person is physically using the device. */
  activity: boolean;
  /** Persist the signal. Per-frame telemetry is not worth a row. */
  store: boolean;
};

export type StateSpec = { authority: "owned" | "external" };

/** Another capability bound to the same resource, as `available` sees it. */
export type BoundView = { config: unknown; secretNames: ReadonlySet<string> };

export type CapabilitySpec<Config> = {
  id: CapabilityId;
  /** Human-readable Chinese label used in conflict/dependency error messages. */
  label: string;
  /**
   * Whether this capability is player-facing and needs a scannable QR / NFC link.
   * A resource has a player link iff it has 0 capabilities OR at least one
   * enabled capability declares `needsLink: true`.
   */
  needsLink: boolean;
  /** Capabilities that cannot be combined with this one on the same resource (checked symmetrically). */
  conflicts?: readonly CapabilityId[];
  /** When true, this capability cannot be combined with ANY other capability on the same resource. */
  conflictsWithAll?: boolean;
  /** Capabilities that MUST also be enabled on the same resource. */
  requires?: readonly CapabilityId[];
  /** Value of `executorKind` in compatibility views and Bot responses. */
  legacyExecutor: "home_assistant" | "hinata_io" | "ttlock" | "machine_ws";
  legacyTargetKind: "facility" | "game_machine";
  /** Input may omit defaulted fields; the parsed output is always complete. */
  config: z.ZodType<Config, z.ZodTypeDef, unknown>;
  /** Names of encrypted values stored in `secret_json`. */
  secrets: readonly string[];
  actions: Partial<Record<ActionName, ActionSpec>>;
  signals: Record<string, SignalSpec>;
  state: Record<string, StateSpec>;
  /**
   * Whether an action is usable with this configuration (e.g. coin needs a key).
   * `others` are the resource's other bound capabilities, for one that works
   * through another (a key pressed by PRiSM Launcher or HINATA IO).
   */
  available(action: ActionName, config: Config, secrets: ReadonlySet<string>, others: ReadonlyMap<CapabilityId, BoundView>): boolean;
};

/**
 * A Home Assistant entity on one of the shop's connections. Bindings from before
 * connections existed have neither field and keep url and token in the
 * `binding` secret until they are adopted.
 */
const haEntityConfig = z
  .object({
    connectionId: z.string().min(1).optional(),
    entityId: z.string().min(1).optional(),
  })
  .passthrough();
export type HaEntityConfig = z.infer<typeof haEntityConfig>;

const haBound = (config: HaEntityConfig, secrets: ReadonlySet<string>) =>
  secrets.has("binding") || (!!config.connectionId && !!config.entityId);

/** Legacy keyboard-only key shape stored inside older `hinata_io` rows. */
const cabinetKey = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(20),
  /** Windows Virtual-Key code. */
  key: z.number().int().min(1).max(65535),
});
export type CabinetKey = z.infer<typeof cabinetKey>;

/** Unified cabinet button: either Windows keyboard VK (Launcher first, HINATA IO fallback) or IoT GPIO pulse. */
const keyboardButtonSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(20),
  mode: z.literal("keyboard").default("keyboard"),
  /** Windows Virtual-Key code. */
  key: z.number().int().min(1).max(65535),
});

const gpioButtonSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(20),
  mode: z.literal("gpio"),
  /** Shop IoT controller node id (`shop_nodes.id`, kind = 'iot'). */
  nodeId: z.string().min(1),
  /** GPIO output pin (0..255). */
  pin: z.number().int().min(0).max(255),
  /** Pulse duration in milliseconds. */
  pulseMs: z.number().int().min(10).max(5000).default(80),
  /** Whether the output pulse pulls the pin low (open-drain / optocoupler). */
  activeLow: z.boolean().default(true),
});

export const resourceButtonSchema = z.union([gpioButtonSchema, keyboardButtonSchema]);
export type ResourceButton = z.infer<typeof resourceButtonSchema>;

const keysConfig = z.object({
  buttons: z.array(resourceButtonSchema).max(16).default([]),
});
export type KeysConfig = z.infer<typeof keysConfig>;

const hinataConfig = z.object({
  transport: z.enum(["external", "embedded"]).default("external"),
  /** Legacy named keys retained for read compatibility with pre-`keys` records. */
  keys: z.array(cabinetKey).max(16).default([]),
  /** Shop-level `hinata_io` node id (`shop_nodes.id`) for the embedded relay. */
  nodeId: z.string().min(1).optional(),
  /** Durable Object name for the embedded relay. Stable across token rotation. */
  channel: z.string().min(1).optional(),
});
export type HinataConfig = z.infer<typeof hinataConfig>;

/**
 * How a resource takes a coin, and what holds every coin whichever way it goes
 * in: the cooldown, the limit, the coin events and billing all belong here.
 *
 * The actual button press (Windows keyboard via Launcher/IO or GPIO pulse via
 * an IoT controller) is defined in the resource's `keys` capability and
 * referenced by `keyId`.
 */
const coinConfig = z.object({
  /** Which button in the resource's `keys` capability performs the coin press. */
  keyId: z.string().nullable().default(null),
  /**
   * The most credits a coin through the platform may leave on the cabinet;
   * null for no limit. Read from the books a directly connected HINATA IO
   * reports (`cabinetMonitor=1`); without them the coin cooldown applies.
   */
  cap: z.number().int().min(1).max(99).nullable().default(null),
  /** A coin for the player whose card the game just took (direct IO with a limit only). */
  afterSwipe: z.boolean().default(false),
  /** Optional IoT controller node id (`shop_nodes.id`) for hardware feedback input. */
  feedbackNodeId: z.string().min(1).nullable().default(null),
  /** Optional GPIO input pin reporting coin/activity feedback from the cabinet. */
  feedbackPin: z.number().int().min(0).max(255).nullable().default(null),
  feedbackEdge: z.enum(["falling", "rising", "both"]).default("falling"),
  feedbackDebounceMs: z.number().int().min(1).max(2000).default(50),
  /** Standard signal emitted when `feedbackPin` triggers. */
  feedbackSignal: z.enum(["cabinet.coin", "cabinet.consumed", "cabinet.activity"]).default("cabinet.coin"),
});
export type CoinConfig = z.infer<typeof coinConfig>;

/** Managed PC host controlled by a PRiSM Launcher node (`shop_nodes.kind = 'launcher'`). */
const hostConfig = z.object({
  nodeId: z.string().min(1),
  defaultProgram: programNameSchema.nullable().default(null),
  programs: z.array(launcherProgramSchema).max(64).default([]),
  allowedRoots: z.array(launcherRootSchema).max(32).optional(),
}).refine(
  (cfg) =>
    new Set(cfg.programs.map((p) => p.name)).size === cfg.programs.length &&
    (cfg.defaultProgram === null || cfg.programs.some((p) => p.name === cfg.defaultProgram)),
  "默认程序必须存在于程序列表中且程序名必须唯一",
);
export type HostConfig = z.infer<typeof hostConfig>;

/** Hardware-agnostic IoT controller (`shop_nodes.kind = 'iot'`): BLE beacon, GPIO, HA watching. */
const iotConfig = z.object({
  nodeId: z.string().min(1),
  haWatch: z.boolean().default(true),
  ble: z.object({
    enabled: z.boolean().default(true),
    /** Shop-unique beacon id (1..65535), auto-allocated when enabled. */
    beaconId: z.number().int().min(1).max(65535).nullable().default(null),
    /** Calibrated RSSI at 1 m (dBm) advertised in the BLE packet. */
    txPower: z.number().int().min(-100).max(20).default(-59),
    /** Default RSSI threshold (dBm) for considering a player within range of this beacon. */
    rssiThreshold: z.number().int().min(-100).max(-20).default(-75),
  }).default({ enabled: true, beaconId: null, txPower: -59, rssiThreshold: -75 }),
});
export type IotConfig = z.infer<typeof iotConfig>;

const doorConfig = z.object({ lockId: z.number().int().positive() });
export type DoorConfig = z.infer<typeof doorConfig>;

/** A table's size is the resource's capacity, not part of this config. */
const tableConfig = z.object({
  pricingConfigIds: z.array(z.string().min(1)).max(20).default([]),
  /**
   * When the table's game plan starts. `full`: players wait at the table on
   * the resource's own plan until it is full, then the game starts for all of
   * them. `seated`: the game plan starts for each player as they sit down, so
   * there is no wait.
   */
  startWhen: z.enum(["full", "seated"]).default("full"),
});
export type TableConfig = z.infer<typeof tableConfig>;

export const power: CapabilitySpec<HaEntityConfig> = {
  id: "power",
  label: "电源控制",
  needsLink: true,
  legacyExecutor: "home_assistant",
  legacyTargetKind: "facility",
  config: haEntityConfig,
  secrets: ["binding"],
  actions: {
    "power.on": { countsAsPlay: true, requiresBilling: true },
    "power.off": { countsAsPlay: true, requiresBilling: true, staffOnly: true },
    // "I am still here": an entered player keeps a running device from being
    // switched off as idle. It never switches anything on.
    "power.keep": { countsAsPlay: true, requiresBilling: true },
  },
  signals: {},
  state: { power: { authority: "external" } },
  available: (_action, config, secrets) => haBound(config, secrets),
};

const climateAction: ActionSpec = { countsAsPlay: false, requiresBilling: true };

export const climate: CapabilitySpec<HaEntityConfig> = {
  id: "climate",
  label: "空调",
  needsLink: true,
  legacyExecutor: "home_assistant",
  legacyTargetKind: "facility",
  config: haEntityConfig,
  secrets: ["binding"],
  actions: {
    "climate.on": climateAction,
    "climate.off": climateAction,
    "climate.set_mode": climateAction,
    "climate.set_temperature": climateAction,
    "climate.set_fan_mode": climateAction,
  },
  signals: {},
  state: { climate: { authority: "external" } },
  available: (_action, config, secrets) => haBound(config, secrets),
};

/**
 * A HINATA IO stored before coin was a capability of its own (it has
 * `coinKey`: migration 0056 moves it, but a backup or an older row may still
 * hold one): the IO as it now reads, and the coin it had, if any. Null for an
 * IO stored as it is now.
 */
export function legacyCoin(ioConfig: Record<string, unknown>): { io: Record<string, unknown>; coin: CoinConfig | null } | null {
  if (!("coinKey" in ioConfig)) return null;
  const { coinKey, coinKeyId, coinMethod: _method, coinCap, coinAfterSwipe, ...io } = ioConfig;
  const code = typeof coinKey === "number" ? coinKey : 0;
  const named = Array.isArray(io.keys) ? (io.keys as CabinetKey[]) : [];
  const keys = named.length || code <= 0 ? named : [{ id: "coin", name: "投币", key: code }];
  if (code <= 0) return { io: { ...io, keys }, coin: null };
  const keyId = typeof coinKeyId === "string" ? coinKeyId : keys.find((key) => key.key === code)?.id ?? null;
  return {
    io: { ...io, keys },
    coin: coinConfig.parse({ keyId, cap: typeof coinCap === "number" ? coinCap : null, afterSwipe: coinAfterSwipe === true }),
  };
}

/** Whether a HINATA IO can be told to press a key: connected, and an external relay holding its password. */
export function ioCanPress(config: HinataConfig, secrets: ReadonlySet<string>): boolean {
  const connected = config.transport === "embedded" ? !!(config.nodeId || config.channel) : secrets.has("url");
  // An external relay rejects a plaintext key press; the embedded relay
  // authenticates the connection instead and needs no password.
  return connected && (config.transport === "embedded" || secrets.has("password"));
}

/** Whether a single button in `keys` can currently be executed given the resource's other capabilities. */
export function buttonUsable(button: ResourceButton, others: ReadonlyMap<CapabilityId, BoundView>): boolean {
  if (button.mode === "gpio") {
    return !!button.nodeId && Number.isInteger(button.pin) && button.pin >= 0 && button.pin <= 255;
  }
  const hostBound = others.get("host");
  if (hostBound && !!(hostBound.config as HostConfig).nodeId) return true;
  const io = others.get("hinata_io");
  if (io && ioCanPress(io.config as HinataConfig, io.secretNames)) return true;
  return false;
}

export const hinataIo: CapabilitySpec<HinataConfig> = {
  id: "hinata_io",
  label: "刷卡 · HINATA IO",
  needsLink: true,
  legacyExecutor: "hinata_io",
  legacyTargetKind: "game_machine",
  config: hinataConfig,
  secrets: ["url", "password"],
  actions: {
    // A game waiting for a card polls its reader continuously, so a card not
    // taken within this means it is busy elsewhere; the IO drops it after 3 s.
    "aime.scan": { countsAsPlay: true, requiresBilling: true, awaits: { signal: "card.consumed", timeoutMs: 4500 } },
  },
  signals: {
    "card.state": { activity: true, store: true },
    "card.consumed": { activity: true, store: true },
    // Games call the LED API every frame; idle attract screens do too.
    "led.set": { activity: false, store: false },
    // Read by the platform from two of the cabinet's book snapshots (`cabinet.ts`).
    "cabinet.coin": { activity: true, store: true },
    // A service/balance adjustment alone is not evidence someone is playing.
    "cabinet.credit": { activity: false, store: true },
    "cabinet.consumed": { activity: true, store: true },
    "cabinet.reset": { activity: false, store: true },
    // Told by the IO when it sees a reader come or go.
    "reader.connected": { activity: false, store: true },
    "reader.disconnected": { activity: false, store: true },
  },
  state: { link: { authority: "owned" }, cabinet: { authority: "external" }, readers: { authority: "external" }, version: { authority: "external" } },
  available(action, config, secrets) {
    if (action !== "aime.scan") return false;
    return config.transport === "embedded" ? !!(config.nodeId || config.channel) : secrets.has("url");
  },
};

export const keys: CapabilitySpec<KeysConfig> = {
  id: "keys",
  label: "机台按键",
  needsLink: true,
  legacyExecutor: "hinata_io",
  legacyTargetKind: "game_machine",
  config: keysConfig,
  secrets: [],
  actions: {
    // Staff pressing any named button on the cabinet (keyboard or GPIO): not a
    // coin, so no cooldown or limit, no coin event and no play.
    "key.press": { countsAsPlay: false, staffOnly: true },
  },
  signals: {},
  state: {},
  available(action, config, _secrets, others) {
    if (action !== "key.press") return false;
    return config.buttons.some((button) => buttonUsable(button, others));
  },
};

export const coin: CapabilitySpec<CoinConfig> = {
  id: "coin",
  label: "投币",
  needsLink: true,
  requires: ["keys"],
  legacyExecutor: "hinata_io",
  legacyTargetKind: "game_machine",
  config: coinConfig,
  secrets: [],
  actions: {
    coin: { countsAsPlay: true, requiresBilling: true },
  },
  signals: {
    "cabinet.coin": { activity: true, store: true },
    "cabinet.consumed": { activity: true, store: true },
    "cabinet.activity": { activity: true, store: true },
  },
  state: {},
  available(action, config, _secrets, others) {
    if (action !== "coin" || !config.keyId) return false;
    const keysBound = others.get("keys");
    if (!keysBound) return false;
    const button = (keysBound.config as KeysConfig).buttons.find((one) => one.id === config.keyId);
    return !!button && buttonUsable(button, others);
  },
};

export const host: CapabilitySpec<HostConfig> = {
  id: "host",
  label: "启动器",
  needsLink: true,
  legacyExecutor: "machine_ws",
  legacyTargetKind: "game_machine",
  config: hostConfig,
  secrets: [],
  actions: {
    "host.switch": { countsAsPlay: false, staffOnly: true },
    "host.key": { countsAsPlay: false, staffOnly: true },
    "host.text": { countsAsPlay: false, staffOnly: true },
    "host.screenshot": { countsAsPlay: false, staffOnly: true, sensitiveResult: true },
    "host.reboot": { countsAsPlay: false, staffOnly: true },
    "host.shutdown": { countsAsPlay: false, staffOnly: true },
    "host.fs.list": { countsAsPlay: false, staffOnly: true, sensitiveResult: true },
    "host.fs.read": { countsAsPlay: false, staffOnly: true, sensitiveResult: true },
    "host.fs.write": { countsAsPlay: false, staffOnly: true, sensitiveResult: true },
    "host.fs.mkdir": { countsAsPlay: false, staffOnly: true },
    "host.fs.rename": { countsAsPlay: false, staffOnly: true },
    "host.fs.delete": { countsAsPlay: false, staffOnly: true },
    "host.powershell": { countsAsPlay: false, staffOnly: true, sensitiveResult: true },
  },
  signals: {},
  state: { link: { authority: "owned" }, program: { authority: "external" } },
  available(action, config) {
    if (!config.nodeId) return false;
    if (action === "host.switch") return config.programs.length > 0;
    return true;
  },
};

export const iot: CapabilitySpec<IotConfig> = {
  id: "iot",
  label: "IoT 控制器",
  needsLink: false,
  conflicts: ["table", "door", "climate"],
  legacyExecutor: "machine_ws",
  legacyTargetKind: "facility",
  config: iotConfig,
  secrets: [],
  actions: {},
  signals: {},
  state: { link: { authority: "owned" } },
  available: () => false,
};

export const door: CapabilitySpec<DoorConfig> = {
  id: "door",
  label: "开门密码",
  needsLink: true,
  legacyExecutor: "ttlock",
  legacyTargetKind: "facility",
  config: doorConfig,
  secrets: [],
  actions: {
    // Opening the door is not playing a machine, and its code must not be logged.
    "door.open": { countsAsPlay: false, sensitiveResult: true },
  },
  signals: {},
  state: {},
  available: () => true,
};

export const table: CapabilitySpec<TableConfig> = {
  id: "table",
  label: "桌游",
  needsLink: true,
  legacyExecutor: "machine_ws",
  legacyTargetKind: "game_machine",
  config: tableConfig,
  secrets: [],
  actions: {},
  signals: {},
  state: {},
  available: () => false,
};

const announcementTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const announceGroupSchema = z.object({
  schedules: z.array(z.object({
    id: z.string().min(1).max(40),
    enabled: z.boolean(),
    time: announcementTime,
    additionalTimes: z.array(announcementTime).max(1439).optional(),
    text: z.string().trim().min(1).max(2000),
    date: z.string().date().optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  }).refine(rule => new Set([rule.time, ...rule.additionalTimes ?? []]).size === 1 + (rule.additionalTimes?.length ?? 0), "发送时间不能重复")
    .refine(rule => !(rule.date && rule.weekdays), "单次日期和每周重复不能同时设置"))
    .max(20).refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, "定时播报 ID 不能重复").optional(),
  id: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(40),
  to: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  events: z.record(
    z.string().refine(isAnnouncementKey, "未知的事件"),
    z.object({
      on: z.boolean().default(true),
      sources: z.array(z.string().refine(isShopAnnouncementSource, "未知的来源")).max(10).default([]),
    }),
  ).default({}),
  templates: botReplyTemplatesSchema.refine(
    (templates) => Object.keys(templates).every((key) => key.startsWith("announce.")),
    "播报组只能保存播报文案",
  ).default({}),
  /** When true, player privacy mode does not hide names in broadcasts to this group. */
  ignorePrivacyMode: z.boolean().optional(),
});

/** Per-group command reply configuration, filtering target groups/chats and privacy overrides. */
export const replyGroupSchema = z.object({
  id: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(40),
  /** Target groups/chats (`onebot:42`, `onebot:private:10001`). Use `["*"]` to match any chat not matched specifically. */
  to: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  /** Per-group command reply templates, overriding bot-level `replyTemplates`. */
  templates: botReplyTemplatesSchema.refine(
    (templates) => Object.keys(templates).every((key) => !key.startsWith("announce.")),
    "播报文案在播报组里设置",
  ).default({}),
  /** When true, commands in these chats ignore player privacy mode (e.g. `/list`). */
  ignorePrivacyMode: z.boolean().optional(),
});

const botConfig = z.object({
  replyTemplates: botReplyTemplatesSchema.refine(
    (templates) => Object.keys(templates).every((key) => !key.startsWith("announce.")),
    "播报文案在播报组里设置",
  ).default({}),
  /** Optional command reply groups for target chat filtering, custom per-group replies, and privacy overrides. */
  replyGroups: z.array(replyGroupSchema).max(10).default([]),
  tokenId: z.string().min(1),
  playerCommands: z.enum(["all", "readonly"]).default("all"),
  readOnlyNotice: z.string().max(200).default("请扫描店内二维码或碰 NFC，在网页或 App Clip 里入场、结账和操作设备。"),
  staffCommands: z.boolean().default(true),
  powerOffStaffOnly: z.boolean().default(false),
  doorResourceId: z.string().min(1).nullable().default(null),
  doorPasswordOnEntry: z.boolean().default(false),
  announceGroups: z.array(announceGroupSchema).max(10).default([]),
  idleReminderMinutes: z.number().int().min(0).max(120).default(5),
});
export type BotConfig = z.infer<typeof botConfig>;

export const bot: CapabilitySpec<BotConfig> = {
  id: "bot",
  label: "店铺 Bot",
  needsLink: false,
  conflictsWithAll: true,
  legacyExecutor: "machine_ws",
  legacyTargetKind: "facility",
  config: botConfig,
  secrets: [],
  actions: {},
  signals: { "bot.command": { activity: false, store: true } },
  state: {},
  available: () => false,
};

export const capabilities = {
  power,
  climate,
  hinata_io: hinataIo,
  keys,
  coin,
  host,
  iot,
  door,
  table,
  bot,
} as const;

export function capabilitySpec(id: string): CapabilitySpec<unknown> | null {
  return (capabilities as Record<string, CapabilitySpec<unknown>>)[id] ?? null;
}

/** Whether two capabilities conflict on the same resource (symmetric). */
export function capabilityConflicts(a: CapabilityId, b: CapabilityId): boolean {
  if (a === b) return false;
  const specA = capabilities[a];
  const specB = capabilities[b];
  return Boolean(
    specA.conflictsWithAll ||
    specB.conflictsWithAll ||
    specA.conflicts?.includes(b) ||
    specB.conflicts?.includes(a),
  );
}

/** Validate capability conflicts and dependencies on a single resource. */
export function validateCapabilitySet(
  ids: Iterable<CapabilityId>,
): { code: "CAPABILITY_CONFLICT" | "CAPABILITY_DEPENDENCY"; message: string } | null {
  const list = [...new Set(ids)];
  const set = new Set(list);
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j]!;
      if (capabilityConflicts(a, b)) {
        return {
          code: "CAPABILITY_CONFLICT",
          message: `「${capabilities[a].label}」与「${capabilities[b].label}」不能同时启用`,
        };
      }
    }
    for (const req of capabilities[a].requires ?? []) {
      if (!set.has(req)) {
        return {
          code: "CAPABILITY_DEPENDENCY",
          message: `启用「${capabilities[a].label}」需要先启用「${capabilities[req].label}」`,
        };
      }
    }
  }
  return null;
}

/**
 * Whether a resource has a player-facing QR / NFC link.
 * A resource with no capabilities is a plain check-in QR code (has a link);
 * otherwise it has a link iff at least one enabled capability declares `needsLink: true`.
 */
export function hasResourceLink(ids: Iterable<CapabilityId>): boolean {
  const list = [...ids];
  if (!list.length) return true;
  return list.some((id) => capabilities[id].needsLink);
}

/** The capability that offers an action. Each action belongs to exactly one capability. */
export function capabilityForAction(action: string): CapabilitySpec<unknown> | null {
  for (const spec of Object.values(capabilities) as CapabilitySpec<unknown>[]) {
    if (action in spec.actions) return spec;
  }
  return null;
}

export function actionSpec(action: string): ActionSpec | null {
  const spec = capabilityForAction(action);
  return spec ? (spec.actions as Record<string, ActionSpec>)[action]! : null;
}

export function isActionName(value: string): value is ActionName {
  return capabilityForAction(value) !== null;
}

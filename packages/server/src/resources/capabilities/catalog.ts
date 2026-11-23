/**
 * Capability catalog.
 *
 * Every capability a device can carry is declared here once: how its config is
 * validated, which actions it offers and whether they count as play, which
 * device signals it accepts, and which state it keeps and who is authoritative
 * for it. Every other part of the platform asks this catalog instead of looking
 * at storage columns, which is what used to let a dozen call sites disagree.
 *
 * State authority:
 * - owned     the platform is the source of truth; stored value is the fact
 * - external  the truth lives elsewhere (Home Assistant). While a HINATA IO
 *             watches it, every change arrives as an event and the stored value
 *             is the fact; otherwise nothing is known and a reader asks Home
 *             Assistant itself, without recording the answer (see `device-state.ts`)
 */
import { z } from "zod";
import { botReplyTemplateError, isAnnouncementKey, isShopAnnouncementSource } from "@prism/core";

export const botReplyTemplatesSchema = z.record(z.string(), z.string()).superRefine((templates, ctx) => {
  for (const [key, text] of Object.entries(templates)) {
    const message = botReplyTemplateError(key, text);
    if (message) ctx.addIssue({ code: "custom", path: [key], message });
  }
});

export type CapabilityId = "power" | "climate" | "hinata_io" | "coin" | "door" | "mahjong" | "bot";

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
   * through another (a coin pressed by the HINATA IO).
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

/** A key on the cabinet the shop named, such as 投币, 服务, 测试: pressed from the admin, never from a player's page. */
const cabinetKey = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(20),
  /** Windows Virtual-Key code the IO presses. */
  key: z.number().int().min(1).max(65535),
});
export type CabinetKey = z.infer<typeof cabinetKey>;

const hinataConfig = z.object({
  transport: z.enum(["external", "embedded"]).default("external"),
  /** The shop's named keys, shown as buttons in the admin; the coin may press one of them. */
  keys: z.array(cabinetKey).max(16).default([]),
  /** Durable Object name for the embedded relay. Stable across token rotation. */
  channel: z.string().min(1).optional(),
});
export type HinataConfig = z.infer<typeof hinataConfig>;

/**
 * How a resource takes a coin, and what holds every coin whichever way it goes
 * in: the cooldown, the limit, the coin events and billing all belong here.
 */
const coinConfig = z.object({
  /**
   * How a coin goes in. `key`: the resource's HINATA IO presses one of its
   * named keys (`keyId`). Other ways (a Home Assistant relay pulsing the coin
   * line) are further values here.
   */
  method: z.enum(["key"]).default("key"),
  keyId: z.string().nullable().default(null),
  /**
   * The most credits a coin through the platform may leave on the cabinet;
   * null for no limit. Read from the books a directly connected HINATA IO
   * reports (`cabinetMonitor=1`); without them the coin cooldown applies.
   */
  cap: z.number().int().min(1).max(99).nullable().default(null),
  /** A coin for the player whose card the game just took (direct IO with a limit only). */
  afterSwipe: z.boolean().default(false),
});
export type CoinConfig = z.infer<typeof coinConfig>;

const doorConfig = z.object({ lockId: z.number().int().positive() });
export type DoorConfig = z.infer<typeof doorConfig>;

/** A mahjong table's size is the resource's capacity, not part of this config. */
const mahjongConfig = z.object({
  pricingConfigIds: z.array(z.string().min(1)).max(20).default([]),
  /**
   * When the table's game plan starts. `full`: players wait at the table on
   * the resource's own plan until it is full, then the game starts for all of
   * them. `seated`: the game plan starts for each player as they sit down, so
   * there is no wait.
   */
  startWhen: z.enum(["full", "seated"]).default("full"),
});
export type MahjongConfig = z.infer<typeof mahjongConfig>;

export const power: CapabilitySpec<HaEntityConfig> = {
  id: "power",
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
  // Power can be switched outside the platform. A watcher's events keep it
  // current. Occupancy alone determines whether the device is idle.
  state: { power: { authority: "external" } },
  available: (_action, config, secrets) => haBound(config, secrets),
};

const climateAction: ActionSpec = { countsAsPlay: false, requiresBilling: true };

/**
 * A Home Assistant `climate.*` entity, such as an air conditioner. Kept apart
 * from power: its state is a mode and temperatures rather than on/off, using
 * it is not playing a machine, and an air conditioner being off must not stop
 * a machine from taking coins.
 */
export const climate: CapabilitySpec<HaEntityConfig> = {
  id: "climate",
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
    coin: { method: "key", keyId, cap: typeof coinCap === "number" ? coinCap : null, afterSwipe: coinAfterSwipe === true },
  };
}

/** Whether a HINATA IO can be told to press a key: connected, and an external relay holding its password. */
function ioCanPress(config: HinataConfig, secrets: ReadonlySet<string>): boolean {
  const connected = config.transport === "embedded" ? !!config.channel : secrets.has("url");
  // An external relay rejects a plaintext key press; the embedded relay
  // authenticates the connection instead and needs no password.
  return connected && (config.transport === "embedded" || secrets.has("password"));
}

export const hinataIo: CapabilitySpec<HinataConfig> = {
  id: "hinata_io",
  legacyExecutor: "hinata_io",
  legacyTargetKind: "game_machine",
  config: hinataConfig,
  secrets: ["url", "password"],
  actions: {
    // A game waiting for a card polls its reader continuously, so a card not
    // taken within this means it is busy elsewhere; the IO drops it after 3 s.
    "aime.scan": { countsAsPlay: true, requiresBilling: true, awaits: { signal: "card.consumed", timeoutMs: 4500 } },
    // Staff pressing any key on the cabinet, for service menus and tests: not a
    // coin, so no cooldown or limit, no coin event and no play.
    "key.press": { countsAsPlay: false, staffOnly: true },
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
  // `cabinet`: the latest book snapshot the IO read, whose truth is the cabinet's.
  // `readers` and `version`: what the IO says it has connected and what it is.
  state: { link: { authority: "owned" }, cabinet: { authority: "external" }, readers: { authority: "external" }, version: { authority: "external" } },
  available(action, config, secrets) {
    const connected = config.transport === "embedded" ? !!config.channel : secrets.has("url");
    if (!connected) return false;
    if (action === "key.press") return ioCanPress(config, secrets) && config.keys.length > 0;
    return true;
  },
};

export const coin: CapabilitySpec<CoinConfig> = {
  id: "coin",
  legacyExecutor: "hinata_io",
  legacyTargetKind: "game_machine",
  config: coinConfig,
  secrets: [],
  actions: {
    coin: { countsAsPlay: true, requiresBilling: true },
  },
  signals: {},
  state: {},
  available(action, config, _secrets, others) {
    if (action !== "coin") return false;
    switch (config.method) {
      case "key": {
        const io = others.get("hinata_io");
        if (!io || !config.keyId) return false;
        const ioConfig = io.config as HinataConfig;
        return ioCanPress(ioConfig, io.secretNames) && ioConfig.keys.some((key) => key.id === config.keyId);
      }
    }
  },
};

export const door: CapabilitySpec<DoorConfig> = {
  id: "door",
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

export const mahjong: CapabilitySpec<MahjongConfig> = {
  id: "mahjong",
  legacyExecutor: "machine_ws",
  legacyTargetKind: "game_machine",
  config: mahjongConfig,
  secrets: [],
  // Joining and leaving a table are seat changes handled by the mahjong flow,
  // not device actions.
  actions: {},
  signals: {},
  state: {},
  available: () => false,
};

/**
 * A shop bot (Koishi): what it offers players and staff, set by the shop on its
 * resource and delivered to the bot, so its own configuration is only how to
 * connect. Everything the platform already knows (staff, currency, tables,
 * doors) is derived, never configured here.
 */
/** One way a bot announces: its destinations and a whole table of what it says (`AnnouncementGroup`). */
export const announceGroupSchema = z.object({
  id: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(40),
  /** Wherever the bot can say something: a group or a person, as the bot addresses it. */
  to: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  events: z.record(
    z.string().refine(isAnnouncementKey, "未知的事件"),
    z.object({
      on: z.boolean().default(true),
      sources: z.array(z.string().refine(isShopAnnouncementSource, "未知的来源")).max(10).default([]),
    }),
  ).default({}),
  /** This group's own words; only announcement templates. */
  templates: botReplyTemplatesSchema.refine(
    (templates) => Object.keys(templates).every((key) => key.startsWith("announce.")),
    "播报组只能保存播报文案",
  ).default({}),
});

const botConfig = z.object({
  /** The words of the bot's answers to commands; what it announces is in each group's own. */
  replyTemplates: botReplyTemplatesSchema.refine(
    (templates) => Object.keys(templates).every((key) => !key.startsWith("announce.")),
    "播报文案在播报组里设置",
  ).default({}),
  /** The integration token the bot connects with. */
  tokenId: z.string().min(1),
  /** `readonly`: players may only bind, look up and redeem through the bot. */
  playerCommands: z.enum(["all", "readonly"]).default("all"),
  readOnlyNotice: z.string().max(200).default("请扫描店内二维码或碰 NFC，在网页或 App Clip 里入场、结账和操作设备。"),
  /** Staff (by their bound platform identity) may act for other players. */
  staffCommands: z.boolean().default(true),
  /** Only staff may switch machines off through the bot. */
  powerOffStaffOnly: z.boolean().default(false),
  /** The door `开门` opens; a resource with the door capability. */
  doorResourceId: z.string().min(1).nullable().default(null),
  /**
   * `login`/`入场` also hands out the door code, so a player who comes in
   * through the bot needs one command. Off by default: a code lives three
   * minutes, and a player who does not need the door should not cost one.
   */
  doorPasswordOnEntry: z.boolean().default(false),
  /**
   * Everything the bot announces, and where: each group is one audience with
   * its own table of what it says and in which words. A bot with no groups
   * announces nothing.
   */
  announceGroups: z.array(announceGroupSchema).max(10).default([]),
  /** How many minutes before an idle power-off its warning is said; 0 for never. */
  idleReminderMinutes: z.number().int().min(0).max(120).default(5),
  /** Whether the bot may be given Home Assistant connections to watch. */
});
export type BotConfig = z.infer<typeof botConfig>;

export const bot: CapabilitySpec<BotConfig> = {
  id: "bot",
  legacyExecutor: "machine_ws",
  legacyTargetKind: "facility",
  config: botConfig,
  secrets: [],
  // A bot is a party that asks for actions, not a device that performs them.
  actions: {},
  // A command someone said to it, and how it was answered (`bot-commands.ts`).
  signals: { "bot.command": { activity: false, store: true } },
  state: {},
  available: () => false,
};

export const capabilities = { power, climate, hinata_io: hinataIo, coin, door, mahjong, bot } as const;

export function capabilitySpec(id: string): CapabilitySpec<unknown> | null {
  return (capabilities as Record<string, CapabilitySpec<unknown>>)[id] ?? null;
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

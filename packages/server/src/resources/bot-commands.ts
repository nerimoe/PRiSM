/**
 * What a shop bot's commands do. The bot forwards a player's command as it was
 * typed (`command` frames, `durable-objects/shop-hub-bot.ts`); the shop hub
 * runs it here and sends what it returns as `say` frames. Who may run what is
 * decided here too: read-only mode, staff acting for someone else, whether
 * entering through this bot bills.
 *
 * Like `MachineRelay`, nothing here goes through the platform's HTTP routes:
 * the commands use the shop's services directly, and `bot-replies.ts` words
 * the result. The routes stay for bots that predate commands.
 */
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { PrismDomainError, botMessage, canonicalBotCommand, renderBotReplyTemplate, type BotMessage } from "@prism/core";
import type { Env, PrismAppDependencies, TenantShop } from "../bindings.js";
import { jsonError } from "../http.js";
import { domainErrorStatus } from "../http-errors.js";
import type { ChatIdentity } from "../durable-objects/shop-hub-bot.js";
import { confirmBinding } from "../routes/shops/binding.js";
import { mahjongState, moveMahjong } from "../routes/platform/mahjong.js";
import { loadScannedResource } from "../routes/platform/resource-ticket.js";
import { assertNotBanned } from "../routes/platform/machine-login.js";
import {
  toBillingChangeView,
  toDeviceCommandView,
  toPlayerCheckoutPreviewView,
  toPlayerCheckoutResultView,
  toRedeemGiftView,
} from "../routes/shops/views.js";
import { yuanOf } from "@prism/core";
import type { BotResource, botConfigView } from "./bot.js";
import {
  ENTRY_DOOR_FAILED,
  deviceActionMessage,
  deviceStatesMessage,
  entryMessage,
  errorReply,
  historyMessage,
  itemsMessage,
  forPlayer,
  mahjongJoinedMessage,
  mahjongLeftMessage,
  mahjongTablesMessage,
  receiptMessage,
  redeemMessage,
  settledAsPreview,
  walletAdjustedMessage,
  walletMessage,
  type Addressee,
  type Refusal,
} from "./bot-replies.js";
import { loadResources, matchesRef } from "./resource.js";
import { rosterMessage } from "./roster.js";
import { eventPlayer } from "./shop-events.js";
import { refreshActivityBill } from "../durable-objects/live-activity-billing.js";
import { notifyBotsChanged, pagesChanged } from "../durable-objects/shop-hub-client.js";
import { extractSessionIds, pushSessionEvent } from "../routes/shops/live-activity-events.js";

/** What the bot is told, as `GET integration/bot` reads it; the hub keeps it until the bot's settings change. */
export type BotView = Awaited<ReturnType<typeof botConfigView>>;

export type BotCommandContext = {
  name: string;
  env: Env;
  waitUntil(promise: Promise<unknown>): void;
  shop: TenantShop;
  deps: PrismAppDependencies;
  bot: BotResource;
  view: BotView;
  from: ChatIdentity;
  /** Whom the command is for: the person it named, otherwise who sent it. */
  who: ChatIdentity;
  /** Someone else was named: only staff come this far. */
  onBehalf: boolean;
  channel: string;
};

/** Something to say: where (by default where the command was said) and what. */
export type Say = { to?: string; message: BotMessage };

type BotCommand = {
  /** Starts billing, settles a bill or drives a device: read-only mode leaves it to staff. */
  effect?: boolean;
  /** Starts this bot's plan, which there is none of when its resource group is free. */
  entry?: boolean;
  /** May be run for someone else, by staff; `required` when it must be. */
  target?: "optional" | "required";
  run(ctx: BotCommandContext, args: string[]): Promise<Say[]>;
};

const DEFAULT_READ_ONLY_NOTICE = "请扫描店内二维码或碰 NFC，在网页或 App Clip 里入场、结账和操作设备。";
const RESOURCE_NOT_BILLED_NOTICE = "这里不计费，无需入场";
const GENERIC_FAILURE = "操作失败，请稍后再试。";

const saying = (message: BotMessage): Say[] => [{ message }];

function messageFor(ctx: BotCommandContext, scene: string, message: BotMessage, values: Parameters<typeof renderBotReplyTemplate>[3] = {}): BotMessage {
  return renderBotReplyTemplate(`${canonicalBotCommand(ctx.name)}.${scene}`, ctx.bot.config.replyTemplates, message, {
    result: message, receipt: message, reason: message, ...values,
  });
}

const answer = (ctx: BotCommandContext, scene: string, message: BotMessage, values: Parameters<typeof renderBotReplyTemplate>[3] = {}) =>
  saying(messageFor(ctx, scene, message, values));
const notice = (ctx: BotCommandContext, text: string) => answer(ctx, "notice", botMessage(text));

/* ------------------------------- who ------------------------------------- */

function identityInput(ctx: BotCommandContext) {
  return {
    identity: { provider: ctx.who.provider, subject: ctx.who.subject },
    autoRegister: !!ctx.shop.auto_register,
    ...(ctx.who.name ? { displayName: ctx.who.name } : {}),
  };
}

async function addressee(ctx: BotCommandContext, playerId: string | null): Promise<Addressee> {
  return { player: await eventPlayer(ctx.env.DB, ctx.shop.id, playerId), provider: ctx.who.provider, subject: ctx.who.subject };
}

const isStaff = (view: BotView, identity: ChatIdentity) =>
  view.staff.some((staff) => staff.provider === identity.provider && staff.subject === identity.subject);

const runtime = (ctx: BotCommandContext) => ({ env: ctx.env, executionCtx: { waitUntil: ctx.waitUntil } });

/**
 * A command moved a player's bill. Commands do not pass the routes' event bridge
 * (`routes/shops/index.ts`), so the phone's Live Activity and the player's open
 * pages are told from here. Never delays or fails the answer.
 */
function billMoved(ctx: BotCommandContext, playerId: string | null | undefined, session?: { event: "start" | "end"; ids: string[] }) {
  if (!playerId) return;
  const { env, shop } = ctx;
  ctx.waitUntil((async () => {
    await pagesChanged(env, shop.id, { player: playerId }, "billing");
    if (!session?.ids.length) return refreshActivityBill(env, shop.id, playerId, false, true);
    await pushSessionEvent({ env }, { shopId: shop.id, playerId, sessionIds: session.ids, event: session.event, initiatorClientId: null });
  })().catch((error) => console.error("Bot command event dispatch failed", error)));
}

/* ------------------------------ commands --------------------------------- */

/** A bill sent where the command was said, and privately to staff on the same platform when the bot is set to. */
function receipt(ctx: BotCommandContext, message: BotMessage): Say[] {
  const staff = ctx.view.settings.receiptsToStaff
    ? [...new Set(ctx.view.staff.filter((identity) => identity.provider === ctx.who.provider).map((identity) => `private:${identity.subject}`))]
    : [];
  return [{ message }, ...staff.map((to) => ({ to, message }))];
}

async function settled(ctx: BotCommandContext, result: Parameters<typeof toPlayerCheckoutResultView>[0], title: string): Promise<Say[]> {
  const view = toPlayerCheckoutResultView(result) as Record<string, any>;
  billMoved(ctx, view.playerSettlement?.playerId, { event: "end", ids: extractSessionIds(view, "end") });
  const who = await addressee(ctx, view.playerSettlement?.playerId ?? null);
  return receipt(ctx, messageFor(ctx, "success", receiptMessage(settledAsPreview(view), { title, preview: false, who, currency: ctx.view.currencyName, timeZone: ctx.shop.time_zone || "UTC" })));
}

async function deviceAction(
  ctx: BotCommandContext,
  type: string,
  target: { kind: "facility" | "game_machine"; ref: string },
  payload: Record<string, unknown> = {},
  options: { staffOverride?: boolean; onEntry?: boolean; count?: number } = {},
): Promise<BotMessage> {
  const action = await ctx.deps.integrationCommands.requestDeviceActionByIdentity({
    ...identityInput(ctx),
    ...(options.staffOverride ? { staffOverride: true } : {}),
    target,
    // The action remembers which bot asked, so that bot does not announce it
    // again after answering the command itself (resources/shop-events.ts).
    action: { type: type as never, payload: { ...payload, viaBot: ctx.bot.id } },
  });
  const view = toDeviceCommandView(action);
  billMoved(ctx, view.playerId as string | null | undefined);
  if (view.status === "expired" || view.status === "rejected" || view.status === "pending") {
    console.warn(JSON.stringify({ event: "bot_device_command_failed", type, failure: (view.payload as Record<string, unknown> | null)?.executorFailure ?? null }));
  }
  return deviceActionMessage(view, { type, ref: target.ref, count: options.count, onEntry: options.onEntry }, ctx.bot.config.replyTemplates);
}

async function doorCode(ctx: BotCommandContext, onEntry: boolean): Promise<BotMessage> {
  const door = ctx.view.door!;
  try {
    return await deviceAction(ctx, "door.open", { kind: "facility", ref: door.id }, {}, { onEntry });
  } catch (error) {
    if (onEntry) return messageFor({ ...ctx, name: "lock" }, "error", botMessage(ENTRY_DOOR_FAILED));
    throw error;
  }
}

function power(state: "on" | "off"): BotCommand {
  return {
    effect: true,
    async run(ctx, [ref]) {
      if (!ref?.trim()) return notice(ctx, "请指定设备");
      // Switching off may be staff's alone; staff then act as staff, not as a player.
      const staffOnly = state === "off" && !!ctx.view.settings.powerOffStaffOnly;
      if (staffOnly && !isStaff(ctx.view, ctx.from)) return notice(ctx, "关闭失败，权限不足");
      return saying(await deviceAction(ctx, `power.${state}`, { kind: "facility", ref: ref.trim() }, { state }, { staffOverride: staffOnly }));
    },
  };
}

function adjust(direction: 1 | -1): BotCommand {
  return {
    target: "required",
    async run(ctx, [raw]) {
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount <= 0) return notice(ctx, "金额必须大于 0");
      const result = await ctx.deps.integrationCommands.adjustWalletByIdentity({
        ...identityInput(ctx),
        amount: amount * direction,
        reason: direction === 1 ? "Koishi 管理员增加余额" : "Koishi 管理员扣除余额",
      });
      void result;
      const player = await ctx.deps.integrationCommands.resolvePlayerByIdentity(identityInput(ctx));
      billMoved(ctx, player.id);
      return answer(ctx, "success", walletAdjustedMessage(await addressee(ctx, player.id), amount * direction, ctx.view.currencyName));
    },
  };
}

async function mahjongTables(ctx: BotCommandContext) {
  return (await loadResources(ctx.env.DB, ctx.shop.id, ctx.env.URL_ENCRYPTION_KEY))
    .filter((resource) => resource.capabilities.has("mahjong") && resource.enabled);
}

async function mahjongTable(ctx: BotCommandContext, ref: string) {
  const table = (await mahjongTables(ctx)).find((resource) => matchesRef(resource, ref));
  if (!table) jsonError(404, "没有找到这张麻将桌", "MAHJONG_TABLE_NOT_FOUND");
  return (await loadScannedResource(runtime(ctx), ctx.shop.id, table.id))!;
}

/** The player a bot seats, as the platform knows them: refused while banned from the table or disabled. */
async function seatedPlayer(ctx: BotCommandContext, machineId: string, register: boolean) {
  await assertNotBanned(runtime(ctx), [["machine", machineId]]);
  const player = register
    ? await ctx.deps.integrationCommands.resolveOrRegisterPlayerByIdentity(identityInput(ctx))
    : await ctx.deps.integrationCommands.resolvePlayerByIdentity(identityInput(ctx));
  if (player.status !== "active") jsonError(403, "店铺玩家资格已停用", "PLAYER_DISABLED");
  return player;
}

const join: BotCommand = {
  effect: true,
  target: "optional",
  async run(ctx, [raw]) {
    const ref = raw?.trim();
    if (!ref) return notice(ctx, "请指定麻将桌，例如 /上桌 a；可先使用 /麻将列表 查看可用桌位。");
    const table = await mahjongTable(ctx, ref);
    const player = await seatedPlayer(ctx, table.id, true);
    const moved = await moveMahjong(runtime(ctx), ctx.shop, table, player, { joining: true, onBehalf: true, body: {}, viewer: { playerId: player.id } });
    const message = mahjongJoinedMessage({ name: table.name, ...moved.mahjong! });
    return answer(ctx, "success", ctx.onBehalf ? forPlayer(await addressee(ctx, player.id), message) : message);
  },
};

const entry = async (ctx: BotCommandContext): Promise<Say[]> => {
  const player = await ctx.deps.integrationCommands.resolveOrRegisterPlayerByIdentity(identityInput(ctx));
  const result = await ctx.deps.resourceBilling.activate({
    playerId: player.id,
    resourceId: ctx.bot.id,
    // Audit trail only: records which bot started this session.
    metadata: { createdBy: "integration", botResourceId: ctx.bot.id },
  });
  const planName = result.session.pricingConfigId
    ? (await ctx.deps.repositories.pricingConfigs.findById(result.session.pricingConfigId))?.name ?? null
    : null;
  const billing = toBillingChangeView(result);
  const created = result.created !== false;
  billMoved(ctx, player.id, { event: "start", ids: [result.session.id] });
  const stopped = billing.stopped as string[];
  const says = answer(ctx, ctx.onBehalf ? (created ? "behalf" : "behalfAlready") : (created ? "success" : "already"),
    entryMessage({ created, planName, stopped }, await addressee(ctx, player.id), ctx.onBehalf),
    { plan: planName ? `「${planName}」` : "场", stopped: stopped.length ? `\n结束方案：${stopped.join("、")}` : "" });
  // Entering and getting the door code as one command, when the shop asks for it.
  // A door that fails must not undo an entry that succeeded.
  if (created && ctx.view.settings.doorPasswordOnEntry && ctx.view.door) says.push({ message: await doorCode(ctx, true) });
  return says;
};

export const botCommands: Record<string, BotCommand> = {
  bind: {
    async run(ctx, [code]) {
      await confirmBinding(runtime(ctx), ctx.shop, ctx.deps, { code, provider: ctx.from.provider, subject: ctx.from.subject }, "integration");
      // A staff member binding an identity changes who the bots treat as staff.
      notifyBotsChanged(ctx.env, ctx.shop.id, { waitUntil: ctx.waitUntil });
      return answer(ctx, "success", botMessage("绑定成功，请返回网页继续操作"));
    },
  },
  login: { effect: true, entry: true, target: "optional", run: entry },
  入场: { effect: true, entry: true, target: "optional", run: entry },
  logout: {
    effect: true,
    target: "optional",
    async run(ctx) {
      const result = await ctx.deps.integrationCommands.confirmCheckoutByIdentity({ ...identityInput(ctx), closeSessionsBeforeBalanceCheck: false });
      return settled(ctx, result, "✅ 退场成功 · 结算账单");
    },
  },
  billing: {
    target: "optional",
    async run(ctx) {
      const result = await ctx.deps.integrationCommands.previewCheckoutByIdentity(identityInput(ctx));
      const view = toPlayerCheckoutPreviewView(result);
      const who = await addressee(ctx, result.settlementPreview.playerId);
      return answer(ctx, "success", receiptMessage(view, { title: "【结算账单】", preview: true, who, currency: ctx.view.currencyName, timeZone: ctx.shop.time_zone || "UTC" }));
    },
  },
  wallet: {
    target: "optional",
    async run(ctx) {
      const wallet = await ctx.deps.integrationCommands.getWalletByIdentity(identityInput(ctx));
      const rows = (wallet ?? []).map((entry: any) => ({ ...entry, quantity: yuanOf(entry.quantity) }));
      return saying(walletMessage(rows, ctx.view.currencyName, ctx.bot.config.replyTemplates));
    },
  },
  items: {
    target: "optional",
    async run(ctx) {
      const assets = JSON.parse(JSON.stringify(await ctx.deps.integrationCommands.getAssetsByIdentity(identityInput(ctx))));
      return answer(ctx, assets.holdings?.length ? "success" : "empty", itemsMessage(assets.holdings ?? [], ctx.shop.time_zone || "UTC"));
    },
  },
  history: {
    target: "optional",
    async run(ctx) {
      const history = JSON.parse(JSON.stringify(await ctx.deps.integrationCommands.getHistoryByIdentity(identityInput(ctx))));
      return answer(ctx, history.sessions?.length ? "success" : "empty", historyMessage(history.sessions ?? [], ctx.view.currencyName, ctx.shop.time_zone || "UTC"));
    },
  },
  redeem: {
    async run(ctx, [code]) {
      if (!code?.trim()) return notice(ctx, "请输入兑换码");
      const result = await ctx.deps.integrationCommands.redeemByIdentity({ ...identityInput(ctx), code: code.trim() });
      billMoved(ctx, (await ctx.deps.integrationCommands.resolvePlayerByIdentity(identityInput(ctx))).id);
      const granted = toRedeemGiftView(result).grantedAssets as Record<string, any>[];
      return answer(ctx, granted.length ? "success" : "empty", redeemMessage(granted));
    },
  },
  add: adjust(1),
  del: adjust(-1),
  overwrite: {
    target: "required",
    async run(ctx, [raw, ...reason]) {
      const total = Number(raw);
      if (!Number.isFinite(total) || total < 0) return notice(ctx, "金额必须为非负数");
      const result = await ctx.deps.integrationCommands.checkoutWithOverrideByIdentity({
        ...identityInput(ctx),
        total,
        reason: reason.join(" ").trim() || "管理员调价",
      });
      return settled(ctx, result, "✅ 覆盖结账成功 · 结算账单");
    },
  },
  list: {
    async run(ctx, args) {
      const name = args.join(" ").trim();
      if (!name) return answer(ctx, "success", rosterMessage(await ctx.deps.roster.list()));
      const roster = await ctx.deps.roster.only(name);
      if (!roster) jsonError(404, `找不到「${name}」`, "ROSTER_TARGET_NOT_FOUND");
      return answer(ctx, "success", rosterMessage(roster, true));
    },
  },
  show: {
    async run(ctx, [raw]) {
      const states = ctx.deps.staffQueries.listDeviceStates ? await ctx.deps.staffQueries.listDeviceStates() : [];
      const name = raw?.trim();
      if (!name) return answer(ctx, "success", deviceStatesMessage(states));
      const aliases = (device: (typeof states)[number]) => ((device.metadata as { aliases?: string[] } | null)?.aliases ?? []);
      const wanted = states.filter((device) => device.deviceId === name || device.label === name
        || aliases(device).some((alias) => alias.trim().toLowerCase() === name.toLowerCase()));
      return answer(ctx, "success", deviceStatesMessage(wanted, name));
    },
  },
  麻将列表: {
    async run(ctx) {
      const tables = await Promise.all((await mahjongTables(ctx)).map(async (resource) => {
        const state = await mahjongState(runtime(ctx), (await loadScannedResource(runtime(ctx), ctx.shop.id, resource.id))!, { playerId: "" });
        return { name: resource.name, aliases: resource.aliases, capacity: state?.capacity ?? 0, seats: state?.seats ?? [] };
      }));
      return answer(ctx, "success", mahjongTablesMessage(tables));
    },
  },
  mahjong: join,
  上桌: join,
  下桌: {
    effect: true,
    target: "optional",
    async run(ctx, [raw]) {
      const ref = raw?.trim();
      const named = ref ? await mahjongTable(ctx, ref) : null;
      const player = await ctx.deps.integrationCommands.resolvePlayerByIdentity(identityInput(ctx));
      // The table the player sits at: the one named, or any.
      const candidates = named ? [named] : await Promise.all((await mahjongTables(ctx)).map(async (resource) => (await loadScannedResource(runtime(ctx), ctx.shop.id, resource.id))!));
      for (const table of candidates) {
        const seat = (await mahjongState(runtime(ctx), table, { playerId: player.id }))?.seats.find((candidate) => candidate.playerId === player.id);
        if (!seat) continue;
        await seatedPlayer(ctx, table.id, false);
        const moved = await moveMahjong(runtime(ctx), ctx.shop, table, player, { joining: false, onBehalf: true, body: {}, viewer: { playerId: player.id } });
        const message = mahjongLeftMessage({ name: table.name, ...moved.mahjong! }, seat.playing, moved.billing?.remaining ?? []);
        return answer(ctx, "success", ctx.onBehalf ? forPlayer(await addressee(ctx, player.id), message) : message);
      }
      return notice(ctx, named ? `你当前不在 ${named.name}。` : "你当前未在任何麻将桌上。");
    },
  },
  lock: {
    effect: true,
    async run(ctx) {
      if (!ctx.view.door) return notice(ctx, "🔑 本店还没有设置 Bot 开的门");
      return saying(await doorCode(ctx, false));
    },
  },
  on: power("on"),
  off: power("off"),
  // Not limited by read-only mode: it never switches anything on, and the
  // platform only accepts it from an entered player for a device that is on.
  keep: {
    async run(ctx, [ref]) {
      if (!ref?.trim()) return notice(ctx, "请指定设备");
      return saying(await deviceAction(ctx, "power.keep", { kind: "facility", ref: ref.trim() }));
    },
  },
  coin: {
    effect: true,
    async run(ctx, [ref, rawCount]) {
      if (!ref?.trim()) return notice(ctx, "请指定设备");
      const count = rawCount?.trim() ? Number.parseInt(rawCount, 10) : 1;
      if (!Number.isInteger(count) || count <= 0) return notice(ctx, "数量必须是正整数");
      return saying(await deviceAction(ctx, "coin", { kind: "game_machine", ref: ref.trim() }, { count }, { count }));
    },
  },
  scan: {
    effect: true,
    async run(ctx, [ref]) {
      if (!ref?.trim()) return notice(ctx, "请指定设备");
      return saying(await deviceAction(ctx, "aime.scan", { kind: "game_machine", ref: ref.trim() }, { provider: "aime" }));
    },
  },
};
botCommands["prism.bind"] = botCommands.bind!;

/* ------------------------------ running ---------------------------------- */

/** A thrown refusal as the bot is told it: domain errors, route errors and invalid input alike. */
async function refusalOf(error: unknown): Promise<Refusal | null> {
  if (error instanceof PrismDomainError) return { code: error.code, message: error.message, status: domainErrorStatus(error.code) };
  if (error instanceof HTTPException) {
    const body = await error.getResponse().json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    return { code: body?.error?.code ?? "INTERNAL_ERROR", message: body?.error?.message ?? error.message, status: error.status };
  }
  if (error instanceof z.ZodError) return { code: "VALIDATION_FAILED", message: error.issues[0]?.message ?? "", status: 422 };
  return null;
}

/**
 * Run one command: the gates first, then the command, then its words. A
 * refusal is said like any answer; anything else is logged and said as a
 * generic failure, so internal wording never reaches a chat.
 */
export async function runBotCommand(
  input: Omit<BotCommandContext, "who" | "onBehalf"> & { name: string; args: string[]; target?: ChatIdentity },
): Promise<Say[]> {
  const ctx: BotCommandContext = { ...input, who: input.from, onBehalf: false };
  const command = botCommands[input.name];
  if (!command) return notice(ctx, "不支持这个命令");
  const { view, from } = input;
  const staff = isStaff(view, from);
  if (command.effect && view.settings.playerCommands === "readonly" && !staff) {
    return notice(ctx, view.settings.readOnlyNotice || DEFAULT_READ_ONLY_NOTICE);
  }
  if (command.entry && !view.billingEnabled) return answer(ctx, "free", botMessage(RESOURCE_NOT_BILLED_NOTICE));
  let who = from;
  if (input.target) {
    if (!command.target) return notice(ctx, "这个命令不能代他人操作");
    // Acting for another player is for staff, and only when the bot's settings allow it.
    if (input.target.provider !== from.provider) return notice(ctx, "请在目标平台使用该命令");
    if (!view.settings.staffCommands) return notice(ctx, "员工命令未启用");
    if (!staff) return notice(ctx, "权限不足");
    who = input.target;
  } else if (command.target === "required") {
    return notice(ctx, "请指定玩家");
  }
  ctx.who = who;
  ctx.onBehalf = who !== from;
  try {
    return await command.run(ctx, input.args);
  } catch (error) {
    const refusal = await refusalOf(error);
    if (!refusal || refusal.status >= 500) {
      console.error(JSON.stringify({ event: "bot_command_failed", command: input.name, message: error instanceof Error ? error.message : String(error) }));
      if (!refusal) return answer(ctx, "error", botMessage(GENERIC_FAILURE));
    }
    const checkInUrl = `${(input.env.APP_ORIGIN ?? "").replace(/\/+$/, "")}/t/${encodeURIComponent(input.shop.public_id)}`;
    return answer(ctx, "error", errorReply(input.name, input.args, refusal, checkInUrl));
  }
}

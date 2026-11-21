import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { jsonError, clientIp } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { checkShopLocation } from "../../middleware/geo.js";
import { enforceRateLimits } from "../../middleware/rate-limit.js";
import { requestOrigin, shopServices } from "../../middleware/tenant.js";
import { runPlayerOperation } from "../shops/player-operation.js";
import { assertNotBanned, getShopForMachine as getBillingShop, requireShopPlayer, requireResourcePlan } from "./machine-login.js";
import type { ScannedResource as ScannedResource } from "./resource-ticket.js";
import type { AppBindings } from "../../bindings.js";
import { can, hinataConfigOf, loadResource } from "../../resources/resource.js";
import type { CabinetKey } from "../../resources/capabilities/catalog.js";
import { createRuntimeBus } from "../../resources/capabilities/runtime.js";
import { readClimate, readPower, type ClimateState } from "../../resources/capabilities/device-state.js";
import { createCardStore } from "../../resources/cards.js";
import { notice, requestLocale } from "../../notices.js";
import { claimCoin } from "../../resources/capabilities/cabinet.js";
import type { ActionName } from "../../resources/capabilities/catalog.js";
import { logger } from "../../log.js";

const log = logger("devices");

type C = Context<AppBindings, any, any>;

export const actionSchema=z.object({
  ticket:z.string().min(1),
  operationId:z.string().uuid(),
  action:z.enum([
    "power.on","power.off","power.keep","aime.scan","coin","key.press","door.open",
    "climate.on","climate.off","climate.set_mode","climate.set_temperature","climate.set_fan_mode",
    "mahjong.join","mahjong.leave","mahjong.seat","mahjong.unseat",
  ]),
  /** Staff act on behalf of a chosen player for mahjong seats, or send a raw card. */
  playerId:z.string().min(1).optional(),
  /** A card number staff typed in: 20 digits, sent to the machine as-is. */
  cardNumber:z.string().regex(/^\d{20}$/).optional(),
  /** Which of the cabinet's named keys staff press with `key.press`. A coin always uses the cabinet's own way. */
  keyId:z.string().min(1).max(40).optional(),
  /** Climate settings. Which values an entity accepts is its own; Home Assistant rejects the rest. */
  mode:z.string().regex(/^[a-z_]{1,32}$/).optional(),
  temperature:z.number().finite().min(-20).max(60).optional(),
  fanMode:z.string().trim().min(1).max(40).optional(),
  consent:z.boolean().optional(),
  expectedRevision:z.string().optional(),
  location:z.unknown().optional(),
});

/**
 * Power state for a device page: "unmanaged" when it has no power binding. A
 * watched connection answers from the stored fact; otherwise Home Assistant is
 * asked now. Neither writes anything.
 */
export async function resourcePowerState(
  c: C,
  machine: ScannedResource,
): Promise<"on" | "off" | "unknown" | "unmanaged"> {
  const device = await loadResource(c.env.DB, machine.shop_id, machine.id);
  if (!device?.capabilities.has("power")) return "unmanaged";
  const power = await readPower({ db: c.env.DB, env: c.env, shopId: machine.shop_id }, device).catch(() => null);
  return power ?? "unknown";
}

/** Climate state for a device page; null when it has no climate binding or the state is unknown. */
export async function resourceClimateState(c: C, machine: ScannedResource): Promise<ClimateState | null> {
  const device = await loadResource(c.env.DB, machine.shop_id, machine.id);
  if (!device?.capabilities.has("climate")) return null;
  return readClimate({ db: c.env.DB, env: c.env, shopId: machine.shop_id }, device).catch(() => null);
}

/** The setting a climate action changes, checked before anything is recorded. */
function climatePayload(body: z.infer<typeof actionSchema>): Record<string, unknown> {
  if (body.action === "climate.set_mode") {
    if (!body.mode) jsonError(400, "请选择空调模式", "CLIMATE_MODE_REQUIRED");
    return { mode: body.mode };
  }
  if (body.action === "climate.set_temperature") {
    if (body.temperature === undefined) jsonError(400, "请设置温度", "CLIMATE_TEMPERATURE_REQUIRED");
    return { temperature: body.temperature };
  }
  if (body.action === "climate.set_fan_mode") {
    if (!body.fanMode) jsonError(400, "请选择风速", "CLIMATE_FAN_MODE_REQUIRED");
    return { fanMode: body.fanMode };
  }
  return {};
}

/** Refusals that are a question to the player or a guard against repeats, not someone being turned away. */
const NOT_A_REFUSAL = new Set(["CHECKIN_CONSENT_REQUIRED", "OPERATION_CONFLICT", "OPERATION_PENDING", "RATE_LIMITED", "DEVICE_UNAVAILABLE"]);

/**
 * A device action from a scanned page or the merchant board. A request that is
 * turned away (not entered, the cabinet full, switched off) is recorded as an
 * event of the resource, saying who tried and why; what the caller is answered
 * is unchanged.
 */
export async function executeResourceAction(
  c: C,
  machine: ScannedResource,
  body: z.infer<typeof actionSchema>,
  staff = false,
) {
  const user = requireUser(c);
  const seen: { playerId?: string } = {};
  const refused = async (status: number, read: () => Promise<unknown>) => {
    if (status !== 403 && status !== 409 && status !== 429) return;
    const error = ((await read().catch(() => null)) as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" ? error.code : null;
    if (!code || NOT_A_REFUSAL.has(code)) return;
    await createRuntimeBus({
      db: c.env.DB, env: c.env, shopId: machine.shop_id,
      via: { channel: staff ? "merchant" : "page", resourceId: null },
    }).refuse({
      device: { id: machine.id },
      action: body.action as ActionName,
      actor: staff ? { type: "staff", staffId: `user:${user.id}` } : seen.playerId ? { type: "player", playerId: seen.playerId } : { type: "system" },
      code,
      ...(typeof error?.message === "string" && error.message ? { message: error.message } : {}),
    }).catch((failure) => log.error(`could not record that ${body.action} on ${machine.id} was refused (${code})`, { shopId: machine.shop_id, deviceId: machine.id, action: body.action, code, error: failure }));
  };
  try {
    const response = await performResourceAction(c, machine, body, staff, seen);
    if (!response.ok) await refused(response.status, () => response.clone().json());
    return response;
  } catch (error) {
    if (error instanceof HTTPException) await refused(error.status, () => error.getResponse().clone().json());
    throw error;
  }
}

async function performResourceAction(
  c: C,
  machine: ScannedResource,
  body: z.infer<typeof actionSchema>,
  staff: boolean,
  seen: { playerId?: string },
): Promise<Response> {
  const user = requireUser(c);
  const shop = await getBillingShop(c, machine.shop_public_id);
  await assertNotBanned(c, [
    ["user", user.id],
    ["ip", clientIp(c.req.raw)],
    ["machine", machine.id],
  ]);
  const action = body.action as ActionName;
  const device = await loadResource(c.env.DB, shop.id, machine.id);
  if (!device || !can(device, action))
    jsonError(409, "这里不支持此操作", "DEVICE_ACTION_UNSUPPORTED");
  const isDoor = action === "door.open";
  const isClimate = action.startsWith("climate.");
  const climate = isClimate ? climatePayload(body) : {};
  if (!staff)
    checkShopLocation(shop, isDoor ? "checkin" : "machine", body.location);
  const billed = staff || isDoor ? null : await requireResourcePlan(c, shop, machine.id);
  const player = staff
    ? null
    : isDoor
      ? await requireShopPlayer(c, shop)
      : billed
        ? { id: billed.playerId }
        : device.capabilities.has("door")
          ? await requireShopPlayer(c, shop)
          : null;
  if (action === "coin") {
    // Only an explicit "off" blocks: an unreadable switch must not lock players out.
    if (device.capabilities.has("power") && (await readPower({ db: c.env.DB, env: c.env, shopId: shop.id }, device)) === "off")
      jsonError(409, "请先开机", "DEVICE_POWER_OFF");
  }
  if (player) seen.playerId = player.id;
  // Opening a door may start its plan: that is an entry made here, on this page or board.
  const deps = shopServices(c, shop, requestOrigin(c, staff ? "merchant" : "page"));
  // A card scan sends a card to the machine. Staff either type the 20-digit
  // card number or name a player whose bound card is used. The number is
  // handed to the runner only; it is never stored.
  let accessCode: string | null = null;
  if (staff && action === "aime.scan") {
    if (body.cardNumber) {
      accessCode = body.cardNumber;
    } else if (body.playerId) {
      // The player's most recently used card at this shop, decrypted for the
      // machine only.
      accessCode = await createCardStore(c.env.DB, shop.id, c.env.URL_ENCRYPTION_KEY).latestOf(body.playerId);
      if (!accessCode)
        jsonError(409, "该玩家没有绑定的卡片", "SCAN_IDENTITY_NOT_BOUND_TO_PLAYER");
    } else {
      jsonError(400, "请输入卡号或选择玩家", "CARD_REQUIRED");
    }
  }
  // Staff may press any key on the cabinet (`key.press`), which is not a coin.
  // A coin is always the cabinet's own coin, so its key is never the caller's.
  let pressed: CabinetKey | null = null;
  if (action === "key.press") {
    if (!staff) jsonError(403, "只有店员可以按键", "FORBIDDEN");
    pressed = hinataConfigOf(device)?.keys.find((key) => key.id === body.keyId) ?? null;
    if (!pressed) jsonError(404, "没有这个按键", "KEY_NOT_FOUND");
  }
  return runPlayerOperation(
    c,
    shop.id,
    `${staff ? "staff-device" : "device"}/${machine.id}/${body.action}`,
    body,
    async () => {
      if (!c.env.RATE_LIMIT_10) jsonError(503, "限流服务尚未配置", "RATE_LIMIT_UNAVAILABLE");
      await enforceRateLimits(c, [
        {
          key: `device:${machine.id}:${user.id}`,
          limit: 10,
          windowSeconds: 60,
        },
      ]);
      if (action === "coin") {
        // The cooldown keeps players from coining in a burst; staff coin on purpose. The limit holds for both.
        const claim = await claimCoin(c.env.DB, shop.id, device, body.operationId, { cooldown: !staff });
        if (claim === "full") jsonError(409, "达到机台投币上限", "COIN_CABINET_FULL");
        if (claim === "cooldown") jsonError(429, "请稍后再投币", "COIN_COOLDOWN");
      }
      // Opening a door starts the door's plan when the player agreed to it, as
      // scanning any other resource and confirming does.
      if (!staff && isDoor &&
          !(await deps.resourceBilling.admits({ resourceId: machine.id, playerId: player!.id }))) {
        if (!body.consent)
          jsonError(409, "请确认计费规则", "CHECKIN_CONSENT_REQUIRED");
        await deps.resourceBilling.activate({
          resourceId: machine.id,
          playerId: player!.id,
        });
      }
      await c.env.DB.prepare(
        "UPDATE player_operations SET device_id=? WHERE shop_id=? AND user_id=? AND id=?",
      )
        .bind(machine.id, shop.id, user.id, body.operationId)
        .run();

      const bus = createRuntimeBus({ db: c.env.DB, env: c.env, shopId: shop.id, via: { channel: staff ? "merchant" : "page", resourceId: null } });
      const done = await bus.perform({
        device,
        action,
        actor: player ? { type: "player", playerId: player.id } : { type: "staff", staffId: `user:${user.id}` },
        operationId: body.operationId,
        // Which key staff pressed is kept with the event; a card number is not.
        payload: { holder: player?.id ?? user.id, ...climate, ...(pressed ? { key: pressed.key, keyId: pressed.id, keyName: pressed.name } : {}) },
        // Staff swiping or coining for a named player act for them.
        ...(staff && body.playerId ? { forPlayerId: body.playerId } : {}),
        ...(accessCode ? { transient: { accessCode } } : {}),
      });
      if (done.operation.status !== "succeeded") {
        return c.json(
          {
            error: {
              code: "DEVICE_UNAVAILABLE",
              message: isDoor ? "获取开门密码失败，请联系店员" : "设备连接失败，请联系店员检查设备或配置",
              details: { operationId: body.operationId },
            },
          },
          502,
        );
      }
      // A power or climate action answers with what the device shows now, read back by the bus;
      // the page shows it without knowing where it came from. The player's bill on their phone
      // and the idle rule follow from the request's own events (`events/subscribers.ts`).
      // A coin leaves no state to show, so the player is told it went in.
      const notices = action === "coin" ? [notice("COIN_SENT", requestLocale(c.req.header("accept-language")))] : undefined;
      return c.json({ operationId: body.operationId, ...done.result, ...(done.device ? { device: done.device } : {}), ...(notices ? { notices } : {}) });
    },
  );
}

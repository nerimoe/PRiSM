/**
 * Hardware runners for the capability catalog, plus the per-request bus that
 * wires them to the readers in `device-state.ts`. Runners only talk to
 * hardware; recording what happened is the bus's job.
 */
import { createOccupancy } from "../occupancy/service.js";
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { createD1Executor } from "@prism/adapter-d1";
import { normalizeTTLockConnectionConfig } from "@prism/application";
import { createDeviceEventRepository } from "@prism/storage-sql";
import type { Env } from "../../bindings.js";
import { callHomeAssistantPower, callHomeAssistantService } from "../../hardware/home-assistant.js";
import { normalizeHinataUrl, sendHinataCard, sendHinataCoin } from "../../hardware/hinata.js";
import { TTLockClient } from "../../hardware/ttlock.js";
import { machineRelayNamespace } from "../../gateway/machine-relay-gateway.js";
import { createDeviceBus, type ActionRunner, type PerformInput, type PerformResult, type RunOutcome } from "./bus.js";
import { doorConfigOf, hinataConfigOf, readSecret } from "../resource.js";
import { deviceRead, machinePoweredOff } from "../../durable-objects/shop-hub-client.js";
import { announceShopEvent, eventPlayer } from "../shop-events.js";
import { climateSetting, deviceView, haBinding, readAfterAction, readClimate, readPower, type DeviceView } from "./device-state.js";

const KEY_PRESS_TTL_MS = 30_000;
const HA_TIMEOUT_MS = 10_000;
/**
 * A game waiting for a card polls its reader continuously, so an unread card
 * means it is busy elsewhere; the IO drops the card after 3 s.
 */
const CARD_LOGIN_WAIT = { readMs: 4500 };

export type DeviceRuntime = {
  db: D1DatabaseLike;
  env: Env;
  shopId: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  id?: () => string;
  /**
   * Tell the shop hub when an action switches a HINATA IO off, so it stops
   * waiting for that IO. The hub's own idle power-off sets this to false.
   */
  notifyHub?: boolean;
};

/**
 * Keep a running device from being switched off as idle. Nothing is sent to
 * Home Assistant, so it can never switch a device on; a device that is off
 * (or whose state cannot be read) is refused.
 */
function keepRunner(runtime: DeviceRuntime): ActionRunner {
  return async ({ device }) => {
    const power = await readPower(runtime, device);
    if (power === "on") return { outcome: "ok" };
    return { outcome: "failed", message: power === "off" ? "设备已关机" : "读取不到设备电源状态" };
  };
}

function powerRunner(runtime: DeviceRuntime, service: "turn_on" | "turn_off"): ActionRunner {
  return async ({ device }) => {
    const binding = await haBinding(runtime, device);
    if (!binding) return { outcome: "failed", message: "电源未配置" };
    return relayOutcome(await callHomeAssistantPower({
      baseUrl: binding.url,
      accessToken: binding.token,
      entityId: binding.entityId,
      service,
      fetch: runtime.fetcher,
      timeoutMs: HA_TIMEOUT_MS,
    }));
  };
}

function climateRunner(
  runtime: DeviceRuntime,
  service: string,
  data: (payload: Record<string, unknown>) => Record<string, unknown> | null,
): ActionRunner {
  return async ({ device, payload }) => {
    const binding = await haBinding(runtime, device, "climate");
    if (!binding) return { outcome: "failed", message: "空调未配置" };
    const body = data(payload);
    if (!body) return { outcome: "failed", message: "空调操作缺少参数" };
    return relayOutcome(await callHomeAssistantService({
      baseUrl: binding.url,
      accessToken: binding.token,
      entityId: binding.entityId,
      domain: "climate",
      service,
      data: body,
      fetch: runtime.fetcher,
      timeoutMs: HA_TIMEOUT_MS,
    }));
  };
}

/** Map an HTTP call result: no status means the request may still have arrived. */
function relayOutcome(result: { ok: boolean; status: number; error?: string }): RunOutcome {
  if (result.ok) return { outcome: "ok" };
  if (result.status === 0) return { outcome: "unknown", message: result.error ?? "机台未响应" };
  return { outcome: "failed", message: result.error ?? "机台通信失败", httpStatus: result.status };
}

function cardRunner(runtime: DeviceRuntime): ActionRunner {
  return async ({ device, operationId, payload }) => {
    const accessCode = typeof payload.accessCode === "string" ? payload.accessCode : "";
    if (!accessCode) return { outcome: "failed", message: "缺少卡号" };
    const config = hinataConfigOf(device)!;
    // `source` carries the operation id so the machine's card report can be
    // tied back to this request.
    if (config.transport === "embedded") {
      const relay = machineRelayNamespace(runtime.env);
      if (!relay || !config.channel) return { outcome: "failed", message: "直连中继尚未配置" };
      const sent = await relay.getByName(config.channel).sendCard({
        accessCode,
        source: operationId,
        ...(payload.awaitLogin === true ? { wait: CARD_LOGIN_WAIT } : {}),
      });
      if (!sent.ok) return { outcome: "failed", message: sent.error ?? "机台未在线" };
      return { outcome: "ok", ...(sent.login ? { result: { login: sent.login } } : {}) };
    }
    const url = await readSecret(runtime.db, device, "hinata_io", "url", runtime.env.URL_ENCRYPTION_KEY);
    if (!url) return { outcome: "failed", message: "机台未配置连接地址" };
    const password = await readSecret(runtime.db, device, "hinata_io", "password", runtime.env.URL_ENCRYPTION_KEY);
    return relayOutcome(await sendHinataCard(normalizeHinataUrl(url), accessCode, password, operationId, {
      fetcher: runtime.fetcher,
    }));
  };
}

function coinRunner(runtime: DeviceRuntime): ActionRunner {
  return async ({ device, operationId, payload }) => {
    const config = hinataConfigOf(device)!;
    const count = typeof payload.count === "number" ? payload.count : 1;
    // Staff may press a key of their choosing; otherwise the device's
    // configured coin key is used.
    const key = typeof payload.key === "number" ? payload.key : config.coinKey;
    if (config.transport === "embedded") {
      const relay = machineRelayNamespace(runtime.env);
      if (!relay || !config.channel) return { outcome: "failed", message: "直连中继尚未配置" };
      const sent = await relay.getByName(config.channel).sendKeyPress({
        key,
        count,
        messageId: operationId,
        expiresAt: (runtime.now?.() ?? new Date()).getTime() + KEY_PRESS_TTL_MS,
      });
      return sent.ok ? { outcome: "ok" } : { outcome: "failed", message: sent.error ?? "机台未在线" };
    }
    const url = await readSecret(runtime.db, device, "hinata_io", "url", runtime.env.URL_ENCRYPTION_KEY);
    if (!url) return { outcome: "failed", message: "机台未配置连接地址" };
    const password = await readSecret(runtime.db, device, "hinata_io", "password", runtime.env.URL_ENCRYPTION_KEY);
    return relayOutcome(await sendHinataCoin(normalizeHinataUrl(url), key, password, operationId, {
      count,
      fetcher: runtime.fetcher,
    }));
  };
}

function doorRunner(runtime: DeviceRuntime): ActionRunner {
  return async ({ device, payload }) => {
    const config = doorConfigOf(device)!;
    // TTLock credentials are one account per shop, not per lock.
    const row = await runtime.db
      .prepare("SELECT value_json FROM app_settings WHERE shop_id=? AND key='devices.ttlock_connection'")
      .bind(runtime.shopId)
      .first<{ value_json: string }>();
    const connection = normalizeTTLockConnectionConfig(row ? JSON.parse(row.value_json) : undefined);
    if (!connection.accessToken && !connection.refreshToken && !(connection.appAccount && connection.appPwd)) {
      return { outcome: "failed", message: "店家尚未配置门锁" };
    }
    const fetcher = runtime.fetcher ?? fetch;
    const client = new TTLockClient({
      connection,
      fetcher: (url, init) => fetcher(url, { ...init, signal: AbortSignal.timeout(HA_TIMEOUT_MS) }),
      onConnectionUpdated: async (value) => {
        await runtime.db
          .prepare("UPDATE app_settings SET value_json=?,updated_at=? WHERE shop_id=? AND key='devices.ttlock_connection'")
          .bind(JSON.stringify(value), new Date().toISOString(), runtime.shopId)
          .run();
      },
    });
    const holder = typeof payload.holder === "string" ? payload.holder : "prism";
    const code = await client.createRandomTemporaryPassword(config.lockId, `prism:${holder}`);
    return { outcome: "ok", result: { temporaryPassword: code.password, expiresAt: code.expiresAt } };
  };
}

/** What a successful platform action tells the shop's bots, if anything. */
async function announceAction(runtime: DeviceRuntime, input: PerformInput, playerId: string | null, started: boolean) {
  const viaBot = typeof input.payload?.viaBot === "string" ? input.payload.viaBot : null;
  const place = { resourceId: input.device.id, resourceName: input.device.name, ...(viaBot ? { botId: viaBot } : {}) };
  const player = () => eventPlayer(runtime.db, runtime.shopId, playerId);
  if (input.action === "power.on" || input.action === "power.off") {
    await announceShopEvent(runtime.env, runtime.shopId, {
      kind: "power", ...place, state: input.action === "power.on" ? "on" : "off", by: input.actor.type, player: await player(),
    });
  } else if (input.action === "aime.scan") {
    await announceShopEvent(runtime.env, runtime.shopId, { kind: "card", ...place, player: await player(), started });
  } else if (input.action === "coin") {
    await announceShopEvent(runtime.env, runtime.shopId, { kind: "coin", ...place, player: await player(), started });
  } else if (started) {
    const who = await player();
    if (who) await announceShopEvent(runtime.env, runtime.shopId, { kind: "occupancy", ...place, player: who });
  }
}

export function createRuntimeBus(runtime: DeviceRuntime) {
  const runners: Record<string, ActionRunner> = {
    "power.on": powerRunner(runtime, "turn_on"),
    "power.off": powerRunner(runtime, "turn_off"),
    "power.keep": keepRunner(runtime),
    "climate.on": climateRunner(runtime, "turn_on", () => ({})),
    "climate.off": climateRunner(runtime, "turn_off", () => ({})),
    "climate.set_mode": climateRunner(runtime, "set_hvac_mode", (p) =>
      typeof p.mode === "string" && p.mode ? { hvac_mode: p.mode } : null),
    "climate.set_temperature": climateRunner(runtime, "set_temperature", (p) =>
      typeof p.temperature === "number" && Number.isFinite(p.temperature) ? { temperature: p.temperature } : null),
    "climate.set_fan_mode": climateRunner(runtime, "set_fan_mode", (p) =>
      typeof p.fanMode === "string" && p.fanMode ? { fan_mode: p.fanMode } : null),
    "aime.scan": cardRunner(runtime),
    coin: coinRunner(runtime),
    "door.open": doorRunner(runtime),
  };
  const bus = createDeviceBus({
    events: createDeviceEventRepository(createD1Executor(runtime.db, runtime.shopId)),
    now: runtime.now ?? (() => new Date()),
    id: runtime.id ?? (() => crypto.randomUUID()),
    runners,
    readers: {
      "power.power": (device) => readPower(runtime, device),
      "climate.climate": async (device) => {
        const state = await readClimate(runtime, device);
        return state ? climateSetting(state) : null;
      },
    },
  });
  const occupancy = createOccupancy({ db: runtime.db, shopId: runtime.shopId, ...(runtime.now ? { now: runtime.now } : {}) });
  return {
    ...bus,
    async perform(input: PerformInput): Promise<PerformResult & { device?: DeviceView }> {
      const result = await bus.perform(input);
      if (result.operation.status === "succeeded") {
        // Who a swipe or a coin was for may now occupy the resource. Losing
        // that must not fail the action the player already got.
        const playerId = input.actor.type === "player" ? input.actor.playerId : input.forPlayerId ?? null;
        const observed = await occupancy.observe({ resourceId: input.device.id, event: { kind: "action", action: input.action, playerId } })
          .catch((error) => {
            console.error("Occupancy update failed", { shopId: runtime.shopId, deviceId: input.device.id, error });
            return { started: null };
          });
        // The hub's own idle power-off (notifyHub false) is announced by the hub.
        if (runtime.notifyHub !== false) await announceAction(runtime, input, playerId, !!observed.started);
      }
      // The command was accepted, which is all this can know: Home Assistant
      // answers the same whether or not the machine actually went dark. The hub
      // starts an observation and waits for the state to confirm it.
      if (runtime.notifyHub !== false && input.action === "power.off" && result.operation.status === "succeeded"
        && input.device.capabilities.has("hinata_io")) {
        await machinePoweredOff(runtime.env, runtime.shopId, input.device.id);
      }
      // What a power or climate action left the device in, read back the same
      // way as any read, so the caller can show it. A device that is not live has
      // nobody else to tell its pages and the boards, so the hub is handed it.
      if (runtime.notifyHub !== false && result.operation.status === "succeeded") {
        const after = await readAfterAction(runtime, input.device, input.action, input.payload).catch(() => null);
        if (after) {
          const device = deviceView(input.device, after);
          if (!after.watching) await deviceRead(runtime.env, runtime.shopId, input.device.id, device);
          return { ...result, device };
        }
      }
      return result;
    },
  };
}

/**
 * Hardware runners for the capability catalog, plus the per-request bus that
 * wires them to the readers in `device-state.ts`. Runners only talk to
 * hardware; recording what happened is the bus's job.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { createD1Executor } from "@prism/adapter-d1";
import { normalizeTTLockConnectionConfig } from "@prism/application";
import { createDeviceEventRepository } from "@prism/storage-sql";
import type { DeviceEventVia } from "@prism/core";
import { createEventDispatcher } from "../../events/dispatcher.js";
import { eventSubscribers, type EventContext } from "../../events/subscribers.js";
import type { EventSubscriber } from "../../events/dispatcher.js";
import type { Env } from "../../bindings.js";
import { callHomeAssistantPower, callHomeAssistantService } from "../../hardware/home-assistant.js";
import { normalizeHinataUrl, sendHinataCard, sendHinataCoin } from "../../hardware/hinata.js";
import { TTLockClient } from "../../hardware/ttlock.js";
import { machineRelayNamespace } from "../../gateway/machine-relay-gateway.js";
import { createDeviceBus, type ActionRunner, type PerformInput, type PerformResult, type RunOutcome } from "./bus.js";
import { ioCanPress, type ResourceButton } from "./catalog.js";
import { coinKeyOf, doorConfigOf, hinataConfigOf, hostConfigOf, keysConfigOf, readSecret } from "../resource.js";
import { resolveNodeChannel } from "../nodes.js";
import { deviceRead, type HubCalls } from "../../durable-objects/shop-hub-client.js";
import { climateSetting, deviceView, haBinding, readAfterAction, readClimate, readPower, type DeviceView } from "./device-state.js";

const KEY_PRESS_TTL_MS = 30_000;
const FILE_TRANSFER_TTL_MS = 40_000;
const PS_TIMEOUT_MARGIN_MS = 10_000;
const HA_TIMEOUT_MS = 10_000;

export type DeviceRuntime = {
  db: D1DatabaseLike;
  env: Env;
  shopId: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  id?: () => string;
  hub?: HubCalls;
  subscribers?: readonly EventSubscriber<EventContext>[];
  via?: DeviceEventVia;
  defer?: (work: Promise<unknown>) => void;
};

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

function relayOutcome(result: { ok: boolean; status: number; error?: string }): RunOutcome {
  if (result.ok) return { outcome: "ok" };
  if (result.status === 0) return { outcome: "unknown", message: result.error ?? "机台未响应" };
  return { outcome: "failed", message: result.error ?? "机台通信失败", httpStatus: result.status };
}

function cardRunner(runtime: DeviceRuntime): ActionRunner {
  return async ({ device, operationId, payload, awaits }) => {
    const accessCode = typeof payload.accessCode === "string" ? payload.accessCode : "";
    if (!accessCode) return { outcome: "failed", message: "缺少卡号" };
    const config = hinataConfigOf(device)!;
    if (config.transport === "embedded") {
      const relay = machineRelayNamespace(runtime.env);
      const target = await resolveNodeChannel(runtime.db, runtime.shopId, config.nodeId, config.channel);
      if (!relay || !target) return { outcome: "failed", message: "直连中继尚未配置" };
      if (!target.enabled) return { outcome: "failed", message: "该直连节点已停用" };
      const sent = await relay.getByName(target.channel).sendCard({
        accessCode,
        source: operationId,
        ...(awaits ? { wait: awaits } : {}),
      });
      if (!sent.ok) return { outcome: "failed", message: sent.error ?? "机台未在线" };
      return { outcome: "ok", ...(sent.awaited !== undefined ? { awaited: sent.awaited } : {}) };
    }
    const url = await readSecret(runtime.db, device, "hinata_io", "url", runtime.env.URL_ENCRYPTION_KEY);
    if (!url) return { outcome: "failed", message: "机台未配置连接地址" };
    const password = await readSecret(runtime.db, device, "hinata_io", "password", runtime.env.URL_ENCRYPTION_KEY);
    return relayOutcome(await sendHinataCard(normalizeHinataUrl(url), accessCode, password, operationId, {
      fetcher: runtime.fetcher,
    }));
  };
}

/** Press a Windows VK key via a bound PRiSM Launcher (`host`) node. */
async function pressLauncherKey(
  runtime: DeviceRuntime,
  device: Parameters<ActionRunner>[0]["device"],
  operationId: string,
  key: number,
  count: number,
): Promise<RunOutcome> {
  const host = hostConfigOf(device);
  const relay = machineRelayNamespace(runtime.env);
  if (!host?.nodeId || !relay) return { outcome: "failed", message: "未绑定 Launcher 节点" };
  const target = await resolveNodeChannel(runtime.db, runtime.shopId, host.nodeId);
  if (!target) return { outcome: "failed", message: "Launcher 节点不存在" };
  if (!target.enabled) return { outcome: "failed", message: "Launcher 节点已停用" };
  const reply = await relay.getByName(target.channel).callNode(
    "key.press",
    { key, count },
    { id: operationId, expiresAt: (runtime.now?.() ?? new Date()).getTime() + KEY_PRESS_TTL_MS },
  );
  return reply.ok ? { outcome: "ok" } : { outcome: "failed", message: reply.error ?? "Launcher 离线" };
}

/** Press a Windows VK key via HINATA IO (embedded or external relay). */
async function pressHinataKey(
  runtime: DeviceRuntime,
  device: Parameters<ActionRunner>[0]["device"],
  operationId: string,
  key: number,
  count: number,
): Promise<RunOutcome> {
  const config = hinataConfigOf(device);
  if (!config) return { outcome: "failed", message: "未配置 HINATA IO" };
  if (config.transport === "embedded") {
    const relay = machineRelayNamespace(runtime.env);
    const target = await resolveNodeChannel(runtime.db, runtime.shopId, config.nodeId, config.channel);
    if (!relay || !target) return { outcome: "failed", message: "直连中继尚未配置" };
    if (!target.enabled) return { outcome: "failed", message: "该直连节点已停用" };
    const sent = await relay.getByName(target.channel).sendKeyPress({
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
}

/** Pulse a GPIO output pin on an IoT controller node. */
async function pulseGpioButton(
  runtime: DeviceRuntime,
  operationId: string,
  button: Extract<ResourceButton, { mode: "gpio" }>,
  count: number,
): Promise<RunOutcome> {
  const relay = machineRelayNamespace(runtime.env);
  if (!relay) return { outcome: "failed", message: "直连中继尚未配置" };
  const target = await resolveNodeChannel(runtime.db, runtime.shopId, button.nodeId);
  if (!target) return { outcome: "failed", message: "绑定的 IoT 控制器不存在" };
  if (!target.enabled) return { outcome: "failed", message: "绑定的 IoT 控制器已停用" };
  const reply = await relay.getByName(target.channel).callNode(
    "gpio.pulse",
    { pin: button.pin, duration_ms: button.pulseMs, count, active_low: button.activeLow },
    { id: operationId, expiresAt: (runtime.now?.() ?? new Date()).getTime() + KEY_PRESS_TTL_MS },
  );
  return reply.ok ? { outcome: "ok" } : { outcome: "failed", message: reply.error ?? "IoT 控制器离线" };
}

/**
 * Execute a unified cabinet button (`keys` capability):
 * - `gpio`: pulses the configured IoT controller pin.
 * - `keyboard`: prefers PRiSM Launcher (`host`) when available, falling back
 *   automatically to HINATA IO when Launcher is absent or offline.
 */
async function pressKeyboardWithPriority(
  runtime: DeviceRuntime,
  device: Parameters<ActionRunner>[0]["device"],
  operationId: string,
  key: number,
  count: number,
): Promise<RunOutcome> {
  const hasHost = !!hostConfigOf(device)?.nodeId;
  const ioBound = device.capabilities.get("hinata_io");
  const canUseIo = !!ioBound && ioCanPress(hinataConfigOf(device)!, ioBound.secretNames);

  if (hasHost) {
    const primary = await pressLauncherKey(runtime, device, operationId, key, count);
    if (primary.outcome === "ok" || !canUseIo) return primary;
    const fallback = await pressHinataKey(runtime, device, operationId, key, count);
    return fallback.outcome === "ok" ? fallback : primary;
  }
  if (canUseIo) {
    return pressHinataKey(runtime, device, operationId, key, count);
  }
  return { outcome: "failed", message: "需要绑定 PRiSM Launcher 或 HINATA IO 才能发送键盘按键" };
}

async function pressButton(
  runtime: DeviceRuntime,
  device: Parameters<ActionRunner>[0]["device"],
  operationId: string,
  button: ResourceButton,
  count: number,
): Promise<RunOutcome> {
  if (button.mode === "gpio") {
    return pulseGpioButton(runtime, operationId, button, count);
  }
  return pressKeyboardWithPriority(runtime, device, operationId, button.key, count);
}

const countOf = (payload: Record<string, unknown>) => typeof payload.count === "number" ? payload.count : 1;

/** A coin, triggered through the button selected by this resource's `coin` capability. */
function coinRunner(runtime: DeviceRuntime): ActionRunner {
  return async ({ device, operationId, payload }) => {
    const button = coinKeyOf(device);
    if (!button) return { outcome: "failed", message: "投币按键不存在" };
    return pressButton(runtime, device, operationId, button, countOf(payload));
  };
}

type HostRpcMethod =
  | "host.switch"
  | "key.press"
  | "host.text"
  | "host.update.check"
  | "host.screenshot"
  | "host.reboot"
  | "host.shutdown"
  | "host.fs.list"
  | "host.fs.read"
  | "host.fs.write"
  | "host.fs.mkdir"
  | "host.fs.rename"
  | "host.fs.delete"
  | "host.powershell";

/** Managed host (PRiSM Launcher) command runner, audited through DeviceBus. */
function hostRunner(
  runtime: DeviceRuntime,
  method: HostRpcMethod,
  paramsOf: (payload: Record<string, unknown>) => Record<string, unknown> | null,
  ttlMsOf?: (payload: Record<string, unknown>) => number,
): ActionRunner {
  return async ({ device, operationId, payload }) => {
    const host = hostConfigOf(device);
    if (!host?.nodeId) return { outcome: "failed", message: "未绑定 Launcher 节点" };
    const relay = machineRelayNamespace(runtime.env);
    if (!relay) return { outcome: "failed", message: "直连中继尚未配置" };
    const target = await resolveNodeChannel(runtime.db, runtime.shopId, host.nodeId);
    if (!target) return { outcome: "failed", message: "Launcher 节点不存在" };
    if (!target.enabled) return { outcome: "failed", message: "Launcher 节点已停用" };
    const params = paramsOf(payload);
    if (!params) return { outcome: "failed", message: "主机指令缺少参数" };
    const ttlMs = ttlMsOf ? ttlMsOf(payload) : KEY_PRESS_TTL_MS;
    const reply = await relay.getByName(target.channel).callNode(method, params, {
      id: operationId,
      expiresAt: (runtime.now?.() ?? new Date()).getTime() + ttlMs,
      timeoutMs: ttlMs + 5_000,
    });
    if (!reply.ok) return { outcome: "failed", message: reply.error ?? "Launcher 离线" };
    const result = reply.result && typeof reply.result === "object" && !Array.isArray(reply.result)
      ? (reply.result as Record<string, unknown>)
      : undefined;
    return { outcome: "ok", ...(result !== undefined ? { result } : {}) };
  };
}

/** Staff pressing a named cabinet button (`key.press`). */
function keyRunner(runtime: DeviceRuntime): ActionRunner {
  return async ({ device, operationId, payload }) => {
    const count = countOf(payload);
    if (typeof payload.keyId === "string" && payload.keyId) {
      const button = keysConfigOf(device)?.buttons.find((b) => b.id === payload.keyId);
      if (button) return pressButton(runtime, device, operationId, button, count);
    }
    if (typeof payload.key === "number") {
      return pressKeyboardWithPriority(runtime, device, operationId, payload.key, count);
    }
    return { outcome: "failed", message: "缺少按键配置" };
  };
}

function doorRunner(runtime: DeviceRuntime): ActionRunner {
  return async ({ device, payload }) => {
    const config = doorConfigOf(device)!;
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
    "key.press": keyRunner(runtime),
    "host.switch": hostRunner(runtime, "host.switch", (p) =>
      typeof p.name === "string" && p.name ? { name: p.name } : null),
    "host.key": hostRunner(runtime, "key.press", (p) =>
      typeof p.key === "number" ? { key: p.key, count: countOf(p) } : null),
    "host.text": hostRunner(runtime, "host.text", (p) =>
      typeof p.text === "string" && p.text ? { text: p.text } : null),
    "host.update.check": hostRunner(runtime, "host.update.check", () => ({}), () => 90_000),
    "host.screenshot": hostRunner(runtime, "host.screenshot", () => ({})),
    "host.reboot": hostRunner(runtime, "host.reboot", () => ({})),
    "host.shutdown": hostRunner(runtime, "host.shutdown", () => ({})),
    "host.fs.list": hostRunner(runtime, "host.fs.list", (p) =>
      typeof p.path === "string" && p.path ? { path: p.path } : null),
    "host.fs.read": hostRunner(
      runtime,
      "host.fs.read",
      (p) =>
        typeof p.path === "string" && p.path
          ? { path: p.path, encoding: p.encoding === "base64" ? "base64" : "utf8" }
          : null,
      () => FILE_TRANSFER_TTL_MS,
    ),
    "host.fs.write": hostRunner(
      runtime,
      "host.fs.write",
      (p) =>
        typeof p.path === "string" && p.path && typeof p.content === "string"
          ? {
              path: p.path,
              content: p.content,
              encoding: p.encoding === "base64" ? "base64" : "utf8",
              createDirs: p.createDirs === true,
            }
          : null,
      () => FILE_TRANSFER_TTL_MS,
    ),
    "host.fs.mkdir": hostRunner(runtime, "host.fs.mkdir", (p) =>
      typeof p.path === "string" && p.path
        ? { path: p.path, recursive: p.recursive !== false }
        : null),
    "host.fs.rename": hostRunner(runtime, "host.fs.rename", (p) =>
      typeof p.from === "string" && p.from && typeof p.to === "string" && p.to
        ? { from: p.from, to: p.to, overwrite: p.overwrite === true }
        : null),
    "host.fs.delete": hostRunner(runtime, "host.fs.delete", (p) =>
      typeof p.path === "string" && p.path
        ? { path: p.path, recursive: p.recursive === true }
        : null),
    "host.powershell": hostRunner(
      runtime,
      "host.powershell",
      (p) => {
        if (typeof p.script !== "string" || !p.script) return null;
        const timeoutMs =
          typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs)
            ? Math.min(Math.max(Math.trunc(p.timeoutMs), 1_000), 120_000)
            : 15_000;
        return {
          script: p.script,
          ...(typeof p.cwd === "string" && p.cwd ? { cwd: p.cwd } : {}),
          timeoutMs,
          shell: p.shell === "pwsh" ? "pwsh" : "powershell",
        };
      },
      (p) => {
        const timeoutMs =
          typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs)
            ? Math.min(Math.max(Math.trunc(p.timeoutMs), 1_000), 120_000)
            : 15_000;
        return timeoutMs + PS_TIMEOUT_MARGIN_MS;
      },
    ),
    "door.open": doorRunner(runtime),
  };
  const bus = createDeviceBus({
    events: createDeviceEventRepository(createD1Executor(runtime.db, runtime.shopId)),
    now: runtime.now ?? (() => new Date()),
    id: runtime.id ?? (() => crypto.randomUUID()),
    runners,
    ...(runtime.via ? { via: runtime.via } : {}),
    published: createEventDispatcher({
      subscribers: [...eventSubscribers, ...(runtime.subscribers ?? [])],
      context: {
        db: runtime.db,
        env: runtime.env,
        shopId: runtime.shopId,
        ...(runtime.now ? { now: runtime.now } : {}),
        ...(runtime.hub ? { hub: runtime.hub } : {}),
      },
      ...(runtime.defer ? { defer: runtime.defer } : {}),
    }),
    readers: {
      "power.power": (device) => readPower(runtime, device),
      "climate.climate": async (device) => {
        const state = await readClimate(runtime, device);
        return state ? climateSetting(state) : null;
      },
    },
  });
  return {
    ...bus,
    async perform(input: PerformInput): Promise<PerformResult & { device?: DeviceView }> {
      const result = await bus.perform(input);
      if (!runtime.hub && result.operation.status === "succeeded") {
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

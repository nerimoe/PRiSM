import type { AfterSubscriber } from "../events/dispatcher.js";
import type { EventContext } from "../events/subscribers.js";
import type { DurableObject } from "cloudflare:workers";
import type { Env } from "../bindings.js";
import { hinataIo } from "../resources/capabilities/catalog.js";
import { createRuntimeBus } from "../resources/capabilities/runtime.js";
import type { AwaitSpec, Awaited } from "../resources/capabilities/bus.js";
import { cabinetChanges, coinGate, coinLimit, isCabinetBooks, type CabinetBooks } from "../resources/capabilities/cabinet.js";
import { can, coinConfigOf, hinataConfigOf, loadResource } from "../resources/resource.js";
import { cardRead, pagesChanged, shopHub } from "./shop-hub-client.js";
import { createCardStore, reportedCard, withoutCardNumber } from "../resources/cards.js";
import { bindReaderCard, type CardCapture, type CardCaptureResult } from "../resources/card-capture.js";
import { publishShopFacts } from "../events/shop-facts.js";
import {
  capabilitiesForAttachment,
  capabilitiesFromRequest,
  ioEventSource,
  parseCabinetSnapshot,
  prepareMessageForClient,
  type CabinetSnapshot,
  type ClientCapabilities,
  type IoEventMethod,
  type IoReader,
  type RelayMessage,
} from "../hardware/aimeio-relay.js";
import {
  encodeNodeCommand,
  encodeNodeConfig,
  encodeNodeHaWatch,
  parseNodeMessage,
  type IotNodeConfig,
  type NodeCallReply,
  type NodeKind,
  type NodeRuntimeConfig,
} from "../hardware/node-protocol.js";
import { deriveNodeRuntimeConfig, getNode, resolveGpioInputTargets } from "../resources/nodes.js";
import type { NodeLiveStatus } from "../gateway/machine-relay-gateway.js";
import { logger } from "../log.js";

const log = logger("machine-relay");

const STATE_KEY = "state-message";
const CHANNEL_KEY = "channel";
const CAPTURE_KEY = "card-capture";
/** The last readable cabinet books, compared with the next ones. */
const CABINET_KEY = "cabinet-books";
/** The credit last judged against the limit, so a repeated beat costs nothing. */
const CABINET_JUDGED_KEY = "cabinet-judged";
/** Whether the cabinet was last at its limit, so pages hear only when that flips. */
const COIN_FULL_KEY = "coin-full";
/** The reader list last stored, so an unchanged heartbeat writes nothing. */
const READERS_KEY = "readers";
/** How long an RPC to the IO may take; reading its books takes milliseconds. */
const RPC_TIMEOUT_MS = 5000;
const ONLINE_KEY = "online";
const HA_SESSION_KEY = "ha-session";
/**
 * How long a silent machine is still believed alive.
 *
 * The IO beats every 60 s, so one late beat must not condemn it: two beats plus
 * a margin for a slow round trip. Kept equal to `LEASE_MS` on purpose — how long
 * a watcher is believed, and how long a machine is believed, are the same
 * question asked about the same beat.
 */
const BEAT_TIMEOUT_MS = 150_000;

/** The IO forgets a remote card this long after receiving it unless told otherwise. */
const CARD_LIFETIME_MS = 3000;

/** IO event methods as device signals of the `hinata_io` capability. */
const SIGNAL_NAMES: Record<IoEventMethod, string> = {
  "event.cardStateChanged": "card.state",
  "event.cardConsumed": "card.consumed",
  "event.ledSet": "led.set",
};

type Channel = {
  shopId: string;
  /** Resource id for a `hinata_io` node bound to a machine (optional for 1:0 / 1:N nodes). */
  machineId?: string;
  /** `shop_nodes.id` (defaults to `machineId` for legacy upgrades). */
  nodeId?: string;
  /** Edge node kind (defaults to `hinata_io`). */
  kind?: NodeKind;
  /** Friendly node label for ShopHub watcher views. */
  label?: string;
  channel?: string;
};

/**
 * Per-socket state. It lives in the socket attachment rather than on the
 * object, because a hibernated object wakes with its fields reset while its
 * sockets and their attachments survive.
 */
type Attachment = ClientCapabilities & {
  kind?: NodeKind;
  e2ee?: boolean;
  ha?: boolean;
  session?: string;
  /** Last time this socket said anything, ms. */
  seenAt?: number;
  version?: string | null;
  model?: string | null;
  program?: string | null;
};

const NODE_CALL_TIMEOUT_MS = 35_000;
const MAX_NODE_CALL_TIMEOUT_MS = 150_000;
const MAX_NODE_FRAME_BYTES = 1_000_000;
const TEXT_ENCODER = new TextEncoder();

function channelKind(channel: Channel | null | undefined): NodeKind {
  return channel?.kind ?? "hinata_io";
}

function watcherKeyOf(channel: Channel): string {
  const kind = channelKind(channel);
  if (kind === "hinata_io") return channel.machineId ?? channel.nodeId ?? "";
  return `node:${channel.nodeId ?? channel.channel ?? ""}`;
}

/**
 * What the IO assigned to watch the shop's Home Assistants should subscribe to.
 * `urls` are tried in order (the shop-local address first); the token is a
 * read-only account's. `term` identifies this assignment in every report.
 */
export type HaWatch = {
  term: number;
  connections: Array<{ id: string; urls: string[]; token: string; entities: string[] }>;
};

/** A stored card is only worth replaying while the IO would still hold it. */
type StoredCard = { message: RelayMessage; expiresAt: number; source?: string };

/** A caller waiting for the IO to report a signal that names its operation. */
type SignalWait = {
  signal: string;
  timer: ReturnType<typeof setTimeout>;
  settle: (awaited: Awaited) => void;
};

let BaseDurableObject: typeof DurableObject;
try {
  // @ts-ignore
  const cf = await import("cloudflare:workers");
  BaseDurableObject = cf.DurableObject;
} catch {
  BaseDurableObject = class MockDurableObject {
    constructor(public ctx: any, public env: any) {}
  } as any;
}

/**
 * Per-machine relay channel.
 *
 * The device connects here as `role=agent`. This platform is the controller, so
 * it calls the methods below directly rather than POSTing to a relay over HTTP —
 * that is what removes the extra hop and the public controller endpoints.
 *
 * Only the Worker can reach a Durable Object, and the Worker authenticates the
 * device token and resolves the channel before dispatching, so this class trusts
 * the channel headers it is given and never parses a credential itself.
 */
export class MachineRelay extends BaseDurableObject<Env> {
  /**
   * Callers waiting for a signal, by the operation it must name. Memory is
   * enough: the waiting call keeps the object awake, and nothing else reads these.
   */
  private readonly waits = new Map<string, SignalWait>();

  /** RPCs sent to the IO awaiting its answer, by request id. Memory only, like `waits`. */
  private readonly rpcs = new Map<string, { timer: ReturnType<typeof setTimeout>; settle: (reply: Record<string, any> | null) => void }>();

  /** Unified JSON-RPC calls in flight to any node (`launcher`, `iot`, etc.), by request id. */
  private readonly nodeCalls = new Map<string, { ws: WebSocket; finish: (reply: NodeCallReply) => void }>();

  private socketKind(ws: WebSocket): NodeKind {
    return (ws.deserializeAttachment() as Attachment | null)?.kind ?? "hinata_io";
  }

  /** Live status of the node owning this relay Durable Object. */
  async nodeStatus(): Promise<NodeLiveStatus> {
    const channel = await this.channel();
    const live = await this.syncPresence();
    const primary = live[0];
    const att = primary?.deserializeAttachment() as Attachment | null | undefined;
    return {
      online: live.length > 0,
      kind: att?.kind ?? channelKind(channel),
      version: att?.version ?? null,
      model: att?.model ?? null,
      program: att?.program ?? null,
      e2ee: live.some((ws) => this.socketE2ee(ws)),
    };
  }

  /** Push freshly derived runtime config (`node.setConfig`) to all live sockets of this node. */
  async pushConfig(config: NodeRuntimeConfig): Promise<{ delivered: boolean }> {
    const live = this.liveAgents();
    if (!live.length) return { delivered: false };
    let delivered = false;
    for (const ws of live) {
      const frame = encodeNodeConfig(this.socketKind(ws), config);
      if (!frame) continue;
      try {
        ws.send(frame);
        delivered = true;
      } catch {
        // Dead socket will be cleaned up on close/timeout.
      }
    }
    return { delivered };
  }

  /** Invoke a JSON-RPC command on the connected node and wait for its reply. */
  async callNode(
    method: string,
    params: Record<string, unknown>,
    options: { id?: string; expiresAt?: number; timeoutMs?: number } = {},
  ): Promise<NodeCallReply> {
    const ws = this.liveAgents()[0];
    if (!ws) return { ok: false, error: "节点离线" };
    const id = options.id ?? crypto.randomUUID();
    if (this.nodeCalls.has(id)) return { ok: false, error: "指令已在执行" };
    const expiresAt = options.expiresAt ?? Date.now() + 30_000;
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? NODE_CALL_TIMEOUT_MS, 1_000), MAX_NODE_CALL_TIMEOUT_MS);
    const kind = this.socketKind(ws);
    const frame = encodeNodeCommand(kind, { id, method, params, expiresAt });
    if (TEXT_ENCODER.encode(frame).byteLength > MAX_NODE_FRAME_BYTES) {
      return { ok: false, error: "指令负载超过 WebSocket 传输上限" };
    }
    return new Promise((resolve) => {
      const finish = (reply: NodeCallReply) => {
        clearTimeout(timer);
        this.nodeCalls.delete(id);
        resolve(reply);
      };
      const timer = setTimeout(() => finish({ ok: false, error: "节点响应超时，执行结果未知" }), timeoutMs);
      this.nodeCalls.set(id, { ws, finish });
      try {
        ws.send(frame);
      } catch {
        finish({ ok: false, error: "节点已断线" });
      }
    });
  }

  /**
   * Ask the IO to read its cabinet's books now (`cabinet.getSnapshot`), and
   * handle what it read exactly like a snapshot it reported on its own. For an
   * operator who thinks the platform's view is out of date.
   */
  async readCabinet(): Promise<{ ok: true; cabinet: CabinetSnapshot } | { ok: false; error: string }> {
    const agents = this.agents();
    if (agents.length === 0) return { ok: false, error: "机台未在线" };
    if (agents.some((ws) => this.socketE2ee(ws))) return { ok: false, error: "该机台仍配置了 remotePassword（端到端加密），直连模式需要将其清空。" };
    const id = crypto.randomUUID();
    const reply = new Promise<Record<string, any> | null>((resolve) => {
      const timer = setTimeout(() => {
        this.rpcs.delete(id);
        resolve(null);
      }, RPC_TIMEOUT_MS);
      this.rpcs.set(id, { timer, settle: resolve });
    });
    const request = JSON.stringify({ jsonrpc: "2.0", id, method: "cabinet.getSnapshot", params: {} });
    for (const ws of agents) {
      try {
        ws.send(request);
      } catch {
        // A dead socket is reaped by the runtime; another may still answer.
      }
    }
    const answer = await reply;
    if (!answer) return { ok: false, error: "机台没有回应" };
    if (answer.error) {
      const message = typeof answer.error.message === "string" ? answer.error.message : "";
      return { ok: false, error: message.includes("cabinetMonitor") ? "这台 IO 没有读取机台状态（游戏没有 sysfile.dat，或 IO 版本太旧）" : `机台读取失败：${message}` };
    }
    const cabinet = parseCabinetSnapshot(answer.result);
    if (!cabinet) return { ok: false, error: "机台不支持读取币数，或未开启 cabinetMonitor" };
    await this.cabinet(cabinet);
    return { ok: true, cabinet };
  }

  private socketCapabilities(ws: WebSocket): ClientCapabilities {
    return capabilitiesForAttachment(ws.deserializeAttachment());
  }

  private agents(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => this.socketCapabilities(ws).role === "agent");
  }

  private socketE2ee(ws: WebSocket): boolean {
    return (ws.deserializeAttachment() as Attachment | null)?.e2ee === true;
  }

  private async channel(): Promise<Channel | null> {
    return (await this.ctx.storage.get<Channel>(CHANNEL_KEY)) ?? null;
  }

  /**
   * Record through the device bus. Storage failures are logged and swallowed:
   * losing an audit row must not break card delivery to the game.
   */
  private async record(what: string, write: (bus: ReturnType<typeof createRuntimeBus>, channel: Channel & { machineId: string }) => Promise<unknown>) {
    const channel = await this.channel();
    if (!channel?.machineId) return;
    const bound = channel as Channel & { machineId: string };
    try {
      await write(createRuntimeBus({
        db: this.env.DB, env: this.env, shopId: bound.shopId,
        via: { channel: "relay", resourceId: null },
        subscribers: [this.coinAfterCardSubscriber(bound)],
      }), bound);
    } catch (error) {
      log.error(`could not record ${what} from machine ${bound.machineId}`, { event: "machine_relay_record_failed", shopId: bound.shopId, machineId: bound.machineId, what, error });
    }
  }

  private async setLink(online: boolean) {
    const channel = await this.channel();
    if (!channel?.machineId || channelKind(channel) !== "hinata_io") return;
    await this.record("link", (bus, bound) =>
      bus.setOwned({ device: { id: bound.machineId }, capability: "hinata_io", key: "link", value: online ? "online" : "offline" }),
    );
    // Without a link the books no longer count, so the coin button is no longer held by them.
    await this.judgeCoinLimit();
    // A page shows the IO's actions only while it is connected.
    await pagesChanged(this.env, channel.shopId, { device: channel.machineId }, "link");
  }

  /** Open pages hear when the cabinet reaches or leaves its limit, and only then. Never gets in the way of the machine. */
  private async judgeCoinLimit() {
    const channel = await this.channel();
    if (!channel?.machineId || channelKind(channel) !== "hinata_io") return;
    try {
      const device = await loadResource(this.env.DB, channel.shopId, channel.machineId);
      const full = !!device && (await coinLimit(this.env.DB, channel.shopId, device)) === "full";
      // Never judged counts as not full: the button starts on, so there is nothing to tell.
      if (((await this.ctx.storage.get(COIN_FULL_KEY)) ?? false) === full) return;
      await this.ctx.storage.put(COIN_FULL_KEY, full);
      await pagesChanged(this.env, channel.shopId, { device: channel.machineId }, "coin");
    } catch (error) {
      log.error(`could not check machine ${channel.machineId}'s coin limit`, { shopId: channel.shopId, machineId: channel.machineId, error });
    }
  }

  /**
   * WebSocket upgrade from an edge node (`hinata_io`, `launcher`, `iot`).
   * A request without the gateway's channel headers did not come through the
   * authenticated path and is refused.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const shopId = request.headers.get("x-prism-relay-shop");
    const machineId = request.headers.get("x-prism-relay-machine") ?? undefined;
    const nodeId = request.headers.get("x-prism-relay-node") ?? machineId;
    const rawKind = request.headers.get("x-prism-relay-kind");
    const kind: NodeKind = rawKind === "launcher" || rawKind === "iot" ? rawKind : "hinata_io";
    if (!shopId || !nodeId) {
      return new Response("Missing relay channel", { status: 400 });
    }
    const channelName = request.headers.get("x-prism-relay-channel") ?? undefined;
    const rawLabel = request.headers.get("x-prism-relay-label");
    let label: string | undefined;
    if (rawLabel) {
      try { label = decodeURIComponent(rawLabel); } catch { label = rawLabel; }
    }
    const storedChannel: Channel = {
      shopId,
      nodeId,
      kind,
      ...(machineId ? { machineId } : {}),
      ...(label ? { label } : {}),
      ...(channelName ? { channel: channelName } : {}),
    };
    await this.ctx.storage.put<Channel>(CHANNEL_KEY, storedChannel);

    const capabilities = capabilitiesFromRequest(request);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Single active connection for dedicated server-driven nodes (`launcher` / `iot`).
    if (kind !== "hinata_io") {
      for (const old of this.ctx.getWebSockets()) {
        try { old.close(1000, "replaced"); } catch { /* already closed */ }
      }
    }

    // Look up node-level settings (e.g. IoT haWatch & derived runtime config).
    const nodeRecord = await getNode(this.env.DB, shopId, nodeId).catch(() => null);
    const iotHaWatch = kind === "iot" && (nodeRecord ? (nodeRecord.config as IotNodeConfig).haWatch !== false : true);
    const session = crypto.randomUUID();

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      ...capabilities,
      kind,
      ...(iotHaWatch ? { ha: true } : {}),
      session,
      seenAt: Date.now(),
    } satisfies Attachment);

    if (capabilities.role === "agent") {
      await this.ctx.storage.put(ONLINE_KEY, true);
      if (kind === "hinata_io") await this.setLink(true);
      await this.syncPresence();
    }

    if (kind === "hinata_io") {
      // A reconnecting IO cleared its card locally, so it must learn the card
      // it was still holding while it is still valid.
      const stored = await this.storedCard();
      if (stored) {
        try {
          server.send(prepareMessageForClient(JSON.stringify(stored.message), capabilities));
        } catch {
          // Socket already gone; the next command will deliver the state again.
        }
      }
    } else {
      // Push server-derived runtime configuration immediately on connect.
      if (nodeRecord) {
        const runtimeConfig = await deriveNodeRuntimeConfig(this.env.DB, shopId, nodeRecord).catch(() => null);
        const encoded = runtimeConfig ? encodeNodeConfig(kind, runtimeConfig) : null;
        if (encoded) {
          try { server.send(encoded); } catch { /* socket already gone */ }
        }
      }
      // Register always-on IoT hardware as a high-priority Home Assistant watcher candidate.
      if (iotHaWatch && channelName) {
        await this.ctx.storage.put(HA_SESSION_KEY, session);
        await shopHub(this.env, shopId)
          ?.relayOnline(shopId, watcherKeyOf(storedChannel), channelName, {
            session,
            kind: "iot",
            ...(label ? { label } : {}),
          })
          .catch((error) => log.error(`could not register iot node ${nodeId} with shop hub`, { shopId, nodeId, error }));
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /** The card to hand a reconnecting device, dropping one that has lapsed. */
  private async storedCard(): Promise<StoredCard | null> {
    const stored = await this.ctx.storage.get<Partial<StoredCard>>(STATE_KEY);
    if (!stored) return null;
    // Older objects stored the bare message with no lifetime; treat it as lapsed.
    if (!stored.message || typeof stored.expiresAt !== "number" || stored.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(STATE_KEY);
      return null;
    }
    return stored as StoredCard;
  }

  /**
   * What the connected IO reported about itself, for the device board.
   *
   * "Online" means a socket *and* a recent beat. A machine switched off at the
   * wall leaves its socket in this object — nothing closes it, because the
   * process that would have closed it is the one that stopped — and the runtime
   * takes its time to notice. The IO beats every 60 s; two missed beats is what
   * it takes to call the machine gone.
   */
  async getCapabilities(): Promise<{
    online: boolean;
    e2ee: boolean;
    agents: Array<{ cardProtocol: number; clientVersion: string }>;
  }> {
    const agents = this.agents().map((ws) => {
      const { cardProtocol, clientVersion } = this.socketCapabilities(ws);
      return { cardProtocol, clientVersion };
    });
    const live = await this.syncPresence();
    return {
      online: live.length > 0,
      e2ee: live.some((ws) => this.socketE2ee(ws)),
      agents,
    };
  }

  /** Whether this socket has beaten within the last two beats. */
  private beatIsRecent(ws: WebSocket): boolean {
    // A socket that connected after the last beat is given the benefit of the
    // doubt: it has only just arrived and has not had its turn yet.
    const seen = (ws.deserializeAttachment() as Attachment | null)?.seenAt;
    if (typeof seen !== "number") {
      ws.serializeAttachment({ ...(ws.deserializeAttachment() as Attachment), seenAt: Date.now() } satisfies Attachment);
      return true;
    }
    return Date.now() - seen < BEAT_TIMEOUT_MS;
  }

  private liveAgents(): WebSocket[] {
    return this.agents().filter((ws) => ws.readyState === 1 && this.beatIsRecent(ws));
  }

  /** The board and HA assignments both use this node presence decision. */
  private async offline(): Promise<void> {
    if ((await this.ctx.storage.get<boolean>(ONLINE_KEY)) === false) return;
    const session = await this.ctx.storage.get<string>(HA_SESSION_KEY);
    await this.setLink(false);
    if (this.liveAgents().length) {
      await this.setLink(true);
      return;
    }
    const channel = await this.channel();
    const key = channel ? watcherKeyOf(channel) : "";
    if (channel && key) await shopHub(this.env, channel.shopId)?.relayOffline(channel.shopId, key, { session });
    if (!this.liveAgents().length) await this.ctx.storage.put(ONLINE_KEY, false);
    else await this.setLink(true);
  }

  private async syncPresence(): Promise<WebSocket[]> {
    const live = this.liveAgents();
    const times = live.map((ws) => (ws.deserializeAttachment() as Attachment).seenAt! + BEAT_TIMEOUT_MS);
    if (!times.length) {
      await this.offline();
      return live;
    }
    const due = Math.min(...times);
    const current = await this.ctx.storage.getAlarm?.();
    if (current == null || current > due) await this.ctx.storage.setAlarm(due);
    return live;
  }

  async alarm(): Promise<void> {
    await this.syncPresence();
  }

  /** Record that this socket is alive; every message counts, not just the beat. */
  private async markSeen(ws: WebSocket): Promise<void> {
    const attachment = (ws.deserializeAttachment() ?? {}) as Attachment;
    ws.serializeAttachment({ ...attachment, seenAt: Date.now() } satisfies Attachment);
    if (this.socketCapabilities(ws).role === "agent") {
      if ((await this.ctx.storage.get<boolean>(ONLINE_KEY)) !== true) {
        await this.ctx.storage.put(ONLINE_KEY, true);
        await this.setLink(true);
      }
      await this.syncPresence();
    }
  }

  /**
   * Deliver a card and remember it for replay.
   *
   * `source` rides along and the IO echoes it in its card reports. With `wait`,
   * the call returns only once the IO reported that signal for this card, or
   * the limit ran out (`awaited: null`).
   */
  async sendCard(input: {
    accessCode: string;
    source?: string;
    disposable?: boolean;
    duration?: number;
    wait?: AwaitSpec;
  }): Promise<{ ok: boolean; error?: string; awaited?: Awaited }> {
    // The IO holds one card at a time, so a newer card ends the wait for an older one.
    for (const [source, wait] of this.waits) if (wait.signal.startsWith("card.")) this.settle(source, null);
    const waiting = input.wait && input.source ? this.waitFor(input.source, input.wait) : null;
    const lifetime = input.duration ?? CARD_LIFETIME_MS;
    const sent = await this.deliver(
      {
        action: "SET_CARD",
        body: {
          type: "aime",
          value: input.accessCode,
          disposable: input.disposable ?? true,
          ...(input.source ? { source: input.source } : {}),
          ...(input.duration ? { duration: input.duration } : {}),
        },
      },
      { expiresAt: Date.now() + lifetime, ...(input.source ? { source: input.source } : {}) },
    );
    if (!sent.ok) {
      if (input.source) this.settle(input.source, null, false);
      return sent;
    }
    return waiting ? { ok: true, awaited: await waiting } : sent;
  }

  /** Start waiting before the command leaves, so a fast device cannot beat the wait. */
  private waitFor(operationId: string, spec: AwaitSpec): Promise<Awaited> {
    return new Promise((resolve) => {
      this.waits.set(operationId, {
        signal: spec.signal,
        timer: setTimeout(() => this.settle(operationId, null), spec.timeoutMs),
        settle: resolve,
      });
    });
  }

  /** End a wait with what came in, or null. `answer: false` drops it unanswered. */
  private settle(operationId: string, awaited: Awaited, answer = true) {
    const wait = this.waits.get(operationId);
    if (!wait) return;
    clearTimeout(wait.timer);
    this.waits.delete(operationId);
    if (answer) wait.settle(awaited);
  }

  /** A reported signal that names an operation answers whoever waits for it. */
  private answer(name: string, operationId: string | null, payload: Record<string, unknown>) {
    if (operationId && this.waits.get(operationId)?.signal === name) this.settle(operationId, { name, payload });
  }

  /**
   * Ask the device to press a key.
   *
   * Not stored as channel state: a coin press is one-shot, and replaying it to a
   * reconnecting device would press the key a second time. `messageId` and
   * `expiresAt` are required because the device rejects a plaintext press
   * without them — that is its only replay protection once E2EE is off.
   */
  async sendKeyPress(input: {
    key: number;
    messageId: string;
    expiresAt: number;
    count?: number;
  }): Promise<{ ok: boolean; error?: string }> {
    if (!Number.isInteger(input.key) || input.key < 1 || input.key > 65535) {
      return { ok: false, error: "投币按键值必须在 1 到 65535 之间。" };
    }
    const count = input.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      return { ok: false, error: "投币次数必须在 1 到 20 之间。" };
    }
    return this.deliver(
      {
        action: "KEY_PRESS",
        body: {
          key: input.key,
          count,
          message_id: input.messageId,
          expires_at: input.expiresAt,
        },
      },
      null,
    );
  }

  private async deliver(
    message: RelayMessage,
    store: Omit<StoredCard, "message"> | null,
  ): Promise<{ ok: boolean; error?: string }> {
    const agents = this.agents();
    if (agents.length === 0) return { ok: false, error: "机台未在线或连接地址不正确。" };
    // A device that announced E2EE cannot read plaintext, and it rejects every
    // plaintext command. Saying so beats a silent no-op on the device screen.
    if (agents.some((ws) => this.socketE2ee(ws))) {
      return {
        ok: false,
        error: "该机台仍配置了 remotePassword（端到端加密），直连模式需要将其清空。",
      };
    }
    if (store) await this.ctx.storage.put<StoredCard>(STATE_KEY, { message, ...store });
    const encoded = JSON.stringify(message);
    for (const ws of agents) {
      try {
        ws.send(prepareMessageForClient(encoded, this.socketCapabilities(ws)));
      } catch {
        // A dead socket is reaped by the runtime; the others still receive it.
      }
    }
    return { ok: true };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    // Anything at all is proof of life: the beat is the reliable case, but a
    // card, GPIO event, or command reply is just as good.
    await this.markSeen(ws);

    const kind = this.socketKind(ws);
    const inbound = parseNodeMessage(kind, message);
    if (!inbound) return;

    // Unified JSON-RPC reply handling across all node kinds.
    if (inbound.kind === "rpc_reply") {
      const nodeCall = this.nodeCalls.get(inbound.id);
      if (nodeCall?.ws === ws) {
        nodeCall.finish(inbound.error ? { ok: false, error: inbound.error.message } : { ok: true, result: inbound.result });
        return;
      }
      const pending = this.rpcs.get(inbound.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.rpcs.delete(inbound.id);
        pending.settle(inbound.error ? { id: inbound.id, error: inbound.error } : { id: inbound.id, result: inbound.result });
      }
      return;
    }

    // Unified passive hello for `launcher` and `iot`.
    if (inbound.kind === "node_hello") {
      const previous = (ws.deserializeAttachment() ?? {}) as Attachment;
      ws.serializeAttachment({
        ...previous,
        ...(inbound.hello.version ? { version: inbound.hello.version } : {}),
        ...(inbound.hello.model ? { model: inbound.hello.model } : {}),
        seenAt: Date.now(),
      } satisfies Attachment);
      return;
    }

    // Unified heartbeat for `launcher` and `iot`.
    if (inbound.kind === "node_heartbeat") {
      const previous = (ws.deserializeAttachment() ?? {}) as Attachment;
      ws.serializeAttachment({
        ...previous,
        ...("program" in inbound.heartbeat ? { program: inbound.heartbeat.program ?? null } : {}),
        seenAt: Date.now(),
      } satisfies Attachment);
      const channel = await this.channel();
      if (channel?.channel && previous.ha && inbound.heartbeat.ha !== undefined) {
        const key = watcherKeyOf(channel);
        const session = await this.ctx.storage.get<string>(HA_SESSION_KEY);
        if (!session || previous.session === session) {
          await shopHub(this.env, channel.shopId)
            ?.relayOnline(channel.shopId, key, channel.channel, {
              session: previous.session,
              restart: !inbound.heartbeat.ha.length,
              kind,
              ...(channel.label ? { label: channel.label } : {}),
            })
            .catch((error) => log.error(`could not refresh watcher node ${key} with shop hub`, { shopId: channel.shopId, key, error }));
          for (const health of inbound.heartbeat.ha) {
            await shopHub(this.env, channel.shopId)
              ?.haReport(channel.shopId, key, { method: "ha.status", params: health })
              .catch((error) => log.error(`could not pass node ${key}'s Home Assistant status to shop hub`, { shopId: channel.shopId, key, error }));
          }
        }
      }
      return;
    }

    // GPIO input feedback -> map `(nodeId, pin)` to bound resource standard signal.
    if (inbound.kind === "gpio_event") {
      const channel = await this.channel();
      if (!channel?.nodeId) return;
      const targets = await resolveGpioInputTargets(this.env.DB, channel.shopId, channel.nodeId, inbound.event.pin).catch(() => []);
      if (!targets.length) return;
      const bus = createRuntimeBus({
        db: this.env.DB,
        env: this.env,
        shopId: channel.shopId,
        via: { channel: "relay", resourceId: null },
      });
      for (const target of targets) {
        await bus
          .signal({
            device: { id: target.deviceId },
            capability: target.capability,
            name: target.signal,
            payload: {
              nodeId: channel.nodeId,
              pin: inbound.event.pin,
              edge: inbound.event.edge,
              count: inbound.event.count,
              ...(inbound.event.value !== undefined ? { value: inbound.event.value } : {}),
            },
          })
          .catch((error) =>
            log.error(`could not record gpio event from node ${channel.nodeId}`, {
              shopId: channel.shopId,
              nodeId: channel.nodeId,
              deviceId: target.deviceId,
              pin: inbound.event.pin,
              error,
            }),
          );
      }
      return;
    }

    // Unified HA state report (`hinata_io` and `iot`).
    if (inbound.kind === "ha_report") {
      const channel = await this.channel();
      const key = channel ? watcherKeyOf(channel) : "";
      if (channel && key) {
        await shopHub(this.env, channel.shopId)
          ?.haReport(channel.shopId, key, inbound.report)
          .catch((error) => log.error(`could not pass node ${key}'s Home Assistant report to the shop hub`, { shopId: channel.shopId, key, error }));
      }
      return;
    }

    // HINATA IO protocol events below.
    if (inbound.kind === "io_hello") {
      const { hello } = inbound;
      const ha = hello.features.includes("ha.watch");
      const previous = ws.deserializeAttachment() as Attachment;
      const session = previous.session ?? crypto.randomUUID();
      ws.serializeAttachment({
        ...previous,
        e2ee: hello.e2ee,
        ha,
        session,
        ...(hello.ioVersion ? { version: hello.ioVersion } : {}),
        seenAt: Date.now(),
      } satisfies Attachment);
      if (hello.ioVersion) await this.ioVersion(hello.ioVersion);
      if (hello.authenticated && !hello.e2ee) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "io.setLiveConfig", params: { key: "cabinetMonitor", value: "1" } }));
      }
      const channel = await this.channel();
      const key = channel ? watcherKeyOf(channel) : "";
      if (ha && channel?.channel && key) {
        await this.ctx.storage.put(HA_SESSION_KEY, session);
        await shopHub(this.env, channel.shopId)
          ?.relayOnline(channel.shopId, key, channel.channel, { session })
          .catch((error) => log.error(`could not tell the shop hub machine ${key} is online`, { shopId: channel.shopId, machineId: key, error }));
      }
      return;
    }

    const attachment = ws.deserializeAttachment() as Attachment | null;
    const session = await this.ctx.storage.get<string>(HA_SESSION_KEY);
    if (session && attachment?.ha && attachment.session !== session) return;

    if (inbound.kind === "io_heartbeat") {
      await this.dropExpiredCapture();
      const channel = await this.channel();
      const key = channel ? watcherKeyOf(channel) : "";
      if (channel?.channel && key && attachment?.ha) {
        await shopHub(this.env, channel.shopId)
          ?.relayOnline(channel.shopId, key, channel.channel, { session: attachment.session, restart: !inbound.ha.length })
          .catch((error) => log.error(`could not tell the shop hub machine ${key} is online`, { shopId: channel.shopId, machineId: key, error }));
      }
      if (channel?.channel && key && inbound.ha.length) {
        for (const health of inbound.ha) {
          await shopHub(this.env, channel.shopId)
            ?.haReport(channel.shopId, key, { method: "ha.status", params: health })
            .catch((error) => log.error(`could not pass machine ${key}'s Home Assistant report to the shop hub`, { shopId: channel.shopId, machineId: key, error }));
        }
      }
      if (inbound.cabinet) await this.cabinet(inbound.cabinet);
      if (inbound.readers) await this.readers(inbound.readers);
      return;
    }

    if (inbound.kind === "cabinet") {
      await this.cabinet(inbound.snapshot);
      return;
    }

    if (inbound.kind === "readers") {
      await this.readers(inbound.readers);
      if (inbound.change) {
        const change = inbound.change;
        await this.record("reader", (bus, bound) =>
          bus.signal({ device: { id: bound.machineId }, capability: "hinata_io", name: change.signal, payload: change.reader }));
      }
      return;
    }

    if (inbound.kind !== "io_event") return;
    const { event } = inbound;
    // Reader colours come every frame and are never stored.
    if (event.method === "event.ledSet") return;
    const name = SIGNAL_NAMES[event.method];
    const source = ioEventSource(event.params);
    if (event.method === "event.cardConsumed" && source) {
      // The game has the card, so a reconnect must not hand it over again.
      const stored = await this.ctx.storage.get<Partial<StoredCard>>(STATE_KEY);
      if (stored?.source === source) await this.ctx.storage.delete(STATE_KEY);
    }
    const card = reportedCard(event.params.card);
    // A card the platform did not send may be one a player is adding here.
    if (event.method === "event.cardStateChanged" && event.params.card && !source) await this.capture(card);
    // Card numbers never leave this object: the log keeps the card's type and
    // whose it is.
    const payload = {
      ...event.params,
      card: withoutCardNumber(event.params.card),
      ...("previous_card" in event.params ? { previous_card: withoutCardNumber(event.params.previous_card) } : {}),
      // Put on the reader, or sent by the platform (a page or a bot asked for it, `operationId` says which).
      ...(event.params.card ? { cardFrom: source ? "platform" : "reader" } : {}),
    };
    this.answer(name, source, payload);
    if (!hinataIo.signals[name]?.store) return;
    await this.record(name, (bus, bound) => this.signal(bus, bound, name, source, payload, card?.accessCode ?? null));
  }

  /**
   * Record a signal about whoever it concerns. A card names its owner at this
   * shop; otherwise the operation the signal belongs to names the player it
   * was for. A card nobody owns here concerns nobody. Who then occupies the
   * cabinet, what the bots say and the hub's recheck all follow from the event
   * (`events/subscribers.ts`).
   */
  private async signal(
    bus: ReturnType<typeof createRuntimeBus>,
    channel: Channel & { machineId: string },
    name: string,
    source: string | null,
    payload: Record<string, unknown>,
    accessCode: string | null,
  ) {
    const cards = createCardStore(this.env.DB, channel.shopId, this.env.URL_ENCRYPTION_KEY);
    const playerId = (accessCode ? await cards.playerOf(accessCode) : null)
      ?? (source ? await this.operationPlayer(channel.shopId, source) : null);
    await bus.signal({ device: { id: channel.machineId }, capability: "hinata_io", name, operationId: source, payload, playerId });
  }

  /**
   * Hears the cabinet's player seen at it by a card the game took, the same
   * test that keeps the cabinet from idling: a known player billing for it.
   * This object's own listener, because the coin is a key press only it can make.
   */
  private coinAfterCardSubscriber(channel: Channel & { machineId: string }): AfterSubscriber<EventContext> {
    return {
      name: "coin-after-card",
      when: "after",
      wants: ["occupancy.seen"],
      run: async (_context, heard) => {
        for (const { event } of heard) {
          if (event.payload.causeType !== "card.consumed" || !event.playerId) continue;
          await this.coinAfterCard(channel, event.playerId, event.operationId);
        }
      },
    };
  }

  /**
   * One coin for the card the game just took, when the cabinet is set to coin
   * after a card. Only below a coin limit read from the cabinet's own books:
   * an IO that does not report them, or a cabinet with no limit, gets none.
   */
  private async coinAfterCard(channel: Channel & { machineId: string }, playerId: string, cardOperation: string | null) {
    const device = await loadResource(this.env.DB, channel.shopId, channel.machineId);
    if (!device || !coinConfigOf(device)?.afterSwipe || !can(device, "coin")) return;
    const operationId = crypto.randomUUID();
    if (await coinGate(this.env.DB, channel.shopId, device, operationId) !== "ok") return;
    // The key press is this object's own; it is not sent out and back to reach it.
    const env = { ...this.env, MACHINE_RELAY: { getByName: () => this } } as unknown as Env;
    // The platform's own rule asked for this coin, not the reader the card came through.
    await createRuntimeBus({ db: this.env.DB, env, shopId: channel.shopId, via: { channel: "system", resourceId: null } }).perform({
      device, action: "coin", actor: { type: "player", playerId }, operationId, cause: "card",
      ...(cardOperation ? { parentOperationId: cardOperation } : {}),
    });
  }

  /**
   * The cabinet's books as the IO read them. The latest readable ones are kept
   * here to compare the next with, and stored as the device's `cabinet` state
   * (what the coin limit reads); what changed between two is recorded and told
   * (`cabinet.ts`). A read that failed is stored too, so the board can say so,
   * but is never compared: the next good read is compared with the last good one.
   */
  private async cabinet(snapshot: CabinetSnapshot) {
    const before = await this.ctx.storage.get<CabinetBooks>(CABINET_KEY);
    if (isCabinetBooks(snapshot)) await this.ctx.storage.put<CabinetBooks>(CABINET_KEY, snapshot);
    const changes = isCabinetBooks(snapshot) && before ? cabinetChanges(before, snapshot) : [];
    await this.record("cabinet", async (bus, channel) => {
      const device = { id: channel.machineId };
      const { revision: _revision, readAtMs: _read, ...value } = snapshot;
      // The read itself is not news; only what changed between reads is.
      await bus.reportMany([{ device, capability: "hinata_io", key: "cabinet", value, quiet: true }]);
      if (!before || !isCabinetBooks(snapshot) || !changes.length) return;
      for (const change of changes) {
        await bus.signal({ device, capability: "hinata_io", name: change.type, payload: {
          ...change.detail,
          previousCredit: before.players[0]!.credit,
          previousTotalCoin: before.bookkeeping.totalCoin,
          totalCoin: snapshot.bookkeeping.totalCoin,
        } });
      }
    });
    const judged = isCabinetBooks(snapshot) ? snapshot.players[0]?.credit ?? null : "unreadable";
    if ((await this.ctx.storage.get(CABINET_JUDGED_KEY)) !== judged) {
      await this.ctx.storage.put(CABINET_JUDGED_KEY, judged);
      await this.judgeCoinLimit();
    }
  }

  private ioVersion(version: string) {
    return this.record("version", (bus, channel) =>
      bus.reportMany([{ device: { id: channel.machineId }, capability: "hinata_io", key: "version", value: version, quiet: true }]),
    );
  }

  /** The readers an IO has now, replacing the list stored when it differs. */
  private async readers(readers: IoReader[]) {
    const encoded = JSON.stringify(readers);
    if ((await this.ctx.storage.get(READERS_KEY)) === encoded) return;
    await this.ctx.storage.put(READERS_KEY, encoded);
    await this.record("readers", (bus, channel) =>
      bus.reportMany([{ device: { id: channel.machineId }, capability: "hinata_io", key: "readers", value: readers, quiet: true }]));
  }

  /** The player a platform operation was requested by or for. */
  private async operationPlayer(shopId: string, operationId: string): Promise<string | null> {
    const row = await this.env.DB.prepare(
      `SELECT COALESCE(player_id, json_extract(payload_json, '$.forPlayerId')) AS player_id FROM device_events
       WHERE shop_id = ? AND operation_id = ? AND kind = 'request' LIMIT 1`,
    ).bind(shopId, operationId).first<{ player_id: string | null }>();
    return row?.player_id ?? null;
  }

  /** Open a window in which the next card on this reader is added to a player's account. */
  async startCardCapture(input: Omit<CardCapture, "result">): Promise<{ ok: boolean; error?: string }> {
    if (!this.agents().length) return { ok: false, error: "机台未在线" };
    await this.ctx.storage.put(CAPTURE_KEY, input);
    return { ok: true };
  }

  /**
   * What became of a capture window: still waiting, the card's outcome, or gone. A card
   * the reader has reported is added now that its player asks, not when it was read.
   * The outcome stays until the next window, so an answer lost on the way can be asked for again.
   */
  async cardCaptureResult(id: string, userId: string): Promise<{ status: "waiting" | "expired" } | CardCaptureResult> {
    const capture = await this.ctx.storage.get<CardCapture>(CAPTURE_KEY);
    if (!capture || capture.id !== id || capture.userId !== userId) return { status: "expired" };
    if (capture.result) return capture.result;
    if (capture.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(CAPTURE_KEY);
      return { status: "expired" };
    }
    if (capture.card === undefined) return { status: "waiting" };
    let result: CardCaptureResult;
    try {
      // Bound on the player's word, on their page, at this cabinet's reader.
      const channel = await this.channel();
      result = await bindReaderCard(this.env.DB, this.env.URL_ENCRYPTION_KEY, capture, capture.card, async ({ type }) => {
        await publishShopFacts({ db: this.env.DB, env: this.env, shopId: capture.shopId }, { via: { channel: "page", resourceId: null } }, [{
          name: "card.bound", resourceId: channel?.machineId ?? null, playerId: capture.playerId, payload: { type },
        }]);
      });
    } catch (error) {
      log.error(`could not bind the card read for player ${capture.playerId}`, { shopId: capture.shopId, playerId: capture.playerId, error });
      return { status: "waiting" };
    }
    const { card: _card, ...rest } = capture;
    await this.ctx.storage.put(CAPTURE_KEY, { ...rest, result });
    return result;
  }

  /** The player gave up: the next card on this reader is nobody's to add. */
  async cancelCardCapture(id: string, userId: string): Promise<void> {
    const capture = await this.ctx.storage.get<CardCapture>(CAPTURE_KEY);
    if (capture?.id === id && capture.userId === userId) await this.ctx.storage.delete(CAPTURE_KEY);
  }

  private async capture(card: ReturnType<typeof reportedCard>) {
    const capture = await this.ctx.storage.get<CardCapture>(CAPTURE_KEY);
    if (!capture || capture.result || capture.card !== undefined || capture.expiresAt <= Date.now()) return;
    await this.ctx.storage.put(CAPTURE_KEY, { ...capture, card });
    const channel = await this.channel();
    if (channel?.machineId) await cardRead(this.env, capture.shopId, capture.userId, channel.machineId);
  }

  /** A card nobody came for does not stay in storage. */
  private async dropExpiredCapture() {
    const capture = await this.ctx.storage.get<CardCapture>(CAPTURE_KEY);
    if (capture && capture.expiresAt <= Date.now()) await this.ctx.storage.delete(CAPTURE_KEY);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Hibernation sockets need the server to finish the closing handshake.
    // 1005/1006/1015 are reserved and cannot be sent in a close frame.
    const responseCode = [1005, 1006, 1015].includes(code) ? 1000 : code;
    try {
      ws.close(responseCode, reason);
    } catch {
      // Already closed.
    }
    for (const call of this.nodeCalls.values()) {
      if (call.ws === ws) call.finish({ ok: false, error: "节点已断线，执行结果未知" });
    }
    if (this.socketCapabilities(ws).role !== "agent") return;
    const otherLive = this.liveAgents().some((other) => other !== ws);
    if (!otherLive) await this.offline();
    const watching = (ws.deserializeAttachment() as Attachment | null)?.ha;
    const session = (ws.deserializeAttachment() as Attachment | null)?.session;
    if (otherLive && watching && (!this.watchers().some((other) => other !== ws) || session === await this.ctx.storage.get<string>(HA_SESSION_KEY))) {
      const channel = await this.channel();
      const key = channel ? watcherKeyOf(channel) : "";
      if (channel && key) {
        await shopHub(this.env, channel.shopId)
          ?.relayOffline(channel.shopId, key, { session })
          .catch((error) => log.error(`could not tell the shop hub node ${key} is offline`, { shopId: channel.shopId, key, error }));
      }
    }
    await this.syncPresence();
  }

  /** Connected nodes (`hinata_io` or `iot`) that can watch Home Assistant. */
  private watchers(): WebSocket[] {
    return this.liveAgents().filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.ha === true);
  }

  /**
   * Hand this node the Home Assistant watch for the shop, or take it away with
   * `null`. Uses the node's wire adapter (`HA_WATCH` for HINATA IO, JSON-RPC
   * `ha.watch` for IoT/newer nodes).
   */
  async watchHa(watch: HaWatch | null, session?: string): Promise<{ ok: boolean }> {
    const socket = this.watchers().find((ws) => !session || (ws.deserializeAttachment() as Attachment | null)?.session === session);
    if (!socket) return { ok: false };
    try {
      socket.send(encodeNodeHaWatch(this.socketKind(socket), watch));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "WebSocket error");
  }
}

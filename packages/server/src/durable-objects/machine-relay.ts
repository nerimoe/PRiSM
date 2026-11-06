import { announceShopEvent, eventPlayer } from "../resources/shop-events.js";
import type { DurableObject } from "cloudflare:workers";
import type { Env } from "../bindings.js";
import { hinataIo } from "../resources/capabilities/catalog.js";
import { createRuntimeBus } from "../resources/capabilities/runtime.js";
import type { AwaitSpec, Awaited } from "../resources/capabilities/bus.js";
import { cabinetChanges, coinLimit, isCabinetBooks, type CabinetBooks } from "../resources/capabilities/cabinet.js";
import { loadResource } from "../resources/resource.js";
import { pagesChanged, shopHub } from "./shop-hub-client.js";
import { createCardStore, reportedCard, withoutCardNumber } from "../resources/cards.js";
import { bindReaderCard, type CardCapture, type CardCaptureResult } from "../resources/card-capture.js";
import { createOccupancy } from "../resources/occupancy/service.js";
import {
  capabilitiesForAttachment,
  capabilitiesFromRequest,
  ioEventSource,
  isRecord,
  parseCabinetEvent,
  parseCabinetSnapshot,
  parseClientHello,
  parseHaStates,
  parseHeartbeat,
  parseIoEvent,
  prepareMessageForClient,
  type CabinetSnapshot,
  type ClientCapabilities,
  type IoEventMethod,
  type RelayMessage,
} from "../hardware/aimeio-relay.js";

const STATE_KEY = "state-message";
const CHANNEL_KEY = "channel";
const CAPTURE_KEY = "card-capture";
/** The last readable cabinet books, compared with the next ones. */
const CABINET_KEY = "cabinet-books";
/** The credit last judged against the limit, so a repeated beat costs nothing. */
const CABINET_JUDGED_KEY = "cabinet-judged";
/** Whether the cabinet was last at its limit, so pages hear only when that flips. */
const COIN_FULL_KEY = "coin-full";
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

type Channel = { shopId: string; machineId: string; channel?: string };

/**
 * Per-socket state. It lives in the socket attachment rather than on the
 * object, because a hibernated object wakes with its fields reset while its
 * sockets and their attachments survive.
 */
type Attachment = ClientCapabilities & { e2ee?: boolean; ha?: boolean; session?: string; /** Last time this socket said anything, ms. */ seenAt?: number };

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
    if (answer.error) return { ok: false, error: typeof answer.error.message === "string" ? answer.error.message : "机台读取失败" };
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
  private async record(what: string, write: (bus: ReturnType<typeof createRuntimeBus>, channel: Channel) => Promise<unknown>) {
    const channel = await this.channel();
    if (!channel) return;
    try {
      await write(createRuntimeBus({ db: this.env.DB, env: this.env, shopId: channel.shopId }), channel);
    } catch (error) {
      console.error(JSON.stringify({
        event: "machine_relay_record_failed",
        machineId: channel.machineId,
        what,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async setLink(online: boolean) {
    await this.record("link", (bus, channel) =>
      bus.setOwned({ device: { id: channel.machineId }, capability: "hinata_io", key: "link", value: online ? "online" : "offline" }),
    );
    // Without a link the books no longer count, so the coin button is no longer held by them.
    await this.judgeCoinLimit();
  }

  /** Open pages hear when the cabinet reaches or leaves its limit, and only then. Never gets in the way of the machine. */
  private async judgeCoinLimit() {
    const channel = await this.channel();
    if (!channel) return;
    try {
      const device = await loadResource(this.env.DB, channel.shopId, channel.machineId);
      const full = !!device && (await coinLimit(this.env.DB, channel.shopId, device)) === "full";
      // Never judged counts as not full: the button starts on, so there is nothing to tell.
      if (((await this.ctx.storage.get(COIN_FULL_KEY)) ?? false) === full) return;
      await this.ctx.storage.put(COIN_FULL_KEY, full);
      await pagesChanged(this.env, channel.shopId, { device: channel.machineId }, "coin");
    } catch (error) {
      console.error("Coin limit check failed", error);
    }
  }

  /**
   * WebSocket upgrade from a device. A request without the gateway's channel
   * headers did not come through the authenticated path and is refused.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const shopId = request.headers.get("x-prism-relay-shop");
    const machineId = request.headers.get("x-prism-relay-machine");
    if (!shopId || !machineId) {
      return new Response("Missing relay channel", { status: 400 });
    }
    const channel = request.headers.get("x-prism-relay-channel") ?? undefined;
    await this.ctx.storage.put<Channel>(CHANNEL_KEY, { shopId, machineId, ...(channel ? { channel } : {}) });

    const capabilities = capabilitiesFromRequest(request);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ...capabilities, session: crypto.randomUUID(), seenAt: Date.now() } satisfies Attachment);
    if (capabilities.role === "agent") {
      await this.ctx.storage.put(ONLINE_KEY, true);
      await this.setLink(true);
      await this.syncPresence();
    }

    // A reconnecting device cleared its card locally, so it must learn the card
    // it was still holding. Only while it would still hold it: a card replayed
    // after its lifetime would sign the last player in again on a later boot.
    const stored = await this.storedCard();
    if (stored) {
      try {
        server.send(prepareMessageForClient(JSON.stringify(stored.message), capabilities));
      } catch {
        // Socket already gone; the next command will deliver the state again.
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

  /** The board and HA assignments both use this IO presence decision. */
  private async offline(): Promise<void> {
    if ((await this.ctx.storage.get<boolean>(ONLINE_KEY)) === false) return;
    const session = await this.ctx.storage.get<string>(HA_SESSION_KEY);
    await this.setLink(false);
    if (this.liveAgents().length) {
      await this.setLink(true);
      return;
    }
    const channel = await this.channel();
    if (channel) await shopHub(this.env, channel.shopId)?.relayOffline(channel.shopId, channel.machineId, { session });
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
    // card or a state report is just as good.
    await this.markSeen(ws);

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    // An answer to an RPC this object sent.
    if (isRecord(parsed) && typeof parsed.id === "string" && !("method" in parsed) && this.rpcs.has(parsed.id)) {
      const pending = this.rpcs.get(parsed.id)!;
      clearTimeout(pending.timer);
      this.rpcs.delete(parsed.id);
      pending.settle(parsed);
      return;
    }

    // The IO announces its transports on connect, before anything else.
    const hello = parseClientHello(parsed);
    if (hello) {
      const ha = hello.features.includes("ha.watch");
      const previous = ws.deserializeAttachment() as Attachment;
      const session = previous.session ?? crypto.randomUUID();
      ws.serializeAttachment({ ...previous, e2ee: hello.e2ee, ha, session, seenAt: Date.now() } satisfies Attachment);
      const channel = await this.channel();
      if (ha && channel?.channel) {
        await this.ctx.storage.put(HA_SESSION_KEY, session);
        await shopHub(this.env, channel.shopId)
          ?.relayOnline(channel.shopId, channel.machineId, channel.channel, { session })
          .catch((error) => console.error("Shop hub relayOnline failed", error));
      }
      return;
    }

    const attachment = ws.deserializeAttachment() as Attachment | null;
    const session = await this.ctx.storage.get<string>(HA_SESSION_KEY);
    if (session && attachment?.ha && attachment.session !== session) return;

    // The beat says the IO is alive and, when it holds an assignment, what it
    // knows about each Home Assistant. That health is handed on under the same
    // method the hub already reasons about.
    const heartbeat = parseHeartbeat(parsed);
    if (heartbeat) {
      const channel = await this.channel();
      if (channel?.channel && attachment?.ha) {
        // Reoffer after an outage; an empty HA list also says the IO lost its assignment.
        await shopHub(this.env, channel.shopId)
          ?.relayOnline(channel.shopId, channel.machineId, channel.channel, { session: attachment.session, restart: !heartbeat.ha.length })
          .catch((error) => console.error("Shop hub relayOnline failed", error));
      }
      if (channel?.channel && heartbeat.ha.length) {
        // The same session keeps its assignment; only a reconnect or lost task gets a new term.
        for (const health of heartbeat.ha) {
          await shopHub(this.env, channel.shopId)
            ?.haReport(channel.shopId, channel.machineId, { method: "ha.status", params: health })
            .catch((error) => console.error("Shop hub haReport failed", error));
        }
      }
      // The beat repeats the latest books, so a missed snapshot event is made up
      // for here; an unchanged one changes nothing.
      if (heartbeat.cabinet) await this.cabinet(heartbeat.cabinet);
      return;
    }

    const books = parseCabinetEvent(parsed);
    if (books) {
      await this.cabinet(books);
      return;
    }

    const report = parseHaStates(parsed);
    if (report) {
      const channel = await this.channel();
      if (channel) {
        await shopHub(this.env, channel.shopId)
          ?.haReport(channel.shopId, channel.machineId, report)
          .catch((error) => console.error("Shop hub haReport failed", error));
      }
      return;
    }

    const event = parseIoEvent(message);
    if (!event) return;
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
    };
    this.answer(name, source, payload);
    if (!hinataIo.signals[name]?.store) return;
    await this.record(name, (bus, channel) => this.signal(bus, channel, name, source, payload, card?.accessCode ?? null));
    // Recheck occupancy and its deadline; an ineligible card does not extend either.
    if (hinataIo.signals[name]?.activity) await this.touchHub();
  }

  /**
   * Record a signal about whoever it concerns, and tell occupancy. A card names
   * its owner at this shop; otherwise the operation the signal belongs to names
   * the player it was for. A card nobody owns here concerns nobody.
   */
  private async signal(
    bus: ReturnType<typeof createRuntimeBus>,
    channel: Channel,
    name: string,
    source: string | null,
    payload: Record<string, unknown>,
    accessCode: string | null,
  ) {
    const cards = createCardStore(this.env.DB, channel.shopId, this.env.URL_ENCRYPTION_KEY);
    const playerId = (accessCode ? await cards.playerOf(accessCode) : null)
      ?? (source ? await this.operationPlayer(channel.shopId, source) : null);
    await bus.signal({ device: { id: channel.machineId }, capability: "hinata_io", name, operationId: source, payload, playerId });
    const observed = await createOccupancy({ db: this.env.DB, shopId: channel.shopId })
      .observe({ resourceId: channel.machineId, event: { kind: "signal", name, payload, playerId } });
    // The game took a card: whether it came from the reader or the platform,
    // this is when it happened, so this is where it is told.
    if (name === "card.consumed") {
      const place = { resourceId: channel.machineId, resourceName: await this.resourceName(channel) };
      const player = await eventPlayer(this.env.DB, channel.shopId, playerId);
      const started = !!observed.started;
      await announceShopEvent(this.env, channel.shopId, { type: "card", kind: "card", ...place, player, started });
      // Older bots heard the start as part of the card; newer ones as its own.
      if (started && player) await announceShopEvent(this.env, channel.shopId, { type: "start", ...place, player });
    }
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
      if (!changes.length) return;
      const place = { resourceId: channel.machineId, resourceName: await this.resourceName(channel) };
      for (const change of changes) {
        await bus.signal({ device, capability: "hinata_io", name: change.type, payload: change.detail });
        await announceShopEvent(this.env, channel.shopId, { type: change.type, ...place, player: null, detail: change.detail });
      }
    });
    if (changes.some((change) => hinataIo.signals[change.type]?.activity)) await this.touchHub();
    const judged = isCabinetBooks(snapshot) ? snapshot.players[0]?.credit ?? null : "unreadable";
    if ((await this.ctx.storage.get(CABINET_JUDGED_KEY)) !== judged) {
      await this.ctx.storage.put(CABINET_JUDGED_KEY, judged);
      await this.judgeCoinLimit();
    }
  }

  private async resourceName(channel: Channel): Promise<string> {
    const resource = await this.env.DB.prepare("SELECT name FROM machines WHERE shop_id = ? AND id = ?")
      .bind(channel.shopId, channel.machineId).first<{ name: string }>();
    return resource?.name ?? channel.machineId;
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

  /** What became of a capture window: still waiting, the card's outcome, or gone. */
  async cardCaptureResult(id: string, userId: string): Promise<{ status: "waiting" | "expired" } | CardCaptureResult> {
    const capture = await this.ctx.storage.get<CardCapture>(CAPTURE_KEY);
    if (!capture || capture.id !== id || capture.userId !== userId) return { status: "expired" };
    if (capture.result) {
      await this.ctx.storage.delete(CAPTURE_KEY);
      return capture.result;
    }
    if (capture.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(CAPTURE_KEY);
      return { status: "expired" };
    }
    return { status: "waiting" };
  }

  private async capture(card: ReturnType<typeof reportedCard>) {
    const capture = await this.ctx.storage.get<CardCapture>(CAPTURE_KEY);
    if (!capture || capture.result || capture.expiresAt <= Date.now()) return;
    let result: CardCaptureResult;
    try {
      result = await bindReaderCard(this.env.DB, this.env.URL_ENCRYPTION_KEY, capture, card);
    } catch (error) {
      console.error("Card capture failed", error);
      return;
    }
    await this.ctx.storage.put(CAPTURE_KEY, { ...capture, result });
  }

  private async touchHub() {
    const channel = await this.channel();
    if (!channel) return;
    await shopHub(this.env, channel.shopId)?.touch(channel.shopId).catch((error) => console.error("Shop hub touch failed", error));
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
    if (this.socketCapabilities(ws).role !== "agent") return;
    const otherLive = this.liveAgents().some((other) => other !== ws);
    if (!otherLive) await this.offline();
    const watching = (ws.deserializeAttachment() as Attachment | null)?.ha;
    const session = (ws.deserializeAttachment() as Attachment | null)?.session;
    if (otherLive && watching && (!this.watchers().some((other) => other !== ws) || session === await this.ctx.storage.get<string>(HA_SESSION_KEY))) {
      const channel = await this.channel();
      if (channel) {
        await shopHub(this.env, channel.shopId)
          ?.relayOffline(channel.shopId, channel.machineId, { session })
          .catch((error) => console.error("Shop hub relayOffline failed", error));
      }
    }
    await this.syncPresence();
  }

  /** Connected IOs that said they can watch Home Assistant. */
  private watchers(): WebSocket[] {
    return this.liveAgents().filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.ha === true);
  }

  /**
   * Hand this machine's IO the Home Assistant watch for the shop, or take it
   * away with `null`. Not stored: the shop hub sends it again on reconnect.
   */
  async watchHa(watch: HaWatch | null, session?: string): Promise<{ ok: boolean }> {
    const socket = this.watchers().find((ws) => !session || (ws.deserializeAttachment() as Attachment | null)?.session === session);
    if (!socket) return { ok: false };
    try {
      socket.send(JSON.stringify(watch ? { action: "HA_WATCH", body: watch } : { action: "HA_UNWATCH", body: {} }));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "WebSocket error");
  }
}

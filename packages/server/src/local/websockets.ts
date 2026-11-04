import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { OutboundSocketError, type OutboundSocket, type WebSocketPlatform } from "../platform/websocket.js";
import type { LocalObjectState } from "./object-host.js";

/**
 * WebSockets for the local runtime, shaped like Cloudflare's hibernation API.
 *
 * An object makes a pair, accepts the server end and returns the client end
 * as a 101 response. Bun keeps no `webSocket` on a response, so the response
 * carries a one-time id instead; `Bun.serve` upgrades the original request and
 * joins the connection to that server end. Frames the object sends before the
 * connection opens are held and sent on open, as the client end would have
 * received them on Cloudflare.
 */
const UPGRADE_HEADER = "x-prism-local-upgrade";
/** A 101 that never reaches `Bun.serve` (the client left) frees its socket after this. */
const UPGRADE_WAIT_MS = 30_000;

type Connection = ServerWebSocket<LocalServerSocket>;

export class LocalServerSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  private connection: Connection | null = null;
  private held: (string | ArrayBuffer | ArrayBufferView)[] = [];
  private closeWith: { code?: number; reason?: string } | null = null;
  private attachment: unknown = null;
  state: LocalObjectState | null = null;
  readyState = LocalServerSocket.OPEN;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== LocalServerSocket.OPEN) throw new Error("WebSocket is not open");
    if (this.connection) this.connection.send(data as string);
    else this.held.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= LocalServerSocket.CLOSING) return;
    this.readyState = LocalServerSocket.CLOSING;
    if (this.connection) this.connection.close(code, reason);
    else this.closeWith = { code, reason };
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): any {
    return this.attachment === null ? null : structuredClone(this.attachment);
  }

  /** The connection opened: send what was held, or the close the object already asked for. */
  open(connection: Connection): void {
    this.connection = connection;
    for (const data of this.held) connection.send(data as string);
    this.held = [];
    if (this.closeWith) connection.close(this.closeWith.code, this.closeWith.reason);
  }

  closed(): void {
    this.readyState = LocalServerSocket.CLOSED;
    this.connection = null;
    this.held = [];
  }
}

export class LocalWebSockets implements WebSocketPlatform {
  private readonly waiting = new Map<string, { socket: LocalServerSocket; timer: ReturnType<typeof setTimeout> }>();

  pair() {
    const server = new LocalServerSocket();
    return { client: server, server: server as unknown as WebSocket };
  }

  upgrade(client: unknown): Response {
    if (!(client instanceof LocalServerSocket)) throw new TypeError("Not a local WebSocket");
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      this.waiting.delete(id);
      void this.disconnected(client, 1006, "Upgrade not completed");
    }, UPGRADE_WAIT_MS);
    this.waiting.set(id, { socket: client, timer });
    return new Response(null, { status: 101, headers: { [UPGRADE_HEADER]: id } });
  }

  async connect(url: string): Promise<OutboundSocket> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new OutboundSocketError(502)), { once: true });
      socket.addEventListener("close", () => reject(new OutboundSocketError(502)), { once: true });
    });
    return socket;
  }

  autoResponse(request: string, response: string) {
    return { request, response };
  }

  accept(socket: LocalServerSocket, state: LocalObjectState, tags: string[]): void {
    socket.state = state;
    state.sockets.set(socket, [...tags]);
  }

  /**
   * Finish a 101 from the app: upgrade the request it answered and hand Bun
   * the socket to join. Returns undefined when Bun took the connection.
   */
  complete(request: Request, response: Response, server: Server<LocalServerSocket>): Response | undefined {
    const id = response.headers.get(UPGRADE_HEADER);
    const entry = id ? this.waiting.get(id) : undefined;
    if (!id || !entry) return new Response("WebSocket upgrade was not prepared", { status: 500 });
    this.waiting.delete(id);
    clearTimeout(entry.timer);
    const headers = new Headers(response.headers);
    headers.delete(UPGRADE_HEADER);
    if (server.upgrade(request, { data: entry.socket, headers })) return undefined;
    void this.disconnected(entry.socket, 1006, "Upgrade failed");
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  /** Bun's handlers for every socket an object accepted. */
  readonly handler: WebSocketHandler<LocalServerSocket> = {
    open: (connection) => connection.data.open(connection),
    message: (connection, message) => {
      const socket = connection.data;
      const state = socket.state;
      if (!state) return;
      // Cloudflare answers the auto-response pair without waking the object.
      if (typeof message === "string" && state.autoResponse && message === state.autoResponse.request) {
        connection.send(state.autoResponse.response);
        return;
      }
      const data = typeof message === "string"
        ? message
        : message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength);
      void this.dispatch(socket, "webSocketMessage", [socket, data]);
    },
    close: (connection, code, reason) => {
      void this.disconnected(connection.data, code, reason);
    },
  };

  private async disconnected(socket: LocalServerSocket, code: number, reason: string): Promise<void> {
    if (socket.readyState === LocalServerSocket.CLOSED) return;
    socket.closed();
    await this.dispatch(socket, "webSocketClose", [socket, code, reason, code !== 1006]);
    socket.state?.sockets.delete(socket);
  }

  private async dispatch(socket: LocalServerSocket, handler: string, args: unknown[]): Promise<void> {
    const instance = socket.state?.object.instance;
    if (typeof instance?.[handler] !== "function") return;
    try {
      await instance[handler](...args);
    } catch (error) {
      console.error(JSON.stringify({
        event: "local_websocket_handler_failed", handler, namespace: socket.state?.object.namespace,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

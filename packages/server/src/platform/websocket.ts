/**
 * WebSockets the platform has to make: the pair a Durable Object accepts and
 * hands back as a 101 response, and an outbound socket (Home Assistant).
 *
 * Cloudflare's are the default. The local runtime installs its own at start
 * (`local/websockets.ts`), since Bun has no `WebSocketPair`, drops a
 * response's `webSocket`, and opens outbound sockets with `new WebSocket`.
 */
export type OutboundSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: (event: any) => void): void;
};

export type WebSocketPlatform = {
  /** The client end goes into the upgrade response; the server end is accepted by the object. */
  pair(): { client: unknown; server: WebSocket };
  upgrade(client: unknown): Response;
  connect(url: string): Promise<OutboundSocket>;
  /** The pair `ctx.setWebSocketAutoResponse` takes: `request` is answered with `response`. */
  autoResponse(request: string, response: string): unknown;
};

export const cloudflareWebSockets: WebSocketPlatform = {
  pair() {
    const [client, server] = Object.values(new WebSocketPair());
    return { client, server: server! };
  },
  upgrade(client) {
    return new Response(null, { status: 101, webSocket: client as WebSocket });
  },
  async connect(url) {
    // Workers open an outbound WebSocket through `fetch` with an Upgrade header.
    const response = await fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } });
    const socket = (response as Response & { webSocket?: (OutboundSocket & { accept(): void }) | null }).webSocket;
    if (!socket) throw new OutboundSocketError(response.status);
    socket.accept();
    return socket;
  },
  autoResponse(request, response) {
    return new WebSocketRequestResponsePair(request, response);
  },
};

export class OutboundSocketError extends Error {
  constructor(readonly status: number) {
    super(`WebSocket upgrade refused (HTTP ${status})`);
  }
}

let current = cloudflareWebSockets;

/** Install a platform; returns the one it replaces, to put back. */
export function useWebSocketPlatform(platform: WebSocketPlatform): WebSocketPlatform {
  const previous = current;
  current = platform;
  return previous;
}

export const openWebSocketPair = () => current.pair();
export const webSocketUpgrade = (client: unknown) => current.upgrade(client);
export const connectWebSocket = (url: string) => current.connect(url);
export const webSocketAutoResponse = (request: string, response: string) => current.autoResponse(request, response);

import {
  authenticateMachineWebSocketRequest,
  createPrismApp,
  type PrismAppDependencies,
} from "@prism/server-hono";

export type BunWebSocketUpgradeServer = {
  upgrade(request: Request, options: { data: Record<string, unknown> }): boolean;
};

export function createPrismLocalFetchHandler(dependencies: PrismAppDependencies) {
  const app = createPrismApp(dependencies);

  return async function fetch(
    request: Request,
    server: BunWebSocketUpgradeServer,
  ): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === "/rpc/machine/ws") {
      const auth = await authenticateMachineWebSocketRequest(request, dependencies);
      if (auth instanceof Response) return auth;
      const upgraded = server.upgrade(request, {
        data: auth.data,
      });
      return upgraded
        ? undefined
        : new Response("WebSocket upgrade failed.", { status: 400 });
    }
    return app.fetch(request);
  };
}

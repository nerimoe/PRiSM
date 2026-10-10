import { Hono } from "hono";
import type { AppBindings } from "../bindings.js";
import { unwrapLegacyResponse } from "../middleware/response-time.js";

export { unwrapLegacyResponse };

/**
 * Creates an RPC fallback router for legacy clients expecting unnested JSON
 * at `/rpc/*` endpoints (rewriting requests to `/api/v1/*` internally).
 */
export function createLegacyRpcRouter(apiRouter: Hono<AppBindings>): Hono<AppBindings> {
  const rpc = new Hono<AppBindings>();

  rpc.all("/*", async (c) => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^\/rpc\//, "/api/v1/").replace(/^\/rpc$/, "/api/v1");

    const req = new Request(url.toString(), c.req.raw);
    let executionCtx: any = undefined;
    try {
      executionCtx = c.executionCtx;
    } catch {
      // Non-Cloudflare environment (Bun/Node tests)
    }
    const res = await apiRouter.fetch(req, c.env, executionCtx);
    return unwrapLegacyResponse(res);
  });

  return rpc;
}

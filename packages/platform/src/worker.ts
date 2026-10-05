import app from "./index";
import { deploymentControl } from "./deployment-control";
import { isDeploymentMaintenance, maintenanceResponse } from "./deployment-gate";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const control = await deploymentControl(request, env,
      async () => app.fetch(new Request(new URL("/api/v1/health", request.url)), env, ctx));
    if (control) return control;
    try {
      if (await isDeploymentMaintenance(env)) return maintenanceResponse(request);
    } catch { return maintenanceResponse(request); }
    const path = new URL(request.url).pathname;
    if (env.ASSETS && ["GET", "HEAD"].includes(request.method)
      && !path.startsWith("/api/") && !path.startsWith("/.well-known/")
      && !path.startsWith("/callback") && !/^\/t\/[^/]+\/[^/]+/.test(path))
      return env.ASSETS.fetch(request);
    const response = await app.fetch(request, env, ctx);
    if (path === "/api/v1/health" && env.PRISM_DEPLOY_REVISION) {
      const headers = new Headers(response.headers);
      headers.set("x-prism-revision", env.PRISM_DEPLOY_REVISION);
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },
};
export { LiveBilling } from "./live-billing-object";

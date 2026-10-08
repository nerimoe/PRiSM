import app from "./index";
import { deploymentControl } from "./deployment-control";
import { isDeploymentMaintenance, maintenanceResponse } from "./deployment-gate";
import { purgeExpiredPlatformState } from "./retention";
import type { Env } from "./types";

export default {
  async scheduled(_event: ScheduledController, env: Env) {
    if (await isDeploymentMaintenance(env)) return;
    await purgeExpiredPlatformState(env);
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const control = await deploymentControl(request, env,
      async () => app.fetch(new Request(new URL("/api/v1/health", request.url)), env, ctx));
    if (control) return control;
    const path = new URL(request.url).pathname;
    if (env.ASSETS && env.PRISM_DEPLOY_PHASE !== "maintenance" && env.PRISM_DEPLOY_PHASE !== "verify"
      && ["GET", "HEAD"].includes(request.method)
      && !path.startsWith("/api/") && !path.startsWith("/.well-known/")
      && !path.startsWith("/callback") && !path.startsWith("/__prism_deploy") && !/^\/t\/[^/]+\/[^/]+/.test(path))
      return env.ASSETS.fetch(request);
    try {
      if (await isDeploymentMaintenance(env)) return maintenanceResponse(request);
    } catch { return maintenanceResponse(request); }
    const startedAt = performance.now();
    const response = await app.fetch(request, env, ctx);
    if (response.status >= 500 || Math.random() < 0.01) {
      const route = path.startsWith("/t/") ? "/t/:shop/:machine"
        : path.startsWith("/api/v1/devices/session/") ? path
        : path.startsWith("/api/v1/machines/") ? "/api/v1/machines/:action"
        : path.startsWith("/api/v1/shops/") ? "/api/v1/shops/:shop" : "/other";
      console.log(JSON.stringify({ event: "api_request", route, method: request.method,
        status: response.status, durationMs: Math.round(performance.now() - startedAt) }));
    }
    if (path === "/api/v1/health" && env.PRISM_DEPLOY_REVISION) {
      const headers = new Headers(response.headers);
      headers.set("x-prism-revision", env.PRISM_DEPLOY_REVISION);
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },
};
export { LiveBilling } from "./live-billing-object";

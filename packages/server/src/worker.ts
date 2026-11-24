import app from "./app.js";
import { applyAllDuePricingChanges } from "./pricing-changes.js";
import {
  deploymentControl,
  isDeploymentMaintenance,
  maintenanceResponse,
} from "./deployment-gate.js";
import { dispatchToRelay, relayGateway } from "./gateway/machine-relay-gateway.js";
import { purgeExpiredPlatformState } from "./tasks/cron-handlers.js";
import { isAssetEligiblePath } from "./routes/web-assets.js";
import type { Env } from "./bindings.js";
import { logger, requestLine } from "./log.js";

const log = logger("http");
/** What the static assets answered; those are not requests worth a line each. */
const assetResponses = new WeakSet<Response>();

async function handle(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const control = await deploymentControl(
    request,
    env,
    async () =>
      app.fetch(
        new Request(new URL("/api/v1/health", request.url)),
        env,
        ctx,
      ),
  );
  if (control) return control;

  const path = new URL(request.url).pathname;

  if (
    env.ASSETS &&
    env.PRISM_DEPLOY_PHASE !== "maintenance" &&
    env.PRISM_DEPLOY_PHASE !== "verify" &&
    ["GET", "HEAD"].includes(request.method) &&
    isAssetEligiblePath(path)
  ) {
    const asset = await env.ASSETS.fetch(request);
    assetResponses.add(asset);
    return asset;
  }

  try {
    if (await isDeploymentMaintenance(env)) {
      return maintenanceResponse(request);
    }
  } catch {
    return maintenanceResponse(request);
  }

  // Device relay upgrades. Handled before app.fetch because this is a bare
  // WebSocket upgrade, not a JSON route, and it must win over the static-asset
  // gate above. A device retries on 5xx but treats 401 as permanent, so an
  // offline platform during maintenance is a clean, non-fatal interruption.
  const relay = await relayGateway(request, env);
  if (relay.kind === "rejected") return relay.response;
  if (relay.kind === "dispatch") {
    return dispatchToRelay(request, env, relay);
  }

  const response = await app.fetch(request, env, ctx);

  if (
    (path === "/api/v1/health" || path === "/health") &&
    env.PRISM_DEPLOY_REVISION
  ) {
    const headers = new Headers(response.headers);
    headers.set("x-prism-revision", env.PRISM_DEPLOY_REVISION);
    return new Response(response.body, { status: response.status, headers });
  }

  return response;
}

export const worker = {
  async scheduled(
    _event: ScheduledController | { scheduledTime?: number; cron?: string },
    env: Env,
  ): Promise<void> {
    if (await isDeploymentMaintenance(env)) return;
    await purgeExpiredPlatformState(env);
    // Scheduled price changes apply before anyone enters anyway; the sweep
    // puts them in place for shops nobody visits around the moment.
    await applyAllDuePricingChanges(env.DB);
  },

  /** Every request the Worker answers itself gets one line (`log.ts`); Cloudflare's own per-call records are off. */
  async fetch(
    request: Request,
    env: Env,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const startedAt = performance.now();
    try {
      const response = await handle(request, env, ctx);
      if (!assetResponses.has(response)) requestLine(request, response.status, performance.now() - startedAt);
      return response;
    } catch (error) {
      requestLine(request, 500, performance.now() - startedAt);
      log.error("request threw", { error });
      throw error;
    }
  },
};

export default worker;
export { LiveBilling } from "./durable-objects/live-billing.js";
export { MachineRelay } from "./durable-objects/machine-relay.js";
export { ShopHub } from "./durable-objects/shop-hub.js";

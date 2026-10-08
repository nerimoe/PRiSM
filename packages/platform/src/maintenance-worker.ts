import { DurableObject } from "cloudflare:workers";
import { deploymentControl } from "./deployment-control";
import { maintenanceResponse } from "./deployment-gate";
import type { Env } from "./types";

/** Keeps the existing Durable Object class and storage; no business schema is touched. */
export class LiveBilling extends DurableObject<Env> {
  async refresh(shopId: string, playerId: string) {
    const previous = await this.ctx.storage.get<{ revision: number }>("visit");
    await this.ctx.storage.put("visit", { shopId, playerId, revision: (previous?.revision ?? 0) + 1 });
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }
  async alarm() { await this.ctx.storage.setAlarm(Date.now() + 30_000); }
}

export default {
  async scheduled() { /* Retention pauses while the schema is being migrated. */ },
  async fetch(request: Request, env: Env): Promise<Response> {
    const control = await deploymentControl(request, env, async () => maintenanceResponse(request));
    return control ?? maintenanceResponse(request);
  },
};

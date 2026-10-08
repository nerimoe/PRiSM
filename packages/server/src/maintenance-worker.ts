import type { DurableObject } from "cloudflare:workers";
import { deploymentControl, maintenanceResponse } from "./deployment-gate.js";
import type { Env } from "./bindings.js";

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

/** Keeps the existing Durable Object class and storage; no business schema is touched. */
export class LiveBilling extends BaseDurableObject<Env> {
  async refresh(shopId: string, playerId: string): Promise<void> {
    const previous = await this.ctx.storage.get<{ revision: number }>("visit");
    await this.ctx.storage.put("visit", {
      shopId,
      playerId,
      revision: (previous?.revision ?? 0) + 1,
    });
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }
}

export default {
  async scheduled(): Promise<void> {
    /* Retention pauses while the schema is being migrated. */
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const control = await deploymentControl(
      request,
      env,
      async () => maintenanceResponse(request),
    );
    return control ?? maintenanceResponse(request);
  },
};

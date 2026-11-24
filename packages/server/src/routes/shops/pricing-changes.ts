import { Hono, type Context } from "hono";
import { z } from "zod";
import { normalizePricingConfigDraft } from "@prism/application";
import type { PricingBindings, PricingConfig, PricingSnapshot } from "@prism/core";
import type { AppBindings, TenantShop } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { getShop } from "../../middleware/tenant.js";
import { notifyBotsChangedAfter } from "../../durable-objects/shop-hub-client.js";
import {
  applyDuePricingChanges,
  applyPricingChangeNow,
  cancelPricingChange,
  pricingActor,
  pricingChangeDetail,
  pricingTimeline,
  projectedSnapshot,
  readBindingNames,
  readCurrentSnapshot,
  restoreDraft,
  savePricingChange,
  type PricingChangeDraft,
} from "../../pricing-changes.js";
import { toPricingConfigManagementView } from "./views.js";

/**
 * The price list's history and its scheduled changes, under
 * `/shops/:shopCode/staff/pricing-configs/changes`. See docs/pricing-changes.md.
 */
export const pricingChangesRouter = new Hono<AppBindings>();
type C = Context<AppBindings>;

const planId = z.string().min(1).nullable();
const bindingsInput = z.object({
  groups: z.record(z.string(), planId).optional(),
  resources: z.record(z.string(), planId).optional(),
  tables: z.record(z.string(), planId).optional(),
});
const planInput = z.object({
  id: z.string().min(1),
  kind: z.enum(["time.priority", "time.cap", "charge.fixed"]),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  status: z.enum(["active", "archived"]).optional(),
  provider: z.record(z.string(), z.unknown()),
  relations: z.object({
    requires: z.array(z.string().min(1)).max(50),
    conflicts: z.array(z.string().min(1)).max(50),
  }).optional(),
});
const changeInput = z.object({
  /** Null applies the change now. */
  effectiveAt: z.string().datetime({ offset: true }).nullable(),
  /** Only the plans the editor changed or created. */
  plans: z.array(planInput).max(200).default([]),
  bindings: bindingsInput.default({}),
  note: z.string().trim().max(200).nullable().optional(),
  restoredFrom: z.string().min(1).nullable().optional(),
});

async function writer(c: C) {
  const shop = getShop(c);
  const principal = await staffPrincipal(c, shop);
  const actor = await pricingActor(c.env.DB, shop.id, {
    userId: c.get("user")?.id ?? null,
    staffId: "staffId" in principal ? (principal as { staffId?: string }).staffId : null,
  });
  return { shop, actor };
}

function snapshotView(snapshot: PricingSnapshot) {
  return { configs: snapshot.configs.map(toPricingConfigManagementView), bindings: snapshot.bindings };
}

async function names(c: C, shop: TenantShop) {
  const [bindingNames, current] = await Promise.all([readBindingNames(c.env.DB, shop.id), readCurrentSnapshot(c.env.DB, shop.id)]);
  return { ...bindingNames, plans: Object.fromEntries(current.configs.map((config) => [config.id, config.name])) };
}

/** Which plan each group, resource and table uses now, with their names. */
async function currentBindings(c: C, shop: TenantShop) {
  return (await readCurrentSnapshot(c.env.DB, shop.id)).bindings;
}

async function draftOf(c: C, shop: TenantShop, body: z.infer<typeof changeInput>): Promise<PricingChangeDraft> {
  const current = new Map((await readCurrentSnapshot(c.env.DB, shop.id)).configs.map((config) => [config.id, config]));
  const configs: PricingConfig[] = [];
  for (const plan of body.plans) {
    configs.push(await normalizePricingConfigDraft(
      { ...plan, provider: plan.provider as PricingConfig["provider"] },
      { now: () => new Date(), existing: current.get(plan.id) ?? null },
    ));
  }
  return { configs, bindings: body.bindings as Partial<PricingBindings> };
}

pricingChangesRouter.get("/", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  await applyDuePricingChanges(c.env.DB, shop.id);
  const timeline = await pricingTimeline(c.env.DB, shop.id, {
    before: c.req.query("before") || undefined,
    limit: Number(c.req.query("limit")) || undefined,
  });
  return c.json({
    ...timeline,
    names: await names(c, shop),
    bindings: await currentBindings(c, shop),
    timeZone: shop.time_zone || "UTC",
  });
});

/** The price list as it will be at `at`, for a new scheduled change to start from. */
pricingChangesRouter.get("/projected", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  await applyDuePricingChanges(c.env.DB, shop.id);
  const at = new Date(c.req.query("at") ?? "");
  if (Number.isNaN(at.getTime())) jsonError(400, "请提供有效的时间", "INVALID_TIME");
  return c.json({ snapshot: snapshotView(await projectedSnapshot(c.env.DB, shop.id, at)), names: await names(c, shop) });
});

pricingChangesRouter.get("/:id", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const { entry, snapshot } = await pricingChangeDetail(c.env.DB, shop.id, c.req.param("id"));
  const baseNames = await names(c, shop);
  const planNames = { ...baseNames.plans, ...Object.fromEntries(snapshot.configs.map((config) => [config.id, config.name])) };
  return c.json({ entry, snapshot: snapshotView(snapshot), names: { ...baseNames, plans: planNames } });
});

/** A draft that brings back the price list of this entry. */
pricingChangesRouter.get("/:id/restore-draft", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  return c.json({ snapshot: snapshotView(await restoreDraft(c.env.DB, shop.id, c.req.param("id"))), names: await names(c, shop) });
});

pricingChangesRouter.post("/", async (c) => {
  const { shop, actor } = await writer(c);
  const body = changeInput.parse(await c.req.json());
  const result = await savePricingChange(c.env.DB, shop.id, {
    effectiveAt: body.effectiveAt ? new Date(body.effectiveAt) : null,
    draft: await draftOf(c, shop, body),
    note: body.note ?? null,
    actor,
    source: body.restoredFrom ? "restore" : body.effectiveAt ? "schedule" : "edit",
    restoredFrom: body.restoredFrom ?? null,
    timeZone: shop.time_zone || "UTC",
  });
  if (!body.effectiveAt) notifyBotsChangedAfter(c, shop.id);
  return c.json(result, 201);
});

pricingChangesRouter.patch("/:id", async (c) => {
  const { shop, actor } = await writer(c);
  const body = changeInput.parse(await c.req.json());
  if (!body.effectiveAt) jsonError(400, "请选择生效时间", "PRICING_CHANGE_IN_PAST");
  const result = await savePricingChange(c.env.DB, shop.id, {
    id: c.req.param("id"),
    effectiveAt: new Date(body.effectiveAt),
    draft: await draftOf(c, shop, body),
    note: body.note,
    actor,
    timeZone: shop.time_zone || "UTC",
  });
  return c.json(result);
});

pricingChangesRouter.post("/:id/cancel", async (c) => {
  const { shop } = await writer(c);
  await cancelPricingChange(c.env.DB, shop.id, c.req.param("id"));
  return c.json({ status: "cancelled" });
});

pricingChangesRouter.post("/:id/apply-now", async (c) => {
  const { shop } = await writer(c);
  const status = await applyPricingChangeNow(c.env.DB, shop.id, c.req.param("id"));
  notifyBotsChangedAfter(c, shop.id);
  return c.json({ status });
});

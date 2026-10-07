import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import {
  toAssetDefinitionManagementView,
  toPricingEffectManagementView,
} from "./views.js";

export const assetsRouter = new Hono<AppBindings>();

// List Asset Definitions
assetsRouter.get("/", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const definitions = await deps.staffAssetDefinitionCommands.listAssetDefinitions();
  return c.json({
    assetDefinitions: definitions.map(toAssetDefinitionManagementView),
  });
});

// Save Asset Definition
assetsRouter.put("/:assetType/:assetCode", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const definition = await deps.staffAssetDefinitionCommands.saveAssetDefinition({
    type: c.req.param("assetType"),
    code: c.req.param("assetCode"),
    name: body.name,
    stackable: body.stackable ?? true,
    pricingEffectId: body.pricingEffectId ?? null,
    activeAt: body.activeAt ? new Date(body.activeAt) : undefined,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    metadata: body.metadata,
  });
  return c.json({
    assetDefinition: toAssetDefinitionManagementView(definition),
  });
});

// Archive Asset Definition
assetsRouter.post("/:assetType/:assetCode/archive", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const definition = await deps.staffAssetDefinitionCommands.archiveAssetDefinition({
    type: c.req.param("assetType"),
    code: c.req.param("assetCode"),
  });
  return c.json({
    assetDefinition: toAssetDefinitionManagementView(definition),
  });
});

// Restore Asset Definition
assetsRouter.post("/:assetType/:assetCode/restore", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const definition = await deps.staffAssetDefinitionCommands.restoreAssetDefinition({
    type: c.req.param("assetType"),
    code: c.req.param("assetCode"),
  });
  return c.json({
    assetDefinition: toAssetDefinitionManagementView(definition),
  });
});

// List Pricing Effects
assetsRouter.get("/effects", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const effects = await deps.staffPricingEffectCommands.listPricingEffects();
  return c.json({
    pricingEffects: effects.map(toPricingEffectManagementView),
  });
});

// Save Pricing Effect
assetsRouter.put("/effects/:effectId", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const effect = await deps.staffPricingEffectCommands.savePricingEffect({
    id: c.req.param("effectId"),
    name: body.name,
    type: body.type,
    scope: body.scope,
    value: body.value,
    consumable: body.consumable,
    limitPerDay: body.limitPerDay,
    activeAt: body.activeAt ? new Date(body.activeAt) : undefined,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    status: body.status,
    config: body.config,
  });
  return c.json({
    pricingEffect: toPricingEffectManagementView(effect),
  });
});

// Archive Pricing Effect
assetsRouter.post("/effects/:effectId/archive", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const effect = await deps.staffPricingEffectCommands.archivePricingEffect({
    effectId: c.req.param("effectId"),
  });
  return c.json({
    pricingEffect: toPricingEffectManagementView(effect),
  });
});

// Restore Pricing Effect
assetsRouter.post("/effects/:effectId/restore", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const effect = await deps.staffPricingEffectCommands.restorePricingEffect({
    effectId: c.req.param("effectId"),
  });
  return c.json({
    pricingEffect: toPricingEffectManagementView(effect),
  });
});

import { errorResponse } from "../../http-errors.js";
import { publishShopFacts } from "../../events/shop-facts.js";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { formatLocalDate, PrismDomainError } from "@prism/core";
import { withOperationLease } from "@prism/application";
import type { AppBindings, TenantShop } from "../../bindings.js";
import { sha256 } from "../../crypto.js";
import { requestLocale } from "../../notices.js";
import { renderBindingPromptLines } from "../../resources/page-text.js";
import { jsonError } from "../../http.js";
import { optionalUser, requireUser, staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps, tenantMiddleware } from "../../middleware/tenant.js";
import { billingSetupStatements } from "../platform/shops.js";

import { playerRouter } from "./player.js";
import { staffRouter } from "./staff.js";
import { integrationRouter } from "./integration.js";
import { pricingRouter } from "./pricing.js";
import { pricingChangesRouter } from "./pricing-changes.js";
import { assetsRouter, staffAssetsCompatRouter } from "./assets.js";
import { cashierRouter } from "./cashier.js";
import { staffBusinessRouter } from "./business.js";
import { staffPricingCompatRouter } from "./staff-compat.js";
import { redeemRouter, staffRedeemCompatRouter } from "./redeem.js";
import { billingCompatRouter } from "./billing-compat.js";
import { identityConversionRouter } from "./identity-conversion.js";
import { shopDataRouter } from "./data/index.js";
import { legacyStaffRouter } from "../../legacy/handlers/staff.js";
import { legacyIntegrationRouter } from "../../legacy/handlers/integration.js";
import { shopBillsSql } from "../../resources/billed-sql.js";

export * from "./player.js";
export * from "./staff.js";
export * from "./integration.js";
export * from "./pricing.js";
export * from "./assets.js";
export * from "./cashier.js";
import { cashierResourceId } from "./cashier.js";
import {
  readShopLocationSettings,
  shopLocationModeSchema,
  writeShopLocationSettingsStatement,
} from "../../resources/location.js";
import { listShopBeacons } from "../../resources/nodes.js";
import { ACCOUNT_HAS_PLATFORM_IDENTITY_SQL, listAccountPlatformIdentities } from "../../resources/platform-identities.js";
import { ACCOUNT_PROFILES_SQL } from "../../resources/account-profiles.js";
export * from "./redeem.js";
export * from "./binding.js";
export * from "./views.js";

/**
 * Whether the shop can bill: players need a balance to pay from. Which
 * resources bill is set on resource groups and resources, not here.
 */
export async function billingConfiguration(db: Context<AppBindings>["env"]["DB"], shopId: string) {
  const currency = await db
    .prepare("SELECT 1 FROM asset_definitions WHERE shop_id = ? AND type = 'currency' AND status = 'active' LIMIT 1")
    .bind(shopId)
    .first();
  return { ready: !!currency, balanceAssetsReady: !!currency };
}

export function publicSettings(shop: TenantShop) {
  return {
    cashierEnabled: !!shop.cashier_enabled,
    autoRegister: !!shop.auto_register,
    identityBindingRequired: !!shop.identity_binding_required,
    locationEnabled: !!(shop.checkin_geo || shop.checkout_geo || shop.machine_geo),
    checkinGeo: !!shop.checkin_geo,
    checkoutGeo: !!shop.checkout_geo,
    machineGeo: !!shop.machine_geo,
    botContact: shop.bot_contact,
    privacyModeEnabled: !!shop.privacy_mode_enabled,
  };
}

/**
 * What players are told to do with a binding code; the line holding `{code}`
 * is the command. Older shops stored free contact text here, which stays valid
 * until it is edited.
 */
export const bindingPromptSchema = z.string().trim().max(500);

const settingsSchema = z.object({
  cashierEnabled: z.boolean().optional(),
  autoRegister: z.boolean(),
  identityBindingRequired: z.boolean().optional(),
  locationEnabled: z.boolean().optional(),
  locationMode: shopLocationModeSchema.optional(),
  locationActionModes: z.object({
    checkin: shopLocationModeSchema.optional(),
    checkout: shopLocationModeSchema.optional(),
    machine: shopLocationModeSchema.optional(),
  }).optional(),
  locationRssiThreshold: z.number().int().min(-100).max(-20).optional(),
  checkinGeo: z.boolean().optional(),
  checkoutGeo: z.boolean().optional(),
  machineGeo: z.boolean().optional(),
  // The resource a front-desk check-in bills through: its group's plan, or its own.
  cashierResourceId: z.string().min(1).nullable().optional(),
  botContact: bindingPromptSchema,
  privacyModeEnabled: z.boolean().optional(),
});

export const shopRouter = new Hono<AppBindings>();

// Tenant resolution & dependency container injection
shopRouter.use("*", tenantMiddleware);

// Centralized error mapping for direct domain errors
shopRouter.onError((err, c) => errorResponse(c, err, "shopRouter"));

// Mount modular sub-routers
shopRouter.route("/player", playerRouter);
shopRouter.route("/staff", staffRouter);
shopRouter.route("/staff", staffBusinessRouter);
shopRouter.route("/staff", staffPricingCompatRouter);
shopRouter.route("/integration", integrationRouter);
shopRouter.route("/cashier", cashierRouter);
shopRouter.route("/pricing/changes", pricingChangesRouter);
shopRouter.route("/staff/pricing-configs/changes", pricingChangesRouter);
shopRouter.route("/pricing", pricingRouter);
shopRouter.route("/staff/pricing-configs", pricingRouter);
shopRouter.route("/assets", assetsRouter);
shopRouter.route("/staff", staffAssetsCompatRouter);
shopRouter.route("/redeem", redeemRouter);
shopRouter.route("/staff", staffRedeemCompatRouter);
shopRouter.route("/", billingCompatRouter);
shopRouter.route("/identity-conversion", identityConversionRouter);
shopRouter.route("/data", shopDataRouter);
// Keep the historical tenant-scoped staff administration and Bot commands.
// Root-level /api/v1/staff and /integration alone cannot replace these: their
// tenant selection is different and the shopCode is part of the public contract.
shopRouter.route("/staff", legacyStaffRouter);
shopRouter.route("/integration", legacyIntegrationRouter);

// Shop Overview
shopRouter.get("/", async (c) => {
  const shop = getShop(c);
  const user = optionalUser(c);

  const membership = user
    ? await c.env.DB.prepare(
        `SELECT player_id AS playerId, ${ACCOUNT_HAS_PLATFORM_IDENTITY_SQL} AS identityBound
         FROM ${ACCOUNT_PROFILES_SQL} a WHERE shop_id=? AND user_id=?`,
      )
        .bind(shop.id, user.id, shop.id, user.id)
        .first<{ playerId: string; identityBound: number }>()
    : null;

  // Released App Clips decode `shop.billingEnabled` as a required field and use
  // it to offer the bill and wallet. There is no switch behind it any more: it
  // says whether any resource bills.
  const [billingEnabledRow, locationSettings, beacons] = await Promise.all([
    c.env.DB.prepare(`SELECT ${shopBillsSql("?")} AS bills`).bind(shop.id).first<{ bills: number }>(),
    readShopLocationSettings(c.env.DB, shop.id),
    listShopBeacons(c.env.DB, shop.id),
  ]);
  const billingEnabled = !!billingEnabledRow?.bills;
  const activeLocationMode = beacons.some((b) => b.online) ? "ble" : "gps";

  const localDate =
    c.req.query("date") ?? formatLocalDate(new Date(), shop.time_zone);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(localDate) ||
    !Number.isFinite(Date.parse(localDate)) ||
    new Date(localDate).toISOString().slice(0, 10) !== localDate
  ) {
    jsonError(400, "日期无效", "INVALID_DATE");
  }

  // A shop has no entry plan: what a visit bills is the scanned resource's
  // group's plan, shown on its page. The empty lists stay for released App
  // Clips, which decode them as required fields.
  return c.json({
    entryPricing: [],
    pricingSchedule: {
      localDate,
      timeZone: shop.time_zone,
      groups: [],
      ...(c.req.query("pricing") === "raw" ? { clientCalculation: true } : {}),
    },
    shop: {
      publicId: shop.public_id,
      name: shop.name,
      timeZone: shop.time_zone,
      heroUrl: shop.hero_url,
      ...publicSettings(shop),
      locationMode: activeLocationMode,
      locationRssiThreshold: locationSettings.rssiThreshold,
      billingEnabled,
    },
    membership: membership
      ? { ...membership, identityBound: !!membership.identityBound }
      : null,
  });
});

// Shop cover image: preserve immutable versioned URLs and conditional caching.
shopRouter.get("/hero", async (c) => {
  const shop = getShop(c);
  const row = await c.env.DB.prepare(
    "SELECT hero_data AS heroData, COALESCE(hero_hash,'original') AS version FROM shops WHERE id=?",
  ).bind(shop.id).first<{ heroData: string | null; version: string }>();
  const version = c.req.query("v");
  const missing = () => new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  if (!row || (version !== undefined && row.version !== version)) return missing();
  const match = row.heroData?.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || !match[1] || !match[2]) return missing();
  const headers = {
    "cache-control": version ? "public, max-age=31536000, immutable" : "public, max-age=60, must-revalidate",
    "content-type": match[1],
    etag: `"${row.version}"`,
  };
  const validators = c.req.header("if-none-match")?.split(",").map(v => v.trim().replace(/^W\//, ""));
  if (validators?.some(v => v === "*" || v === headers.etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(Uint8Array.from(atob(match[2]), ch => ch.charCodeAt(0)), { headers });
});

// Shop Settings
shopRouter.get("/settings", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const [cashierResource, configuration, locationSettings, beacons] = await Promise.all([
    cashierResourceId(c.env.DB, shop.id),
    billingConfiguration(c.env.DB, shop.id),
    readShopLocationSettings(c.env.DB, shop.id),
    listShopBeacons(c.env.DB, shop.id),
  ]);
  const activeLocationMode = beacons.some((b) => b.online) ? "ble" : "gps";
  return c.json({
    ...publicSettings(shop),
    locationMode: activeLocationMode,
    locationRssiThreshold: locationSettings.rssiThreshold,
    cashierResourceId: cashierResource,
    billingConfiguration: configuration,
  });
});

// Update Shop Settings
shopRouter.put("/settings", async (c) => {
  const initialShop = getShop(c);
  const principal = await staffPrincipal(c, initialShop);
  if (principal.staffRole !== "owner") {
    jsonError(403, "只有店铺负责人可以修改平台设置");
  }

  const deps = getShopDeps(c);
  return withOperationLease(
    {
      repository: deps.repositories.operationLocks,
      scope: "shop.cashier",
      resourceId: initialShop.id,
      now: () => new Date(),
    },
    async () => {
      const body = settingsSchema.parse(await c.req.json());
      // The unified toggle wins over aliases included in a read/merge/write request.
      const checkinGeo = body.locationEnabled ?? body.checkinGeo ?? !!initialShop.checkin_geo;
      const checkoutGeo = body.locationEnabled ?? body.checkoutGeo ?? !!initialShop.checkout_geo;
      const machineGeo = body.locationEnabled ?? body.machineGeo ?? !!initialShop.machine_geo;
      const cashierEnabled = body.cashierEnabled ?? !!initialShop.cashier_enabled;
      const identityBindingRequired = body.identityBindingRequired ?? !!initialShop.identity_binding_required;
      if (body.botContact && body.botContact !== initialShop.bot_contact && !body.botContact.includes("{code}")) {
        jsonError(400, "绑定提示需要包含 {code}，用来显示绑定码", "BINDING_PROMPT_CODE_REQUIRED");
      }

      if (initialShop.cashier_enabled && !cashierEnabled) {
        const unpaid = await c.env.DB.prepare(`SELECT 1 FROM sessions s JOIN cashier_profiles cp
          ON cp.shop_id=s.shop_id AND cp.player_id=s.player_id
          WHERE s.shop_id=? AND s.payment_status='unpaid' LIMIT 1`)
          .bind(initialShop.id).first();
        if (unpaid) jsonError(409, "存在未结清的前台账单，请先收款结账", "CASHIER_UNSETTLED_SESSIONS");
      }

      // A front-desk check-in bills through a resource, like a scan; the front
      // desk cannot be on without one.
      const cashierResource = body.cashierResourceId === undefined
        ? await cashierResourceId(c.env.DB, initialShop.id)
        : body.cashierResourceId;
      if (cashierEnabled && !cashierResource) jsonError(409, "请先选择前台资源", "CASHIER_RESOURCE_REQUIRED");
      if (cashierResource && !await c.env.DB.prepare("SELECT 1 FROM machines WHERE shop_id = ? AND id = ?")
        .bind(initialShop.id, cashierResource).first()) jsonError(404, "没有找到这个资源", "DEVICE_NOT_FOUND");
      const [configuration, existingLocation, beacons] = await Promise.all([
        billingConfiguration(c.env.DB, initialShop.id),
        readShopLocationSettings(c.env.DB, initialShop.id),
        listShopBeacons(c.env.DB, initialShop.id),
      ]);
      const nextLocationSettings = {
        ...existingLocation,
        rssiThreshold: body.locationRssiThreshold ?? existingLocation.rssiThreshold,
      };
      const locationChanged = body.locationRssiThreshold !== undefined;
      const activeLocationMode = beacons.some((b) => b.online) ? "ble" : "gps";
      const privacyModeEnabled = body.privacyModeEnabled ?? !!initialShop.privacy_mode_enabled;
      const now = new Date().toISOString();

      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO shop_billing_settings (shop_id, auto_register, checkin_geo, checkout_geo, machine_geo, bot_contact, identity_binding_required)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(shop_id) DO UPDATE SET
             auto_register=excluded.auto_register,
             checkin_geo=excluded.checkin_geo, checkout_geo=excluded.checkout_geo, machine_geo=excluded.machine_geo,
             bot_contact=excluded.bot_contact,
             identity_binding_required=excluded.identity_binding_required`,
        ).bind(
          initialShop.id,
          +body.autoRegister,
          +checkinGeo,
          +checkoutGeo,
          +machineGeo,
          body.botContact,
          +identityBindingRequired,
        ),
        c.env.DB.prepare(
          `INSERT INTO app_settings(shop_id, key, value_json, updated_at)
           VALUES (?, 'cashier.settings', ?, ?)
           ON CONFLICT(shop_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
        ).bind(
          initialShop.id,
          JSON.stringify({ enabled: cashierEnabled, ...(cashierResource ? { resourceId: cashierResource } : {}) }),
          now,
        ),
        ...(locationChanged
          ? [writeShopLocationSettingsStatement(c.env.DB, initialShop.id, nextLocationSettings)]
          : []),
        ...(body.privacyModeEnabled !== undefined
          ? [c.env.DB.prepare(
              `INSERT INTO app_settings(shop_id, key, value_json, updated_at)
               VALUES (?, 'player.privacy', ?, ?)
               ON CONFLICT(shop_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
            ).bind(initialShop.id, JSON.stringify({ enabled: privacyModeEnabled }), now)]
          : []),
      ]);

      // Every page shows the shop's settings.
      const origin = c.get("factOrigin");
      if (origin) await publishShopFacts({ db: c.env.DB, env: c.env, shopId: initialShop.id }, origin, [{ name: "shop.changed", payload: { what: "settings" } }]);

      return c.json({
        ...body,
        locationEnabled: checkinGeo || checkoutGeo || machineGeo,
        locationMode: activeLocationMode,
        locationRssiThreshold: nextLocationSettings.rssiThreshold,
        checkinGeo,
        checkoutGeo,
        machineGeo,
        cashierEnabled,
        cashierResourceId: cashierResource,
        identityBindingRequired,
        privacyModeEnabled,
        billingConfiguration: configuration,
      });
    },
  );
});

// Platform Binding Code
shopRouter.post("/platform-binding", async (c) => {
  const user = requireUser(c);
  const shop = getShop(c);
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const code = Array.from(
    crypto.getRandomValues(new Uint8Array(8)),
    (b) => alphabet[b % 32],
  ).join("");
  const expiresAt = new Date(Date.now() + 300000).toISOString();

  await c.env.DB.prepare(
    `INSERT INTO platform_binding_codes (shop_id, user_id, code_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(shop_id, user_id) DO UPDATE SET
       code_hash=excluded.code_hash, expires_at=excluded.expires_at, created_at=excluded.created_at`,
  )
    .bind(
      shop.id,
      user.id,
      await sha256(code),
      expiresAt,
      new Date().toISOString(),
    )
    .run();

  const lines = renderBindingPromptLines(
    requestLocale(c.req.header("accept-language")),
    shop.bot_contact,
    code,
  );

  return c.json({ code, expiresAt, botContact: shop.bot_contact, lines });
});

// List Platform Bindings
shopRouter.get("/platform-binding", async (c) => {
  const user = requireUser(c);
  const shop = getShop(c);
  return c.json({ bindings: await listAccountPlatformIdentities(c.env.DB, shop.id, user.id) });
});

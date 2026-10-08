import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";
import { staffRouter } from "../../routes/shops/staff.js";
import { pricingRouter } from "../../routes/shops/pricing.js";
import { assetsRouter } from "../../routes/shops/assets.js";
import { redeemRouter } from "../../routes/shops/redeem.js";

export const legacyStaffRouter = new Hono<AppBindings>();

// Mount core staff router
legacyStaffRouter.route("/", staffRouter);

// Mount staff resource sub-routers matching legacy server-hono paths
legacyStaffRouter.route("/pricing-configs", pricingRouter);
legacyStaffRouter.route("/asset-definitions", assetsRouter);
legacyStaffRouter.route("/redeem-codes", redeemRouter);

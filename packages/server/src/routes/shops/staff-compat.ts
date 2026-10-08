import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import { toStaffPricingExtensionView } from "./views.js";

/** Historical standalone route names that were not covered by /pricing-configs. */
export const staffPricingCompatRouter = new Hono<AppBindings>();

staffPricingCompatRouter.get("/pricing-extensions", async (c) => {
  await staffPrincipal(c, getShop(c), true);
  const commands = getShopDeps(c).staffPricingCommands as {
    listPricingExtensions?: () => Promise<any[]>;
  };
  const extensions = commands.listPricingExtensions
    ? await commands.listPricingExtensions()
    : [];
  return c.json({ pricingExtensions: extensions.map(toStaffPricingExtensionView) });
});

staffPricingCompatRouter.post("/pricing-timeline/preview", async (c) => {
  const shop = getShop(c);
  const principal = await staffPrincipal(c, shop);
  if (principal.staffRole === "viewer") {
    jsonError(403, "Write permission required.", "FORBIDDEN");
  }
  const body = await c.req.json<any>();
  const localDate = body.localDate ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    jsonError(400, "Pricing timeline date must use YYYY-MM-DD.", "INVALID_TIMELINE_DATE");
  }
  const timeline = await getShopDeps(c).staffPricingCommands.previewPricingTimeline({
    localDate,
    displayTimeZone: body.displayTimeZone ?? shop.time_zone,
    provider: body.provider,
  });
  return c.json({ timeline });
});

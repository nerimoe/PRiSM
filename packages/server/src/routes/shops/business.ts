import { Hono, type Context } from "hono";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import { toBusinessItemManagementView, toBusinessItemOrderView } from "./views.js";

/** Preserve the original standalone staff business catalogue and order API. */
export const staffBusinessRouter = new Hono<AppBindings>();

async function requireBusinessStaff(c: Context<AppBindings>, write = false) {
  const principal = await staffPrincipal(c, getShop(c), !write);
  if (write && principal.staffRole === "viewer") {
    jsonError(403, "Write permission required.", "FORBIDDEN");
  }
}

staffBusinessRouter.get("/business-items", async (c) => {
  await requireBusinessStaff(c);
  const items = await getShopDeps(c).staffBusinessItemCommands.listBusinessItems();
  return c.json({ businessItems: items.map(toBusinessItemManagementView) });
});

staffBusinessRouter.post("/business-items", async (c) => {
  await requireBusinessStaff(c, true);
  const body = await c.req.json<any>();
  const item = await getShopDeps(c).staffBusinessItemCommands.createBusinessItem({
    kind: body.kind,
    name: body.name,
    price: body.price,
    assetType: body.assetType,
    assetCode: body.assetCode,
    activeAt: body.activeAt ? new Date(body.activeAt) : null,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    metadata: body.metadata,
  });
  return c.json({ businessItem: toBusinessItemManagementView(item) });
});

staffBusinessRouter.post("/business-items/:businessItemId/archive", async (c) => {
  await requireBusinessStaff(c, true);
  const item = await getShopDeps(c).staffBusinessItemCommands.archiveBusinessItem({
    businessItemId: c.req.param("businessItemId"),
  });
  return c.json({ businessItem: toBusinessItemManagementView(item) });
});

staffBusinessRouter.post("/business-items/:businessItemId/restore", async (c) => {
  await requireBusinessStaff(c, true);
  const item = await getShopDeps(c).staffBusinessItemCommands.restoreBusinessItem({
    businessItemId: c.req.param("businessItemId"),
  });
  return c.json({ businessItem: toBusinessItemManagementView(item) });
});

staffBusinessRouter.get("/business-item-orders", async (c) => {
  await requireBusinessStaff(c);
  const orders = await getShopDeps(c).businessItemOrderCommands.listBusinessItemOrders();
  return c.json({ businessItemOrders: orders.map(toBusinessItemOrderView) });
});

staffBusinessRouter.post("/business-item-orders/:orderId/fulfill", async (c) => {
  await requireBusinessStaff(c, true);
  const order = await getShopDeps(c).businessItemOrderCommands.fulfillBusinessItemOrder({
    orderId: c.req.param("orderId"),
  });
  return c.json({ businessItemOrder: toBusinessItemOrderView(order) });
});

staffBusinessRouter.post("/business-item-orders/:orderId/cancel", async (c) => {
  await requireBusinessStaff(c, true);
  const order = await getShopDeps(c).businessItemOrderCommands.cancelBusinessItemOrder({
    orderId: c.req.param("orderId"),
  });
  return c.json({ businessItemOrder: toBusinessItemOrderView(order) });
});

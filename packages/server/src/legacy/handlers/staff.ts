import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";
import { staffRouter } from "../../routes/shops/staff.js";
import { staffMeView } from "../../routes/shops/staff-me-view.js";
import { staffBusinessRouter } from "../../routes/shops/business.js";
import { staffPricingCompatRouter } from "../../routes/shops/staff-compat.js";
import { pricingRouter } from "../../routes/shops/pricing.js";
import { staffAssetsCompatRouter } from "../../routes/shops/assets.js";
import { staffRedeemCompatRouter } from "../../routes/shops/redeem.js";

export const legacyStaffRouter = new Hono<AppBindings>();

legacyStaffRouter.get("/me", async (c) => {
  const principal = await requireStandaloneStaff(c);
  return c.json({ staff: await staffMeView(c, getShop(c), principal) });
});

// Mount core staff router
legacyStaffRouter.route("/", staffRouter);
legacyStaffRouter.route("/", staffBusinessRouter);
legacyStaffRouter.route("/", staffPricingCompatRouter);

// Mount staff resource sub-routers matching legacy server-hono paths
legacyStaffRouter.route("/pricing-configs", pricingRouter);
legacyStaffRouter.route("/", staffAssetsCompatRouter);
legacyStaffRouter.route("/", staffRedeemCompatRouter);


import { z } from "zod";
import { jsonError } from "../../http.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import { staffPrincipal } from "../../middleware/auth.js";

async function requireStandaloneStaff(c: import("hono").Context<AppBindings>, access: "read" | "write" | "owner" = "read") {
  const principal = await staffPrincipal(c, getShop(c), access === "read");
  if (access === "owner" && principal.staffRole !== "owner") {
    jsonError(403, "Owner principal required.", "FORBIDDEN");
  }
  if (access === "write" && principal.staffRole === "viewer") {
    jsonError(403, "Write permission required.", "FORBIDDEN");
  }
  return principal;
}

// Admin-session tokens and platform staff sessions share these canonical services.


legacyStaffRouter.get("/users", async (c) => {
  await requireStandaloneStaff(c, "owner");
  const staffUsers = await getShopDeps(c).staffUserCommands.listStaffUsers();
  return c.json({ staffUsers });
});
legacyStaffRouter.post("/users", async (c) => {
  await requireStandaloneStaff(c, "owner");
  const body = z.object({
    username: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    password: z.string().min(1),
    role: z.enum(["owner", "manager", "viewer"]),
  }).parse(await c.req.json());
  const staffUser = await getShopDeps(c).staffUserCommands.createStaffUser(body);
  return c.json({ staffUser });
});
legacyStaffRouter.patch("/users/:staffUserId", async (c) => {
  await requireStandaloneStaff(c, "owner");
  const body = z.object({
    displayName: z.string().trim().min(1),
    role: z.enum(["owner", "manager", "viewer"]),
    status: z.enum(["active", "disabled"]),
  }).parse(await c.req.json());
  const staffUser = await getShopDeps(c).staffUserCommands.updateStaffUser({
    staffUserId: c.req.param("staffUserId"), ...body,
  });
  return c.json({ staffUser });
});
legacyStaffRouter.post("/users/:staffUserId/password", async (c) => {
  await requireStandaloneStaff(c, "owner");
  const body = z.object({ password: z.string().min(1) }).parse(await c.req.json());
  const staffUser = await getShopDeps(c).staffUserCommands.resetStaffUserPassword({
    staffUserId: c.req.param("staffUserId"), ...body,
  });
  return c.json({ staffUser });
});

legacyStaffRouter.get("/settings", async (c) => {
  // This settings DTO contains HA / TTLock access tokens and Hinata passwords.
  await requireStandaloneStaff(c, "owner");
  return c.json({ settings: await getShopDeps(c).staffSettingsCommands.getSettings() });
});
legacyStaffRouter.put("/settings", async (c) => {
  await requireStandaloneStaff(c, "write");
  const body = await c.req.json();
  return c.json({ settings: await getShopDeps(c).staffSettingsCommands.updateSettings(body) });
});

legacyStaffRouter.get("/api-tokens", async (c) => {
  await requireStandaloneStaff(c);
  return c.json({ apiTokens: await getShopDeps(c).staffApiTokenCommands.listApiTokens() });
});
legacyStaffRouter.post("/api-tokens", async (c) => {
  await requireStandaloneStaff(c, "write");
  const body = z.object({ label: z.string().trim().min(1), role: z.enum(["integration", "machine"]) })
    .parse(await c.req.json());
  const apiToken = await getShopDeps(c).staffApiTokenCommands.createApiToken(body);
  return c.json({ apiToken });
});
legacyStaffRouter.post("/api-tokens/:tokenId/revoke", async (c) => {
  await requireStandaloneStaff(c, "write");
  const apiToken = await getShopDeps(c).staffApiTokenCommands.revokeApiToken({
    tokenId: c.req.param("tokenId"),
  });
  return c.json({ apiToken });
});

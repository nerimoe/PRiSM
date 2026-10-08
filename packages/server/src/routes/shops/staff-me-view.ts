import type { Context } from "hono";
import type { AppBindings, StaffPrincipal, TenantShop } from "../../bindings.js";

/** Public staff/me DTO from before the server consolidation.
 * Internal principal.role ("staff") and principal.staffRole must not leak.
 */
export type StaffMeView = {
  id: string;
  displayName: string;
  role: "owner" | "manager" | "viewer";
  canWrite: boolean;
};

export async function staffMeView(
  c: Context<AppBindings>,
  shop: TenantShop,
  principal: StaffPrincipal,
): Promise<StaffMeView> {
  const row = await c.env.DB.prepare(
    "SELECT display_name AS displayName FROM staff_users WHERE shop_id=? AND id=?",
  ).bind(shop.id, principal.staffId).first<{ displayName: string }>();

  return {
    id: principal.staffId,
    displayName: row?.displayName || c.get("user")?.displayName || principal.staffId,
    role: principal.staffRole,
    canWrite: principal.staffRole !== "viewer",
  };
}

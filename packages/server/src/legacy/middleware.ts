import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../bindings.js";

/**
 * Maps a legacy endpoint URL path to the modern multi-tenant replacement path.
 *
 * Example mappings:
 *   /api/v1/player/assets -> /api/v1/shops/:shopCode/player/assets
 *   /api/v1/staff/players -> /api/v1/shops/:shopCode/staff/players
 *   /api/v1/integration/players/by-identity/resolve -> /api/v1/shops/:shopCode/integration/players/by-identity/resolve
 *   /api/v1/setup/status -> /api/v1/setup/status
 *   /rpc/player/assets -> /api/v1/shops/:shopCode/player/assets
 */
export function getReplacementPath(pathname: string, shopCode = ":shopCode"): string {
  let path = pathname;

  if (path.startsWith("/rpc/")) {
    path = path.replace(/^\/rpc\//, "/api/v1/");
  } else if (!path.startsWith("/api/v1/")) {
    path = `/api/v1${path.startsWith("/") ? "" : "/"}${path}`;
  }

  // Preserve setup paths
  if (path.startsWith("/api/v1/setup")) {
    return path;
  }

  // If already multi-tenant, preserve
  if (path.includes("/shops/")) {
    return path;
  }

  return path.replace("/api/v1/", `/api/v1/shops/${shopCode}/`);
}

/**
 * Appends standard deprecation headers to responses from legacy single-store endpoints.
 *
 * Headers added:
 *   - X-API-Deprecated: true
 *   - X-API-Replacement: /api/v1/shops/:shopCode/...
 *   - Link: </api/v1/shops/:shopCode/...>; rel="successor-version"
 *   - Warning: 299 - "This endpoint is deprecated. Migrate to ..."
 *   - Deprecation: true
 */
export const legacyDeprecationMiddleware: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  await next();

  const shop = c.get("shop");
  const shopCode = shop ? (shop.public_id || shop.id) : ":shopCode";
  const replacement = getReplacementPath(c.req.path, shopCode);

  const headers = new Headers(c.res.headers);
  headers.set("X-API-Deprecated", "true");
  headers.set("X-API-Replacement", replacement);
  headers.set("Link", `<${replacement}>; rel="successor-version"`);
  headers.set(
    "Warning",
    `299 - "This legacy single-store endpoint is deprecated. Migrate to ${replacement}."`,
  );
  headers.set("Deprecation", "true");

  console.warn(
    `[DEPRECATED API] ${c.req.method} ${c.req.path} invoked by ${c.req.header("user-agent") ?? "unknown"} -> replacement: ${replacement}`,
  );

  c.res = new Response(c.res.body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
};

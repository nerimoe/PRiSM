import { describe, expect, it } from "bun:test";
import { createApp } from "../src/app.js";
import {
  preMergeRoutes,
  preMergeLiveActivityRoutes,
} from "./fixtures/pre-merge-api-routes.js";

/**
 * Full historical route presence contract, independent of the current
 * implementation's router structure. A route omitted by consolidation must
 * break CI rather than disappearing until a customer opens its page.
 *
 * Route registration is only the first gate; request/response equivalence
 * is checked in the real production-app integration tests.
 */
describe("Pre-consolidation API method/path contracts", () => {
  const routes = new Set(
    createApp().routes.map(({ method, path }) => `${method.toUpperCase()} ${path}`),
  );

  function assertRegistered(required: readonly string[]) {
    const missing = required.filter((r) => !routes.has(r));
    expect(missing).toEqual([]);
  }

  it("preserves every explicit pre-merge public API endpoint", () => {
    expect(preMergeRoutes.length).toBeGreaterThanOrEqual(150);
    assertRegistered(preMergeRoutes);
  });

  it("preserves the historical tenant-scoped staff, player and Bot APIs", () => {
    const scoped = preMergeRoutes
      .filter((route) => / \/api\/v1\/(staff|player|integration)\//.test(route))
      .map((route) =>
        route.replace(" /api/v1/", " /api/v1/shops/:shopCode/"),
      );
    expect(scoped.length).toBeGreaterThanOrEqual(100);
    assertRegistered(scoped);
  });

  it("preserves all three ActivityKit endpoints omitted by old static Hono declarations", () => {
    assertRegistered(preMergeLiveActivityRoutes);
  });
});

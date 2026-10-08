import { describe, expect, it } from "bun:test";
import { createApp } from "../src/app.js";
import { androidAssetLinks, appleAppSiteAssociation } from "../src/routes/platform/apple.js";

describe("pre-fork main compatibility registrations", () => {
  const registered = new Set(createApp().routes.map((route) => `${route.method} ${route.path}`));
  for (const [method, path] of [
    ["DELETE", "/api/v1/admin/users/:id"],
    ["POST", "/api/v1/shops/:shopCode/identity-conversion/preview"],
    ["POST", "/api/v1/shops/:shopCode/identity-conversion/apply"],
    ["GET", "/api/v1/staff/business-items"],
    ["POST", "/api/v1/staff/business-items"],
    ["GET", "/api/v1/staff/business-item-orders"],
    ["POST", "/api/v1/staff/business-item-orders/:orderId/fulfill"],
    ["POST", "/api/v1/staff/business-item-orders/:orderId/cancel"],
    ["GET", "/api/v1/staff/redeem-codes"],
    ["POST", "/api/v1/staff/redeem-codes/batch"],
    ["GET", "/api/v1/staff/presents"],
    ["GET", "/api/v1/staff/pricing-effects"],
    ["PUT", "/api/v1/staff/pricing-effects/:effectId"],
    ["GET", "/api/v1/staff/pricing-extensions"],
    ["POST", "/api/v1/staff/pricing-timeline/preview"],
    ["GET", "/.well-known/apple-app-site-association"],
    ["GET", "/.well-known/assetlinks.json"],
  ]) {
    it(`${method} ${path} is registered`, () => {
      expect(registered.has(`${method} ${path}`)).toBe(true);
    });
  }
});

describe("app association manifest compatibility", () => {
  it("keeps old machine and shop universal link destinations", () => {
    const association = appleAppSiteAssociation("TESTTEAM");
    expect(association.applinks.details[0]?.components).toEqual([
      { "/": "/t/*/*" }, { "/": "/t/*" },
    ]);
    expect(association.appclips.apps[0]).toBe("TESTTEAM.moe.neri.hinatago.prism");
  });

  it("requires valid Android signing certificate fingerprints", () => {
    expect(androidAssetLinks("not-a-fingerprint")).toEqual([]);
    const digest = Array(32).fill("AB").join(":");
    const links = androidAssetLinks(digest);
    expect(links).toHaveLength(1);
    expect(links[0]?.target.sha256_cert_fingerprints).toEqual([digest]);
  });
});

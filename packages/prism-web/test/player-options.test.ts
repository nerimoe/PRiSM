import { describe, expect, it } from "bun:test";
import { buildButtonPayload, reconcileFieldValues, type PageButton } from "@prism/page-protocol";
import { renderAccountSheetPage, renderShopPage, type ShopPageHead } from "../../server/src/resources/shop-page";

const HEAD: ShopPageHead = {
  shop: "Arcade",
  shopCode: "arcade",
  heroUrl: null,
  timeZone: "Asia/Shanghai",
};

describe("server-driven player options visibility", () => {
  it("hides 选项 menu tab and privacyMode block when shop privacy mode is off, and exposes them when on", () => {
    const shopOff = renderShopPage({
      locale: "zh",
      head: HEAD,
      signedIn: true,
      needsBinding: false,
      shopBills: true,
      privacyModeEnabled: false,
      checkoutGeo: false,
      liveBill: null,
      settledReceipt: null,
    });
    expect(shopOff.accountMenu?.tabs.map((t) => t.id)).toEqual(["redeem", "history", "wallet", "bindings"]);

    const sheetOff = renderAccountSheetPage({
      locale: "zh",
      view: "options",
      head: HEAD,
      needsBinding: false,
      checkoutGeo: false,
      privacyModeEnabled: false,
    });
    expect(sheetOff.blocks).toEqual([
      { kind: "text", id: "options-empty", text: "暂无可用选项", style: "body", level: "muted" },
    ]);

    const shopOn = renderShopPage({
      locale: "zh",
      head: HEAD,
      signedIn: true,
      needsBinding: false,
      shopBills: true,
      privacyModeEnabled: true,
      checkoutGeo: false,
      liveBill: null,
      settledReceipt: null,
    });
    expect(shopOn.accountMenu?.tabs.map((t) => t.id)).toEqual([
      "redeem",
      "history",
      "wallet",
      "bindings",
      "options",
    ]);

    const sheetOn = renderAccountSheetPage({
      locale: "zh",
      view: "options",
      head: HEAD,
      needsBinding: false,
      checkoutGeo: false,
      privacyModeEnabled: true,
      playerOptions: { privacyMode: false },
    });
    const values = reconcileFieldValues(sheetOn.blocks, {});
    expect(values).toEqual({ privacyMode: false });
    const saveButton = sheetOn.blocks.find((b): b is PageButton => b.kind === "button")!;
    expect(buildButtonPayload(saveButton, sheetOn.blocks, { ...values, privacyMode: true })).toEqual({
      privacyMode: true,
    });
  });
});

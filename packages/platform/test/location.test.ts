import { expect, test } from "bun:test";
import { checkShopLocation, type BillingShop } from "../src/billing";

const shop: BillingShop = {
  id: "shop", public_id: "shop", name: "Shop", latitude: 35, longitude: 139,
  radius_meters: 80, billing_enabled: 1, auto_register: 0,
  checkin_geo: 0, checkout_geo: 0, machine_geo: 1,
  entry_pricing_ids_json: "[]", bot_contact: "", time_zone: "Asia/Shanghai",
};
const inside = { lat: 35, lng: 139, accuracy: 5 };
const outside = { lat: 35.01, lng: 139, accuracy: 5 };

test("one location policy requires inside for venue actions and outside for checkout", () => {
  for (const action of ["checkin", "machine", "checkout"] as const) {
    expect(() => checkShopLocation(shop, action, undefined)).toThrow("此操作需要获取当前位置");
    expect(() => checkShopLocation(shop, action, { ...outside, accuracy: 500 })).toThrow("定位精度不足");
    expect(() => checkShopLocation({ ...shop, machine_geo: 0 }, action, undefined)).not.toThrow();
  }
  for (const action of ["checkin", "machine"] as const) {
    expect(() => checkShopLocation(shop, action, inside)).not.toThrow();
    expect(() => checkShopLocation(shop, action, outside)).toThrow("请到店后再操作");
  }
  expect(() => checkShopLocation(shop, "checkout", inside)).toThrow("请离开店铺定位范围后再结账");
  expect(() => checkShopLocation(shop, "checkout", outside)).not.toThrow();
  // A near-boundary fix whose uncertainty overlaps the store cannot prove departure.
  expect(() => checkShopLocation(shop, "checkout", { lat: 35.001, lng: 139, accuracy: 50 })).toThrow("请离开店铺定位范围后再结账");
});

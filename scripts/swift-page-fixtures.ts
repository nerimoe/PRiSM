/**
 * Scanned pages for the App Clip's native checks (hinata_go test/native). Every page is made by the
 * server's own `renderPage`, so the checks decode and act on exactly what the platform sends: when
 * the page changes shape and the Swift models do not follow, they fail. Regenerate after changing
 * the page:
 *
 *   bun scripts/swift-page-fixtures.ts <hinata_go>/test/native/fixtures/prism-page
 *
 * All data is synthetic.
 */
import { notice } from "../packages/server/src/notices";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pageCode, renderPage, type PageInput } from "../packages/server/src/resources/page";
import { checkoutCelebration } from "../packages/server/src/resources/page-blocks/bill";
import { translator } from "../packages/server/src/resources/page-text";
import { pageUi } from "../packages/server/src/resources/page-ui";
import { renderAccountSheetPage, renderShopPage, type ShopPageHead } from "../packages/server/src/resources/shop-page";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: bun scripts/swift-page-fixtures.ts <outDir>");
  process.exit(2);
}

const none = { power: false, climate: false, card: false, coin: false, door: false, table: false };
const on = (...names: Array<keyof typeof none>) => ({ ...none, ...Object.fromEntries(names.map((name) => [name, true])) });
const base: PageInput = {
  locale: "zh",
  head: { shop: "Store", shopCode: "store", heroUrl: "/api/v1/shops/store/hero?v=abc123", resource: "Device", publicId: "device" },
  billingActive: false, capabilities: none, billed: false, cardCapture: false,
  geo: { checkin: false, machine: false }, signedIn: true, gate: "ready", billing: null, power: null,
  climate: null, coinFull: false, ioWaiting: false, table: null,
};

const plan = {
  id: "fee", kind: "charge.fixed", name: "入场费", enabled: true, status: "active",
  provider: { id: "fee", label: "入场费", amount: 12 },
};
const billing = {
  rules: { source: { kind: "resource" }, timeZone: "Asia/Tokyo", plans: [{ role: "resource", config: plan }], caps: { unsettled: 0, plans: [], shared: [] } },
  preview: {
    pricingConfigId: "fee", planName: "入场费", changed: true, revision: "rev-1",
    started: [{ planId: "fee", planName: "入场费" }], stopped: [], kept: [],
  },
};
const climate = {
  mode: "off", modes: ["off", "cool", "heat", "dry", "fan_only", "auto"], temperature: 26, currentTemperature: 28.5,
  minTemperature: 16, maxTemperature: 30, temperatureStep: 1, fanMode: "auto", fanModes: ["auto", "low", "high"],
};
const seat = (name: string, mine: boolean) => ({ name, mine, playing: false });

const scenes: Record<string, Partial<PageInput>> = {
  signin: { capabilities: on("card"), signedIn: false },
  empty: {},
  disabled: { capabilities: on("coin"), gate: "disabled" },
  binding: { capabilities: on("card", "door"), gate: "binding" },
  entryDoor: { capabilities: on("door"), gate: "entry", geo: { checkin: true, machine: false }, billing },
  entryError: { capabilities: on("door"), gate: "entry", billing: { error: { message: "没有配置计费" } } },
  door: { capabilities: on("door"), geo: { checkin: true, machine: false }, billingActive: true },
  doorCardsCoin: { capabilities: on("door", "card", "coin"), billingActive: true },
  cards: { capabilities: on("card") },
  cardsCapture: { capabilities: on("card", "coin"), cardCapture: true },
  coinFull: { capabilities: on("coin"), coinFull: true },
  ioWaiting: { capabilities: on("card", "coin"), ioWaiting: true },
  tableEmpty: { capabilities: on("table"), table: { capacity: 4, seats: [] } },
  tableMine: { capabilities: on("table"), table: { capacity: 4, seats: [seat("Player", true)] } },
  climate: { capabilities: on("climate"), climate },
  climateOnSite: { capabilities: on("climate"), climate, geo: { checkin: false, machine: true } },
  climateUnknown: { capabilities: on("climate") },
  powerOff: { capabilities: on("power"), power: "off" },
  powerOn: { capabilities: on("power"), power: "on" },
};

const pages = Object.fromEntries(Object.entries(scenes).map(([name, input]) => [name, renderPage({ ...base, ...input })]));

// No page of the platform's own uses every component yet, so this one does.
pages.components = {
  ...renderPage(base),
  offerPasskeySetup: true,
  blocks: [
    pageUi.banner("banner", "请确认时段后提交", { level: "warning", title: "提示" }),
    pageUi.section("section", [
      pageUi.kv("kv", [{ label: "当前状态", value: "可预约", tone: "success" }]),
      pageUi.divider("divider"),
      pageUi.image("image", "/assets/event.png", { alt: "活动", aspectRatio: 1.78 }),
      pageUi.text("caption", "小字说明", { style: "caption" }),
      pageUi.select("slot", [{ value: "a", label: "14:00" }, { value: "full", label: "15:00", disabled: true }], { required: true }),
      pageUi.input("pin", { name: "code", inputType: "number", maxLength: 4, required: true }),
      pageUi.toggle("remind", "到期提醒", { defaultValue: true }),
      pageUi.consent("agree", "我已阅读说明"),
    ], { title: "预约", style: "card" }),
    pageUi.row("row", [
      pageUi.button("cancel", "释放", "booking.cancel", { style: "destructive" }),
      pageUi.button("submit", "确认预约", "booking.create", {
        style: "primary", requires: "agree", collect: ["slot", "pin", "remind"], payload: { remind: false, plan: "vip" },
        confirm: { title: "确认预约", body: "提交后将锁定名额", confirmLabel: "确认", cancelLabel: "取消" },
      }),
    ]),
  ],
};

const shopHead: ShopPageHead = {
  shop: "Store",
  shopCode: "store",
  heroUrl: "/api/v1/shops/store/hero?v=abc123",
  timeZone: "Asia/Tokyo",
};

const sampleReceipt = {
  playerSettlement: { total: 24, settledAt: "2026-10-02T03:00:00.000Z" },
  timeline: {
    tracks: [{ id: "fee", name: "入场费", lane: 0, color: 0, startedAt: "2026-10-02T02:00:00.000Z", endedAt: "2026-10-02T03:00:00.000Z" }],
    events: [],
    totals: [{ name: "入场费", amount: 24 }],
  },
  wallet: { balanceAfter: 76 },
  chargeItems: [{ id: "c1", label: "入场费", amount: 24 }],
  adjustments: [],
};

const shopPages = {
  shopSignIn: renderShopPage({ locale: "zh", head: shopHead, signedIn: false, needsBinding: false, shopBills: true, checkoutGeo: false, liveBill: null, settledReceipt: null }),
  shopBinding: renderShopPage({ locale: "zh", head: shopHead, signedIn: true, needsBinding: true, shopBills: true, identityBindingRequired: true, checkoutGeo: false, liveBill: null, settledReceipt: null }),
  shopLive: renderShopPage({ locale: "zh", head: shopHead, signedIn: true, needsBinding: false, shopBills: true, checkoutGeo: true, liveBill: { billingInputs: { playerId: "p1", billingSnapshot: { version: 1, players: [] } } }, settledReceipt: null }),
  shopLivePreview: renderShopPage({ locale: "zh", head: shopHead, signedIn: true, needsBinding: false, shopBills: true, checkoutGeo: false, liveBill: { preview: { settlementPreview: { total: 12 }, chargeItems: [{ id: "c1", label: "入场费", amount: 12 }], adjustments: [] } }, settledReceipt: null }),
  shopSettled: renderShopPage({ locale: "zh", head: shopHead, signedIn: true, needsBinding: false, shopBills: true, checkoutGeo: false, liveBill: null, settledReceipt: sampleReceipt }),
  shopEmpty: renderShopPage({ locale: "zh", head: shopHead, signedIn: true, needsBinding: false, shopBills: true, checkoutGeo: false, liveBill: null, settledReceipt: null }),
  billSheet: renderAccountSheetPage({ locale: "zh", view: "bill", head: shopHead, checkoutGeo: true, liveBill: { preview: { settlementPreview: { total: 12 }, chargeItems: [{ id: "c1", label: "入场费", amount: 12 }], adjustments: [] } } }),
  redeemForm: renderAccountSheetPage({ locale: "zh", view: "redeem", head: shopHead, checkoutGeo: false }),
  redeemDone: renderAccountSheetPage({ locale: "zh", view: "redeem", head: shopHead, checkoutGeo: false, redeemed: true }),
  historyList: renderAccountSheetPage({
    locale: "zh",
    view: "history",
    head: shopHead,
    checkoutGeo: false,
    now: new Date("2026-10-02T12:00:00.000Z"),
    history: {
      records: [
        {
          id: "co-1",
          subtotal: 30,
          total: 24,
          settledAt: "2026-10-02T03:00:00.000Z",
          startedAt: "2026-10-02T02:00:00.000Z",
          endedAt: "2026-10-02T03:00:00.000Z",
          sessionCount: 1,
          paymentMethod: null,
        },
        {
          id: "co-2",
          subtotal: 36,
          total: 36,
          settledAt: "2026-10-01T12:00:00.000Z",
          startedAt: "2026-10-01T10:30:00.000Z",
          endedAt: "2026-10-01T12:00:00.000Z",
          sessionCount: 2,
          paymentMethod: "wechat",
        },
      ],
      nextOffset: 20,
    },
  }),
  historyDetail: renderAccountSheetPage({ locale: "zh", view: "history", head: shopHead, checkoutGeo: false, detailReceipt: sampleReceipt }),
  wallet: renderAccountSheetPage({
    locale: "zh",
    view: "wallet",
    head: shopHead,
    checkoutGeo: false,
    holdings: [
      { id: "h-coupon", assetType: "coupon", assetName: "免费畅玩券", assetCode: "free-play", quantity: 2 },
      { id: "h-free", assetType: "currency", assetName: "赠送余额", assetCode: "free", quantity: 20 },
      { id: "h-paid", assetType: "currency", assetName: "储值余额", assetCode: "paid", quantity: 76 },
      { id: "h-pass", assetType: "pass", assetName: "月度通行证", assetCode: "monthly-pass", quantity: 1 },
      { id: "h-ticket", assetType: "ticket", assetName: "活动票券", assetCode: "event-ticket", quantity: 3 },
    ],
  }),
  bindings: renderAccountSheetPage({ locale: "zh", view: "bindings", head: shopHead, checkoutGeo: false, bindings: [{ playerId: "p1", provider: "onebot", subject: "123456", displayName: "Player", verifiedAt: "2026-10-02T01:00:00.000Z" }] }),
};

mkdirSync(resolve(outDir), { recursive: true });
const code = pageCode("zh", { temporaryPassword: "12345678", expiresAt: "2999-01-01T00:00:00Z" });
const celebration = checkoutCelebration(translator("zh"));
const noticeCodes = [
  "RATE_LIMITED", "INSUFFICIENT_BALANCE", "DEVICE_UNAVAILABLE", "DOOR_CODE_FAILED",
  "COIN_COOLDOWN", "COIN_SENT", "COIN_FAILED", "CARD_SENT", "LOCATION_STILL_INSIDE",
  "REDEEM_CODE_NOT_FOUND", "PLAYER_OPTIONS_SAVED", "DEVICE_RESULT_UNKNOWN",
];
const notices = Object.fromEntries(noticeCodes.map((code) => [code, notice(code, "zh")]));
const noticesEn = Object.fromEntries(noticeCodes.map((code) => [code, notice(code, "en")]));
writeFileSync(join(resolve(outDir), "pages.json"), `${JSON.stringify({ pages, shopPages, code, celebration, notices, noticesEn }, null, 2)}\n`);
console.log(`wrote ${Object.keys(pages).length} pages and ${Object.keys(shopPages).length} shop pages to ${join(outDir, "pages.json")}`);

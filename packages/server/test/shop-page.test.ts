import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Page, PageBill, PageList } from "@prism/page-protocol";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import type { Env } from "../src/bindings.js";
import { sha256 } from "../src/crypto.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { clearRateLimitMemory } from "../src/middleware/rate-limit.js";
import { clearShopDependenciesCache } from "../src/middleware/tenant.js";
import { accountMenuFor } from "../src/resources/page-blocks/account.js";
import { renderAccountSheetPage, renderShopPage, type ShopPageHead } from "../src/resources/shop-page.js";
import { mintResourceTicket } from "../src/routes/platform/resource-ticket.js";

const NOW = "2026-10-02T02:00:00.000Z";
const TOKEN = "shop-page-token";
const SECRET = "shop-page-secret";

const HEAD: ShopPageHead = {
  shop: "Tsukimiya",
  shopCode: "tsukimiya",
  heroUrl: "/api/v1/shops/tsukimiya/hero?v=1",
  timeZone: "Asia/Tokyo",
};

const SAMPLE_RECEIPT = {
  playerSettlement: { total: 24, settledAt: "2026-10-02T03:00:00.000Z" },
  timeline: {
    tracks: [{ id: "t1", name: "畅玩", lane: 0, color: 0, startedAt: "2026-10-02T02:00:00.000Z", endedAt: "2026-10-02T03:00:00.000Z" }],
    events: [],
    totals: [{ name: "畅玩", amount: 24 }],
  },
  wallet: { balanceAfter: 76 },
  chargeItems: [{ id: "c1", label: "畅玩", amount: 24 }],
  adjustments: [],
};

describe("shop page renderers", () => {
  it("renders accountMenu tabs for billing vs non-billing shops", () => {
    const tZh = (s: string) => s;
    expect(accountMenuFor(tZh, { billingActive: true, shopBills: true, includeBillTab: true })).toEqual({
      billingBadge: "计费中",
      tabs: [
        { id: "bill", label: "账单" },
        { id: "redeem", label: "兑换" },
        { id: "history", label: "记录" },
        { id: "wallet", label: "钱包" },
        { id: "bindings", label: "身份" },
      ],
      logoutLabel: "退出登录",
    });

    expect(accountMenuFor(tZh, { billingActive: false, shopBills: true, includeBillTab: false }).tabs.map((tab) => tab.id)).toEqual([
      "redeem",
      "history",
      "wallet",
      "bindings",
    ]);

    expect(
      accountMenuFor(tZh, { billingActive: false, shopBills: false, identityBindingRequired: true, includeBillTab: true }).tabs,
    ).toEqual([{ id: "bindings", label: "身份" }]);

    expect(
      accountMenuFor(tZh, { billingActive: false, shopBills: false, identityBindingRequired: false, includeBillTab: true }).tabs,
    ).toEqual([]);
  });

  it("renders signed-out, binding, live bill, settled, and empty shop views", () => {
    const signedOut = renderShopPage({
      locale: "zh",
      head: HEAD,
      signedIn: false,
      needsBinding: false,
      shopBills: true,
      checkoutGeo: false,
      liveBill: null,
      settledReceipt: null,
    });
    expect(signedOut.blocks.map((b) => b.kind)).toEqual(["signin"]);
    expect(signedOut.accountMenu).toBeUndefined();
    expect(signedOut.offerPasskeySetup).toBe(false);

    const binding = renderShopPage({
      locale: "zh",
      head: HEAD,
      signedIn: true,
      needsBinding: true,
      shopBills: true,
      identityBindingRequired: true,
      checkoutGeo: false,
      liveBill: null,
      settledReceipt: null,
    });
    expect(binding.resource).toBe("未入场");
    expect(binding.blocks.map((b) => b.kind)).toEqual(["binding"]);
    expect(binding.offerPasskeySetup).toBe(false);
    expect(binding.accountMenu?.tabs.map((tab) => tab.id)).toEqual(["redeem", "history", "wallet", "bindings"]);

    const live = renderShopPage({
      locale: "zh",
      head: HEAD,
      signedIn: true,
      needsBinding: false,
      shopBills: true,
      checkoutGeo: true,
      liveBill: { billingInputs: { playerId: "p1", billingSnapshot: { version: 1 } } },
      settledReceipt: null,
    });
    expect(live.resource).toBe("计费中");
    expect(live.billingActive).toBe(true);
    expect(live.offerPasskeySetup).toBe(true);
    expect(live.accountMenu?.billingBadge).toBe("计费中");
    const liveBlock = live.blocks[0] as PageBill;
    expect(liveBlock).toMatchObject({ kind: "bill", mode: "live", timeZone: "Asia/Tokyo" });
    expect(liveBlock.billingInputs).toEqual({ playerId: "p1", billingSnapshot: { version: 1 } });
    expect(liveBlock.preview).toBeUndefined();
    expect(live.footer).toHaveLength(1);
    expect(live.footer?.[0]).toMatchObject({ kind: "button", action: "checkout.confirm", needsLocation: true });

    const settled = renderShopPage({
      locale: "zh",
      head: HEAD,
      signedIn: true,
      needsBinding: false,
      shopBills: true,
      checkoutGeo: false,
      liveBill: null,
      settledReceipt: SAMPLE_RECEIPT,
    });
    expect(settled.resource).toBe("结账成功");
    expect(settled.billingActive).toBe(false);
    expect(settled.footer).toBeUndefined();
    expect(settled.blocks[0]).toMatchObject({
      kind: "bill",
      mode: "settled",
      settledAt: SAMPLE_RECEIPT.playerSettlement.settledAt,
      balanceAfter: 76,
    });

    const empty = renderShopPage({
      locale: "zh",
      head: HEAD,
      signedIn: true,
      needsBinding: false,
      shopBills: true,
      checkoutGeo: false,
      liveBill: null,
      settledReceipt: null,
    });
    expect(empty.resource).toBe("未入场");
    expect(empty.blocks[0]).toMatchObject({ kind: "text", text: "请碰一下 NFC 或扫描机台上的二维码" });
  });

  it("renders account sheets and honors English translations", () => {
    const redeemForm = renderAccountSheetPage({
      locale: "en",
      view: "redeem",
      head: HEAD,
      needsBinding: false,
      checkoutGeo: false,
    });
    expect(redeemForm.title).toBe("Redeem");
    expect(redeemForm.blocks[0]).toMatchObject({ kind: "input", id: "code", placeholder: "Redemption code", required: true });
    expect((redeemForm.blocks[0] as { label?: string }).label).toBeUndefined();
    expect(redeemForm.blocks[1]).toMatchObject({ kind: "button", action: "redeem.submit", collect: ["code"] });

    const redeemDone = renderAccountSheetPage({
      locale: "en",
      view: "redeem",
      head: HEAD,
      needsBinding: false,
      checkoutGeo: false,
      redeemed: true,
    });
    expect(redeemDone.blocks[0]).toMatchObject({ kind: "banner", body: "Redeemed successfully", level: "success" });

    const historyList = renderAccountSheetPage({
      locale: "en",
      view: "history",
      head: HEAD,
      needsBinding: false,
      checkoutGeo: false,
      now: new Date("2026-10-02T12:00:00.000Z"),
      history: {
        records: [
          {
            id: "co-1",
            subtotal: 24,
            total: 18.5,
            settledAt: "2026-10-02T03:00:00.000Z",
            startedAt: "2026-10-02T02:00:00.000Z",
            endedAt: "2026-10-02T03:00:00.000Z",
            sessionCount: 1,
            paymentMethod: null,
          },
          {
            id: "co-2",
            subtotal: 48,
            total: 48,
            settledAt: "2026-10-01T16:00:00.000Z",
            startedAt: "2026-10-01T13:00:00.000Z",
            endedAt: "2026-10-01T16:00:00.000Z",
            sessionCount: 2,
            paymentMethod: "wechat",
          },
          {
            id: "co-3",
            subtotal: 30,
            total: 30,
            settledAt: "2026-10-01T15:05:00.000Z",
            startedAt: "2026-10-01T13:00:00.000Z",
            endedAt: "2026-10-01T14:30:00.000Z",
            sessionCount: 1,
            paymentMethod: null,
          },
          {
            id: "co-4",
            subtotal: 15,
            total: 15,
            settledAt: "2025-12-31T09:40:00.000Z",
            startedAt: null,
            endedAt: null,
            sessionCount: 0,
            paymentMethod: "alipay",
          },
        ],
        nextOffset: 20,
      },
    });
    expect(historyList.title).toBe("History");
    const listBlock = historyList.blocks[0] as PageList;
    expect(listBlock).toMatchObject({
      kind: "list",
      emptyText: "No settled bills yet",
      emptyIcon: "receipt",
      moreLabel: "Load more",
      moreTarget: { view: "history", cursor: "20" },
    });
    expect(listBlock.items).toEqual([
      {
        id: "co-1",
        group: "Oct 2",
        title: "11:00 – 12:00",
        titleMeta: "1h",
        subtitle: "Wallet",
        trailing: "18.50",
        trailingStrikethrough: "24.00",
        open: { view: "history", item: "co-1" },
      },
      {
        id: "co-2",
        group: "Oct 2",
        title: "10-01 22:00 – 01:00",
        titleMeta: "3h",
        subtitle: "Cashier · WeChat · 2 items",
        trailing: "48.00",
        open: { view: "history", item: "co-2" },
      },
      {
        id: "co-3",
        group: "Oct 2",
        title: "10-01 22:00 – 23:30",
        titleMeta: "1h 30m",
        subtitle: "Wallet · Settled 00:05",
        trailing: "30.00",
        open: { view: "history", item: "co-3" },
      },
      {
        id: "co-4",
        group: "Dec 31, 2025",
        title: "18:40",
        subtitle: "Cashier · Alipay",
        trailing: "15.00",
        open: { view: "history", item: "co-4" },
      },
    ]);

    const historyZh = renderAccountSheetPage({
      locale: "zh",
      view: "history",
      head: HEAD,
      needsBinding: false,
      checkoutGeo: false,
      now: new Date("2026-10-02T12:00:00.000Z"),
      history: {
        records: [
          {
            id: "zh-1",
            subtotal: 30,
            total: 24,
            settledAt: "2026-10-02T03:06:00.000Z",
            startedAt: "2026-10-02T01:30:00.000Z",
            endedAt: "2026-10-02T03:00:00.000Z",
            sessionCount: 2,
            paymentMethod: "wechat",
          },
          {
            id: "zh-2",
            subtotal: 15,
            total: 15,
            settledAt: "2025-12-31T09:40:00.000Z",
            startedAt: null,
            endedAt: null,
            sessionCount: 0,
            paymentMethod: null,
          },
        ],
        nextOffset: null,
      },
    });
    expect((historyZh.blocks[0] as PageList).items).toEqual([
      {
        id: "zh-1",
        group: "10月2日",
        title: "10:30 – 12:00",
        titleMeta: "1小时30分",
        subtitle: "现场收款 · 微信 · 2 项 · 结账时间 12:06",
        trailing: "24.00",
        trailingStrikethrough: "30.00",
        open: { view: "history", item: "zh-1" },
      },
      {
        id: "zh-2",
        group: "2025年12月31日",
        title: "18:40",
        subtitle: "资产结算",
        trailing: "15.00",
        open: { view: "history", item: "zh-2" },
      },
    ]);

    const historyDetail = renderAccountSheetPage({
      locale: "en",
      view: "history",
      head: HEAD,
      needsBinding: false,
      checkoutGeo: false,
      detailReceipt: SAMPLE_RECEIPT,
    });
    expect(historyDetail.title).toBe("Bill details");
    expect(historyDetail.backLabel).toBeUndefined();
    expect(historyDetail.blocks[0]).toMatchObject({ kind: "bill", mode: "settled" });

    const wallet = renderAccountSheetPage({
      locale: "en",
      view: "wallet",
      head: HEAD,
      needsBinding: false,
      checkoutGeo: false,
      holdings: [
        { id: "h-coupon", assetType: "coupon", assetName: "Free Play", assetCode: "free-play", quantity: 2 },
        { id: "h-free", assetType: "currency", assetName: "Bonus", assetCode: "free", quantity: 20 },
        { id: "h-paid", assetType: "currency", assetName: "Balance", assetCode: "paid", quantity: 80 },
        { id: "h-pass", assetType: "pass", assetName: "Monthly Pass", assetCode: "pass-1", quantity: 1 },
        { id: "h-ticket", assetType: "ticket", assetName: "Event Ticket", assetCode: "ticket-1", quantity: 3 },
      ],
    });
    expect(wallet.blocks[0]).toMatchObject({
      kind: "kv",
      items: [
        { id: "h-paid", label: "Balance", value: "80", icon: "wallet", badge: "Paid balance", badgeTone: "success" },
        { id: "h-free", label: "Bonus", value: "20", icon: "gift", badge: "Bonus balance", badgeTone: "accent" },
        { id: "h-coupon", label: "Free Play", value: "2", icon: "coupon", badge: "Coupon", badgeTone: "warning" },
        { id: "h-pass", label: "Monthly Pass", value: "1", icon: "pass", badge: "Pass", badgeTone: "purple" },
        { id: "h-ticket", label: "Event Ticket", value: "3", icon: "ticket", badge: "Ticket", badgeTone: "accent" },
      ],
    });

    const bindingsEmpty = renderAccountSheetPage({
      locale: "en",
      view: "bindings",
      head: HEAD,
      needsBinding: false,
      checkoutGeo: false,
      bindings: [],
    });
    expect(bindingsEmpty.title).toBe("Identity");
    expect(bindingsEmpty.blocks).toHaveLength(1);
    expect(bindingsEmpty.blocks[0]).toMatchObject({ kind: "text", text: "No linked identities" });
  });
});

async function createShopPageFixture() {
  const sqlite = new Database(":memory:");
  const migrations = resolve(import.meta.dir, "../../../migrations");
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) {
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) {
      sqlite.run(sql);
    }
  }
  sqlite.run("PRAGMA foreign_keys=OFF");
  sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('u1','user',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('auth','u1',?,?)", [
    await sha256(TOKEN),
    new Date(Date.now() + 86_400_000).toISOString(),
  ]);
  sqlite.run(
    "INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','Arcade',0,0,80,'u1')",
  );
  sqlite.run(
    "INSERT INTO shop_billing_settings(shop_id,billing_enabled,auto_register,identity_binding_required) VALUES ('shop',1,1,0)",
  );
  sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','p1','一号','active',?)", [NOW]);
  sqlite.run(
    "INSERT INTO player_identities(shop_id,subject,player_id,created_at,provider) VALUES ('shop','u1','p1',?, 'web-account')",
    [NOW],
  );
  sqlite.run("INSERT INTO asset_definitions(shop_id,type,code,name,stackable,status) VALUES ('shop','currency','paid','猫粮',1,'active')");
  sqlite.run(
    "INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES ('shop','h1','p1','currency','paid',1000000)",
  );
  sqlite.run(
    `INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
     VALUES ('shop','plan','time.priority','畅玩',1,'active',?,?,?)`,
    [
      JSON.stringify({
        id: "plan",
        timeZone: "UTC",
        rules: [
          {
            id: "all",
            label: "全天",
            priority: 0,
            timeRange: { start: "00:00", end: "00:00" },
            pricing: { unitMinutes: 60, unitPrice: 100, roundGraceMinutes: 0, priceCap: 100000 },
          },
        ],
      }),
      NOW,
      NOW,
    ],
  );
  sqlite.run(
    "INSERT INTO resource_groups(shop_id,id,name,enabled,default_pricing_config_id,created_at,updated_at) VALUES ('shop','default','默认',1,'plan',?,?)",
    [NOW, NOW],
  );
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('cab','cab-pub','shop','舞萌','')");
  sqlite.run(
    `INSERT INTO presents(shop_id,id,name,once_per_player,grants_json,status)
     VALUES ('shop','gift','充值礼',0,?,'active')`,
    [JSON.stringify([{ assetType: "currency", assetCode: "paid", amount: 500, mergeStrategy: "stack" }])],
  );
  sqlite.run(
    "INSERT INTO redeem_codes(shop_id,id,code,present_id,max_use_count) VALUES ('shop','rc1','GIFT-1','gift',1)",
  );

  const env = {
    DB: createD1DatabaseFromSqlite(sqlite),
    SESSION_SECRET: SECRET,
    APP_ORIGIN: "https://prism.test",
  } as unknown as Env;
  const app = createApp();
  return { sqlite, env, app };
}

describe("shop player page routes", () => {
  beforeEach(() => {
    clearShopDependenciesCache();
    clearRateLimitMemory();
  });

  it("serves shop page, account sheets, actions, scanned accountMenu, and keeps legacy /player/me intact", async () => {
    const { sqlite, env, app } = await createShopPageFixture();
    try {
      const authHeaders = { authorization: `Bearer ${TOKEN}` };

      // Unauthenticated: shop view returns signin block, sheet view requires auth
      const guestShop = await app.fetch(new Request("https://prism.test/api/v1/shops/shop-code/player/page?view=shop"), env);
      expect(guestShop.status).toBe(200);
      const guestData = ((await guestShop.json()) as { data: Page }).data;
      expect(guestData.blocks.map((b) => b.kind)).toEqual(["signin"]);
      expect(guestData.accountMenu).toBeUndefined();

      const guestSheet = await app.fetch(new Request("https://prism.test/api/v1/shops/shop-code/player/page?view=redeem"), env);
      expect(guestSheet.status).toBe(401);

      // Scanned resource page attaches accountMenu with bill tab when signed in, omits when guest
      const { ticket } = await mintResourceTicket(SECRET, "shop-code", "cab-pub");
      const guestScan = await app.fetch(
        new Request(`https://prism.test/api/v1/devices/session/page?ticket=${encodeURIComponent(ticket)}`),
        env,
      );
      expect(guestScan.status).toBe(200);
      expect(((await guestScan.json()) as { data: Page }).data.accountMenu).toBeUndefined();

      const signedScan = await app.fetch(
        new Request(`https://prism.test/api/v1/devices/session/page?ticket=${encodeURIComponent(ticket)}`, { headers: authHeaders }),
        env,
      );
      expect(signedScan.status).toBe(200);
      const scanPage = ((await signedScan.json()) as { data: Page }).data;
      expect(scanPage.accountMenu?.tabs.map((t) => t.id)).toContain("bill");

      // Active billing session + live shop page with client-side billingInputs (no server preview calculation)
      const startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
      sqlite.run(
        "INSERT INTO sessions(shop_id,id,player_id,started_at,status,payment_status,pricing_config_ids_json) VALUES ('shop','s1','p1',?,'active','unpaid',?)",
        [startedAt, JSON.stringify(["plan"])],
      );

      const shopLiveRes = await app.fetch(
        new Request("https://prism.test/api/v1/shops/shop-code/player/page?view=shop", { headers: authHeaders }),
        env,
      );
      expect(shopLiveRes.status).toBe(200);
      const shopLive = ((await shopLiveRes.json()) as { data: Page }).data;
      expect(shopLive.billingActive).toBe(true);
      expect(shopLive.resource).toBe("计费中");
      expect(shopLive.accountMenu?.billingBadge).toBe("计费中");
      expect(shopLive.accountMenu?.tabs.map((t) => t.id)).toEqual(["redeem", "history", "wallet", "bindings"]);
      const liveBill = shopLive.blocks[0] as PageBill;
      expect(liveBill.kind).toBe("bill");
      expect(liveBill.mode).toBe("live");
      expect(liveBill.billingInputs?.playerId).toBe("p1");
      expect(liveBill.preview).toBeUndefined();
      expect(shopLive.footer?.[0]).toMatchObject({ kind: "button", action: "checkout.confirm" });

      // Wallet sheet shows currency holding
      const walletRes = await app.fetch(
        new Request("https://prism.test/api/v1/shops/shop-code/player/page?view=wallet", { headers: authHeaders }),
        env,
      );
      expect(walletRes.status).toBe(200);
      const walletPage = ((await walletRes.json()) as { data: Page }).data;
      expect(walletPage.title).toBe("钱包");
      expect(walletPage.blocks[0]).toMatchObject({
        kind: "kv",
        items: [{ id: "h1", label: "猫粮", value: "10000", icon: "wallet", badge: "充值余额", badgeTone: "success" }],
      });

      // Redeem invalid code -> ok: false + inline notice; valid code -> ok: true + success banner
      const badRedeem = await app.fetch(
        new Request("https://prism.test/api/v1/shops/shop-code/player/action", {
          method: "POST",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: JSON.stringify({ view: "redeem", operationId: crypto.randomUUID(), action: "redeem.submit", payload: { code: "NOPE" } }),
        }),
        env,
      );
      expect(badRedeem.status).toBe(200);
      const badRedeemBody = ((await badRedeem.json()) as { data: { ok: boolean; notices: unknown[]; page: Page } }).data;
      expect(badRedeemBody.ok).toBe(false);
      expect(badRedeemBody.notices.length).toBeGreaterThanOrEqual(1);
      expect(badRedeemBody.page.blocks[0]).toMatchObject({ kind: "input", id: "code" });

      const goodRedeem = await app.fetch(
        new Request("https://prism.test/api/v1/shops/shop-code/player/action", {
          method: "POST",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: JSON.stringify({ view: "redeem", operationId: crypto.randomUUID(), action: "redeem.submit", payload: { code: "GIFT-1" } }),
        }),
        env,
      );
      expect(goodRedeem.status).toBe(200);
      const goodRedeemBody = ((await goodRedeem.json()) as { data: { ok: boolean; page: Page } }).data;
      expect(goodRedeemBody.ok).toBe(true);
      expect(goodRedeemBody.page.blocks[0]).toMatchObject({ kind: "banner", body: "兑换成功", level: "success" });

      // Checkout confirm -> returns celebration + receipt + settled shop page without footer
      const checkoutRes = await app.fetch(
        new Request("https://prism.test/api/v1/shops/shop-code/player/action", {
          method: "POST",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: JSON.stringify({ view: "shop", operationId: crypto.randomUUID(), action: "checkout.confirm" }),
        }),
        env,
      );
      expect(checkoutRes.status).toBe(200);
      const checkoutBody = ((await checkoutRes.json()) as {
        data: { ok: boolean; page: Page; celebration?: { effect?: string }; receipt?: unknown };
      }).data;
      expect(checkoutBody.ok).toBe(true);
      expect(checkoutBody.celebration?.effect).toBe("checkout");
      expect(checkoutBody.receipt).toBeDefined();
      expect(checkoutBody.page.footer).toBeUndefined();
      expect(checkoutBody.page.resource).toBe("结账成功");
      expect(checkoutBody.page.blocks[0]).toMatchObject({ kind: "bill", mode: "settled" });

      // History list + drill-down detail
      const historyRes = await app.fetch(
        new Request("https://prism.test/api/v1/shops/shop-code/player/page?view=history", { headers: authHeaders }),
        env,
      );
      expect(historyRes.status).toBe(200);
      const historyPage = ((await historyRes.json()) as { data: Page }).data;
      const list = historyPage.blocks[0] as PageList;
      expect(list.kind).toBe("list");
      expect(list.items.length).toBe(1);
      const checkoutId = list.items[0]!.open!.item!;

      const detailRes = await app.fetch(
        new Request(
          `https://prism.test/api/v1/shops/shop-code/player/page?view=history&item=${encodeURIComponent(checkoutId)}`,
          { headers: authHeaders },
        ),
        env,
      );
      expect(detailRes.status).toBe(200);
      const detailPage = ((await detailRes.json()) as { data: Page }).data;
      expect(detailPage.title).toBe("账单详情");
      expect(detailPage.backLabel).toBeUndefined();
      expect(detailPage.blocks[0]).toMatchObject({ kind: "bill", mode: "settled" });

      // Bindings page & refresh action & legacy /player/me route
      const bindingsRes = await app.fetch(
        new Request("https://prism.test/api/v1/shops/shop-code/player/action", {
          method: "POST",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: JSON.stringify({ view: "bindings", operationId: crypto.randomUUID(), action: "page.refresh" }),
        }),
        env,
      );
      expect(bindingsRes.status).toBe(200);
      const bindingsAnswer = ((await bindingsRes.json()) as { data: { ok: boolean; page: Page } }).data;
      expect(bindingsAnswer.page.title).toBe("身份");
      expect(bindingsAnswer.page.blocks).toHaveLength(1);
      expect(bindingsAnswer.page.blocks[0]).toMatchObject({ kind: "text", text: "暂无绑定身份" });

      const legacyMe = await app.fetch(
        new Request("https://prism.test/api/v1/shops/shop-code/player/me", { headers: authHeaders }),
        env,
      );
      expect(legacyMe.status).toBe(200);
    } finally {
      sqlite.close();
    }
  });
});

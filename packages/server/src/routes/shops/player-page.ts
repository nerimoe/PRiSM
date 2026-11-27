import { z } from "zod";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings, TenantShop } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { getShop, getShopDeps, tenantMiddleware } from "../../middleware/tenant.js";
import { notice, requestLocale, type Notice } from "../../notices.js";
import { ACCOUNT_PROFILES_SQL } from "../../resources/account-profiles.js";
import { shopBillsSql } from "../../resources/billed-sql.js";
import { readShopLocationSettings, resolveEffectiveLocationPolicy } from "../../resources/location.js";
import { checkoutCelebration, type SettledBillReceipt } from "../../resources/page-blocks/bill.js";
import { translator } from "../../resources/page-text.js";
import { listAccountPlatformIdentities } from "../../resources/platform-identities.js";
import {
  renderAccountSheetPage,
  renderShopPage,
  SHOP_PAGE_VIEWS,
  type LiveBillInput,
  type ShopPageView,
} from "../../resources/shop-page.js";
import { hasPlatformBinding, requireShopPlayer } from "./player.js";
import { toPlayerAssetsView, toPlayerCheckoutPreviewView } from "./views.js";

const viewSchema = z.enum(SHOP_PAGE_VIEWS);

const actionBody = z.object({
  view: viewSchema.default("shop"),
  operationId: z.string().uuid(),
  action: z.string().min(1).max(40),
  payload: z.record(z.string(), z.unknown()).optional(),
  location: z.unknown().optional(),
});

type C = Context<AppBindings>;

type DispatchAnswer = {
  data?: unknown;
  error?: { code?: string; message?: string; notice?: Notice };
};

function parseView(raw: string | undefined): ShopPageView {
  if (raw === undefined) return "shop";
  const parsed = viewSchema.safeParse(raw);
  if (!parsed.success) jsonError(400, "Invalid page view.", "INVALID_VIEW");
  return parsed.data;
}

function parseOffset(raw: string | undefined): number {
  const offset = Number(raw ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    jsonError(400, "Invalid history offset.", "INVALID_OFFSET");
  }
  return offset;
}

async function findExistingPlayer(
  c: C,
  shop: TenantShop,
  userId: string,
): Promise<{ id: string; status: string } | null> {
  if (c.req.header("X-PRiSM-Player-Id")) {
    return requireShopPlayer(c, shop, false);
  }
  const player = await c.env.DB.prepare(
    `SELECT p.id, p.status FROM ${ACCOUNT_PROFILES_SQL} a
     JOIN players p ON p.shop_id = a.shop_id AND p.id = a.player_id
     WHERE a.shop_id = ? AND a.user_id = ?`,
  )
    .bind(shop.id, userId)
    .first<{ id: string; status: string }>();
  if (player && player.status !== "active") {
    jsonError(403, "店铺玩家资格已停用", "PLAYER_DISABLED");
  }
  return player;
}

async function isPlayerDisabled(caught: unknown): Promise<boolean> {
  if (!(caught instanceof HTTPException) || caught.status !== 403) return false;
  const body = await caught.getResponse().clone().json().catch(() => null) as { error?: { code?: string } } | null;
  return body?.error?.code === "PLAYER_DISABLED";
}

async function liveBillFor(c: C, playerId: string): Promise<LiveBillInput> {
  const deps = getShopDeps(c);
  if (deps.staffLiveBillingSnapshot) {
    const snapshot = await deps.staffLiveBillingSnapshot([playerId]);
    const held = new Set(snapshot.players.flatMap((row) => row.holdings.map((h) => `${h.assetType}:${h.assetCode}`)));
    return {
      billingInputs: {
        playerId,
        billingSnapshot: {
          ...snapshot,
          assetDefinitions: snapshot.assetDefinitions.filter((d) => held.has(`${d.type}:${d.code}`)),
        },
      },
    };
  }
  const preview = await deps.playerCheckoutCommands.previewCheckout({ playerId });
  return { preview: toPlayerCheckoutPreviewView(preview) };
}

async function readShopView(
  c: C,
  view: ShopPageView,
  opts: {
    item?: string;
    cursor?: string;
    settledReceipt?: SettledBillReceipt;
    redeemed?: boolean;
  } = {},
) {
  const shop = getShop(c);
  const deps = getShopDeps(c);
  const locale = requestLocale(c.req.header("accept-language"));
  const head = {
    shop: shop.name,
    shopCode: shop.public_id,
    heroUrl: shop.hero_url,
    ...(shop.time_zone ? { timeZone: shop.time_zone } : {}),
  };

  const maybeUser = c.get("user");
  if (view === "shop" && !maybeUser) {
    return renderShopPage({
      locale,
      head,
      signedIn: false,
      needsBinding: false,
      shopBills: false,
      identityBindingRequired: !!shop.identity_binding_required,
      privacyModeEnabled: !!shop.privacy_mode_enabled,
      checkoutGeo: false,
      liveBill: null,
      settledReceipt: null,
    });
  }

  const user = requireUser(c);

  const needsBindingCheck =
    shop.identity_binding_required && !c.req.header("X-PRiSM-Player-Id")
      ? hasPlatformBinding(c, shop.id, user.id).then((bound) => !bound)
      : Promise.resolve(false);

  if (view === "bindings") {
    if (await needsBindingCheck) jsonError(403, "请先绑定平台身份", "PLATFORM_BINDING_REQUIRED");
    const bindings = await listAccountPlatformIdentities(c.env.DB, shop.id, user.id);
    return renderAccountSheetPage({
      locale,
      view: "bindings",
      head,
      checkoutGeo: false,
      bindings,
    });
  }

  if (view === "shop") {
    const [needsBinding, billsRow, locationSettings] = await Promise.all([
      needsBindingCheck,
      c.env.DB.prepare(`SELECT ${shopBillsSql("?")} AS bills`).bind(shop.id).first<{ bills: number }>(),
      readShopLocationSettings(c.env.DB, shop.id),
    ]);
    const checkoutPolicy = resolveEffectiveLocationPolicy({
      shop,
      action: "checkout",
      settings: locationSettings,
    });
    const checkoutGeo = checkoutPolicy.mode === "gps" || checkoutPolicy.mode === "any";
    const shopBills = !!billsRow?.bills;

    let liveBill: LiveBillInput | null = null;
    let settledReceipt: SettledBillReceipt | null = opts.settledReceipt ?? null;

    let disabled = false;
    if (!settledReceipt) {
      const player = await (needsBinding ? findExistingPlayer(c, shop, user.id) : requireShopPlayer(c, shop)).catch(
        async (caught: unknown) => {
          // A disabled player still gets the shop page, saying so, rather than a bare error.
          if (await isPlayerDisabled(caught)) {
            disabled = true;
            return null;
          }
          throw caught;
        },
      );
      if (player) {
        const summary = await deps.playerQueries.getPlayerSummary(player.id);
        if (summary.activeSession) {
          liveBill = await liveBillFor(c, player.id);
        } else if (!needsBinding && deps.playerQueries.getLatestPlayerCheckout) {
          settledReceipt = await deps.playerQueries.getLatestPlayerCheckout(player.id);
        }
      }
    }

    return renderShopPage({
      locale,
      head,
      signedIn: true,
      needsBinding,
      disabled,
      shopBills,
      identityBindingRequired: !!shop.identity_binding_required,
      privacyModeEnabled: !!shop.privacy_mode_enabled,
      checkoutGeo,
      liveBill,
      settledReceipt,
    });
  }

  if (view === "bill") {
    const player = await requireShopPlayer(c, shop);
    const locationSettings = await readShopLocationSettings(c.env.DB, shop.id);
    const checkoutPolicy = resolveEffectiveLocationPolicy({
      shop,
      action: "checkout",
      settings: locationSettings,
    });
    const checkoutGeo = checkoutPolicy.mode === "gps" || checkoutPolicy.mode === "any";

    let liveBill: LiveBillInput | null = null;
    let settledReceipt: SettledBillReceipt | null = opts.settledReceipt ?? null;

    if (!settledReceipt) {
      const summary = await deps.playerQueries.getPlayerSummary(player.id);
      if (summary.activeSession) {
        liveBill = await liveBillFor(c, player.id);
      } else if (deps.playerQueries.getLatestPlayerCheckout) {
        settledReceipt = await deps.playerQueries.getLatestPlayerCheckout(player.id);
      }
    }

    return renderAccountSheetPage({
      locale,
      view: "bill",
      head,
      checkoutGeo,
      liveBill,
      settledReceipt,
    });
  }

  if (view === "redeem") {
    if (!opts.redeemed) {
      await requireShopPlayer(c, shop);
    }
    return renderAccountSheetPage({
      locale,
      view: "redeem",
      head,
      checkoutGeo: false,
      redeemed: !!opts.redeemed,
    });
  }

  if (view === "history") {
    const player = await requireShopPlayer(c, shop);
    if (opts.item) {
      if (!deps.playerQueries.getPlayerCheckout) {
        jsonError(503, "Checkout queries are not configured.", "CHECKOUT_QUERIES_NOT_CONFIGURED");
      }
      const receipt = await deps.playerQueries.getPlayerCheckout(player.id, opts.item);
      if (!receipt) {
        jsonError(404, "Checkout not found.", "CHECKOUT_NOT_FOUND");
      }
      return renderAccountSheetPage({
        locale,
        view: "history",
        head,
        checkoutGeo: false,
        detailReceipt: receipt,
      });
    }
    if (!deps.playerQueries.listPlayerCheckouts) {
      jsonError(503, "Checkout queries are not configured.", "CHECKOUT_QUERIES_NOT_CONFIGURED");
    }
    const offset = parseOffset(opts.cursor);
    const history = await deps.playerQueries.listPlayerCheckouts(player.id, offset);
    return renderAccountSheetPage({
      locale,
      view: "history",
      head,
      checkoutGeo: false,
      history,
    });
  }

  if (view === "options") {
    const privacyModeEnabled = !!shop.privacy_mode_enabled;
    // Unbound players are refused here (403, refresh) like every other sheet: binding lives on the page.
    const player = await requireShopPlayer(c, shop);
    let privacyMode = false;
    if (privacyModeEnabled) {
      const row = await c.env.DB.prepare("SELECT privacy_mode FROM players WHERE shop_id = ? AND id = ?")
        .bind(shop.id, player.id)
        .first<{ privacy_mode: number }>();
      privacyMode = Boolean(row?.privacy_mode);
    }
    return renderAccountSheetPage({
      locale,
      view: "options",
      head,
      checkoutGeo: false,
      privacyModeEnabled,
      playerOptions: privacyModeEnabled ? { privacyMode } : {},
    });
  }

  // view === "wallet"
  const player = await requireShopPlayer(c, shop);
  const assets = deps.playerQueries.listPlayerAssets
    ? await deps.playerQueries.listPlayerAssets(player.id)
    : { holdings: [], ledgerEntries: [] };
  const assetsView = toPlayerAssetsView(assets) as {
    holdings: Array<{ id: string; assetType?: string; assetName?: string | null; assetCode: string; quantity: number }>;
  };
  return renderAccountSheetPage({
    locale,
    view: "wallet",
    head,
    checkoutGeo: false,
    holdings: assetsView.holdings,
  });
}

/**
 * Unified server-driven shop & account-sheet pages (`/api/v1/shops/:shopCode/player/page`
 * and `/action`). `tenantMiddleware` is attached per-route so legacy `/player/*` routes stay untouched.
 */
export function createShopPlayerPageRouter(dispatch: (c: C, request: Request) => Promise<Response>) {
  const router = new Hono<AppBindings>();

  router.use("/page", tenantMiddleware);
  router.use("/action", tenantMiddleware);

  router.get("/page", async (c) => {
    const view = parseView(c.req.query("view"));
    const item = c.req.query("item") || undefined;
    const cursor = c.req.query("cursor") || undefined;
    return c.json(await readShopView(c, view, { item, cursor }));
  });

  router.post("/action", async (c) => {
    requireUser(c);
    const body = actionBody.parse(await c.req.json());
    const shop = getShop(c);
    const t = translator(requestLocale(c.req.header("accept-language")));

    if (body.action === "page.refresh") {
      return c.json({ ok: true, page: await readShopView(c, body.view), notices: [] });
    }

    let targetPath: string;
    let method: "POST" | "PUT" = "POST";
    let payload: Record<string, unknown>;
    if (body.action === "checkout.confirm") {
      targetPath = `/api/v1/shops/${encodeURIComponent(shop.public_id)}/player/checkout/confirm`;
      payload = { operationId: body.operationId, ...(body.location !== undefined ? { location: body.location } : {}) };
    } else if (body.action === "redeem.submit") {
      targetPath = `/api/v1/shops/${encodeURIComponent(shop.public_id)}/player/redeem`;
      payload = {
        operationId: body.operationId,
        code: typeof body.payload?.code === "string" ? body.payload.code : "",
      };
    } else if (body.action === "options.save") {
      method = "PUT";
      targetPath = `/api/v1/shops/${encodeURIComponent(shop.public_id)}/player/options`;
      payload = body.payload ?? {};
    } else {
      jsonError(400, "Unsupported action.", "UNSUPPORTED_ACTION");
    }

    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    const answered = await dispatch(
      c,
      new Request(new URL(targetPath, c.req.url), {
        method,
        headers,
        body: JSON.stringify(payload),
      }),
    );
    const answer = (await answered.json().catch(() => ({}))) as DispatchAnswer;
    if (!answered.ok) {
      const flow = answer.error?.notice?.flow;
      if (answered.status >= 500 || flow === "expired" || flow === "signin" || (body.view !== "shop" && flow === "refresh")) {
        return c.json({ error: answer.error }, answered.status as never);
      }
      return c.json({
        ok: false,
        page: await readShopView(c, body.view),
        notices: answer.error?.notice ? [answer.error.notice] : [],
      });
    }

    if (body.action === "checkout.confirm") {
      const receipt = answer.data as SettledBillReceipt;
      return c.json({
        ok: true,
        page: await readShopView(c, body.view, { settledReceipt: receipt }),
        notices: [],
        celebration: checkoutCelebration(t),
        receipt,
      });
    }

    if (body.action === "options.save") {
      return c.json({
        ok: true,
        page: await readShopView(c, body.view),
        notices: [notice("PLAYER_OPTIONS_SAVED", requestLocale(c.req.header("accept-language")))],
      });
    }

    return c.json({
      ok: true,
      page: await readShopView(c, body.view, { redeemed: true }),
      notices: [],
    });
  });

  return router;
}

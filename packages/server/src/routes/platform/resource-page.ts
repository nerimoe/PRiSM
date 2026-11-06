import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { optionalUser } from "../../middleware/auth.js";
import type { Notice } from "../../notices.js";
import { requestLocale } from "../../notices.js";
import { withReadScope } from "../../read-scope.js";
import { coinLimit, ioConnected } from "../../resources/capabilities/cabinet.js";
import { readDeviceState } from "../../resources/capabilities/device-state.js";
import { pageCode, renderPage, type Page } from "../../resources/page.js";
import { hinataConfigOf, loadResource, publicCapabilities } from "../../resources/resource.js";
import { mahjongState } from "./mahjong.js";
import { readGate } from "./resource-session.js";
import { resolveResourceTicket, type ScannedResource } from "./resource-ticket.js";

type C = Context<AppBindings, any, any>;

const NO_CAPABILITIES = { power: false, climate: false, card: false, coin: false, door: false, mahjong: false };

/**
 * Reads what the page depends on and renders it. A read asks nothing it will not
 * show: a player still confirming costs no device reads, and the books are read
 * only when a coin button is on the page. Only a direct-connected IO has a link to read.
 */
export function readPage(c: C, machine: ScannedResource): Promise<Page> {
  return withReadScope(async () => {
    const shopId = machine.shop_id;
    const device = await loadResource(c.env.DB, shopId, machine.id);
    const capabilities = device ? publicCapabilities(device) : NO_CAPABILITIES;
    const io = device ? hinataConfigOf(device) : null;
    const user = optionalUser(c);
    const needsPlayer = !!user && (Object.values(capabilities).some(Boolean) || !!machine.billed);
    const gated = needsPlayer ? await readGate(c, machine, device) : null;
    const ready = gated?.gate === "ready";
    const state = ready && device && (capabilities.power || capabilities.climate)
      ? await readDeviceState({ db: c.env.DB, env: c.env, shopId }, device)
      : null;
    const ioWaiting = !!ready && !!device && io?.transport === "embedded" && (capabilities.card || capabilities.coin)
      && state?.power !== "off" && !(await ioConnected(c.env.DB, shopId, device.id));
    const coinButton = ready && device && capabilities.coin && !io?.coinAfterSwipe && state?.power !== "off" && !ioWaiting;
    const [coin, mahjong, billing] = await Promise.all([
      coinButton ? coinLimit(c.env.DB, shopId, device) : null,
      ready && device && capabilities.mahjong ? mahjongState(c, machine, undefined, device) : null,
      user
        ? c.env.DB.prepare(
            `SELECT 1 FROM shop_player_accounts a
             JOIN sessions s ON s.shop_id=a.shop_id AND s.player_id=a.player_id AND s.status='active'
             WHERE a.shop_id=? AND a.user_id=? LIMIT 1`,
          ).bind(shopId, user.id).first()
        : null,
    ]);
    return renderPage({
      locale: requestLocale(c.req.header("accept-language")),
      head: {
        shop: machine.shop_name, shopCode: machine.shop_public_id, heroUrl: machine.shop_hero_url,
        resource: machine.name, publicId: machine.public_id,
      },
      billingActive: !!billing,
      capabilities,
      billed: !!machine.billed,
      coinAfterSwipe: !!io?.coinAfterSwipe,
      cardCapture: capabilities.card && io?.transport === "embedded" && !!io.channel,
      geo: { checkin: !!gated?.shop.checkin_geo, machine: !!gated?.shop.machine_geo },
      signedIn: !!user,
      gate: gated?.gate ?? "ready",
      billing: gated?.billing ?? null,
      power: state?.power ?? null,
      climate: state?.climate ?? null,
      coinFull: coin === "full",
      ioWaiting,
      mahjong,
    });
  });
}

const actionBody = z.object({
  ticket: z.string().min(1),
  operationId: z.string().uuid(),
  action: z.string().min(1).max(40),
  /** What the block gave for this action, and `consent` when it required agreeing. */
  payload: z.record(z.string(), z.unknown()).optional(),
  location: z.unknown().optional(),
});

/** Which existing route carries out an action, with what it expects. */
function routeOf(machine: ScannedResource, body: z.infer<typeof actionBody>) {
  const { ticket, operationId, action, location, payload } = body;
  if (action === "entry")
    return { path: `/api/v1/shops/${encodeURIComponent(machine.shop_public_id)}/player/session/start`, json: { ...payload, ticket, operationId, location } };
  // A swipe takes its coordinates at the top level.
  if (action === "card.swipe")
    return { path: "/api/v1/machines/login", json: { ...payload, ...(location && typeof location === "object" ? location : {}), ticket, operationId } };
  return { path: "/api/v1/devices/session/actions", json: { ...payload, ticket, operationId, action, location } };
}

type Answer = {
  data?: {
    notices?: Notice[];
    temporaryPassword?: string;
    expiresAt?: string;
    door?: { temporaryPassword?: string; expiresAt?: string; notice?: Notice };
  };
  error?: { notice?: Notice };
};

/**
 * Reading the page, and acting on it. An action runs through the route that has
 * always done it, as a request of its own, so everything hung on that route
 * applies here too: repeat protection, rate limits, the Live Activity bridge. It
 * answers with the page as it now stands.
 *
 * A refusal is an ordinary answer: the player is told why, under the button they
 * pressed, and the page shows the state that caused it. Only what the page cannot
 * answer stays an error: the ticket or sign-in has gone, or the server failed.
 */
export function createResourcePageRouter(
  dispatch: (c: C, request: Request) => Promise<Response>,
) {
  const router = new Hono<AppBindings>();

  router.get("/session/page", async (c) => {
    const machine = await resolveResourceTicket(c, c.req.query("ticket") ?? "");
    return c.json(await readPage(c, machine));
  });

  router.post("/session/action", async (c) => {
    const body = actionBody.parse(await c.req.json());
    const machine = await resolveResourceTicket(c, body.ticket);
    const { path, json } = routeOf(machine, body);
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    const answered = await dispatch(c, new Request(new URL(path, c.req.url), { method: "POST", headers, body: JSON.stringify(json) }));
    const answer = (await answered.json().catch(() => ({}))) as Answer;
    if (!answered.ok) {
      const flow = answer.error?.notice?.flow;
      if (answered.status >= 500 || flow === "expired" || flow === "signin")
        return c.json({ error: answer.error }, answered.status as never);
      return c.json({ ok: false, page: await readPage(c, machine), notices: answer.error?.notice ? [answer.error.notice] : [] });
    }
    const data = answer.data ?? {};
    const door = data.door ?? data;
    const failed = data.door?.notice;
    return c.json({
      ok: true,
      page: await readPage(c, machine),
      notices: [...(data.notices ?? []), ...(failed ? [failed] : [])],
      ...(door.temporaryPassword && door.expiresAt
        ? { code: pageCode(requestLocale(c.req.header("accept-language")), { temporaryPassword: door.temporaryPassword, expiresAt: door.expiresAt }) }
        : {}),
    });
  });

  return router;
}

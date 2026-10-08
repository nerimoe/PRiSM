import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { createSession } from "../../middleware/auth.js";
import { enforceRateLimits } from "../../middleware/rate-limit.js";
import { clientIp, jsonError } from "../../http.js";
import { randomToken } from "../../crypto.js";
import { munetAuthorizeUrl, finishMunetAuth } from "./munet.js";
import {
  appClipAuthCallbackURLWithParams, consumeAppClipAuthCode, consumeAppClipAuthState,
  createAppClipAuthCode, createAppClipAuthState, provisionMunetUser,
} from "./munet-appclip.js";
import { munetSuccessReturn, munetFailureReturn } from "./auth-return.js";

export const munetAuthRouter = new Hono<AppBindings>();
export const appclipAuthRouter = new Hono<AppBindings>();
export const munetCallbackRouter = new Hono<AppBindings>();
const oauthStateCookie = "arcadelink_munet_state";
const oauthNextCookie = "arcadelink_munet_next";
const safePath = (value?: string) => value?.startsWith("/") && !value.startsWith("//") && value.length <= 500
  ? value : "/cards";
const cookieOptions = (c: Context<AppBindings>) => ({
  httpOnly: true,
  secure: new URL(c.req.url).protocol === "https:",
  sameSite: "Lax" as const,
  path: "/",
  maxAge: 600,
});

function munetConfig(c: Context<AppBindings>) {
  const clientId = c.env.MUNET_CLIENT_ID, clientSecret = c.env.MUNET_CLIENT_SECRET;
  if (!clientId || !clientSecret) jsonError(503, "MuNET 登录尚未配置", "MUNET_NOT_CONFIGURED");
  return { clientId, clientSecret };
}

munetAuthRouter.get("/munet", (c) => {
  const { clientId } = munetConfig(c);
  const state = randomToken(24);
  setCookie(c, oauthStateCookie, state, cookieOptions(c));
  setCookie(c, oauthNextCookie, safePath(c.req.query("next")), cookieOptions(c));
  return c.redirect(munetAuthorizeUrl(clientId, `${c.env.APP_ORIGIN}/callback`, state));
});

appclipAuthRouter.get("/start", async (c) => {
  const { clientId } = munetConfig(c);
  await enforceRateLimits(c, [{
    key: `appclip-auth:start:${clientIp(c.req.raw)}`, limit: 5, windowSeconds: 60,
  }]);
  const state = `appclip.${randomToken(24)}`;
  await createAppClipAuthState(c, state);
  return c.redirect(munetAuthorizeUrl(clientId, `${c.env.APP_ORIGIN}/callback`, state));
});

async function finishAppClipCallback(c: Context<AppBindings>, redirectPath: string) {
  const callback = (params: Record<string, string>) => c.redirect(appClipAuthCallbackURLWithParams(params));
  const state = c.req.query("state");
  const valid = state ? await consumeAppClipAuthState(c, state) : false;
  if (!valid) return callback({ error: "MuNET 授权无效，请重新登录" });
  if (c.req.query("error")) return callback({ error: "MuNET 授权已取消" });
  const code = c.req.query("code");
  if (!code) return callback({ error: "MuNET 授权无效，请重新登录" });
  try {
    const munet = await finishMunetAuth({
      ...munetConfig(c), code, redirectUri: `${c.env.APP_ORIGIN}${redirectPath}`,
    });
    const { userId, isNewUser } = await provisionMunetUser(c, munet);
    const exchangeCode = await createAppClipAuthCode(c, userId);
    return callback({ code: exchangeCode, ...(isNewUser ? { setup: "passkey" } : {}) });
  } catch (error) {
    console.error(error);
    return callback({
      error: error instanceof z.ZodError ? "MuNET 返回的数据无法识别"
        : error instanceof Error ? error.message : "MuNET 登录失败",
    });
  }
}

appclipAuthRouter.get("/callback", (c) => finishAppClipCallback(c, "/api/v1/appclip/auth/callback"));

appclipAuthRouter.post("/exchange", async (c) => {
  await enforceRateLimits(c, [{
    key: `appclip-auth:exchange:${clientIp(c.req.raw)}`, limit: 10, windowSeconds: 60,
  }]);
  const body = z.object({ code: z.string().trim().min(1).max(160) }).parse(await c.req.json());
  const userId = await consumeAppClipAuthCode(c, body.code);
  await createSession(c, userId);
  return c.json({ ok: true });
});

munetCallbackRouter.get("/", async (c) => {
  if (c.req.query("state")?.startsWith("appclip.")) {
    return finishAppClipCallback(c, "/callback");
  }
  const next = safePath(getCookie(c, oauthNextCookie));
  const fail = (message: string) => c.redirect(munetFailureReturn(next, message));
  const expected = getCookie(c, oauthStateCookie);
  deleteCookie(c, oauthStateCookie, { path: "/" });
  deleteCookie(c, oauthNextCookie, { path: "/" });
  if (c.req.query("error")) return fail("MuNET 授权已取消");
  const code = c.req.query("code");
  if (!code || !expected || c.req.query("state") !== expected) return fail("MuNET 授权无效，请重试");
  try {
    const munet = await finishMunetAuth({
      ...munetConfig(c), code, redirectUri: `${c.env.APP_ORIGIN}/callback`,
    });
    const { userId, isNewUser } = await provisionMunetUser(c, munet);
    await createSession(c, userId);
    return c.redirect(munetSuccessReturn(next, isNewUser));
  } catch (error) {
    console.error(error);
    return fail(error instanceof z.ZodError ? "MuNET 返回的数据无法识别"
      : error instanceof Error ? error.message : "MuNET 登录失败");
  }
});

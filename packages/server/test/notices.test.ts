import { describe, expect, it } from "bun:test";
import { clientNotices, errorNotice, notice, noticeCodes, requestLocale } from "../src/notices.js";
import { wrapApiResponse } from "../src/middleware/response-time.js";

describe("player notices", () => {
  it("picks English only when the player's first language is English", () => {
    expect(requestLocale("en-US,en;q=0.9,zh-CN;q=0.8")).toBe("en");
    expect(requestLocale("zh-Hans-CN;q=1, en-US;q=0.9")).toBe("zh");
    expect(requestLocale(undefined)).toBe("zh");
  });

  it("interrupts only for what went wrong, and keeps normal outcomes inline", () => {
    expect(notice("CARD_NOT_READ", "zh")).toMatchObject({ display: "inline", level: "error", body: "登录失败", actions: [] });
    for (const code of ["COIN_FAILED", "COIN_UNKNOWN", "COIN_SKIPPED"]) expect(notice(code, "zh").display).toBe("inline");
    expect(errorNotice({ code: "COIN_COOLDOWN", message: "请稍后再投币", status: 429 }, "zh").display).toBe("inline");
    const banned = errorNotice({ code: "ACCOUNT_BANNED", message: "这个账号暂时无法使用", status: 403 }, "zh");
    expect(banned).toMatchObject({ display: "inline", presentation: "status", level: "error", title: "账号已停用" });
    expect(banned.actions).toEqual([]);
  });

  it("classifies severity independently of presentation", () => {
    const news = ["DEVICE_POWER_OFF", "COIN_COOLDOWN", "COIN_SKIPPED", "CHECKIN_CONSENT_REQUIRED", "LOCATION_STILL_INSIDE", "REDEEM_CODE_NOT_ACTIVE", "PRESENT_ONCE_PER_PLAYER_REDEEMED", "SESSION_NOT_ACTIVE"];
    for (const code of news) expect(notice(code, "zh")).toMatchObject({ level: "info", display: "inline" });
    for (const code of ["CARD_SENT", "COIN_SENT", "PLAYER_OPTIONS_SAVED"]) expect(notice(code, "zh").level).toBe("success");
    const failed = ["DOOR_CODE_FAILED", "PRESENT_EXPIRED", "PLAYER_OPTION_FORBIDDEN", "CARD_NOT_FOUND", "COIN_FAILED", "LOCATION_OUT_OF_RANGE"];
    for (const code of failed) expect(notice(code, "zh")).toMatchObject({ level: "error", display: "inline" });
    for (const code of ["INSUFFICIENT_BALANCE", "LOCATION_REQUIRED", "DEVICE_RESULT_UNKNOWN", "REDEEM_CODE_NOT_FOUND"]) expect(notice(code, "zh")).toMatchObject({ level: "error", display: "dialog" });
    // A route's own wording for a refusal is an error the player sees in place.
    expect(errorNotice({ code: "SOMETHING", message: "这里不能这样做", status: 400 }, "zh")).toMatchObject({ level: "error", display: "inline" });
  });

  it("routes interruption, persistent conditions, fields, controls and transient results", () => {
    expect(notice("RATE_LIMITED", "zh")).toMatchObject({ display: "dialog", level: "info", actions: [{ kind: "dismiss", label: "知道了" }] });
    const groups = {
      status: ["DEVICE_UNAVAILABLE", "ACCOUNT_BANNED", "OPERATION_PENDING", "LOCATION_STILL_INSIDE", "PRICING_RELATION_CYCLE"],
      field: ["INVALID_REDEEM_CODE", "REDEEM_CODE_EXPIRED", "CHECKIN_CONSENT_REQUIRED"],
      control: ["COIN_COOLDOWN", "COIN_SENT", "COIN_UNKNOWN", "CARD_SENT"],
      toast: ["DOOR_CODE_FAILED", "LOCATION_LOW_ACCURACY", "PLAYER_OPTIONS_SAVED", "SESSION_NOT_ACTIVE"],
    };
    for (const [presentation, codes] of Object.entries(groups)) {
      for (const code of codes) expect(notice(code, "zh")).toMatchObject({ display: "inline", presentation });
    }
    expect(errorNotice({ code: "INTERNAL_ERROR", message: "internal", status: 500 }, "zh")).toMatchObject({ display: "inline", presentation: "toast" });
  });

  it("sends timing and client-failure instructions from the same catalog", () => {
    for (const code of noticeCodes()) {
      const item = notice(code, "zh");
      expect(item.controlDurationMs).toBeGreaterThan(0);
      expect(item.durationMs === null || typeof item.durationMs === "number").toBe(true);
      if (item.presentation === "status" || item.presentation === "field" || item.display !== "inline") expect(item.durationMs).toBeNull();
    }
    expect(notice("COIN_SENT", "zh")).toMatchObject({ durationMs: 3000, controlDurationMs: 3000 });
    expect(notice("COIN_FAILED", "zh")).toMatchObject({ durationMs: null, controlDurationMs: 5000 });
    const cached = clientNotices("en");
    for (const [code, item] of Object.entries(cached)) expect(item).toEqual(notice(code, "en"));
  });

  it("lets the client move on by itself where there is nothing to read", () => {
    expect(errorNotice({ code: "TICKET_EXPIRED", message: "本次会话已失效", status: 410 }, "zh")).toMatchObject({ display: "none", flow: "expired" });
    expect(errorNotice({ code: "CHECKIN_REQUIRED", message: "请先确认入场", status: 403 }, "zh")).toMatchObject({ display: "none", flow: "refresh" });
  });

  it("explains redeemed gifts and exhausted public codes without suggesting a retry", () => {
    expect(notice("PRESENT_ONCE_PER_PLAYER_REDEEMED", "zh")).toMatchObject({ body: "您已经领取过这份礼物", display: "inline", actions: [] });
    expect(notice("REDEEM_CODE_MAX_USE_REACHED", "zh")).toMatchObject({ body: "兑换码已被领完", display: "inline", actions: [] });
    expect(notice("PRESENT_GRANT_LIMIT_REACHED", "en")).toMatchObject({ body: "You have reached this gift's per-player limit.", actions: [] });
  });

  it("tells an operator why the cabinet could not be read", () => {
    expect(errorNotice({ code: "CABINET_READ_FAILED", message: "这台 IO 没有开启 cabinetMonitor", status: 409 }, "zh").body).toBe("这台 IO 没有开启 cabinetMonitor");
  });

  it("offers a retry only where trying again can help", () => {
    const device = errorNotice({ code: "DEVICE_UNAVAILABLE", message: "设备连接失败", status: 502 }, "en");
    expect(device).toMatchObject({ display: "inline", presentation: "status", actions: [] });
    // A weak fix is retried by tapping again, right where the player is.
    const location = errorNotice({ code: "LOCATION_LOW_ACCURACY", message: "定位精度不足，请重试", status: 403 }, "en");
    expect(location).toMatchObject({ display: "inline", actions: [], body: "Location not precise enough. Retry." });
  });

  it("keeps a route's own Chinese wording but never shows developer text or faults", () => {
    expect(errorNotice({ code: "SOMETHING_NEW", message: "请先在后台开通", status: 409 }, "zh")).toMatchObject({ body: "请先在后台开通", display: "inline" });
    expect(errorNotice({ code: "REDEEM_THING", message: "Redeem code batch exhausted.", status: 400 }, "zh").body).toBe("操作失败，请稍后重试");
    expect(errorNotice({ code: "INTERNAL_ERROR", message: "数据库超时", status: 500 }, "zh").body).toBe("操作失败，请稍后重试");
  });

  it("is attached to every wrapped error, with the player text also in message", async () => {
    const wrapped = await wrapApiResponse(
      Response.json({ error: { code: "INSUFFICIENT_BALANCE", message: "Insufficient currency holdings for this operation." } }, { status: 409 }),
      "UTC",
      "zh",
    );
    const body = (await wrapped.json()) as { error: { code: string; message: string; reason?: string; notice: { body: string; title: string } } };
    expect(body.error.code).toBe("INSUFFICIENT_BALANCE");
    expect(body.error.message).toBe(body.error.notice.body);
    expect(body.error.notice.title).toBe("余额不足");
    expect(body.error.reason).toBe("Insufficient currency holdings for this operation.");
  });
});

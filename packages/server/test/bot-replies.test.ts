import { describe, expect, it } from "bun:test";
import { botMessageText } from "@prism/core";
import {
  deviceActionMessage,
  deviceStatesMessage,
  errorReply,
  receiptMessage,
  settledAsPreview,
  walletMessage,
} from "../src/resources/bot-replies.js";

const who = { player: { playerId: "player-1", displayName: "Tester", identities: [] }, provider: "onebot", subject: "123456" };
const text = botMessageText;

describe("what a bot says for a bill", () => {
  it("words a preview as the plugin did, naming the player as a segment", () => {
    const view = {
      settlementPreview: { playerId: "player-1", subtotal: 25, total: 22, previewedAt: "2026-06-07T19:00:00.000Z" },
      sessionPreviews: [{ label: "音游区间", startedAt: "2026-06-07T18:00:00.000Z", endedAt: "2026-06-07T19:00:00.000Z", status: "closed", total: 22, adjustments: [{ label: "月卡折扣", amount: -3 }] }],
      checkoutAdjustments: [{ label: "月卡折扣", amount: -3 }],
      pricingCapAdjustments: [],
      globalCapWindows: [],
      wallet: { balanceBefore: 100, balanceAfter: 78 },
    };
    const message = receiptMessage(view, { title: "【结算账单】", preview: true, currency: "猫粮", who, timeZone: "UTC" });
    expect(message[1]).toEqual({ player: who.player });
    expect(text(message)).toBe("【结算账单】\n玩家：Tester（onebot:123456）\n⏰ 游玩时间：18:00–19:00（UTC+00:00）\n\n音游区间\n游玩时段：18:00-19:00\n游玩时长：1小时0分钟｜计价：22猫粮\n  └ 月卡折扣：-3猫粮\n\n计费总价：25猫粮\n\n月卡折扣：-3猫粮\n\n优惠后价格：22猫粮\n当前余额：100猫粮\n预计结账后余额：78猫粮");
  });

  it("words a settled checkout with its caps, at the shop's clock", () => {
    const cap = (id: string, label: string, amount: number) => ({ id, source: `time.cap:${id}`, label, amount, pricingCapHistory: {} });
    const settled = {
      playerSettlement: { playerId: "player-1", subtotal: 111, total: 67 },
      settlements: [
        { settlement: { label: "🎵 音乐游戏", startedAt: "2026-07-10T07:28:00.000Z", endedAt: "2026-07-10T12:42:00.000Z", subtotal: 66 }, adjustments: [] },
        { settlement: { label: "🀄️ 麻将", startedAt: "2026-07-10T11:25:00.000Z", endedAt: "2026-07-10T12:19:00.000Z", subtotal: 3 }, adjustments: [cap("day", "日间", -39)] },
      ],
      checkoutAdjustments: [],
      pricingCapAdjustments: [cap("day", "日间", -39), cap("night", "夜间", -5)],
      globalCapWindows: [
        { ruleLabel: "日间", windowStartedAt: "2026-07-10T02:00:00.000Z", currentAmount: 81, amountApplied: 42, priceCap: 69, paidBefore: 27 },
        { ruleLabel: "夜间", windowStartedAt: "2026-07-11T14:00:00.000Z", currentAmount: 30, amountApplied: 25, priceCap: 79, paidBefore: 54 },
      ],
      wallet: { balanceBefore: 252, balanceAfter: 185 },
    };
    expect(text(receiptMessage(settledAsPreview(settled), { title: "✅ 退场成功 · 结算账单", preview: false, currency: "猫粮", who, timeZone: "Asia/Shanghai" })))
      .toBe("✅ 退场成功 · 结算账单\n玩家：Tester（onebot:123456）\n⏰ 游玩时间：15:28–20:42（UTC+08:00）\n\n🎵 音乐游戏\n游玩时段：15:28-20:42\n游玩时长：5小时14分钟｜计价：66猫粮\n\n🀄️ 麻将\n游玩时段：19:25-20:19\n游玩时长：54分钟｜计价：3猫粮\n\n封顶：\n- 07-10 日间：81 → 42猫粮（上限69，已计27）\n- 07-11 夜间：30 → 25猫粮（上限79，已计54）\n\n计费总价：67猫粮\n扣款后余额：185猫粮");
  });

  it("says when nothing was charged", () => {
    const view = { settlementPreview: { subtotal: 0, total: 0 }, sessionPreviews: [], checkoutAdjustments: [], wallet: { balanceBefore: 10, balanceAfter: 10 } };
    expect(text(receiptMessage(view, { title: "【结算账单】", preview: true, currency: "猫粮", who, timeZone: "UTC" })))
      .toBe("【结算账单】\n玩家：Tester（onebot:123456）\n\n本次未产生费用\n余额：10猫粮");
  });
});

describe("what a bot says for the rest", () => {
  it("sums a wallet", () => {
    expect(text(walletMessage([{ assetCode: "paid", quantity: 3 }, { assetCode: "free", quantity: 2 }], "猫粮")))
      .toBe("💰 --- 钱包余额 ---\n可用: 5 猫粮 (共 5)\n  - 付费: 3\n  - 免费: 2");
  });

  it("says a device action was done, or why not", () => {
    expect(text(deviceActionMessage({ status: "acked", payload: { deviceLabel: "舞萌" } }, { type: "coin", ref: "m", count: 2 }))).toBe("🪙 舞萌 投币成功（2 币）");
    expect(text(deviceActionMessage({ status: "expired", payload: { executorFailure: { message: "机台未在线" } } }, { type: "power.on", ref: "m" }))).toBe("启动失败，设备未连接");
    expect(text(deviceActionMessage({ status: "acked", executorKind: "ttlock", payload: { temporaryPassword: "1234" } }, { type: "door.open", ref: "d" }))).toBe("🔑 临时门锁密码：1234\n有效期：3 分钟");
    expect(text(deviceActionMessage({ status: "rejected", payload: {} }, { type: "door.open", ref: "d", onEntry: true }))).toBe("🔑 门锁临时密码没有生成，可以在入场后用 lock 再取一次");
  });

  it("uses result-specific device templates without hiding failures or door expiry", () => {
    const templates = { "coin.success": "{device} 已投 {count} 币", "coin.error": "请找店员：{reason}", "lock.success": "请勿转发\n{result}" };
    expect(text(deviceActionMessage({ status: "acked", payload: { deviceLabel: "舞萌" } }, { type: "coin", ref: "m", count: 2 }, templates))).toBe("舞萌 已投 2 币");
    expect(text(deviceActionMessage({ status: "pending", payload: {} }, { type: "coin", ref: "m" }, templates))).toContain("请找店员：投币失败");
    const door = text(deviceActionMessage({ status: "acked", executorKind: "ttlock", payload: { temporaryPassword: "1234" } }, { type: "door.open", ref: "d" }, templates));
    expect(door).toBe("请勿转发\n🔑 临时门锁密码：1234\n有效期：3 分钟");
    expect(text(walletMessage([{ assetCode: "paid", quantity: 3.5 }, { assetCode: "free", quantity: 2 }], "猫粮", { "wallet.success": "可用 {balance} {currency}，付费 {paid}，赠送 {free}" }))).toBe("可用 5.5 猫粮，付费 3.5，赠送 2");
  });

  it("says each device's power, or that nothing has the name asked for", () => {
    const states = [{ deviceId: "m1", label: "舞萌", state: "on" }, { deviceId: "m2", label: "中二", state: "off" }, { deviceId: "m3", label: "", state: "unknown" }];
    expect(text(deviceStatesMessage(states))).toBe("舞萌：🟢 开机\n中二：⚫ 关机\nm3：❔ 未知");
    expect(text(deviceStatesMessage([], "nope"))).toBe("找不到设备: nope");
    expect(text(deviceStatesMessage([]))).toBe("没有找到任何设备状态。");
  });

  it("answers a refusal by the command it refused", () => {
    const refused = (command: string, args: string[], code: string, message = "") =>
      text(errorReply(command, args, { code, message, status: 409 }, "https://prism.test/t/shop"));
    expect(refused("scan", ["mai"], "SCAN_IDENTITY_NOT_BOUND_TO_PLAYER")).toBe("刷卡失败，玩家未绑定 Aime 卡");
    expect(refused("off", ["mai"], "DEVICE_NOT_FOUND")).toBe("关闭失败，没有这个设备");
    expect(refused("上桌", ["a"], "MAHJONG_TABLE_FULL")).toBe("「a」已满桌，请等待本局结束后再上桌。");
    expect(refused("logout", [], "INSUFFICIENT_BALANCE")).toBe("余额不足，暂时不能结账。请先充值，或由店员在后台改价后再结账。");
    expect(refused("wallet", [], "SOMETHING_INTERNAL", "stack trace")).toBe("操作失败，请稍后再试。");
    expect(refused("bind", ["X"], "BINDING_CODE_EXPIRED", "验证码已失效，请重新生成")).toBe("验证码已失效，请重新生成");
    expect(refused("login", [], "LOCATION_REQUIRED")).toBe("请在网页完成到店校验：https://prism.test/t/shop");
  });
});

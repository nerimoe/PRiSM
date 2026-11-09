import { shopAnnouncementCatalog } from "./shop-announcements";
import { botMessage, type BotMessage, type BotMessagePlayer } from "./bot-message";

export type BotReplyTemplate = {
  key: string;
  label: string;
  text: string;
  samples: Record<string, string>;
  required: string[];
};

const reply = (key: string, label: string, text: string, samples: Record<string, string> = {}, required: string[] = []): BotReplyTemplate =>
  ({ key, label, text, samples, required });
// shortcut: complex replies keep system blocks; expose individual fields when merchants need to edit their contents.
const block = (key: string, label: string, variable: string, sample: string) =>
  reply(key, label, `{${variable}}`, { [variable]: sample }, [variable]);

export const botReplyCommands = [
  ["bind", "绑定"], ["login", "入场"], ["logout", "退场"], ["billing", "账单"],
  ["wallet", "钱包"], ["items", "物品"], ["history", "历史记录"], ["redeem", "兑换"],
  ["add", "增加余额"], ["del", "扣除余额"], ["overwrite", "调价结账"],
  ["list", "查人"], ["show", "设备状态"], ["麻将列表", "麻将列表"],
  ["上桌", "上桌"], ["下桌", "下桌"], ["lock", "开门"], ["on", "开机"],
  ["off", "关机"], ["keep", "延迟关机"], ["coin", "投币"], ["scan", "刷卡"],
] as const;

export const canonicalBotCommand = (name: string): string =>
  ({ "prism.bind": "bind", "入场": "login", mahjong: "上桌" } as Record<string, string>)[name] ?? name;

export const botReplyTemplates: BotReplyTemplate[] = [
  reply("bind.success", "绑定成功", "绑定成功，请返回网页继续操作"),
  reply("login.success", "入场成功", "✅ 入场成功{stopped}", { stopped: "\n结束方案：旧方案" }, ["stopped"]),
  reply("login.already", "已入场", "您已在{plan}中，无需重复入场", { plan: "「音游区」" }, ["plan"]),
  block("login.behalf", "代玩家入场", "result", "✅ 已为用户 小明（onebot:12345） 入场成功"),
  block("login.behalfAlready", "代玩家重复入场", "result", "用户 小明（onebot:12345） 已在「音游区」中，无需重复入场"),
  reply("login.free", "无需入场", "这里不计费，无需入场"),
  reply("wallet.success", "钱包余额", "💰 --- 钱包余额 ---\n可用: {balance} {currency} (共 {balance})\n  - 付费: {paid}\n  - 免费: {free}", { balance: "100", currency: "猫粮", paid: "80", free: "20" }, ["balance", "currency"]),
  ...["billing", "logout", "overwrite"].map(key => block(`${key}.success`, "账单内容", "receipt", "【结算账单】\n玩家：小明\n计费总价：20猫粮\n扣款后余额：80猫粮")),
  ...[["items", "物品列表", "🎒 --- 您拥有的物品 ---\n- 免费券 (x1)"], ["history", "历史记录", "📜 最近 1 条记录：\n- 2026/11/09 12:00 → 14:00 (20 猫粮)"], ["redeem", "兑换成功", "✅ 兑换成功！您获得了以下物品：\n- 免费券 x1"], ["add", "增加余额", "✅ 已为用户 小明 增加 10 猫粮"], ["del", "扣除余额", "✅ 已为用户 小明 扣除 10 猫粮"], ["list", "玩家列表", "[总计 1 人]\n音游区：小明"], ["show", "设备状态", "舞萌：🟢 开机"], ["麻将列表", "桌位列表", "🀄️ 麻将机列表（1 台）\n- A桌｜空闲"], ["上桌", "加入桌位", "已加入 A桌，当前 1/4 人，满 4 人开始计费。"], ["下桌", "离开桌位", "已离开 A桌，麻将计费已停止。\n仍在计费：音游区"]].map(([key, label, sample]) => block(`${key}.success`, label!, "result", sample!)),
  reply("items.empty", "没有物品", "您当前没有任何物品。"),
  reply("history.empty", "没有记录", "暂无历史记录"),
  reply("redeem.empty", "未获得物品", "兑换成功，但没有获得任何物品。"),
  ...[["on", "✅ {device} 启动成功"], ["off", "🛑 {device} 关闭成功"], ["keep", "✅ {device} 已延迟关机"], ["coin", "🪙 {device} 投币成功（{count} 币）"], ["scan", "💳 {device} 刷卡成功"]].map(([key, text]) => reply(`${key}.success`, "操作成功", text!, key === "coin" ? { device: "舞萌", count: "2" } : { device: "舞萌" }, key === "coin" ? ["device", "count"] : ["device"])),
  block("lock.success", "开门结果／临时密码", "result", "🔑 临时门锁密码：123456\n有效期：3 分钟"),
  block("lock.error", "开门失败", "reason", "🔑 开门失败，设备未连接"),
  ...botReplyCommands.flatMap(([key]) => [
    block(`${key}.notice`, "参数／权限提示", "reason", "请指定玩家"),
    ...(key === "lock" ? [] : [block(`${key}.error`, "操作失败", "reason", "操作失败，玩家未入场")]),
  ]),
];

export const botAnnouncementTemplates: BotReplyTemplate[] = [
  ...[
    ["power.on", "✅ {device} 已开机"], ["power.off", "🛑 {device} 已关机"],
    ["request.power.on", "✅ {player} 通过平台开启了 {device}"],
    ["request.power.off", "🛑 {player} 通过平台关闭了 {device}"],
    ["request.power.idle_off", "💤 {device} 闲置，已自动关机"],
    ["card", "💳 {player} 在 {device} 刷卡"], ["start", "🎮 {player} 在 {device} 上机"],
    ["request.card", "💳 {player} 通过平台在 {device} 刷卡"],
    ["request.coin", "🪙 {player} 在 {device} 投币"],
    ["cabinet.coin", "🪙 {device} 投币 {coins} 个，当前 {credit} 币"],
    ["cabinet.consumed", "🎮 {device} 开局消耗 {credits} 币，剩余 {credit} 币"],
    ["cabinet.reset", "🧾 {device} 投币计数已清零"],
  ].map(([type, text]) => {
    const samples: Record<string, string> = { device: "舞萌", player: "小明", coins: "2", credits: "1", credit: "3" };
    const variables = [...text!.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]!);
    return reply(`announce.${type}.message`, shopAnnouncementCatalog.find(item => item.type === type)!.label,
      text!, Object.fromEntries(variables.map(key => [key, samples[key]!])), variables);
  }),
  reply("announce.idle.reminder.shop_empty", "店内无人", "店里没人，{minutes} 分钟后全部关机", { minutes: "5" }, ["minutes"]),
  reply("announce.idle.reminder.device_idle", "设备闲置", "{devices} 闲置中，{minutes} 分钟后关机。已入场的玩家发送 keep 设备名 可以延迟", { devices: "舞萌、中二", minutes: "5" }, ["devices", "minutes"]),
];

/** Only named placeholders; no executable expressions or chat element markup. */
export function botReplyTemplateError(key: string, text: string): string | null {
  const definition = botReplyTemplates.find(item => item.key === key) ?? botAnnouncementTemplates.find(item => item.key === key);
  if (!definition) return "未知回复场景";
  if (text.length > 2000) return "回复模板最多 2000 字";
  if (!text.trim()) return null;
  if (/[<>]/.test(text)) return "回复模板仅支持纯文本，不支持消息标签";
  const variables = [...text.matchAll(/\{([^{}]*)\}/g)].map(match => match[1]!);
  if (/[{}]/.test(text.replace(/\{[^{}]*\}/g, ""))) return "变量括号不完整";
  const unknown = variables.find(variable => !Object.hasOwn(definition.samples, variable));
  if (unknown !== undefined) return `未知变量：{${unknown}}`;
  const missing = definition.required.find(variable => !variables.includes(variable));
  return missing ? `需要保留 {${missing}}` : null;
}

export function renderBotReplyTemplate(
  key: string, templates: Record<string, string> | undefined, fallback: BotMessage,
  values: Record<string, string | BotMessagePlayer | BotMessage> = {},
): BotMessage {
  const text = templates?.[key];
  if (!text?.trim() || botReplyTemplateError(key, text)) return fallback;
  const parts: Array<string | BotMessagePlayer | BotMessage> = [];
  let start = 0;
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    const value = values[match[1]!];
    if (value === undefined) return fallback;
    parts.push(text.slice(start, match.index), value);
    start = match.index! + match[0].length;
  }
  return botMessage(...parts, text.slice(start));
}

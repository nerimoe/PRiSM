import type { Locale } from "../notices.js";

const EN: Record<string, string> = {
  "这里没有可操作的设备": "Nothing to operate here",
  "你在本店的玩家资格已停用，请联系店员": "Your membership at this shop is suspended. Please ask the staff.",
  "暂时无法使用": "Not available right now",
  "计费规则": "Pricing",
  "跨方案封顶": "Combined cap",
  "确认后结束": "Ends when you confirm",
  "新增": "New",
  "保留": "Kept",
  "单次收取": "Flat fee",
  "不计费": "Not billed",
  "未覆盖": "Not covered",
  "不封顶": "Uncapped",
  "已达封顶": "Cap reached",
  "累计": "So far",
  "封顶": "Cap",
  "分钟": "min",
  "确认开始计费，离店前请结账。关闭页面不会停止计费。": "Billing starts when you confirm. Please check out before you leave; closing this page does not stop billing.",
  "确认": "Confirm",
  "入场并获取开门密码": "Enter and get door code",
  "获取开门密码": "Get door code",
  "重新获取密码": "Get a new code",
  "开门密码": "Door code",
  "有效期至": "Valid until",
  "在门锁上输入密码后按 #": "Enter the code on the lock, then press #",
  "设备尚未开机": "The device is off",
  "开机": "Turn on",
  "未检测到开机，请重试": "Power-on not detected. Retry.",
  "桌游": "Tabletop",
  "桌游计费中": "Billing",
  "等待玩家": "Waiting for players",
  "空位": "Empty",
  "你": "You",
  "已满桌": "The table is full",
  "上桌": "Sit down",
  "下桌": "Leave the table",
  "等待机台连接": "Waiting for the machine to connect",
  "投币": "Insert coin",
  "达到机台投币上限": "Coin limit reached",
  "选择卡片": "Select a card",
  "添加卡片": "Add card",
  "刷新": "Refresh",
  "正在加载卡片": "Loading cards",
  "无法加载卡片": "Could not load cards",
  "还没有可用卡片，请先添加卡片": "No cards available. Add a card first.",
  "还没有可用卡片": "No cards available.",
  "确认位置…": "Checking location…",
  "正在登录…": "Signing in…",
  "尾号 {digits}": "Ending in {digits}",
  "正在连接机台…": "Connecting to the cabinet…",
  "取消": "Cancel",
  "完成": "Done",
  "离开页面后已取消添加，请重新添加": "Adding was cancelled because you left the page. Please try again.",
  "已添加卡片": "Card added",
  "这张卡已绑定到本店的其他玩家": "This card belongs to another player here",
  "不支持这种卡片": "This kind of card is not supported",
  "没有读到卡片": "No card was read",
  "使用 MuNET 登录": "Sign in with MuNET",
  "正在连接 MuNET…": "Connecting to MuNET…",
  "使用 Passkey 登录": "Sign in with a passkey",
  "正在验证 Passkey…": "Verifying passkey…",
  "当前浏览器不支持 Passkey，请使用 MuNET 登录": "This browser does not support passkeys. Sign in with MuNET.",
  "绑定平台身份": "Link a platform identity",
  "向店铺 Bot 发送": "Send to this shop’s bot",
  "复制": "Copy",
  "已复制": "Copied",
  "重试": "Retry",
  "空调": "Air conditioner",
  "空调状态未知": "Air conditioner state unknown",
  "已关闭": "Off",
  "开空调": "Turn on",
  "关空调": "Turn off",
  "设定温度": "Set temperature",
  "调低温度": "Lower temperature",
  "调高温度": "Raise temperature",
  "模式": "Mode",
  "风速": "Fan speed",
  "制冷": "Cool",
  "制热": "Heat",
  "除湿": "Dry",
  "送风": "Fan",
  "自动": "Auto",
  "自动冷暖": "Heat/cool",
  "静音": "Quiet",
  "低风": "Low",
  "中风": "Medium",
  "高风": "High",
  "强劲": "Turbo",
};

export type Translate = (text: string) => string;

/** Page text is written in Chinese; this puts it in the player's language. */
export const translator = (locale: Locale): Translate => (text: string) => (locale === "en" ? EN[text] ?? text : text);

export function renderBindingPromptLines(
  locale: Locale,
  template: string | null | undefined,
  code: string,
): Array<{ text: string; command: boolean }> {
  const t = translator(locale);
  const lines = (template ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return [
      { text: t("向店铺 Bot 发送"), command: false },
      { text: `bind ${code}`, command: true },
    ];
  }
  const rendered = lines.map((line) =>
    line.includes("{code}")
      ? { text: line.split("{code}").join(code), command: true }
      : { text: line, command: false },
  );
  return rendered.some((line) => line.command)
    ? rendered
    : [...rendered, { text: `bind ${code}`, command: true }];
}

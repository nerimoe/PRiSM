import { expect, it } from "bun:test";
import { botMessage, botMessageText, botReplyTemplates, botAnnouncementTemplates, shopAnnouncementCatalog, botReplyTemplateError, canonicalBotCommand, renderBotReplyTemplate } from "../src/index";

it("validates every catalog default and rejects unsupported or missing variables", () => {
  expect(new Set([...botReplyTemplates, ...botAnnouncementTemplates].map(item => item.key)).size).toBe(botReplyTemplates.length + botAnnouncementTemplates.length);
  for (const item of [...botReplyTemplates, ...botAnnouncementTemplates]) expect(botReplyTemplateError(item.key, item.text)).toBeNull();
  for (const text of ["{balnce}", "{balance", "{balance} {currency} {}", "<at id='all'/>", "x".repeat(2001)])
    expect(botReplyTemplateError("wallet.success", text)).not.toBeNull();
  expect(botReplyTemplateError("billing.success", "谢谢惠顾")).toContain("{receipt}");
  expect(botReplyTemplateError("lock.error", "没事了")).toContain("{reason}");
  expect(botReplyTemplateError("not.a.scene", "hello")).not.toBeNull();
});

it("substitutes once, retains player segments and falls back safely", () => {
  const player = { playerId: "p1", displayName: "小明{result}", identities: [] };
  const result = botMessage(player, "：已入场");
  const rendered = renderBotReplyTemplate("login.behalf", { "login.behalf": "欢迎！{result}" }, result, { result });
  expect(rendered[1]).toEqual({ player });
  expect(botMessageText(rendered)).toBe("欢迎！小明{result}：已入场");
  for (const templates of [undefined, {}, { "login.behalf": "  " }, { "login.behalf": "{unknown}" }] as Array<Record<string, string> | undefined>)
    expect(renderBotReplyTemplate("login.behalf", templates, result, { result })).toEqual(result);
  expect(renderBotReplyTemplate("login.behalf", { "login.behalf": "{result}" }, result)).toEqual(result);
  expect(canonicalBotCommand("入场")).toBe("login");
  expect(canonicalBotCommand("prism.bind")).toBe("bind");
  expect(canonicalBotCommand("mahjong")).toBe("上桌");
});

it("covers every announcement type, including both idle reminder reasons", () => {
  for (const item of shopAnnouncementCatalog)
    expect(botAnnouncementTemplates.some(template => template.key.startsWith(`announce.${item.type}.`))).toBe(true);
  expect(botReplyTemplateError("announce.card.message", "{device}：{player}")).toBeNull();
  expect(botReplyTemplateError("announce.idle.reminder.shop_empty", "快关机了")).toContain("{minutes}");
});

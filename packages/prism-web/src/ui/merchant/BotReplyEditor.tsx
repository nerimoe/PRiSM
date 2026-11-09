import { useId, useState } from "react";
import { botMessage, botMessageText, botAnnouncementTemplates, shopAnnouncementCatalog, botReplyCommands, botReplyTemplates, botReplyTemplateError, renderBotReplyTemplate } from "@prism/core";
import { useI18n } from "../../i18n";
import { buttonQuiet, input } from "./shared";

export function BotReplyEditor({ value, onChange, announcements = false }: { announcements?: boolean; value: Record<string, string>; onChange: (value: Record<string, string>) => void }) {
  const { t } = useI18n();
  const helpId = useId();
  const commands: ReadonlyArray<readonly [string, string]> = announcements
    ? shopAnnouncementCatalog.map(item => [`announce.${item.type}`, item.label] as const) : botReplyCommands;
  const catalog = announcements ? botAnnouncementTemplates : botReplyTemplates;
  const [command, setCommand] = useState<string>(commands[0]![0]);
  const [scene, setScene] = useState("bind.success");
  const choices = catalog.filter(item => item.key.startsWith(`${command}.`));
  const definition = choices.find(item => item.key === scene) ?? choices[0]!;
  const text = value[definition.key] ?? "";
  const error = botReplyTemplateError(definition.key, text);
  const change = (text: string) => {
    const next = { ...value };
    if (text.trim()) next[definition.key] = text;
    else delete next[definition.key];
    onChange(next);
  };
  const preview = renderBotReplyTemplate(definition.key, { [definition.key]: text || definition.text }, botMessage(definition.text), definition.samples);
  return (
    <section aria-label={t(announcements ? "播报消息" : "命令回复")} className="grid gap-3">
      <h4 className="text-sm font-semibold">{t(announcements ? "播报消息" : "命令回复")}</h4>
      <div className="grid gap-3">
        <p className="text-xs text-ink/55">{t("仅修改当前 Bot 的消息。留空使用系统默认；预览为示例数据，保存资源后生效。")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">{t(announcements ? "播报类型" : "命令")}
            <select aria-label={t(announcements ? "播报类型" : "命令")} className={input} value={command} onChange={event => { setCommand(event.target.value); setScene(""); }}>
              {commands.map(([key, label]) => <option key={key} value={key}>{t(label)}{!announcements && ` · ${key}`}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">{t("回复场景")}
            <select aria-label={t("回复场景")} className={input} value={definition.key} onChange={event => setScene(event.target.value)}>
              {choices.map(item => <option key={item.key} value={item.key}>{t(item.label)}{value[item.key] ? ` · ${t("已修改")}` : ""}</option>)}
            </select>
          </label>
        </div>
        <label className="grid gap-2 text-sm">{t("回复内容")}
          <textarea aria-label={t("回复内容")} key={definition.key} className={`${input} min-h-32 font-mono`} maxLength={2000} value={text} placeholder={definition.text}
            aria-invalid={!!error} aria-describedby={helpId} onChange={event => change(event.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonQuiet} onClick={() => change(definition.text)}>{t("填入默认模板")}</button>
          <button type="button" className={buttonQuiet} onClick={() => change("")}>{t("恢复默认")}</button>
          {Object.keys(definition.samples).map(variable => <button key={variable} type="button" className={buttonQuiet}
            onClick={() => change(`${text || definition.text}{${variable}}`)}>{`{${variable}}`}</button>)}
        </div>
        <p id={helpId} className="text-xs text-ink/55">{t("点击变量按钮可插入变量。")}{definition.required.length > 0 && ` ${t("必须保留：")}${definition.required.map(variable => `{${variable}}`).join("、")}`}</p>
        {error && <p role="alert" className="text-sm text-coral">{error}</p>}
        <span className="text-sm font-medium">{t("回复预览")}</span>
        <div className="whitespace-pre-wrap break-words rounded-lg bg-ink/5 p-3 text-sm">{error ? t("请先修正模板") : botMessageText(preview)}</div>
      </div>
    </section>
  );
}

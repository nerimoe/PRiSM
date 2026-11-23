import { useId, useState } from "react";
import { botMessage, botMessageText, botReplyCommands, botReplyTemplates, botReplyTemplateError, renderBotReplyTemplate } from "@prism/core";
import { useI18n } from "../../i18n";
import { button, input } from "./shared";

export function BotReplyEditor({ value, onChange }: { value: Record<string, string>; onChange: (value: Record<string, string>) => void }) {
  const { t } = useI18n();
  const helpId = useId();
  const templateId = useId();
  const commands: ReadonlyArray<readonly [string, string]> = botReplyCommands;
  const catalog = botReplyTemplates;
  const [command, setCommand] = useState<string>(commands[0]![0]);
  const [scene, setScene] = useState("bind.success");
  const choices = catalog.filter(item => item.key.startsWith(`${command}.`));
  const definition = choices.find(item => item.key === scene) ?? choices[0]!;
  const text = value[definition.key] ?? "";
  const hasCustom = !!text.trim();
  const error = botReplyTemplateError(definition.key, text);
  const change = (nextText: string) => {
    const next = { ...value };
    if (nextText.trim()) next[definition.key] = nextText;
    else delete next[definition.key];
    onChange(next);
  };
  const preview = renderBotReplyTemplate(definition.key, { [definition.key]: text || definition.text }, botMessage(definition.text), definition.samples);
  const presetBtn = `${button} !min-h-8 !rounded-lg !px-3 !py-1 !text-xs`;
  const paneScroll = "sm:max-h-[calc(90dvh-14rem)] sm:overflow-y-auto sm:overscroll-contain";
  return (
    <section aria-label={t("命令回复")} className="grid gap-3">
      <p className="text-xs leading-relaxed text-ink/55">
        {t("仅修改当前 Bot 的消息。留空使用系统默认；预览为示例数据，保存资源后生效。")}
      </p>
      <div className="grid overflow-hidden rounded-2xl border border-ink/10 bg-panel sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-stretch sm:divide-x sm:divide-ink/10">
        <nav aria-label={t("命令")} className={`grid content-start gap-1 p-2.5 ${paneScroll}`}>
          <div className="px-2.5 py-1 text-xs font-medium text-ink/50">{t("命令")}</div>
          {commands.map(([key, label]) => {
            const active = command === key;
            const customized = Object.keys(value).some(k => k.startsWith(`${key}.`) && !!value[k]?.trim());
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setCommand(key);
                  const first = catalog.find(item => item.key.startsWith(`${key}.`));
                  if (first) setScene(first.key);
                }}
                className={`focus-ring flex items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-sm transition-colors ${
                  active ? "bg-mint/10 font-semibold text-ink" : "text-ink/70 hover:bg-ink/[0.04] hover:text-ink"
                }`}
              >
                <span className="truncate">{t(label)}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {customized && <span className="size-1.5 rounded-full bg-mint" aria-label={t("已自定义")} />}
                  <code className="font-mono text-[11px] font-normal text-ink/45">{key}</code>
                </span>
              </button>
            );
          })}
        </nav>
        <div className={`grid min-w-0 content-start gap-3.5 bg-ink/[0.01] p-4 ${paneScroll}`}>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-ink/55">{t("回复场景")}</span>
            <div role="tablist" aria-label={t("回复场景")} className="flex flex-wrap gap-1.5">
              {choices.map(item => {
                const active = item.key === definition.key;
                const sceneCustom = !!value[item.key]?.trim();
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setScene(item.key)}
                    className={`focus-ring inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs transition-colors ${
                      active
                        ? "border-mint bg-mint/[0.10] font-semibold text-ink"
                        : "border-ink/10 bg-panel text-ink/70 hover:bg-ink/[0.03] hover:text-ink"
                    }`}
                  >
                    <span>{t(item.label)}</span>
                    {sceneCustom && <span className="size-1.5 rounded-full bg-mint" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="bill-entry !mb-0 grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor={templateId} className="text-sm font-medium">{t("回复内容")}</label>
              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" className={presetBtn} onClick={() => change(definition.text)}>{t("填入默认模板")}</button>
                <button type="button" className={presetBtn} onClick={() => change("")}>{t("恢复默认")}</button>
              </div>
            </div>
            <textarea
              id={templateId}
              aria-label={t("回复内容")}
              key={definition.key}
              className={`${input} min-h-32 font-mono font-normal`}
              maxLength={2000}
              value={text}
              placeholder={definition.text}
              aria-invalid={!!error}
              aria-describedby={helpId}
              onChange={event => change(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {Object.keys(definition.samples).map(variable => (
                <button
                  key={variable}
                  type="button"
                  className="focus-ring rounded-lg border border-ink/15 bg-panel px-2 py-1 font-mono text-xs transition-colors hover:border-mint/50 hover:bg-mint/10"
                  onClick={() => change(`${text || definition.text}{${variable}}`)}
                >
                  {`{${variable}}`}
                </button>
              ))}
            </div>
            <p id={helpId} className="text-xs text-ink/55">
              {t("点击变量按钮可插入变量。")}
              {definition.required.length > 0 && ` ${t("必须保留：")}${definition.required.map(variable => `{${variable}}`).join("、")}`}
            </p>
            {error && <p role="alert" className="text-sm text-coral">{error}</p>}
          </div>
          <div className="bill-entry !mb-0 grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{t("回复预览")}</span>
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                hasCustom ? "bg-mint/15 text-[#23815d] dark:text-emerald-400" : "bg-ink/[0.06] text-ink/60"
              }`}>
                {t(hasCustom ? "已自定义" : "默认模板")}
              </span>
            </div>
            <div
              aria-label={t("回复预览")}
              className="whitespace-pre-wrap break-words rounded-xl border border-ink/10 bg-panel p-3.5 text-sm leading-relaxed text-ink/85"
            >
              {error ? t("请先修正模板") : botMessageText(preview)}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

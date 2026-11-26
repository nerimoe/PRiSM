import { useId, useState } from "react";
import {
  botMessage,
  botMessageText,
  botReplyCommands,
  botReplyTemplates,
  botReplyTemplateError,
  renderBotReplyTemplate,
  type BotReplyGroup,
} from "@prism/core";
import { useI18n } from "../../i18n";
import { Field, button, input, useMerchant } from "./shared";

const newReplyGroup = (groups: readonly BotReplyGroup[]): BotReplyGroup => ({
  id: `reply-${Date.now().toString(36)}`,
  name: `回复组 ${groups.length + 1}`,
  to: [],
  ignorePrivacyMode: false,
  templates: {},
});

export function BotReplyEditor({
  value,
  onChange,
  groups = [],
  onGroupsChange,
  privacyModeEnabled: privacyModeProp,
}: {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  groups?: BotReplyGroup[];
  onGroupsChange?: (groups: BotReplyGroup[]) => void;
  privacyModeEnabled?: boolean;
}) {
  const { t } = useI18n();
  const merchant = useMerchant();
  const privacyModeEnabled = privacyModeProp ?? merchant.privacyModeEnabled;
  const helpId = useId();
  const templateId = useId();
  const commands: ReadonlyArray<readonly [string, string]> = botReplyCommands;
  const catalog = botReplyTemplates;
  const [activeTab, setActiveTab] = useState<string>("__default__");
  const [command, setCommand] = useState<string>(commands[0]![0]);
  const [scene, setScene] = useState("bind.success");
  const group = activeTab !== "__default__" ? groups.find((one) => one.id === activeTab) : undefined;
  const choices = catalog.filter(item => item.key.startsWith(`${command}.`));
  const definition = choices.find(item => item.key === scene) ?? choices[0]!;
  const activeTemplates = group ? group.templates : value;
  const defaultTemplateText = group ? value[definition.key] || definition.text : definition.text;
  const text = activeTemplates[definition.key] ?? "";
  const hasCustom = !!text.trim();
  const error = botReplyTemplateError(definition.key, text);

  const changeGroup = (patch: Partial<BotReplyGroup>) => {
    if (!group || !onGroupsChange) return;
    onGroupsChange(groups.map((one) => (one.id === group.id ? { ...one, ...patch } : one)));
  };

  const addGroup = (next: BotReplyGroup) => {
    if (!onGroupsChange) return;
    onGroupsChange([...groups, next]);
    setActiveTab(next.id);
  };

  const changeTemplate = (nextText: string) => {
    const next = { ...activeTemplates };
    if (nextText.trim()) next[definition.key] = nextText;
    else delete next[definition.key];
    if (group) changeGroup({ templates: next });
    else onChange(next);
  };

  const preview = renderBotReplyTemplate(
    definition.key,
    { [definition.key]: text || defaultTemplateText },
    botMessage(definition.text),
    definition.samples,
  );
  const presetBtn = `${button} !min-h-8 !rounded-lg !px-3 !py-1 !text-xs`;
  const paneScroll = "sm:max-h-[calc(90dvh-14rem)] sm:overflow-y-auto sm:overscroll-contain";
  return (
    <section aria-label={t("命令回复")} className="grid gap-3">
      {onGroupsChange && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-ink/10 bg-ink/[0.03] p-1" role="tablist" aria-label={t("回复组")}>
            <button
              type="button"
              role="tab"
              aria-selected={!group}
              className={`focus-ring rounded-lg px-3 py-1.5 text-xs transition-colors ${!group ? "bg-panel font-medium text-ink shadow-sm" : "text-ink/60 hover:text-ink"}`}
              onClick={() => setActiveTab("__default__")}
            >
              {t("默认模板")}
            </button>
            {groups.map((one) => (
              <button
                key={one.id}
                type="button"
                role="tab"
                aria-selected={one.id === group?.id}
                className={`focus-ring rounded-lg px-3 py-1.5 text-xs transition-colors ${one.id === group?.id ? "bg-panel font-medium text-ink shadow-sm" : "text-ink/60 hover:text-ink"}`}
                onClick={() => setActiveTab(one.id)}
              >
                {one.name}
              </button>
            ))}
          </div>
          <button type="button" className={`${button} !min-h-8 !rounded-xl !px-3 !py-1 !text-xs`} onClick={() => addGroup(newReplyGroup(groups))}>
            {t("新建回复组")}
          </button>
        </div>
      )}
      {group ? (
        <div className="bill-entry !mb-0 grid gap-3 sm:grid-cols-2">
          <Field label="名称">
            <input
              className={input}
              maxLength={40}
              value={group.name}
              onChange={(e) => changeGroup({ name: e.target.value })}
            />
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <button
              type="button"
              className={`${button} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-xs`}
              onClick={() => addGroup({ ...structuredClone(group), id: newReplyGroup(groups).id, name: `${group.name}（副本）` })}
            >
              {t("复制")}
            </button>
            <button
              type="button"
              className={`${button} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-xs border-coral/25 text-coral hover:bg-coral/5`}
              onClick={() => {
                if (!onGroupsChange) return;
                const rest = groups.filter((one) => one.id !== group.id);
                onGroupsChange(rest);
                setActiveTab(rest[0]?.id ?? "__default__");
              }}
            >
              {t("删除")}
            </button>
          </div>
          <div className="grid gap-1 sm:col-span-2">
            <Field label="回复目标">
              <textarea
                className={`${input} min-h-16 font-mono text-xs`}
                value={group.to.join("\n")}
                onChange={(e) =>
                  changeGroup({
                    to: e.target.value
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
            <p className="text-xs text-ink/55">
              {t("每行一个目标，写法同播报组：群写 平台:群号，私聊写 平台:private:用户号，或写 * 匹配全部未指定目标。")}
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0"
              checked={!!group.ignorePrivacyMode}
              disabled={!privacyModeEnabled}
              onChange={(e) => changeGroup({ ignorePrivacyMode: e.target.checked })}
            />
            <span className="grid gap-0.5">
              <span>{t("忽略玩家隐私模式")}</span>
              {!privacyModeEnabled && <span className="text-xs text-ink/50">{t("（店铺未开启隐私模式）")}</span>}
            </span>
          </label>
        </div>
      ) : (
        onGroupsChange && (
          <p className="text-xs leading-relaxed text-ink/55">
            {groups.length === 0
              ? t("未配置回复组时所有群聊与私聊均可触发命令；新建回复组后将只对指定群/私聊回复，并可按群设置隐私模式例外。")
              : t("默认模板会作为各回复组未单独覆盖时的兜底文案。")}
          </p>
        )
      )}
      <p className="text-xs leading-relaxed text-ink/55">
        {t("仅修改当前 Bot 的消息。留空使用系统默认；预览为示例数据，保存资源后生效。")}
      </p>
      <div className="grid overflow-hidden rounded-2xl border border-ink/10 bg-panel sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-stretch sm:divide-x sm:divide-ink/10">
        <nav aria-label={t("命令")} className={`grid content-start gap-1 p-2.5 ${paneScroll}`}>
          <div className="px-2.5 py-1 text-xs font-medium text-ink/50">{t("命令")}</div>
          {commands.map(([key, label]) => {
            const active = command === key;
            const customized = Object.keys(activeTemplates).some(k => k.startsWith(`${key}.`) && !!activeTemplates[k]?.trim());
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
                const sceneCustom = !!activeTemplates[item.key]?.trim();
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
                <button type="button" className={presetBtn} onClick={() => changeTemplate(defaultTemplateText)}>{t("填入默认模板")}</button>
                <button type="button" className={presetBtn} onClick={() => changeTemplate("")}>{t("恢复默认")}</button>
              </div>
            </div>
            <textarea
              id={templateId}
              aria-label={t("回复内容")}
              key={`${group?.id ?? "default"}:${definition.key}`}
              className={`${input} min-h-32 font-mono font-normal`}
              maxLength={2000}
              value={text}
              placeholder={defaultTemplateText}
              aria-invalid={!!error}
              aria-describedby={helpId}
              onChange={event => changeTemplate(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {Object.keys(definition.samples).map(variable => (
                <button
                  key={variable}
                  type="button"
                  className="focus-ring rounded-lg border border-ink/15 bg-panel px-2 py-1 font-mono text-xs transition-colors hover:border-mint/50 hover:bg-mint/10"
                  onClick={() => changeTemplate(`${text || defaultTemplateText}{${variable}}`)}
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

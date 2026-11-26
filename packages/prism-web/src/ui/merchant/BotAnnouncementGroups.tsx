import { useState } from "react";
import { X } from "lucide-react";
import {
  announcementCatalog,
  announcementTopics,
  attemptOutcomes,
  botAnnouncementTemplates,
  botMessage,
  botMessageText,
  botReplyTemplateError,
  renderBotReplyTemplate,
  shopAnnouncementSources,
  type AnnouncementEntry,
  type AnnouncementGroup,
} from "@prism/core";
import { useI18n } from "../../i18n";
import { Field, button, buttonQuiet, input, useMerchant } from "./shared";

/**
 * One item a shop picks in the sidebar: an attempt with all its outcomes, or
 * a single fact or notice. `keys` are the catalog entries it covers.
 */
type Item = { id: string; topic: string; kind: AnnouncementEntry["kind"]; label: string; keys: string[]; needs?: string };

const items: Item[] = (() => {
  const list: Item[] = [];
  for (const entry of announcementCatalog) {
    const id = entry.action ?? entry.key;
    const known = list.find((item) => item.id === id);
    if (known) known.keys.push(entry.key);
    else list.push({ id, topic: entry.topic, kind: entry.kind, label: entry.label, keys: [entry.key], ...(entry.needs ? { needs: entry.needs } : {}) });
  }
  return list;
})();

/** Independent scroll bounds for the side-by-side columns in the broadcast group card. */
const paneScroll = "sm:max-h-[calc(90dvh-14rem)] sm:overflow-y-auto sm:overscroll-contain";

const KIND_WORDS: Record<AnnouncementEntry["kind"], string> = { attempt: "尝试", fact: "事实", notice: "提醒" };

/** The words a template key is said in for a group: its own, else the catalog's. */
const templatesOf = (key: string) => botAnnouncementTemplates.filter((template) =>
  template.key === `announce.${key}.message` || template.key.startsWith(`announce.${key}.`));

const newGroup = (groups: readonly AnnouncementGroup[]): AnnouncementGroup => ({
  id: `group-${Date.now().toString(36)}`,
  name: `播报组 ${groups.length + 1}`,
  to: [],
  events: {},
  templates: {},
});

/**
 * Everything a bot announces, one group at a time: who hears it, and for every event the group's switch, where it must have come
 * from and the words it is said in, previewed as they would be said.
 */
export function BotAnnouncementGroups({
  value,
  onChange,
  privacyModeEnabled: privacyModeProp,
}: {
  value: AnnouncementGroup[];
  onChange(groups: AnnouncementGroup[]): void;
  privacyModeEnabled?: boolean;
}) {
  const { t } = useI18n();
  const merchant = useMerchant();
  const privacyModeEnabled = privacyModeProp ?? merchant.privacyModeEnabled;
  const [groupId, setGroupId] = useState(value[0]?.id ?? "");
  const [itemId, setItemId] = useState(items[0]!.id);
  const group = value.find((one) => one.id === groupId) ?? value[0];
  const item = items.find((one) => one.id === itemId) ?? items[0]!;
  const change = (patch: Partial<AnnouncementGroup>) =>
    group && onChange(value.map((one) => (one.id === group.id ? { ...one, ...patch } : one)));
  const add = (next: AnnouncementGroup) => {
    onChange([...value, next]);
    setGroupId(next.id);
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-ink/10 bg-ink/[0.03] p-1" role="tablist" aria-label={t("播报组")}>
          {value.map((one) => (
            <button key={one.id} type="button" role="tab" aria-selected={one.id === group?.id}
              className={`focus-ring rounded-lg px-3 py-1.5 text-xs transition-colors ${one.id === group?.id ? "bg-panel font-medium text-ink shadow-sm" : "text-ink/60 hover:text-ink"}`}
              onClick={() => setGroupId(one.id)}>{one.name}</button>
          ))}
        </div>
        <button type="button" className={`${button} !min-h-8 !rounded-xl !px-3 !py-1 !text-xs`} onClick={() => add(newGroup(value))}>{t("新建播报组")}</button>
      </div>
      {!group ? (
        <p className="bill-entry !mb-0 py-6 text-center text-sm text-ink/60">{t("还没有播报组。新建一个，选好要播的事件和发到哪里。")}</p>
      ) : (
        <>
          {/* Group info + destination rows on the left and event configuration on the right scroll independently,
              so adding many destinations never pushes event settings out of view. */}
          <div className="grid overflow-hidden rounded-2xl border border-ink/10 bg-panel sm:grid-cols-[17.5rem_minmax(0,1fr)] sm:items-stretch sm:divide-x sm:divide-ink/10">
            <div className={`grid content-start gap-3 p-3.5 ${paneScroll}`}>
              <Field label="名称">
                <input className={input} maxLength={40} value={group.name} onChange={(e) => change({ name: e.target.value })} />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={`${button} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-xs`}
                  onClick={() => add({ ...structuredClone(group), id: newGroup(value).id, name: `${group.name}（副本）` })}>{t("复制")}</button>
                <button type="button" className={`${button} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-xs border-coral/25 text-coral hover:bg-coral/5`} onClick={() => {
                  const rest = value.filter((one) => one.id !== group.id);
                  onChange(rest);
                  setGroupId(rest[0]?.id ?? "");
                }}>{t("删除")}</button>
              </div>
              <div className="grid gap-2 border-t border-ink/[0.06] pt-3">
                <span className="text-sm font-medium">{t("发到")}</span>
                <p className="text-xs leading-relaxed text-ink/55">{t("每行一个目的地，群和人写法一样：群写 平台:群号，个人写 平台:private:用户号。")}</p>
                {/* Keep one trailing empty row so adding another destination needs no extra button. */}
                {[...group.to, ""].map((target, index) => {
                  const draft = index === group.to.length;
                  return (
                    <div className="flex items-center gap-1.5" key={index}>
                      <input
                        className={`${input} min-h-9 font-mono text-xs`}
                        value={target}
                        aria-label={`${t("发到")} ${index + 1}`}
                        autoComplete="off"
                        onChange={(e) => {
                          const next = e.target.value;
                          if (index < group.to.length) {
                            change({ to: group.to.map((current, i) => (i === index ? next : current)) });
                          } else if (next.trim()) {
                            change({ to: [...group.to, next] });
                          }
                        }}
                        onBlur={() => {
                          if (index < group.to.length && !group.to[index]?.trim()) {
                            change({ to: group.to.filter((_, i) => i !== index) });
                          }
                        }}
                      />
                      {!draft && (
                        <button
                          type="button"
                          className={`${buttonQuiet} size-9 shrink-0 justify-center text-ink/50 hover:text-coral`}
                          aria-label={`${t("删除")} ${index + 1}`}
                          onClick={() => change({ to: group.to.filter((_, i) => i !== index) })}
                        >
                          <X size={15} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <label className="flex items-start gap-2 border-t border-ink/[0.06] pt-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 shrink-0"
                  checked={!!group.ignorePrivacyMode}
                  disabled={!privacyModeEnabled}
                  onChange={(e) => change({ ignorePrivacyMode: e.target.checked })}
                />
                <span className="grid gap-0.5">
                  <span>{t("忽略玩家隐私模式")}</span>
                  {!privacyModeEnabled && (
                    <span className="text-xs text-ink/50">{t("（店铺未开启隐私模式）")}</span>
                  )}
                </span>
              </label>
            </div>
            <div className="grid min-w-0 divide-y divide-ink/10 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-stretch sm:divide-x sm:divide-y-0">
              <nav aria-label={t("事件")} className={`grid content-start gap-3 p-3 ${paneScroll}`}>
                {announcementTopics.map(({ topic, label }) => (
                  <div key={topic} className="grid gap-0.5">
                    <span className="px-2 text-xs font-semibold text-ink/70">{t(label)}</span>
                    {(["attempt", "fact", "notice"] as const).map((kind) => {
                      const listed = items.filter((one) => one.topic === topic && one.kind === kind);
                      if (!listed.length) return null;
                      return (
                        <div key={kind} className="grid gap-0.5">
                          <span className="px-2 pt-1 text-[11px] text-ink/45">{t(KIND_WORDS[kind])}</span>
                          {listed.map((one) => {
                            const on = one.keys.some((key) => group.events[key]?.on);
                            const worded = one.keys.some((key) => templatesOf(key).some((template) => group.templates[template.key]));
                            return (
                              <div key={one.id} className="grid gap-2">
                              <button type="button" aria-current={one.id === item.id}
                                title={t(on ? "播报中" : "未播报")}
                                className={`focus-ring flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${one.id === item.id ? "bg-mint/10 font-medium text-ink" : "text-ink/75 hover:bg-ink/5"}`}
                                onClick={() => setItemId(one.id)}>
                                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${on ? "bg-mint" : "bg-ink/20"}`} />
                                <span className="min-w-0 flex-1 truncate">{t(one.label)}</span>
                                {worded && <span aria-hidden className="text-xs text-ink/45">✎</span>}
                              </button>
                              {/* On a phone the chosen event opens where it was tapped, not below the whole list. */}
                              {one.id === item.id && (
                                <div className="rounded-xl border border-ink/10 bg-ink/[0.015] p-3 sm:hidden"><ItemEditor group={group} item={item} change={change} /></div>
                              )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </nav>
              <div className={`hidden bg-ink/[0.01] p-4 sm:block ${paneScroll}`}><ItemEditor group={group} item={item} change={change} /></div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ItemEditor({ group, item, change }: { group: AnnouncementGroup; item: Item; change(patch: Partial<AnnouncementGroup>): void }) {
  const { t } = useI18n();
  const sources = item.keys.map((key) => group.events[key]?.sources ?? []).find((list) => list.length) ?? [];
  const setEvent = (key: string, on: boolean) =>
    change({ events: { ...group.events, [key]: { on, sources: group.events[key]?.sources ?? sources } } });
  const setSources = (next: string[]) =>
    change({ events: Object.fromEntries(Object.entries(group.events).map(([key, setting]) =>
      [key, item.keys.includes(key) ? { ...setting, sources: next } : setting])) });
  const setWords = (key: string, text: string) => {
    const templates = { ...group.templates };
    if (text.trim()) templates[key] = text;
    else delete templates[key];
    change({ templates });
  };
  return (
    <section aria-label={t(item.label)} className="grid content-start gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="text-base font-semibold">{t(item.label)}</h5>
        <span className="rounded-full bg-ink/[0.05] px-2 py-0.5 text-[11px] font-medium text-ink/65">{t(KIND_WORDS[item.kind])}</span>
        {item.needs && <span className="text-xs text-ink/55">{t("需要{needs}", { needs: t(item.needs) })}</span>}
      </div>
      {item.keys.map((key) => {
        const entry = announcementCatalog.find((one) => one.key === key)!;
        const outcome = entry.outcome ? attemptOutcomes.find((one) => one.outcome === entry.outcome)!.label : null;
        return (
          <div key={key} className="bill-entry !mb-0 grid gap-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={!!group.events[key]?.on} onChange={(e) => setEvent(key, e.target.checked)} />
              {outcome ? t(outcome) : t("播报")}
            </label>
            {templatesOf(key).map((template) => (
              <Words key={`${group.id}:${template.key}`} templateKey={template.key} label={templatesOf(key).length > 1 ? template.label : null}
                text={group.templates[template.key] ?? ""} onChange={(text) => setWords(template.key, text)} />
            ))}
          </div>
        );
      })}
      {item.kind !== "notice" && (
        <fieldset className="bill-entry !mb-0 grid gap-2.5">
          <legend className="text-xs font-medium text-ink/70">{t("只听这些来源（都不选表示任何来源）")}</legend>
          <div className="flex flex-wrap gap-2">
            {shopAnnouncementSources.map((source) => (
              <label key={source.channel} className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-ink/10 bg-panel px-3 py-1.5 text-sm">
                <input type="checkbox" checked={sources.includes(source.channel)}
                  onChange={(e) => setSources(e.target.checked ? [...new Set([...sources, source.channel])] : sources.filter((one) => one !== source.channel))} />
                {t(source.label)}
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </section>
  );
}

/** One set of words: the preview as it would be said, and the editor for the group's own. */
function Words({ templateKey, label, text, onChange }: { templateKey: string; label: string | null; text: string; onChange(text: string): void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const definition = botAnnouncementTemplates.find((template) => template.key === templateKey)!;
  const error = botReplyTemplateError(templateKey, text);
  const preview = renderBotReplyTemplate(templateKey, { [templateKey]: text || definition.text }, botMessage(definition.text), definition.samples);
  return (
    <div className="grid gap-2">
      {label && <span className="text-xs text-ink/55">{t(label)}</span>}
      <p className="whitespace-pre-wrap break-words rounded-xl border border-ink/10 bg-panel px-3 py-2 text-sm">
        {error ? t("请先修正模板") : botMessageText(preview)}
      </p>
      <div>
        <button type="button" className="focus-ring rounded text-xs font-medium text-ink/60 underline-offset-2 hover:text-ink hover:underline"
          aria-expanded={editing} onClick={() => setEditing(!editing)}>
          {t(editing ? "收起" : text ? "编辑文案（已修改）" : "编辑文案")}
        </button>
      </div>
      {editing && (
        <div className="grid gap-2">
          <textarea aria-label={t("文案")} className={`${input} min-h-20 font-mono`} maxLength={2000} value={text} placeholder={definition.text}
            aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" className={`${button} !min-h-8 !rounded-lg !px-2.5 !py-1 !text-xs`} onClick={() => onChange("")}>{t("恢复默认")}</button>
            {Object.keys(definition.samples).map((variable) => (
              <button key={variable} type="button" className="focus-ring rounded-lg border border-ink/15 bg-panel px-2 py-1 font-mono text-xs transition-colors hover:border-mint/50 hover:bg-mint/10"
                onClick={() => onChange(`${text || definition.text}{${variable}}`)}>{`{${variable}}`}</button>
            ))}
          </div>
          {definition.required.length > 0 && (
            <p className="text-xs text-ink/55">{t("必须保留：")}{definition.required.map((variable) => `{${variable}}`).join("、")}</p>
          )}
          {error && <p role="alert" className="text-sm text-coral">{error}</p>}
        </div>
      )}
    </div>
  );
}

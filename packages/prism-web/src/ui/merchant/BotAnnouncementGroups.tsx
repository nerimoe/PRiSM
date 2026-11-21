import { useState } from "react";
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
import { Field, buttonQuiet, input } from "./shared";

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

/** A column pinned under the Modal's sticky header (~5rem) that scrolls itself within the room left above the save bar. */
const paneScroll = "sm:sticky sm:top-[5.5rem] sm:max-h-[calc(90dvh-11.5rem)] sm:overflow-y-auto sm:overscroll-contain sm:pr-1";

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
export function BotAnnouncementGroups({ value, onChange }: { value: AnnouncementGroup[]; onChange(groups: AnnouncementGroup[]): void }) {
  const { t } = useI18n();
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
      <div className="flex flex-wrap items-center gap-1 border-b border-ink/10 pb-3" role="tablist" aria-label={t("播报组")}>
        {value.map((one) => (
          <button key={one.id} type="button" role="tab" aria-selected={one.id === group?.id}
            className={`focus-ring rounded-lg px-2.5 py-2 text-xs ${one.id === group?.id ? "bg-mint/10 font-semibold text-ink" : "text-ink/55 hover:bg-ink/5"}`}
            onClick={() => setGroupId(one.id)}>{one.name}</button>
        ))}
        <button type="button" className={buttonQuiet} onClick={() => add(newGroup(value))}>{t("新建播报组")}</button>
      </div>
      {!group ? (
        <p className="text-sm text-ink/60">{t("还没有播报组。新建一个，选好要播的事件和发到哪里。")}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="名称">
              <input className={input} maxLength={40} value={group.name} onChange={(e) => change({ name: e.target.value })} />
            </Field>
            <div className="flex items-end gap-2">
              <button type="button" className={buttonQuiet}
                onClick={() => add({ ...structuredClone(group), id: newGroup(value).id, name: `${group.name}（副本）` })}>{t("复制")}</button>
              <button type="button" className={buttonQuiet} onClick={() => {
                const rest = value.filter((one) => one.id !== group.id);
                onChange(rest);
                setGroupId(rest[0]?.id ?? "");
              }}>{t("删除")}</button>
            </div>
            <div className="grid gap-1 sm:col-span-2">
              <Field label="发到">
                <textarea className={`${input} min-h-16`} value={group.to.join("\n")}
                  onChange={(e) => change({ to: e.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })} />
              </Field>
              <p className="text-xs text-ink/55">{t("每行一个目的地，群和人写法一样：群写 平台:群号，个人写 平台:private:用户号。")}</p>
            </div>
          </div>
          {/* Side by side, each column scrolls on its own below the dialog's header and above its save bar,
              so reaching the bottom of the event list never pushes the chosen event's editor out of view. */}
          <div className="grid gap-4 sm:grid-cols-[10.5rem_minmax(0,1fr)] sm:items-start">
            <nav aria-label={t("事件")} className={`grid content-start gap-3 ${paneScroll}`}>
              {announcementTopics.map(({ topic, label }) => (
                <div key={topic} className="grid gap-0.5">
                  <span className="text-xs font-semibold text-ink/70">{t(label)}</span>
                  {(["attempt", "fact", "notice"] as const).map((kind) => {
                    const listed = items.filter((one) => one.topic === topic && one.kind === kind);
                    if (!listed.length) return null;
                    return (
                      <div key={kind} className="grid gap-0.5">
                        <span className="pl-2 pt-1 text-[11px] text-ink/45">{t(KIND_WORDS[kind])}</span>
                        {listed.map((one) => {
                          const on = one.keys.some((key) => group.events[key]?.on);
                          const worded = one.keys.some((key) => templatesOf(key).some((template) => group.templates[template.key]));
                          return (
                            <div key={one.id} className="grid gap-2">
                            <button type="button" aria-current={one.id === item.id}
                              title={t(on ? "播报中" : "未播报")}
                              className={`focus-ring flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${one.id === item.id ? "bg-ink/5 font-medium" : "hover:bg-ink/5"}`}
                              onClick={() => setItemId(one.id)}>
                              <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${on ? "bg-mint" : "bg-ink/20"}`} />
                              <span className="min-w-0 flex-1 truncate">{t(one.label)}</span>
                              {worded && <span aria-hidden className="text-xs text-ink/45">✎</span>}
                            </button>
                            {/* On a phone the chosen event opens where it was tapped, not below the whole list. */}
                            {one.id === item.id && (
                              <div className="rounded-lg border border-ink/10 p-3 sm:hidden"><ItemEditor group={group} item={item} change={change} /></div>
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
            <div className={`hidden sm:block ${paneScroll}`}><ItemEditor group={group} item={item} change={change} /></div>
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
      <div className="flex flex-wrap items-baseline gap-2">
        <h5 className="text-base font-semibold">{t(item.label)}</h5>
        <span className="rounded bg-ink/5 px-1.5 py-0.5 text-xs text-ink/60">{t(KIND_WORDS[item.kind])}</span>
        {item.needs && <span className="text-xs text-ink/55">{t("需要{needs}", { needs: t(item.needs) })}</span>}
      </div>
      {item.keys.map((key) => {
        const entry = announcementCatalog.find((one) => one.key === key)!;
        const outcome = entry.outcome ? attemptOutcomes.find((one) => one.outcome === entry.outcome)!.label : null;
        return (
          <div key={key} className="grid gap-2 rounded-lg border border-ink/10 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
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
        <fieldset className="grid gap-2">
          <legend className="text-xs font-medium text-ink/70">{t("只听这些来源（都不选表示任何来源）")}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {shopAnnouncementSources.map((source) => (
              <label key={source.channel} className="flex items-center gap-2 text-sm">
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
      <p className="whitespace-pre-wrap break-words rounded bg-ink/5 px-2.5 py-2 text-sm">
        {error ? t("请先修正模板") : botMessageText(preview)}
      </p>
      <div>
        <button type="button" className="focus-ring rounded text-xs text-ink/60 underline-offset-2 hover:text-ink hover:underline"
          aria-expanded={editing} onClick={() => setEditing(!editing)}>
          {t(editing ? "收起" : text ? "编辑文案（已修改）" : "编辑文案")}
        </button>
      </div>
      {editing && (
        <div className="grid gap-2">
          <textarea aria-label={t("文案")} className={`${input} min-h-20 font-mono`} maxLength={2000} value={text} placeholder={definition.text}
            aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonQuiet} onClick={() => onChange("")}>{t("恢复默认")}</button>
            {Object.keys(definition.samples).map((variable) => (
              <button key={variable} type="button" className={buttonQuiet}
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

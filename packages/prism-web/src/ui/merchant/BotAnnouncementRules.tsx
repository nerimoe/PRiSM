import { shopAnnouncementCatalog, shopAnnouncementSources } from "@prism/core";
import type { BotAnnouncementRule } from "../../api";
import { useI18n } from "../../i18n";
import { Field, buttonQuiet, input } from "./shared";

const families = [
  ["event", "现场事件"],
  ["request", "平台操作"],
  ["shop", "店铺动态"],
  ["notice", "提醒"],
] as const;

const emptyRule: BotAnnouncementRule = { events: [], sources: [], to: [], staff: false };

/**
 * Everything a bot announces: each rule names the events it listens for, where
 * they must have come from (anywhere, when none is ticked), and where it says
 * them. A destination is a group or a person alike; staff can be named as a
 * whole, so the rule follows whoever is staff.
 */
export function BotAnnouncementRules({ value, onChange }: { value: BotAnnouncementRule[]; onChange(rules: BotAnnouncementRule[]): void }) {
  const { t } = useI18n();
  const change = (index: number, patch: Partial<BotAnnouncementRule>) =>
    onChange(value.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)));
  const toggled = (list: string[], item: string, on: boolean) => (on ? [...new Set([...list, item])] : list.filter((one) => one !== item));
  return (
    <div className="grid gap-3">
      <p className="text-xs text-ink/55">
        {t("Bot 只按这里的规则播报：监听哪些事件、只听哪里来的、听到后发到哪里。没有规则就什么都不播。")}
      </p>
      {value.map((rule, index) => (
        <section key={index} aria-label={t("监听规则 {n}", { n: index + 1 })} className="grid gap-3 rounded border border-ink/10 p-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-medium">{t("监听规则 {n}", { n: index + 1 })}</h4>
            <button type="button" className={buttonQuiet} onClick={() => onChange(value.filter((_, at) => at !== index))}>
              {t("删除规则")}
            </button>
          </div>
          {families.map(([family, heading]) => (
            <fieldset key={family} className="grid gap-2">
              <legend className="text-xs font-medium text-ink/70">{t(heading)}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {shopAnnouncementCatalog.filter((entry) => entry.family === family).map((entry) => (
                  <label key={entry.type} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={rule.events.includes(entry.type)}
                      onChange={(e) => change(index, { events: toggled(rule.events, entry.type, e.target.checked) })}
                    />
                    {t(entry.label)}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <fieldset className="grid gap-2 border-t border-ink/10 pt-3">
            <legend className="text-xs font-medium text-ink/70">{t("只听这些来源（都不选表示任何来源）")}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {shopAnnouncementSources.map((source) => (
                <label key={source.channel} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={rule.sources.includes(source.channel)}
                    onChange={(e) => change(index, { sources: toggled(rule.sources, source.channel, e.target.checked) })}
                  />
                  {t(source.label)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-1 border-t border-ink/10 pt-3">
            <Field label="发到">
              <textarea
                className={`${input} min-h-16`}
                value={rule.to.join("\n")}
                onChange={(e) => change(index, { to: e.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })}
              />
            </Field>
            <p className="text-xs text-ink/55">{t("每行一个目的地，群和人写法一样：群写 平台:群号，个人写 平台:private:用户号。")}</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={rule.staff} onChange={(e) => change(index, { staff: e.target.checked })} />
            {t("同时私聊每位店员")}
          </label>
          <p className="text-xs text-ink/55">{t("店员指在本店绑定了聊天平台身份的员工，名单随人员变动，不用改规则。")}</p>
        </section>
      ))}
      <div>
        <button type="button" className={buttonQuiet} onClick={() => onChange([...value, emptyRule])}>
          {t("添加监听规则")}
        </button>
      </div>
    </div>
  );
}

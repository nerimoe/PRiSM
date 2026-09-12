import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import english from "./locales/en.json";

export type Locale = "zh" | "en";
type Values = Record<string, string | number>;
const translations: Record<string, string> = english;

export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    if (base === "zh" || base === "en") return base;
  }
  return "en";
}

export function translate(message: string, locale: Locale, values: Values = {}): string {
  const text = locale === "en" && Object.hasOwn(translations, message) ? translations[message]! : message;
  return text.replace(/\{(\w+)\}/g, (match, key: string) => Object.hasOwn(values, key) ? String(values[key]) : match);
}

export function translateError(message: string, locale: Locale): string {
  if (Object.hasOwn(translations, message)) return translate(message, locale);
  // Upstream diagnostics are not UI copy. Known API messages are translated above.
  return translate("操作失败，请稍后重试", locale);
}

const I18nContext = createContext<{
  locale: Locale;
  t: (message: string, values?: Values) => string;
  errorText: (message: string) => string;
} | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(() => resolveLocale(navigator.languages));
  useEffect(() => {
    const changed = () => setLocale(resolveLocale(navigator.languages));
    window.addEventListener("languagechange", changed);
    return () => window.removeEventListener("languagechange", changed);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);
  const value = useMemo(() => ({
    locale,
    t: (message: string, values?: Values) => translate(message, locale, values),
    errorText: (message: string) => translateError(message, locale),
  }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}

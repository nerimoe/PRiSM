import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { resolveLocale, translate, translateError } from "./i18n";
import english from "./locales/en.json";

describe("localization", () => {
  it("negotiates browser preferences with an English fallback", () => {
    expect(resolveLocale(["zh-TW", "en-US"])).toBe("zh");
    expect(resolveLocale(["ja-JP", "en-GB", "zh-CN"])).toBe("en");
    expect(resolveLocale(["ja-JP"])).toBe("en");
    expect(resolveLocale([])).toBe("en");
  });

  it("formats card details without translating card names", () => {
    expect(translate("尾号 {digits}", "en", { digits: "0025" })).toBe("Ending in 0025");
    expect(translate("尾号 {digits}", "zh", { digits: "0025" })).toBe("尾号 0025");
    expect(translate("User's card", "en")).toBe("User's card");
  });

  it("translates errors without changing session expiry classification", () => {
    for (const message of ["本次会话已失效", "缺少会话凭证"]) {
      const error = new ApiError(message, 403);
      for (const locale of ["zh", "en"] as const) {
        expect(translateError(error.message, locale)).toBeTruthy();
        expect(error.sessionExpired).toBe(true);
      }
    }
    expect(new ApiError("请到店再进行登录", 403).sessionExpired).toBe(false);
    expect(translateError("raw upstream diagnostic", "en")).toBe(english["操作失败，请稍后重试"]);
    expect(translateError("toString", "en")).toBe(english["操作失败，请稍后重试"]);
  });

  it("has English text for every literal translation key in the web UI", () => {
    const missing = new Set<string>();
    for (const name of readdirSync(new URL("./ui/", import.meta.url), { recursive: true })) {
      if (typeof name !== "string" || !name.endsWith(".tsx")) continue;
      const source = readFileSync(new URL(`./ui/${name}`, import.meta.url), "utf8");
      for (const match of source.matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) {
        const key = JSON.parse(match[1]!) as string;
        if (!(key in english)) missing.add(key);
      }
    }
    expect([...missing]).toEqual([]);
  });
});

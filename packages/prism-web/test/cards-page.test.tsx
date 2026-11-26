import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "../src/i18n";
import { CardAddGuidance } from "../src/ui/CardsPage";

// Render CardAddGuidance via a lightweight React context / i18n check without DOM globals.
describe("CardsPage manual add disabled guidance", () => {
  test("translates all new MuNET and card-reader guidance strings in English", () => {
    expect(translate("去 MuNET 添加卡片", "en")).toBe("Add a card in MuNET");
    expect(translate("在店铺内使用读卡器添加卡片", "en")).toBe("Add a card using a store card reader");
    expect(translate("读卡器添加", "en")).toBe("Added via reader");
  });

  test("renders MuNET and store card reader guidance without manual card inputs when I18nProvider is active", async () => {
    const { I18nProvider } = await import("../src/i18n");
    const prevNavigator = globalThis.navigator;
    const prevWindow = (globalThis as { window?: unknown }).window;
    Object.defineProperty(globalThis, "navigator", { value: { languages: ["zh-CN"] }, configurable: true });
    Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
    try {
      const html = renderToStaticMarkup(
        <I18nProvider>
          <CardAddGuidance />
        </I18nProvider>,
      );
      expect(html).toContain("去 MuNET 添加卡片");
      expect(html).toContain("在店铺内使用读卡器添加卡片");
      expect(html).toContain('href="https://portal.mumur.net"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('src="/munet-logo.png"');
      expect(html).not.toContain("前往 MuNET");
      expect(html).not.toContain("在 MuNET 账号中添加卡片后");
      expect(html).not.toContain("<input");
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: prevNavigator, configurable: true });
      Object.defineProperty(globalThis, "window", { value: prevWindow, configurable: true });
    }
  });
});

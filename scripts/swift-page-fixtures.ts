/**
 * Scanned pages for the App Clip's native checks (hinata_go test/native). Every page is made by the
 * server's own `renderPage`, so the checks decode and act on exactly what the platform sends: when
 * the page changes shape and the Swift models do not follow, they fail. Regenerate after changing
 * the page:
 *
 *   bun scripts/swift-page-fixtures.ts <hinata_go>/test/native/fixtures/prism-page
 *
 * All data is synthetic.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pageCode, renderPage, type PageInput } from "../packages/server/src/resources/page";
import { pageUi } from "../packages/server/src/resources/page-ui";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: bun scripts/swift-page-fixtures.ts <outDir>");
  process.exit(2);
}

const none = { power: false, climate: false, card: false, coin: false, door: false, table: false };
const on = (...names: Array<keyof typeof none>) => ({ ...none, ...Object.fromEntries(names.map((name) => [name, true])) });
const base: PageInput = {
  locale: "zh",
  head: { shop: "Store", shopCode: "store", heroUrl: "/api/v1/shops/store/hero?v=abc123", resource: "Device", publicId: "device" },
  billingActive: false, capabilities: none, billed: false, cardCapture: false,
  geo: { checkin: false, machine: false }, signedIn: true, gate: "ready", billing: null, power: null,
  climate: null, coinFull: false, ioWaiting: false, table: null,
};

const plan = {
  id: "fee", kind: "charge.fixed", name: "入场费", enabled: true, status: "active",
  provider: { id: "fee", label: "入场费", amount: 12 },
};
const billing = {
  rules: { source: { kind: "resource" }, timeZone: "Asia/Tokyo", plans: [{ role: "resource", config: plan }], caps: { unsettled: 0, plans: [], shared: [] } },
  preview: {
    pricingConfigId: "fee", planName: "入场费", changed: true, revision: "rev-1",
    started: [{ planId: "fee", planName: "入场费" }], stopped: [], kept: [],
  },
};
const climate = {
  mode: "off", modes: ["off", "cool", "heat", "dry", "fan_only", "auto"], temperature: 26, currentTemperature: 28.5,
  minTemperature: 16, maxTemperature: 30, temperatureStep: 1, fanMode: "auto", fanModes: ["auto", "low", "high"],
};
const seat = (name: string, mine: boolean) => ({ name, mine, playing: false });

const scenes: Record<string, Partial<PageInput>> = {
  signin: { capabilities: on("card"), signedIn: false },
  empty: {},
  disabled: { capabilities: on("coin"), gate: "disabled" },
  binding: { capabilities: on("card", "door"), gate: "binding" },
  entryDoor: { capabilities: on("door"), gate: "entry", geo: { checkin: true, machine: false }, billing },
  entryError: { capabilities: on("door"), gate: "entry", billing: { error: { message: "没有配置计费" } } },
  door: { capabilities: on("door"), geo: { checkin: true, machine: false }, billingActive: true },
  doorCardsCoin: { capabilities: on("door", "card", "coin"), billingActive: true },
  cards: { capabilities: on("card") },
  cardsCapture: { capabilities: on("card", "coin"), cardCapture: true },
  coinFull: { capabilities: on("coin"), coinFull: true },
  ioWaiting: { capabilities: on("card", "coin"), ioWaiting: true },
  tableEmpty: { capabilities: on("table"), table: { capacity: 4, seats: [] } },
  tableMine: { capabilities: on("table"), table: { capacity: 4, seats: [seat("Player", true)] } },
  climate: { capabilities: on("climate"), climate },
  climateOnSite: { capabilities: on("climate"), climate, geo: { checkin: false, machine: true } },
  climateUnknown: { capabilities: on("climate") },
  powerOff: { capabilities: on("power"), power: "off" },
  powerOn: { capabilities: on("power"), power: "on" },
};

const pages = Object.fromEntries(Object.entries(scenes).map(([name, input]) => [name, renderPage({ ...base, ...input })]));

// No page of the platform's own uses every component yet, so this one does.
pages.components = {
  ...renderPage(base),
  offerPasskeySetup: true,
  blocks: [
    pageUi.banner("banner", "请确认时段后提交", { level: "warning", title: "提示" }),
    pageUi.section("section", [
      pageUi.kv("kv", [{ label: "当前状态", value: "可预约", tone: "success" }]),
      pageUi.divider("divider"),
      pageUi.image("image", "/assets/event.png", { alt: "活动", aspectRatio: 1.78 }),
      pageUi.text("caption", "小字说明", { style: "caption" }),
      pageUi.select("slot", [{ value: "a", label: "14:00" }, { value: "full", label: "15:00", disabled: true }], { required: true }),
      pageUi.input("pin", { name: "code", inputType: "number", maxLength: 4, required: true }),
      pageUi.toggle("remind", "到期提醒", { defaultValue: true }),
      pageUi.consent("agree", "我已阅读说明"),
    ], { title: "预约", style: "card" }),
    pageUi.row("row", [
      pageUi.button("cancel", "释放", "booking.cancel", { style: "destructive" }),
      pageUi.button("submit", "确认预约", "booking.create", {
        style: "primary", requires: "agree", collect: ["slot", "pin", "remind"], payload: { remind: false, plan: "vip" },
        confirm: { title: "确认预约", body: "提交后将锁定名额", confirmLabel: "确认", cancelLabel: "取消" },
      }),
    ]),
  ],
};

mkdirSync(resolve(outDir), { recursive: true });
const code = pageCode("zh", { temporaryPassword: "12345678", expiresAt: "2999-01-01T00:00:00Z" });
writeFileSync(join(resolve(outDir), "pages.json"), `${JSON.stringify({ pages, code }, null, 2)}\n`);
console.log(`wrote ${Object.keys(pages).length} pages to ${join(outDir, "pages.json")}`);

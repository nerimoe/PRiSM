const { chromium } = require(process.env.PRISM_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");

/**
 * The merchant device board. It shows what the backend tells it and decides nothing by whether a
 * device is live: the shop hub sends every device's 实时 / 非实时 label and the live devices' values
 * when the board connects, then what Home Assistant said of the others, then every change; an
 * action answers with what the device shows now; the one shop-level refresh asks the backend for
 * everything. A value is never "unknown" because it is old, only while it is being read or when the
 * backend could not read it.
 */
const origin = process.env.PRISM_SCAN_ORIGIN || "http://127.0.0.1:4173";
const output = process.env.PRISM_SCAN_OUTPUT || ".scan-check";
const shop = {
  id: "shop", publicId: "demo", name: "CI 测试店铺", timeZone: "Asia/Shanghai",
  latitude: 31.23, longitude: 121.47, radiusMeters: 80, billingEnabled: false,
  cashierEnabled: false, identityBindingRequired: false, locationEnabled: false,
};
const view = {
  mode: "cool", modes: ["off", "cool"], temperature: 24, currentTemperature: 27, minTemperature: 16,
  maxTemperature: 30, temperatureStep: 1, fanMode: "low", fanModes: ["auto", "low"],
};
const base = {
  coinAfterSwipe: false, hasHinata: false, kind: "machine", hinataUrl: null, homeAssistant: null, climate: null,
  ttlockLockId: null, coinKey: 32, mahjong: null, shopId: "shop", shopPublicId: "demo", aliases: [], enabled: true,
};
const machines = [
  { ...base, id: "cab", publicId: "cab", name: "机台A",
    homeAssistant: { connectionId: "ha_1", url: "https://ha.test", entityId: "switch.cab" },
    climate: { connectionId: "ha_1", url: "https://ha.test", entityId: "climate.room" } },
  { ...base, id: "io", publicId: "io", name: "机台B",
    homeAssistant: { connectionId: "ha_2", url: "https://ha2.test", entityId: "switch.io" } },
  { ...base, id: "door", publicId: "door", name: "大门", kind: "door", ttlockLockId: 7 },
];
const unlabelled = { watching: false };

const until = async (condition, what) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${what}`);
};

/**
 * `watchedIo`: whether the second Home Assistant is watched too, so every device is.
 * `clock`: fake timers, to move past a reconnect wait and a polling interval.
 * `silentHub`: the hub accepts the connection and never says anything.
 * The hub is played by the page's WebSocket route: it greets each connection with the board's labels
 * and the live devices' values, then what Home Assistant says of the other one (on), and the test
 * sends it whatever frames it wants to push. An action answers with what the device shows after it.
 */
async function openBoard(browser, { watchedIo, viewport, clock = false, silentHub = false, role = "user" }) {
  const context = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  await context.addInitScript(() => sessionStorage.setItem("prism.active-shop", "demo"));
  const page = await context.newPage();
  if (clock) await page.clock.install();
  const exceptions = [], calls = [], sockets = [], received = [], puts = [];
  page.on("pageerror", (error) => exceptions.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") exceptions.push(message.text()); });
  // Each device sits on its own Home Assistant connection here, so a device going
  // quiet is a connection going quiet.
  const snapshot = {
    cab: { watching: true, power: "off", climate: view },
    io: watchedIo ? { watching: true, power: "on" } : unlabelled,
  };
  const connections = watchedIo ? ["ha_cab", "ha_io"] : ["ha_cab"];
  // What a read of the shop answers: the backend's view at the time, which the scenario moves along.
  let shopRead = { cab: snapshot.cab, io: watchedIo ? snapshot.io : { watching: false, power: "on" } };
  let listedMachines = [...machines], deletionBlocked = false;
  await page.routeWebSocket(/\/api\/v1\/merchant\/machines\/ws/, (ws) => {
    sockets.push({ ws, url: ws.url() });
    ws.onMessage((message) => received.push(String(message)));
    if (silentHub) return;
    ws.send(JSON.stringify({ type: "states", states: snapshot, liveConnections: connections }));
    if (!watchedIo) ws.send(JSON.stringify({ type: "states", states: { io: { watching: false, power: "on" } } }));
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    if (request.method() !== "GET") {
      calls.push(`${request.method()} ${p}`);
      if (request.method() === "DELETE" && p === "/api/v1/merchant/machines/cab") {
        if (deletionBlocked) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "MACHINE_HAS_HISTORY", message: "资源已有使用记录，请改为停用" } }) });
        listedMachines = listedMachines.filter((machine) => machine.id !== "cab");
      }
      if (request.method() === "PUT") puts.push({ path: p, query: url.search.slice(1), body: JSON.parse(request.postData() || "null") });
      // What each device shows after an action: the cabinet came on, the other one stayed off.
      const answers = {
        "/api/v1/merchant/machines/cab/actions": { device: { power: "on", climate: view } },
        "/api/v1/merchant/machines/io/actions": { device: { power: "off" } },
      };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: answers[p] ?? {} }) });
    }
    calls.push(p + url.search);
    let data = {};
    if (p === "/api/v1/me") data = { user: { id: "owner", username: "owner", displayName: "owner", role, hasShops: true } };
    else if (p === "/api/v1/merchant/shops") data = { shops: [shop] };
    else if (p === "/api/v1/merchant/machines") data = { machines: listedMachines };
    else if (p === "/api/v1/merchant/resource-groups") data = { resourceGroups: [{ id: "default", name: "默认资源组", enabled: true, isDefault: true, defaultPricingConfigId: null, resourceCount: 0 }] };
    else if (p === "/api/v1/merchant/machines/occupancy") data = { resources: [] };
    else if (p === "/api/v1/merchant/machines/states") data = { states: shopRead };
    else if (p === "/api/v1/merchant/device-bindings") data = { bindings: [] };
    else if (p === "/api/v1/merchant/ha-connections") data = { connections: [] };
    else if (p === "/api/v1/merchant/idle-power") data = { settings: { devices: {}, shopEmpty: { enabled: false, minutes: 30 }, device: { enabled: false, minutes: 30, whileOccupied: "off" } } };
    else if (p === "/api/v1/shops/demo/staff/settings") data = { settings: { ttLockConnection: null } };
    else if (p === "/api/v1/shops/demo/staff/pricing-configs") data = { pricingConfigs: [] };
    else if (p === "/api/v1/shops/demo") data = { shop, membership: { playerId: "p", identityBound: true }, entryPricing: [] };
    else if (p === "/api/v1/shops/demo/staff/me") data = { staff: { id: "s", displayName: "店员", role: "owner", canWrite: true } };
    else if (p === "/api/v1/shops/demo/staff/live-players") data = { players: [], billingSnapshot: null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
  });
  await page.goto(`${origin}/merchant/demo/devices`);
  await page.getByText("机台A", { exact: true }).waitFor();
  return { page, context, calls, exceptions, sockets, received, puts, setShopRead: (next) => { shopRead = next; }, setDeletionBlocked: (value) => { deletionBlocked = value; } };
}

const card = (page, name) => page.locator("article", { has: page.getByRole("heading", { name, exact: true }) });
const stateReads = (calls) => calls.filter((call) => call.startsWith("/api/v1/merchant/machines/states"));
const deviceReads = (calls, id) => calls.filter((call) => call.startsWith(`/api/v1/merchant/machines/${id}/state`));
const push = (board, frame) => board.sockets[0].ws.send(JSON.stringify(frame));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ASK = "/api/v1/merchant/machines/states?shopId=shop";

/** Open a device's operate panel and press one of its buttons. */
async function operate(page, name, button) {
  await card(page, name).getByRole("button", { name: "操作", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: button, exact: true }).click();
  return dialog;
}

(async () => {
  const executablePath = process.env.PRISM_CHROMIUM_PATH || (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      const label = viewport.width < 600 ? "mobile" : "desktop";

      const deletion = await openBoard(browser, { watchedIo: false, viewport });
      await card(deletion.page, "机台A").getByRole("button", { name: "编辑", exact: true }).click();
      const editor = deletion.page.getByRole("dialog");
      await editor.getByLabel("资源名称", { exact: true }).fill("");
      await editor.getByRole("button", { name: "删除资源", exact: true }).click();
      await editor.getByText("确定删除资源「机台A」？", { exact: true }).waitFor();
      assert.equal(deletion.calls.filter((call) => call.startsWith("DELETE ")).length, 0);
      await editor.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(await editor.getByLabel("资源名称", { exact: true }).inputValue(), "", "Cancel preserves unsaved edits");
      deletion.setDeletionBlocked(true);
      await editor.getByRole("button", { name: "删除资源", exact: true }).click();
      await editor.getByRole("button", { name: "确认删除资源", exact: true }).click();
      await editor.getByRole("alert").filter({ hasText: "资源已有使用记录，请改为停用" }).waitFor();
      assert.equal(await card(deletion.page, "机台A").count(), 1);
      await editor.getByRole("button", { name: "取消", exact: true }).click();
      deletion.setDeletionBlocked(false);
      await editor.getByRole("button", { name: "删除资源", exact: true }).click();
      await editor.getByRole("button", { name: "确认删除资源", exact: true }).click();
      await editor.waitFor({ state: "hidden" });
      await card(deletion.page, "机台A").waitFor({ state: "hidden" });
      assert.equal(await card(deletion.page, "机台B").count(), 1);
      assert.equal(deletion.calls.filter((call) => call === "DELETE /api/v1/merchant/machines/cab").length, 2);
      assert.equal(deletion.calls.some((call) => call === "PATCH /api/v1/merchant/machines/cab"), false, "Deletion never saves incomplete settings");
      assert.deepEqual(deletion.exceptions.filter((error) => !error.includes("409 (Conflict)")), []);
      await deletion.context.close();
      console.log(`PASS ${label} resource deletion: explicit confirmation, cancel preserves edits, history refusal, list refresh`);

      // One device is live and one has no state of its own.
      const mixed = await openBoard(browser, { watchedIo: false, viewport });
      const { page, calls } = mixed;
      const cab = card(page, "机台A"), io = card(page, "机台B"), door = card(page, "大门");
      await cab.getByText("实时", { exact: true }).waitFor();
      assert.equal(await cab.getByText("已关机").count(), 1, "A live device shows what the hub sent");
      assert.equal(await cab.getByText(/空调：/).count(), 1);
      assert.equal(await door.getByText(/实时/).count(), 0, "A device without power or air conditioner has no tag");
      assert.equal(await card(page, "机台B").getByText("非实时", { exact: true }).count(), 1);
      const refresh = page.getByRole("button", { name: "刷新设备状态" });
      assert.equal(await refresh.count(), 1, "One refresh for the shop, not one per card");

      // The other device's value is what the hub then said Home Assistant answered. The board asks nothing.
      await io.getByText("已开机").waitFor();
      assert.equal(await page.getByText("电源状态未知").count(), 0, "A value is never unknown for being old");
      await pause(300);
      assert.deepEqual(stateReads(calls), [], "The board reads nothing over HTTP while the hub speaks");
      assert.equal(deviceReads(calls, "cab").length + deviceReads(calls, "io").length, 0, "No request per card");
      await page.screenshot({ path: `${output}/device-board-${label}.png`, fullPage: true });

      // One connection for the whole board, opened for the shop.
      await until(() => mixed.sockets.length === 1, "the board's WebSocket");
      assert.equal(new URL(mixed.sockets[0].url).searchParams.get("shopId"), "shop");

      // The hub pushes a change: it shows at once, with no read.
      push(mixed, { type: "state", deviceId: "cab", power: "on" });
      await cab.getByText("已开机").waitFor();
      push(mixed, { type: "state", deviceId: "cab", climate: { ...view, currentTemperature: 29 } });
      await cab.getByText(/室温 29°/).waitFor();
      assert.deepEqual(stateReads(calls), [], "Pushed changes are not read");

      // An action answers with what the device shows now, live or not; nothing is read afterwards.
      let dialog = await operate(page, "机台A", "开机");
      await until(() => calls.includes("POST /api/v1/merchant/machines/cab/actions"), "the action");
      await until(() => calls.filter((call) => call.startsWith("/api/v1/merchant/machines?")).length >= 2, "the device list reloading");
      await pause(300);
      assert.equal(await dialog.getByText("已开机").count() > 0, true, "The panel shows the device's state");
      await dialog.getByRole("button", { name: "关闭" }).click();
      dialog = await operate(page, "机台B", "开机");
      await until(() => calls.includes("POST /api/v1/merchant/machines/io/actions"), "the action");
      // The answer says it is still off: that is what the card shows, not what was asked for.
      await io.getByText("已关机").waitFor();
      assert.equal(await io.getByText("非实时", { exact: true }).count(), 1);
      assert.equal(await page.getByText("电源状态未知").count(), 0);
      await pause(300);
      assert.deepEqual(stateReads(calls), [], "An action reads nothing afterwards");
      assert.equal(deviceReads(calls, "cab").length + deviceReads(calls, "io").length, 0, "An action reads no device afterwards");
      await dialog.getByRole("button", { name: "关闭" }).click();

      // Refreshing asks the backend for the whole shop once and shows what it says, whichever devices are live.
      mixed.setShopRead({ cab: { watching: true, power: "on", climate: view }, io: { watching: false, power: "on" } });
      assert.equal(await refresh.isEnabled(), true);
      await refresh.click();
      await io.getByText("已开机").waitFor();
      assert.equal(await io.getByText("非实时", { exact: true }).count(), 1);
      assert.equal(await cab.getByText("实时", { exact: true }).count(), 1);
      assert.equal(await cab.getByText("已开机").count(), 1);
      assert.deepEqual(stateReads(calls), [ASK], "The refresh is one read of the shop");
      assert.equal(await refresh.isEnabled(), true, "There is always something to refresh");
      await page.screenshot({ path: `${output}/device-board-refreshed-${label}.png`, fullPage: true });

      // Which devices are live changes: the hub sends the labels, keeps each card's last value, then
      // says what Home Assistant answered for the one that stopped being live. The board reads nothing.
      push(mixed, { type: "states", states: { cab: unlabelled, io: { watching: true, power: "off" } }, liveConnections: ["ha_io"] });
      await cab.getByText("非实时", { exact: true }).waitFor();
      await io.getByText("实时", { exact: true }).waitFor();
      assert.equal(await cab.getByText("已开机").count(), 1, "A label alone does not change a value");
      push(mixed, { type: "states", states: { cab: { watching: false, power: "off", climate: view } } });
      await cab.getByText("已关机").waitFor();
      assert.equal(await page.getByText("电源状态未知").count(), 0);
      assert.equal(await io.getByText("已关机").count(), 1);
      await pause(300);
      assert.deepEqual(stateReads(calls), [ASK], "A device that stopped being live is not read by the board");
      await page.screenshot({ path: `${output}/device-board-switched-${label}.png`, fullPage: true });
      assert.deepEqual(mixed.exceptions, []);
      await mixed.context.close();

      // Every device is live: the board still reads nothing on its own, and the refresh is still there.
      const watched = await openBoard(browser, { watchedIo: true, viewport });
      await card(watched.page, "机台B").getByText("实时", { exact: true }).waitFor();
      assert.equal(await card(watched.page, "机台B").getByText("非实时").count(), 0);
      assert.equal(await watched.page.getByRole("button", { name: "刷新设备状态" }).isEnabled(), true);
      await pause(300);
      assert.deepEqual(stateReads(watched.calls), [], "Nothing is read when the hub says everything");
      assert.deepEqual(watched.exceptions, []);
      await watched.context.close();

      // Who is watching Home Assistant. Nothing is shown until the hub says; then each watcher by name and
      // how far it has got, bots first. A shop owner only sees the number of slots.
      const owner = await openBoard(browser, { watchedIo: false, viewport });
      const panel = owner.page.getByRole("region", { name: "HA 监听器" });
      await until(() => owner.sockets.length === 1, "the board's WebSocket");
      await pause(200);
      assert.equal(await panel.count(), 0, "No watcher list before the hub has said anything about it");
      push(owner, { type: "watchers", limit: 2, max: 4, standby: 1, watchers: [
        { id: "bot:1", kind: "bot", name: "前台 Bot", state: "watching" },
        { id: "io", kind: "device", deviceId: "io", state: "starting" },
      ] });
      await panel.getByText("前台 Bot").waitFor();
      assert.equal(await panel.getByText("机台B").count(), 1, "A watching machine is named as the board names it");
      assert.equal(await panel.getByText("监听中").count(), 1);
      assert.equal(await panel.getByText("等待 HA 首次报告…").count(), 1);
      assert.equal(await panel.getByText("2 / 2 个监听器").count(), 1);
      assert.equal(await panel.getByText(/另有 1 个在线/).count(), 1);
      assert.equal(await panel.locator("select").count(), 0, "A shop owner cannot change the number");
      assert.equal(await panel.getByText("由平台管理员设置").count(), 1);
      await owner.page.screenshot({ path: `${output}/device-board-watchers-${label}.png`, fullPage: true });
      // Power-off confirmation retains the task without consuming a normal slot.
      push(owner, { type: "watchers", limit: 2, max: 4, standby: 0, watchers: [
        { id: "bot:1", kind: "bot", name: "前台 Bot", state: "watching" },
        { id: "io", kind: "device", deviceId: "io", state: "confirming" },
        { id: "cab", kind: "device", deviceId: "cab", state: "subscribing" },
      ] });
      await panel.getByText("关机后等待心跳确认（不占名额）").waitFor();
      assert.equal(await panel.getByText("等待 HA 首次报告…").count(), 0);
      assert.equal(await panel.getByText("等待 HA 全量状态…").count(), 1);
      assert.equal(await panel.getByText("2 / 2 个监听器").count(), 1);
      assert.equal(await panel.getByText("3 / 2 个监听器").count(), 0);
      // The hub changes who watches: the list follows, and a watcher that left is gone.
      push(owner, { type: "watchers", limit: 2, max: 4, standby: 0, watchers: [{ id: "io", kind: "device", deviceId: "io", state: "unreachable" }] });
      await panel.getByText("连不上 Home Assistant").waitFor();
      assert.equal(await panel.getByText("前台 Bot").count(), 0);
      push(owner, { type: "watchers", limit: 2, max: 4, standby: 0, watchers: [] });
      await panel.getByText(/没有监听器在线/).waitFor();
      assert.deepEqual(owner.exceptions, []);
      await owner.context.close();

      // The platform administrator can change it, and it is sent for this shop.
      const admin = await openBoard(browser, { watchedIo: false, viewport, role: "admin" });
      const adminPanel = admin.page.getByRole("region", { name: "HA 监听器" });
      await until(() => admin.sockets.length === 1, "the board's WebSocket");
      push(admin, { type: "watchers", limit: 2, max: 4, standby: 0, watchers: [{ id: "bot:1", kind: "bot", name: "前台 Bot", state: "watching" }] });
      const select = adminPanel.getByRole("combobox", { name: "监听器数量" });
      await select.waitFor();
      assert.equal(await select.inputValue(), "2");
      assert.deepEqual(await select.locator("option").allTextContents(), ["1", "2", "3", "4"], "Up to the most the platform allows");
      await select.selectOption("1");
      await until(() => admin.puts.length === 1, "the number being sent");
      assert.deepEqual(admin.puts[0], { path: "/api/v1/merchant/ha-watchers", query: "shopId=shop", body: { count: 1 } });
      await adminPanel.getByText("1 / 1 个监听器").waitFor();
      assert.equal(await select.inputValue(), "1");
      assert.equal(await adminPanel.getByText("由平台管理员设置").count(), 0);
      assert.deepEqual(admin.exceptions, []);
      await admin.context.close();

      console.log(`PASS ${label}: every value from the hub or an answer, never read by the board on its own, labels only label, one refresh for everything`);
    }

    // The hub says nothing: after a moment the board reads the shop over HTTP, once.
    const silent = await openBoard(browser, { watchedIo: false, viewport: { width: 1280, height: 900 }, clock: true, silentHub: true });
    await until(() => silent.sockets.length === 1, "the board's WebSocket");
    assert.deepEqual(stateReads(silent.calls), []);
    await silent.page.clock.fastForward(4_000);
    await until(() => stateReads(silent.calls).length === 1, "the fallback read");
    assert.deepEqual(stateReads(silent.calls), [ASK]);
    await card(silent.page, "机台A").getByText("实时", { exact: true }).waitFor();
    await card(silent.page, "机台B").getByText("非实时", { exact: true }).waitFor();
    await card(silent.page, "机台B").getByText("已开机").waitFor();
    assert.deepEqual(silent.exceptions, []);
    await silent.context.close();
    console.log("PASS a silent hub: one HTTP read as the fallback");

    // The connection drops: nothing is read meanwhile, and the board reconnects. The hub sends the whole
    // shop again, which is how a live device catches up on what it missed.
    const dropped = await openBoard(browser, { watchedIo: false, viewport: { width: 1280, height: 900 }, clock: true });
    await until(() => dropped.sockets.length === 1, "the board's WebSocket");
    await card(dropped.page, "机台B").getByText("已开机").waitFor();
    const reads = stateReads(dropped.calls).length;
    // A keep-alive goes out while it is open.
    await dropped.page.clock.fastForward(31_000);
    await until(() => dropped.received.includes("ping"), "a keep-alive");
    dropped.sockets[0].ws.close();
    await dropped.page.clock.fastForward(16_000);
    await until(() => dropped.sockets.length === 2, "the board reconnecting");
    await pause(300);
    assert.equal(stateReads(dropped.calls).length, reads, "Nothing is read while the connection is down; the hub resends when it is back");
    // What the hub says when it is back shows.
    dropped.sockets[1].ws.send(JSON.stringify({ type: "states", states: { cab: { watching: true, power: "on", climate: view }, io: unlabelled } }));
    await card(dropped.page, "机台A").getByText("已开机").waitFor();
    assert.deepEqual(dropped.exceptions, []);
    await dropped.context.close();
    console.log("PASS keep-alive, reconnect after a drop, and the hub's resend catching the board up without any read");
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });

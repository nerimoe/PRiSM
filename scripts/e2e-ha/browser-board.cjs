/**
 * The merchant device board in a real browser against the real platform, Home Assistant and IO client.
 *
 *   PRISM_PLAYWRIGHT_MODULE=/path/to/playwright node scripts/e2e-ha/browser-board.cjs
 *
 * Nothing is mocked: the page talks to `wrangler dev`, the platform reads Home Assistant in docker, and
 * the live devices are those a real HINATA IO watcher (hinata-aimeio-rs, compiled for macOS) reports.
 * What the platform asked Home Assistant is read back from Home Assistant's own access log.
 */
const { chromium } = require(process.env.PRISM_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

process.chdir(path.resolve(__dirname, "../.."));
const cfg = JSON.parse(fs.readFileSync(".e2e/platform.json", "utf8"));
const { shop, owner, ha, devices } = cfg;
const BASE = "http://localhost:8787"; // the platform's APP_ORIGIN
const output = process.env.PRISM_SCAN_OUTPUT || ".e2e/shots";
const IO_BIN = process.env.IO_SIM || "/Users/neri/Projects/hinata-aimeio-rs/tools/mac-test/target/debug/io_sim";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await pause(50);
  }
  assert.fail(`Timed out waiting for ${what}`);
}
let steps = 0;
const step = (message) => console.log(`  ok    ${message}`) || (steps += 1);

// ---- Home Assistant
const haHeaders = { authorization: `Bearer ${ha.adminToken}`, "content-type": "application/json" };
const haCall = (domain, service, data) => fetch(`${ha.url}/api/services/${domain}/${service}`, { method: "POST", headers: haHeaders, body: JSON.stringify(data) });
function platformReads(since) {
  const out = spawnSync("docker", ["logs", "--since", since, "prism-e2e-ha"], { encoding: "utf8" });
  const reads = [];
  for (const line of `${out.stdout}\n${out.stderr}`.split("\n")) {
    const m = line.match(/\[aiohttp\.access\] \S+ \[[^\]]*\] "GET \/api\/states\/(\S+) HTTP\/[\d.]+" \d+ \d+ "[^"]*" "([^"]*)"/);
    if (m && !/^(Bun|curl|node|undici)(\/|$)/i.test(m[2])) reads.push(m[1]);
  }
  return reads.sort();
}
async function resetHa() {
  await haCall("switch", "turn_on", { entity_id: "switch.decorative_lights" });
  await haCall("switch", "turn_off", { entity_id: "switch.ac" });
  await haCall("input_boolean", "turn_off", { entity_id: "input_boolean.lounge_power" });
  await haCall("climate", "set_hvac_mode", { entity_id: "climate.hvac", hvac_mode: "cool" });
  await haCall("climate", "set_temperature", { entity_id: "climate.hvac", temperature: 21 });
  await haCall("climate", "set_hvac_mode", { entity_id: "climate.heatpump", hvac_mode: "heat" });
  await haCall("climate", "set_temperature", { entity_id: "climate.heatpump", temperature: 20 });
}

// ---- the IO client
const ios = {};
function startIo(name) {
  const fd = fs.openSync(`.e2e/io/${name}.log`, "w");
  ios[name] = spawn(IO_BIN, [], {
    cwd: ".e2e/io",
    env: { ...process.env, SEGATOOLS_CONFIG_PATH: path.resolve(`.e2e/io/${name}.ini`), RUST_LOG: "hinata_mac_test=debug" },
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
}
async function stopIos() {
  spawnSync("pkill", ["-x", "io_sim"]);
  for (const child of Object.values(ios)) child.kill("SIGKILL");
  await pause(500);
}

// ---- the page
const card = (page, name) => page.locator("article", { has: page.getByRole("heading", { name, exact: true }) });
async function operate(page, name, button) {
  await card(page, name).getByRole("button", { name: "操作", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: button, exact: true }).click();
  return dialog;
}

async function openBoard(browser, viewport) {
  const context = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  await context.addCookies([{ name: "arcadelink_session", value: owner.token, url: BASE }]);
  await context.addInitScript((publicId) => sessionStorage.setItem("prism.active-shop", publicId), shop.publicId);
  const page = await context.newPage();
  const board = { page, context, requests: [], sockets: [], frames: [], exceptions: [] };
  page.on("pageerror", (error) => board.exceptions.push(error.message));
  page.on("console", (message) => message.type() === "error" && board.exceptions.push(message.text()));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) board.requests.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  page.on("websocket", (ws) => {
    board.sockets.push(ws.url());
    // A keepalive comes through as plain "pong", not JSON; the board's own
    // protocol frames are the interesting ones.
    ws.on("framereceived", ({ payload }) => {
      try { board.frames.push(JSON.parse(String(payload))); } catch { /* keepalive */ }
    });
  });
  await page.goto(`${BASE}/merchant/${shop.publicId}/devices`);
  await page.getByRole("heading", { name: "机台A", exact: true }).waitFor();
  return board;
}
const states = (board) => board.requests.filter((r) => r.startsWith("GET /api/v1/merchant/machines/states"));
const oneDevice = (board, id) => board.requests.filter((r) => r.startsWith(`GET /api/v1/merchant/machines/${id}/state`));

(async () => {
  const executablePath = process.env.PRISM_CHROMIUM_PATH;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  fs.mkdirSync(output, { recursive: true });
  try {
    await stopIos();
    await resetHa();
    await until(() => spawnSync("scripts/e2e-ha/d1.sh", ["SELECT count(*) AS n FROM ha_event_connections"], { encoding: "utf8" }).stdout.includes('"n": 0'), "nothing live", 20000);

    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const label = viewport.width < 600 ? "mobile" : "desktop";
      console.log(`\n== ${label}`);
      await stopIos();
      await resetHa();
      await until(() => spawnSync("scripts/e2e-ha/d1.sh", ["SELECT count(*) AS n FROM ha_event_connections"], { encoding: "utf8" }).stdout.includes('"n": 0'), "nothing live", 20000);
      await pause(500);

      // 1. No IO: every device is 非实时 and shows what Home Assistant says, which the hub asked for the board.
      const since = new Date().toISOString();
      const board = await openBoard(browser, viewport);
      const { page } = board;
      const A = card(page, "机台A"), B = card(page, "机台B"), L = card(page, "休息室");
      await A.getByText("已开机").waitFor();
      await B.getByText("已关机").waitFor();
      await L.getByText("已关机").waitFor();
      for (const c of [A, B, L]) assert.equal(await c.getByText("非实时", { exact: true }).count(), 1);
      assert.equal(await page.getByText("电源状态未知").count(), 0);
      await A.getByText(/空调：.*21°/).waitFor();
      step("没有 IO：三台设备都是「非实时」，值来自 HA（A 开机 / B 关机 / 休息室 关机 / A 空调 21°）");
      await until(() => board.sockets.length === 1, "the board's WebSocket");
      assert.equal(new URL(board.sockets[0]).searchParams.get("shopId"), shop.id);
      assert.equal(states(board).length, 0, "the board reads nothing over HTTP while the hub speaks");
      assert.equal(oneDevice(board, devices.a.id).length + oneDevice(board, devices.lounge.id).length, 0);
      await pause(500);
      const entered = platformReads(since);
      assert.deepEqual(entered, ["climate.heatpump", "climate.hvac", "input_boolean.lounge_power", "switch.ac", "switch.decorative_lights"]);
      step(`进入页面：只有 1 条 WebSocket，没有 HTTP 读取；Hub 替看板读 HA，每个实体恰好 1 次`);
      await page.screenshot({ path: `${output}/board-1-nonlive-${label}.png`, fullPage: true });

      // 2. A real IO comes up: the tags flip to 实时 by themselves, without the page asking anything.
      const before = board.requests.length;
      startIo("a");
      await A.getByText("实时", { exact: true }).waitFor({ timeout: 20000 });
      await B.getByText("实时", { exact: true }).waitFor();
      assert.equal(await L.getByText("非实时", { exact: true }).count(), 1, "the lounge has no watcher");
      assert.equal(board.requests.length, before, "the flip came over the WebSocket, not over HTTP");
      step("IO 上线：A、B 自动变成「实时」，休息室仍是「非实时」；页面没有发任何请求");
      await page.screenshot({ path: `${output}/board-2-live-${label}.png`, fullPage: true });

      // 3. Home Assistant changes: the live devices follow at once, over the WebSocket only.
      //    The changes are to B and to A's air conditioner, not to A's own power: switching
      //    off the machine the watcher runs on is a power-off, which is step 3b's subject.
      const marker = board.requests.length;
      await haCall("switch", "turn_on", { entity_id: "switch.ac" });
      await B.getByText("已开机").waitFor({ timeout: 3000 });
      await haCall("climate", "set_temperature", { entity_id: "climate.hvac", temperature: 24 });
      await A.getByText(/空调：.*24°/).waitFor({ timeout: 3000 });
      assert.equal(board.requests.length, marker, "live changes cause no request");
      step("HA 里改电源/空调温度：A、B 的卡片立刻更新，页面没有发请求");

      // 3b. The machine the only watcher runs on goes dark. Its assignment is kept and its
      //     word stops being taken for the present, so the hub asks Home Assistant for the
      //     board until that IO reports again. The board itself reads nothing.
      const beforeDark = states(board).length;
      await haCall("switch", "turn_off", { entity_id: "switch.decorative_lights" });
      await A.getByText("已关机").waitFor({ timeout: 3000 });
      // The page is what the shop sees: A goes 非实时 and comes back by itself, and
      // neither move costs a new subscription (checked from the IO's own log after).
      await A.getByText("非实时", { exact: true }).waitFor({ timeout: 15000 });
      step("关机台A：卡片变成「非实时」，订阅没有被撤掉");
      await A.getByText("实时", { exact: true }).waitFor({ timeout: 90000 });
      assert.equal(states(board).length, beforeDark, "going dark and coming back cost the board no read");
      step("IO 继续上报：自动回到「实时」，用的是原来的订阅（没有重新下发）；看板始终没有自己读");

      // A device with no state of its own does not move on its own.
      await haCall("input_boolean", "turn_on", { entity_id: "input_boolean.lounge_power" });
      await pause(2500);
      assert.equal(await L.getByText("已关机").count(), 1, "the lounge stays as last read");
      assert.equal(await L.getByText("已开机").count(), 0);
      step("休息室（非实时）在 HA 里被打开：页面不动，仍显示上次读到的「已关机」");

      // 4. The refresh button asks the backend for the whole shop; the backend asks Home Assistant only for the lounge.
      const t0 = new Date().toISOString();
      const refresh = page.getByRole("button", { name: "刷新设备状态" });
      await refresh.click();
      await L.getByText("已开机").waitFor({ timeout: 8000 });
      await pause(500);
      assert.equal(states(board).length, 1, "the refresh is the board's only read of the shop");
      assert.deepEqual(platformReads(t0), ["climate.heatpump", "input_boolean.lounge_power"]);
      assert.equal(await A.getByText("实时", { exact: true }).count(), 1);
      step("点「刷新设备状态」：一次整店读取，休息室变成「已开机」；后端只向 HA 读了休息室两个实体");

      // 5. Operating a live device: the answer carries the read-back from storage, and nothing asks Home Assistant.
      const t1 = new Date().toISOString();
      const m1 = board.requests.length;
      let dialog = await operate(page, "机台A", "开机");
      await A.getByText("已开机").waitFor({ timeout: 5000 });
      await pause(800);
      const after = board.requests.slice(m1);
      assert.equal(after.filter((r) => r.startsWith("GET") && /machines\/(states|[^/?]+\/state)/.test(r)).length, 0, `no state read after operating a live device: ${after}`);
      assert.deepEqual(platformReads(t1).filter((e) => /decorative_lights|hvac|switch\.ac/.test(e)), []);
      await dialog.getByRole("button", { name: "关闭" }).click();
      step("面板里操作实时设备 A（开机）：卡片按响应的读回和推送更新，没有任何读取请求，HA 也没收到 A 的读取");

      // 6. Operating a device with no state of its own: the backend reads it back from Home Assistant and the answer carries it.
      const t2 = new Date().toISOString();
      const m2 = board.requests.length;
      dialog = await operate(page, "休息室", "关机");
      await L.getByText("已关机").waitFor({ timeout: 8000 });
      await pause(500);
      const lounge = board.requests.slice(m2).filter((r) => r.startsWith("GET") && /machines\/(states|[^/?]+\/state)/.test(r));
      assert.deepEqual(lounge, [], "the board reads nothing after an action");
      const loungeReads = platformReads(t2);
      assert.equal(loungeReads.length > 0 && loungeReads.every((e) => /lounge_power|heatpump/.test(e)), true, `${loungeReads}`);
      await dialog.getByRole("button", { name: "关闭" }).click();
      step("面板里操作非实时设备（休息室关机）：响应带后端的读回，看板不发请求；HA 只收到休息室的读取");

      // 7. The IO goes away: the tags go back to 非实时 at once, nothing turns into "unknown", and the
      //    hub asks Home Assistant for A and B and tells the board.
      await stopIos();
      await A.getByText("非实时", { exact: true }).waitFor({ timeout: 8000 });
      await B.getByText("非实时", { exact: true }).waitFor();
      assert.equal(await page.getByText("电源状态未知").count(), 0);
      assert.equal(await A.getByText("已开机").count(), 1, "A keeps the last value it had");
      await A.getByText(/空调：.*24°/).waitFor();
      assert.equal(await B.getByText("已开机").count(), 1);
      assert.equal(states(board).length, 1, "the board did not read the shop itself");
      step("IO 掉线：A、B 立刻变成「非实时」，值与 HA 一致（A 已开机 24° / B 已开机），没有「未知」，看板没有自己读");
      await page.screenshot({ path: `${output}/board-3-after-${label}.png`, fullPage: true });

      // 8. Now stale until refreshed; a refresh reads all three.
      await haCall("switch", "turn_off", { entity_id: "switch.decorative_lights" });
      await pause(2000);
      assert.equal(await A.getByText("已开机").count(), 1, "no push once not live");
      const t3 = new Date().toISOString();
      await refresh.click();
      await A.getByText("已关机").waitFor({ timeout: 8000 });
      await pause(500);
      assert.deepEqual(platformReads(t3), ["climate.heatpump", "climate.hvac", "input_boolean.lounge_power", "switch.ac", "switch.decorative_lights"]);
      step("非实时之后 HA 的变化不会推到页面；点刷新后三台都从 HA 重读，A 变成「已关机」");

      assert.deepEqual(board.exceptions, [], "no page errors");
      step("页面没有报错、控制台没有 error");
      await board.context.close();
    }
  } finally {
    await stopIos();
    await browser.close();
  }
  console.log(`\n${steps} browser checks passed`);
})().catch((error) => {
  console.error(error);
  spawnSync("pkill", ["-x", "io_sim"]);
  process.exit(1);
});

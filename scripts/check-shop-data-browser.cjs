const { chromium } = require(process.env.PRISM_PLAYWRIGHT_MODULE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = process.env.PRISM_BROWSER_ORIGIN || 'http://127.0.0.1:4173';
const output = process.env.PRISM_SHOP_DATA_OUTPUT || '.scan-check';
fs.mkdirSync(output, { recursive: true });
const shop = { id: 'shop', publicId: 'demo', name: '目标测试店铺', timeZone: 'Asia/Tokyo', latitude: 35, longitude: 139, radiusMeters: 80 };
const backup = {
  format: 'prism-shop-data', version: 1, scope: 'business', exportedAt: '2026-10-06T02:08:00.000Z',
  source: { publicId: 'beta-shop', name: '来源店铺', timeZone: 'Asia/Shanghai', origin: 'https://beta.example.com' },
  storage: { timeZone: 'UTC', money: 'minor-units' }, settings: {},
  tables: { players: [{ id: 'p', display_name: '玩家' }], asset_holdings: [{ quantity: 12345 }], sessions: [{ started_at: '2026-10-06T02:08:00.000Z' }] },
};
(async () => {
  const executablePath = process.env.PRISM_CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'America/Los_Angeles' });
    const errors = [], applies = [], previews = [], exports = [];
    let canImport = false, owner = true, imported = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url()), pathname = url.pathname;
      let data;
      if (pathname.endsWith('/data/export')) {
        exports.push(url.searchParams.get('scope'));
        return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="prism-beta-shop.json"' }, body: JSON.stringify(backup, null, 2) });
      }
      if (pathname.endsWith('/data/import/preview')) {
        previews.push(req.postDataJSON());
        data = { canImport, fingerprint: 'a'.repeat(43), scope: 'business', source: backup.source,
          counts: { players: 1, asset_holdings: 1, asset_ledger_entries: 27, sessions: 1 },
          errors: canImport ? [] : ['目标店铺已有玩家、账单、配置或设备，请选择空店铺导入'],
          warnings: ['仅导入空店铺，保留目标店铺的名称、位置、时区、封面和管理员。'] };
      } else if (pathname.endsWith('/data/import/apply')) {
        applies.push(req.postDataJSON());
        if (applies.length === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '操作失败，请稍后重试' } }) });
        imported = true; data = { imported: true };
      } else if (pathname === '/api/v1/me') data = { user: { id: 'owner', username: 'owner', displayName: '店主', role: 'user', hasShops: true } };
      else if (pathname === '/api/v1/merchant/shops') data = { shops: [shop] };
      else if (pathname === '/api/v1/merchant/shop-members') data = { members: [] };
      else if (pathname === '/api/v1/shops/demo') data = { shop: { ...shop, billingEnabled: imported, cashierEnabled: false } };
      else if (pathname.endsWith('/staff/me')) data = { staff: { canWrite: owner, role: owner ? 'owner' : 'viewer' } };
      else if (pathname.endsWith('/staff/pricing-configs')) data = { pricingConfigs: [] };
      else if (pathname.endsWith('/staff/presents')) data = { presents: [] };
      else if (pathname.endsWith('/staff/api-tokens')) data = { apiTokens: [] };
      else if (pathname.endsWith('/staff/settings')) data = { settings: {
        store: { name: shop.name, timeZone: shop.timeZone }, operations: { coinCooldownMs: 60000 }, registration: { defaultPresentId: null },
        homeAssistantConnection: { url: '', token: '' }, homeAssistantDevices: [], ttLockDevices: [], hinataIoDevices: [],
      } };
      else if (pathname.endsWith('/settings')) data = { billingEnabled: imported, cashierEnabled: false, autoRegister: true, identityBindingRequired: true,
        locationEnabled: false, checkinGeo: false, checkoutGeo: false, machineGeo: false, entryPricingIds: [], botContact: '',
        billingConfiguration: { ready: false, balanceAssetsReady: false, entryPricingReady: false, invalidEntryPricingIds: [] } };
      else data = {};
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    await page.goto(origin + '/merchant/demo/settings?group=data');
    const download = page.getByRole('button', { name: '下载 JSON 文件', exact: true });
    await download.waitFor();
    assert.equal(await page.getByRole('button', { name: '预检导入', exact: true }).isEnabled(), false);
    const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
    assert.equal(file.suggestedFilename(), 'prism-beta-shop.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(await file.path(), 'utf8')), backup);
    assert.deepEqual(exports, ['business']);
    await page.locator('select').filter({ has: page.getByRole('option', { name: '仅店铺配置（不含玩家和账单）', exact: true }) }).selectOption('configuration');
    await Promise.all([page.waitForEvent('download'), download.click()]);
    assert.deepEqual(exports, ['business', 'configuration']);
    const input = page.getByLabel('JSON 备份文件', { exact: true });
    await input.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
    await page.getByRole('alert').filter({ hasText: '请选择有效的 JSON 备份文件' }).waitFor();
    await input.setInputFiles({ name: 'beta-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.getByRole('button', { name: '预检导入', exact: true }).click();
    await page.getByText('预检未通过，请处理上述问题后重试。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认导入', exact: true }).count(), 0);
    canImport = true;
    await page.getByRole('button', { name: '预检导入', exact: true }).click();
    await page.getByText('预检通过，可以确认导入。', { exact: true }).waitFor();
    assert.ok(await page.getByText('来源环境: https://beta.example.com', { exact: true }).isVisible());
    assert.deepEqual(previews[0].backup, backup);
    await page.screenshot({ path: path.join(output, 'shop-data-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认导入店铺数据', exact: true });
    await dialog.waitFor();
    await page.screenshot({ path: path.join(output, 'shop-data-mobile-confirm.png'), fullPage: true });
    await dialog.getByRole('button', { name: '开始导入', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('alert').filter({ hasText: '操作失败，请稍后重试' }).waitFor();
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await dialog.getByRole('button', { name: '开始导入', exact: true }).click();
    await page.getByText('导入完成，请检查计费设置并重新配置设备与接入凭据。', { exact: true }).waitFor();
    assert.equal(applies.length, 2);
    assert.deepEqual(applies[0], applies[1]);
    assert.deepEqual(applies[1].backup, backup);
    assert.ok(applies[1].operationId);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.evaluate(() => localStorage.setItem('prism.locale', 'en'));
    await page.reload();
    await page.getByRole('button', { name: 'Download JSON file', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Data management', exact: true }).waitFor();
    owner = false; await page.reload();
    await page.getByRole('combobox', { name: 'Switch store', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Download JSON file', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: 'raw UTC JSON download, business/configuration scopes, invalid files, failed preflight, source identification, confirmation, same-operation retries, mobile and English UI, owner-only access', errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

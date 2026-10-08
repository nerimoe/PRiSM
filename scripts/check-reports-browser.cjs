const { chromium } = require(process.env.PRISM_PLAYWRIGHT_MODULE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = process.env.PRISM_BROWSER_ORIGIN || 'http://127.0.0.1:4173';
const output = process.env.PRISM_SCAN_OUTPUT || '.scan-check';
fs.mkdirSync(output, { recursive: true });
const shop = { id: 'shop', publicId: 'demo', name: '营业记录测试', timeZone: 'Asia/Shanghai', latitude: 31, longitude: 121, radiusMeters: 80 };
const startedAt = '2026-10-07T01:00:00Z', endedAt = '2026-10-07T02:15:00Z';
const record = { checkoutId: 'bill:1', playerId: 'player-1', playerDisplayName: '历史玩家', startedAt, endedAt, settledAt: '2026-10-07T03:00:00Z', durationMinutes: 150, sessionCount: 2, subtotal: 24, total: 19, archived: false, updatedAt: null, updatedBy: null, externalPayment: { method: 'cash', staffId: 'cashier-id', collectedAt: '2026-10-07T03:00:00Z' } };
const receipt = { playerSettlement: { total: 19, settledAt: record.settledAt }, wallet: { balanceAfter: 81 },
  settlements: ['entry-id', 'table-id'].map(sessionId => ({ settlement: { sessionId, startedAt, endedAt } })),
  chargeItems: [{ label: '旧方案入场', amount: 12 }, { label: '旧方案机台', amount: 12 }], adjustments: [{ label: '历史整单优惠', amount: -5 }],
  timeline: { tracks: [{ id: 'entry-id', name: '旧入场方案', lane: 0, color: 0, startedAt, endedAt }],
    totals: [{ name: '旧入场方案', amount: 24 }, { name: '历史整单优惠', amount: -5 }],
    events: [{ at: endedAt, time: '02:15', date: '2026-10-07', entries: [{ trackId: 'entry-id', kind: 'end', name: '旧入场方案', rule: '历史日间', startedAt, endedAt, amount: 24, unitMinutes: 60, unitPrice: 12, units: 2 }, { trackId: null, kind: 'adjustment', name: '历史整单优惠', amount: -5 }] },
      { at: startedAt, time: '01:00', date: '2026-10-07', entries: [{ trackId: 'entry-id', kind: 'start', name: '旧入场方案', rule: '历史日间' }] }] } };
(async () => {
  const executablePath = process.env.PRISM_CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'America/New_York' });
    let canWrite = true, detailReads = 0, failArchive = true;
    const errors = [], mutations = [], ranges = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url()), pathname = url.pathname;
      let data;
      if (pathname === '/api/v1/me') data = { user: { id: 'owner', username: 'owner', displayName: '店员', role: 'user', hasShops: true } };
      else if (pathname === '/api/v1/merchant/shops') data = { shops: [shop] };
      else if (pathname === '/api/v1/shops/demo') data = { shop: { ...shop, billingEnabled: true, cashierEnabled: true } };
      else if (pathname.endsWith('/staff/me')) data = { staff: { role: 'staff', staffRole: canWrite ? 'manager' : 'viewer' } };
      else if (pathname.endsWith('/reports/summary')) data = { summary: { revenueTotal: record.archived ? 0 : 19, sessionCount: 2, assetGrantTotal: 0, coinCommandCount: 0 } };
      else if (pathname.endsWith('/reports/checkouts')) {
        ranges.push({ from: url.searchParams.get('from'), to: url.searchParams.get('to') });
        const filter = url.searchParams.get('archive');
        data = { records: filter === 'all' || (filter === 'archived') === record.archived ? [record] : [], page: { hasMore: false } };
      } else if (pathname.endsWith('/archive')) {
        if (failArchive) {
          failArchive = false;
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ARCHIVE_FAILED', message: '归档失败，请重试' } }) }); return;
        }
        const body = req.postDataJSON(); mutations.push(body);
        record.archived = body.archived; record.updatedAt = '2026-10-07T04:00:00Z'; record.updatedBy = 'manager';
        data = { archived: record.archived };
      } else if (pathname.includes('/reports/checkouts/')) { detailReads++; data = { record, receipt }; }
      else data = {};
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    await page.goto(origin + '/merchant/demo/reports');
    await page.getByRole('button', { name: '账单详情', exact: true }).filter({ visible: true }).waitFor();
    await page.locator('input[type="date"]').first().fill('2026-10-07');
    await page.locator('input[type="date"]').last().fill('2026-10-07');
    await page.getByRole('button', { name: '账单详情', exact: true }).filter({ visible: true }).waitFor();
    assert.equal(await page.locator('tbody tr:visible').count(), 1);
    assert.equal(await page.locator('dl').first().locator('dd').first().textContent(), '19.00');
    await page.getByRole('button', { name: '账单详情', exact: true }).filter({ visible: true }).click();
    const dialog = page.getByRole('dialog', { name: '账单详情', exact: true });
    await dialog.getByRole('heading', { name: '完整时间轴' }).waitFor();
    assert.deepEqual(await dialog.locator('.bill-event time').allTextContents(), ['10:15', '09:00']);
    assert.ok(await dialog.getByText('cashier-id', { exact: true }).isVisible());
    assert.ok(await dialog.getByText('历史整单优惠', { exact: false }).first().isVisible());
    await dialog.getByText('计时与收费明细', { exact: true }).click();
    assert.ok(await dialog.getByText('计时 ID · table-id', { exact: true }).isVisible());
    await dialog.screenshot({ path: path.join(output, 'merchant-bill-timeline.png') });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await page.getByRole('columnheader', { name: '归档状态', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, 'merchant-report-quick-archive.png'), fullPage: true });
    const readsBeforeArchive = detailReads;
    await page.getByRole('button', { name: '归档账单', exact: true }).filter({ visible: true }).click();
    await page.getByRole('alert').filter({ hasText: '操作失败，请稍后重试' }).filter({ visible: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '归档账单', exact: true }).filter({ visible: true }).isEnabled(), true);
    await page.getByRole('button', { name: '归档账单', exact: true }).filter({ visible: true }).click();
    await page.getByText('暂无记录', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('dl dd')?.textContent === '0.00');
    assert.equal(await page.locator('dl').first().locator('dd').nth(1).textContent(), '2');
    await page.getByLabel('归档筛选').selectOption('archived');
    await page.getByRole('button', { name: '恢复账单', exact: true }).filter({ visible: true }).click();
    assert.equal(detailReads, readsBeforeArchive);
    await page.getByText('暂无记录', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('dl dd')?.textContent === '19.00');
    assert.deepEqual(mutations.map(m => m.archived), [true, false]);
    assert.ok(ranges.some(r => r.from === '2026-10-06T16:00:00.000Z' && r.to === '2026-10-07T16:00:00.000Z'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('归档筛选').selectOption('all');
    await page.getByRole('button', { name: '归档账单', exact: true }).filter({ visible: true }).click();
    await page.getByRole('button', { name: '恢复账单', exact: true }).filter({ visible: true }).click();
    await page.getByRole('button', { name: '归档账单', exact: true }).filter({ visible: true }).waitFor();
    assert.equal(detailReads, readsBeforeArchive);
    await page.screenshot({ path: path.join(output, 'merchant-report-quick-archive-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '账单详情', exact: true }).filter({ visible: true }).click();
    await dialog.getByRole('heading', { name: '完整时间轴' }).waitFor();
    await dialog.screenshot({ path: path.join(output, 'merchant-bill-timeline-mobile.png') });
    canWrite = false;
    await page.goto(origin + '/merchant/demo/reports');
    await page.getByRole('button', { name: '账单详情', exact: true }).filter({ visible: true }).click();
    await dialog.getByRole('heading', { name: '完整时间轴' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '归档账单', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('Reports browser checks passed: grouped receipts, full shop-time timeline, archive/restore revenue, unchanged counts, mobile and viewer access.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

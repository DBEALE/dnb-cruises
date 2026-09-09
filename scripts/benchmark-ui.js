'use strict';

// Profile the locally available provider snapshots without contacting providers.
// --baseline serves app.js from HEAD for a like-for-like comparison.
const { chromium } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../server');

async function run() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => route.request().url().startsWith(origin)
      ? route.continue() : route.abort());
    if (process.argv.includes('--baseline')) {
      const source = execFileSync('git', ['show', 'HEAD:public/app.js'], { encoding: 'utf8' });
      await page.route('**/app.js', route => route.fulfill({ contentType: 'text/javascript', body: source }));
    }
    await page.goto(origin);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => allCruises.length > 0 && document.querySelectorAll('#cruiseBody tr').length >= Math.min(300, allCruises.length));
    const session = await page.context().newCDPSession(page);
    await session.send('Profiler.enable');
    await session.send('Profiler.start');
    const results = await page.evaluate(() => {
      const rows = [...allCruises].sort((a, b) => getLowestRoomPrice(a) - getLowestRoomPrice(b)).slice(0, 300);
      const measure = fn => {
        const times = [];
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          fn();
          times.push(Math.round((performance.now() - start) * 10) / 10);
        }
        return times;
      };
      return {
        cruises: allCruises.length,
        historyEntries: allCruises.reduce((sum, c) => sum + (c.priceHistory?.length || 0), 0),
        rows: rows.length,
        rowHtmlMs: measure(() => renderRowsHtml(rows, 0, rows.length, {})),
        onwardChecksMs: measure(() => rows.forEach(cruiseHasOnwardOptions)),
        filterAndFirstChunkMs: measure(() => applyFilters()),
      };
    });
    const { profile } = await session.send('Profiler.stop');
    const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame.functionName || '(anonymous)']));
    const totals = new Map();
    profile.samples.forEach((id, i) => {
      const name = nodes.get(id);
      totals.set(name, (totals.get(name) || 0) + profile.timeDeltas[i]);
    });
    results.cpuTopMs = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, us]) => [name, Math.round(us / 1000)]);
    console.log(JSON.stringify(results, null, 2));
    if (!process.argv.includes('--baseline')) {
      const directory = path.join(__dirname, '../docs/screenshots');
      fs.mkdirSync(directory, { recursive: true });
      await page.waitForFunction(() => document.querySelectorAll('#cruiseBody tr').length >= Math.min(300, allCruises.length));
      await page.screenshot({ path: path.join(directory, 'performance-loaded-desktop.png') });
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });

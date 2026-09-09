'use strict';

// Exercise the mobile filter sheet with all locally available provider data.
const { chromium } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const app = require('../server');

async function run() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    if (process.argv.includes('--baseline')) {
      for (const file of ['app.js', 'styles.css', 'index.html']) {
        const source = execFileSync('git', ['show', `HEAD:public/${file}`], { encoding: 'utf8' });
        await page.route(file === 'index.html' ? origin + '/' : `**/${file}`, route => route.fulfill({
          contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: source,
        }));
      }
    }
    await page.goto(origin);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => allCruises.length > 0 && document.querySelectorAll('#cruiseBody tr').length === Math.min(300, allCruises.length));
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => {
      window.__filterMetrics = { cruises: allCruises.length, renders: 0, longTasks: [] };
      window.__filterPhase = 'opening';
      const render = renderBody;
      renderBody = (...args) => { window.__filterMetrics.renders++; return render(...args); };
      window.__filterPerfObserver = new PerformanceObserver(list => {
        window.__filterMetrics.longTasks.push(...list.getEntries().map(entry => ({ phase: window.__filterPhase, ms: Math.round(entry.duration) })));
      });
      window.__filterPerfObserver.observe({ type: 'longtask' });
    });
    await page.click('#mobFilterToggle');
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.__filterPhase = 'controls'; });
    for (const value of ['11', '18', '1', '11']) {
      await page.selectOption('#mobileSortSelect', value);
      await page.waitForTimeout(650);
    }
    await page.locator('#mobFilterItinerary').fill('Caribbean');
    await page.waitForTimeout(650);
    const result = await page.evaluate(() => {
      window.__filterPerfObserver.disconnect();
      return window.__filterMetrics;
    });
    console.log(JSON.stringify(result, null, 2));
    if (!process.argv.includes('--baseline')) {
      await page.screenshot({ path: path.join(__dirname, '../docs/screenshots/filters-responsive-mobile.png') });
    }
    await page.click('#mobFiltersClose');
    await page.waitForFunction(() => document.querySelector('#summaryText')?.textContent?.includes('Caribbean') || document.querySelector('.summary-bar')?.textContent?.includes('Caribbean'));
    if (!process.argv.includes('--baseline')) {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.waitForFunction(() => document.querySelectorAll('#cruiseBody tr').length === Math.min(300,
        allCruises.filter(c => searchMeta(c).itinerary.includes('caribbean')).length));
      await page.screenshot({ path: path.join(__dirname, '../docs/screenshots/filters-responsive-desktop.png') });
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

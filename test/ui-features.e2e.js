'use strict';

// E2E coverage for the post-MVP features: sparklines + price-history dialog,
// filter / sort / per-cabin sort, URL state, settings dialog with localStorage.
//
// All tests stub out the provider catalog and cruises.json so they don't
// depend on the live data file (which is gitignored and might be absent
// locally) and so the assertions are deterministic.

const { test, expect } = require('@playwright/test');

const PROVIDER_INDEX = {
  defaultProviderId: 'royal-caribbean',
  providers: [
    { id: 'royal-caribbean', name: 'Royal Caribbean', cruisesUrl: './providers/royal-caribbean/cruises.json' },
    { id: 'celebrity-cruises', name: 'Celebrity Cruises', cruisesUrl: './providers/celebrity-cruises/cruises.json' },
  ],
};

// Helper — build a cruise with the priceHistory shape the UI expects.
function cruise({ id, shipName, provider, priceFrom, prices, history, days = 7, port = 'Southampton' }) {
  return {
    id, shipName, provider,
    shipClass:       'Oasis',
    shipLaunchYear:  2020,
    itinerary:       `${days}-Night ${port} Sample`,
    departureDate:   '2026-09-01',
    duration:        `${days} Nights`,
    departurePort:   port,
    departureRegion: 'UK & Ireland',
    destination:     'Northern Europe',
    priceFrom:       String(priceFrom),
    currency:        'GBP',
    bookingUrl:      `/booking/${id}`,
    prices:          prices || { inside: null, oceanView: null, balcony: null, suite: null },
    priceHistory:    history || [],
  };
}

const CRUISES_RC = {
  scrapedAt: '2026-05-31T10:00:00Z',
  cruises: [
    cruise({
      id: 'rc_a', shipName: 'Anthem of the Seas', provider: 'Royal Caribbean',
      priceFrom: 500, days: 7,
      prices: { inside: '500', oceanView: '650', balcony: '800', suite: '1800' },
      history: [
        { at: '2026-05-01T10:00:00Z', prices: { inside: 600, oceanView: 720, balcony: 900, suite: 2000 } },
        { at: '2026-05-15T10:00:00Z', prices: { inside: 550, oceanView: 680, balcony: 850, suite: 1900 } },
        { at: '2026-05-31T10:00:00Z', prices: { inside: 500, oceanView: 650, balcony: 800, suite: 1800 } },
      ],
    }),
    cruise({
      id: 'rc_b', shipName: 'Harmony of the Seas', provider: 'Royal Caribbean',
      priceFrom: 1200, days: 14,
      prices: { inside: '1200', oceanView: '1500', balcony: '1800', suite: '3500' },
      history: [
        { at: '2026-05-01T10:00:00Z', prices: { inside: 1100, oceanView: 1400, balcony: 1700, suite: 3400 } },
        { at: '2026-05-31T10:00:00Z', prices: { inside: 1200, oceanView: 1500, balcony: 1800, suite: 3500 } },
      ],
    }),
  ],
};

const CRUISES_CEL = {
  scrapedAt: '2026-05-31T10:00:00Z',
  cruises: [
    cruise({
      id: 'cel_a', shipName: 'Celebrity Edge', provider: 'Celebrity Cruises',
      priceFrom: 900, days: 10, port: 'Barcelona',
      prices: { inside: '900', oceanView: null, balcony: '1300', suite: '2500' },
    }),
  ],
};

// Stub every network call so the test exercises the UI in isolation.
async function setupRoutes(page) {
  await page.route('**/providers/index.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVIDER_INDEX) }));
  await page.route('**/providers/royal-caribbean/cruises.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CRUISES_RC) }));
  await page.route('**/providers/celebrity-cruises/cruises.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CRUISES_CEL) }));
  await page.route('**/ship-wiki-links.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ships: {}, providers: {}, classes: {} }) }));
  await page.route('**/build-info.json', r => r.fulfill({ status: 404, body: '' }));
  await page.route('**/open.er-api.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rates: { GBP: 1 } }) }));
}

// Pre-seed display settings before the page boots. Pass `null` to leave
// localStorage untouched so first-time-visitor defaults apply.
async function gotoFresh(page, settings = null) {
  if (settings) {
    await page.addInitScript((s) => {
      localStorage.setItem('cruise-explorer-settings', JSON.stringify(s));
    }, settings);
  }
  await setupRoutes(page);
  await page.goto('/');
  await page.waitForSelector('tbody tr:not(.empty-row)');
}

// Settings preset for tests that need sparklines + per-night visible
// (they're off by default for first-time visitors).
const ALL_ON = { sparklines: true, perNight: true, wikiLinks: true, classDots: true, launchYear: true };

test.describe('Sparklines', () => {
  test('per-cabin sparklines render as lazy placeholders and fill on intersection', async ({ page }) => {
    await gotoFresh(page, ALL_ON);
    // Anthem (3 history points) → 4 cabin sparks; Harmony (2 points) → 4 cabin sparks
    const sparkCount = await page.locator('.cabin-spark').count();
    expect(sparkCount).toBeGreaterThanOrEqual(8);
    // First viewport's placeholders should have filled with SVGs synchronously.
    await page.waitForFunction(() => document.querySelector('.cabin-spark[data-spark-filled="1"]') !== null);
    expect(await page.locator('.cabin-spark svg').count()).toBeGreaterThan(0);
  });

  test('clicking a sparkline opens the price-history dialog with multi-cabin chart', async ({ page }) => {
    await gotoFresh(page, ALL_ON);
    await page.locator('.cabin-spark').first().click();
    await page.waitForSelector('dialog#priceHistoryDialog[open]');
    const legend = await page.locator('#phChart .ph-legend-item').allTextContents();
    expect(legend).toEqual(expect.arrayContaining(['Inside', 'Sea view', 'Balcony', 'Suite']));
    // Chart path per cabin
    expect(await page.locator('#phChart svg path').count()).toBe(4);
    // Earliest at the top
    const firstRowDate = await page.locator('#phTableBody tr:first-child td:first-child').innerText();
    expect(firstRowDate).toMatch(/1 May/);
  });
});

test.describe('Sort and filter', () => {
  test('sort dropdown + direction toggle reorders rows', async ({ page }) => {
    await gotoFresh(page);
    // Picking from the dropdown applies ascending by default; the toggle
    // button flips direction.
    await page.selectOption('#sortSelect', '17');        // £/night, ascending
    await page.click('#sortDirBtn');                     // flip to descending
    // Harmony 14n £1200 = £85/n, Anthem 7n £500 = £71/n, Edge 10n £900 = £90/n
    // Edge (90) > Harmony (85) > Anthem (71)
    const firstShip = await page.locator('tbody tr:first-child .col-ship').innerText();
    expect(firstShip).toContain('Celebrity Edge');
    // Direction button reflects the flipped state
    await expect(page.locator('#sortDirBtn')).toHaveText('↓');
  });

  test('per-cabin sort uses that cabin\'s price', async ({ page }) => {
    await gotoFresh(page);
    await page.selectOption('#sortSelect', '15');        // Suite, ascending
    // Anthem suite 1800, Edge suite 2500, Harmony suite 3500
    const firstShip = await page.locator('tbody tr:first-child .col-ship').innerText();
    expect(firstShip).toContain('Anthem');
  });

  test('direction button is disabled until a sort column is picked', async ({ page }) => {
    await gotoFresh(page);
    await expect(page.locator('#sortDirBtn')).toBeDisabled();
    await page.selectOption('#sortSelect', '11');
    await expect(page.locator('#sortDirBtn')).toBeEnabled();
    await expect(page.locator('#sortDirBtn')).toHaveText('↑');
  });

  test('column filter narrows results and updates summary count', async ({ page }) => {
    await gotoFresh(page);
    await page.locator('.col-filter[data-field="provider"]').selectOption('Celebrity Cruises');
    await expect(page.locator('#summary')).toContainText('1 of 3');
    expect(await page.locator('tbody tr').count()).toBe(1);
  });

  test('ship-size filter (tier:large) keeps only ships whose class maps to large', async ({ page }) => {
    await gotoFresh(page);
    // All three fixtures are Oasis class (mega), so tier:mega keeps all and
    // tier:small drops them all — proves the tier filter is wired.
    await page.locator('.col-filter[data-field="shipClass"]').selectOption('tier:small');
    await expect(page.locator('#summary')).toContainText('0 of 3');
    await page.locator('.col-filter[data-field="shipClass"]').selectOption('tier:mega');
    await expect(page.locator('#summary')).toContainText('all 3');
  });
});

test.describe('URL state', () => {
  test('sort + filter persist across reload via URL hash', async ({ page }) => {
    await gotoFresh(page);
    await page.selectOption('#sortSelect', '14');
    await page.locator('.col-filter[data-field="provider"]').selectOption('Royal Caribbean');
    await page.waitForFunction(() => location.hash.includes('sort=14-asc') && location.hash.includes('provider=Royal'));
    const urlBefore = page.url();
    await setupRoutes(page); // re-arm routes for the reload
    await page.goto(urlBefore);
    await page.waitForSelector('tbody tr:not(.empty-row)');
    // Dropdown holds column index; direction lives on the toggle button.
    expect(await page.locator('#sortSelect').inputValue()).toBe('14');
    await expect(page.locator('#sortDirBtn')).toHaveText('↑');
    expect(await page.locator('.col-filter[data-field="provider"]').inputValue()).toBe('Royal Caribbean');
  });
});

test.describe('Settings dialog', () => {
  test('first-time visitors get sparklines and £/night off; the body class reflects it', async ({ page }) => {
    await gotoFresh(page);
    await expect(page.locator('body')).toHaveClass(/hide-sparklines/);
    await expect(page.locator('body')).toHaveClass(/hide-per-night/);
  });

  test('toggling sparklines on persists across reload', async ({ page }) => {
    await gotoFresh(page);
    await page.click('#settingsBtn');
    await page.waitForSelector('dialog#settingsDialog[open]');
    await page.locator('#settingsDialog input[data-setting="sparklines"]').check();
    await expect(page.locator('body')).not.toHaveClass(/hide-sparklines/);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('cruise-explorer-settings')));
    expect(stored.sparklines).toBe(true);
    // Reload — choice survives
    await setupRoutes(page);
    await page.reload();
    await page.waitForSelector('tbody tr:not(.empty-row)');
    await expect(page.locator('body')).not.toHaveClass(/hide-sparklines/);
  });

  test('per-night toggle on shows the £/night column', async ({ page }) => {
    await gotoFresh(page);
    await expect(page.locator('.col-per-night').first()).toBeHidden();
    await page.click('#settingsBtn');
    await page.waitForSelector('dialog#settingsDialog[open]');
    await page.locator('#settingsDialog input[data-setting="perNight"]').check();
    await expect(page.locator('.col-per-night').first()).toBeVisible();
  });

  test('Reset to defaults restores first-time-visitor state', async ({ page }) => {
    // Start with everything on, then reset — should land on sparklines/perNight off.
    await gotoFresh(page, ALL_ON);
    await page.click('#settingsBtn');
    await page.waitForSelector('dialog#settingsDialog[open]');
    await page.click('#settingsReset');
    expect(await page.locator('#settingsDialog input[data-setting="sparklines"]').isChecked()).toBe(false);
    expect(await page.locator('#settingsDialog input[data-setting="perNight"]').isChecked()).toBe(false);
    expect(await page.locator('#settingsDialog input[data-setting="wikiLinks"]').isChecked()).toBe(true);
    await expect(page.locator('body')).toHaveClass(/hide-sparklines/);
  });
});

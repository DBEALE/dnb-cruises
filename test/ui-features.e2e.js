'use strict';

// E2E coverage for the post-MVP features: sparklines + price-history dialog,
// filter / sort / per-cabin sort, URL state, settings dialog with localStorage.
//
// All tests stub out the provider catalog and cruises.json so they don't
// depend on the live data file (which is gitignored and might be absent
// locally) and so the assertions are deterministic.

const { test, expect } = require('@playwright/test');

const TEST_NOW = Date.now();
const isoAgo = milliseconds => new Date(TEST_NOW - milliseconds).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const PROVIDER_INDEX = {
  defaultProviderId: 'royal-caribbean',
  providers: [
    { id: 'royal-caribbean', name: 'Royal Caribbean', cruisesUrl: './providers/royal-caribbean/cruises.json' },
    { id: 'celebrity-cruises', name: 'Celebrity Cruises', cruisesUrl: './providers/celebrity-cruises/cruises.json' },
  ],
};

// Helper — build a cruise with the priceHistory shape the UI expects.
function cruise({ id, shipName, provider, priceFrom, prices, history, firstSeenAt, departureDate = '2026-09-01', days = 7, port = 'Southampton', destinationPort = port, itinerary = `${days}-Night ${port} Sample`, shipLaunchYear = 2020, seaDays = null }) {
  return {
    id, shipName, provider,
    shipClass:       'Oasis',
    shipLaunchYear,
    itinerary,
    departureDate,
    duration:        `${days} Nights`,
    seaDays,
    departurePort:   port,
    departureRegion: 'UK & Ireland',
    destination:     'Northern Europe',
    destinationPort,
    priceFrom:       String(priceFrom),
    currency:        'GBP',
    bookingUrl:      `/booking/${id}`,
    prices:          prices || { inside: null, oceanView: null, balcony: null, suite: null },
    priceHistory:    history || [],
    firstSeenAt,
  };
}

const CRUISES_RC = {
  scrapedAt: '2026-05-31T10:00:00Z',
  cruises: [
    cruise({
      id: 'rc_a', shipName: 'Anthem of the Seas', provider: 'Royal Caribbean',
      priceFrom: 500, days: 7, departureDate: '2026-08-31', firstSeenAt: isoAgo(20 * DAY),
      shipLaunchYear: 2025,
      seaDays: 3,
      prices: { inside: '500', oceanView: '650', balcony: '800', suite: '1800' },
      history: [
        { at: isoAgo(20 * DAY), prices: { inside: 1000, oceanView: 900, balcony: 1200, suite: 2000 } },
        { at: isoAgo(30 * HOUR), prices: { inside: 550, oceanView: 680, balcony: 850, suite: 1900 } },
        { at: isoAgo(2 * HOUR), prices: { inside: 500, oceanView: 650, balcony: 800, suite: 1800 } },
      ],
    }),
    cruise({
      id: 'rc_b', shipName: 'Harmony of the Seas', provider: 'Royal Caribbean',
      priceFrom: 1200, days: 14, firstSeenAt: isoAgo(2 * HOUR),
      shipLaunchYear: 2000,
      seaDays: 9,
      prices: { inside: '1200', oceanView: '1500', balcony: '1800', suite: '3500' },
      history: [
        { at: isoAgo(30 * HOUR), prices: { inside: 1100, oceanView: 1400, balcony: 1700, suite: 3400 } },
        { at: isoAgo(HOUR), prices: { inside: 1200, oceanView: 1500, balcony: 1800, suite: 3500 } },
      ],
    }),
  ],
};

const CRUISES_CEL = {
  scrapedAt: '2026-05-31T10:00:00Z',
  cruises: [
    cruise({
      id: 'cel_a', shipName: 'Celebrity Edge', provider: 'Celebrity Cruises',
      priceFrom: 900, days: 10, port: 'Barcelona', departureDate: '2026-09-02', firstSeenAt: isoAgo(3 * DAY),
      itinerary: 'Barcelona, Spain Mediterranean Escape',
      seaDays: 2,
      prices: { inside: '900', oceanView: null, balcony: '1300', suite: '2500' },
      history: [
        { at: isoAgo(30 * HOUR), prices: { inside: 1000, oceanView: null, balcony: 1450, suite: 2750 } },
        { at: isoAgo(HOUR), prices: { inside: 900, oceanView: null, balcony: 1300, suite: 2500 } },
      ],
    }),
  ],
};

// Stub every network call so the test exercises the UI in isolation.
async function setupRoutes(page) {
  await page.route('**/providers/index.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVIDER_INDEX) }));
  await page.route('**/providers/royal-caribbean/cruises.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CRUISES_RC) }));
  await page.route('**/providers/celebrity-cruises/cruises.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CRUISES_CEL) }));
  await page.route('**/ship-wiki-links.json', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ships: { 'anthem of the seas': 'https://en.wikipedia.org/wiki/Anthem_of_the_Seas' },
      providers: { 'royal caribbean': 'https://en.wikipedia.org/wiki/Royal_Caribbean_International' },
      classes: { oasis: 'https://en.wikipedia.org/wiki/Oasis-class_cruise_ship' },
    }),
  }));
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
    await expect(page.locator('#phSub')).not.toContainText('Sample');
    await expect(page.locator('#phSub')).toContainText('7N');
    await expect(page.locator('#phSub')).toContainText('Southampton');
    const legend = await page.locator('#phChart .ph-legend-item').allTextContents();
    expect(legend).toEqual(expect.arrayContaining(['Inside', 'Sea view', 'Balcony', 'Suite']));
    // Chart path per cabin
    expect(await page.locator('#phChart svg path').count()).toBe(4);
    expect(await page.locator('.ph-table-wrap').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.locator('.ph-table-wrap').evaluate(el => el.clientHeight > 360)).toBe(true);
    // Latest at the top
    const firstRowDate = await page.locator('#phTableBody tr:first-child td:first-child').innerText();
    const latestDay = new Date(TEST_NOW - 2 * HOUR).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
    expect(firstRowDate).toContain(latestDay);
  });

  test('price-history close button remains reachable on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 640 });
    await gotoFresh(page, ALL_ON);
    await page.locator('.cabin-spark').first().click();
    await page.waitForSelector('dialog#priceHistoryDialog[open]');
    await expect(page.locator('#phClose')).toBeInViewport();
    const box = await page.locator('dialog#priceHistoryDialog').boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(640);
  });
});

test.describe('Header wave', () => {
  test('pressing the title triggers a single slower sweep', async ({ page }) => {
    await gotoFresh(page);
    const wave = page.locator('.header-wave');
    await expect(page.locator('.header-wave .wave')).toHaveCount(4);
    await expect(page.locator('.header-wave .wave-crest')).toHaveCount(1);
    await page.locator('header h1').dispatchEvent('pointerdown', { button: 0 });
    await expect(wave).toHaveClass(/is-sweeping/);
    await expect(wave).not.toHaveClass(/is-sweeping/, { timeout: 3500 });
  });
});

test.describe('Sort and filter', () => {
  test('ship launch years render with newness badges', async ({ page }) => {
    await gotoFresh(page);
    await expect(page.locator('tbody tr:first-child .col-launch .launch-year-badge')).toHaveClass(/newness-newest/);
    await expect(page.locator('tbody tr:first-child .col-launch .launch-year-star')).toHaveCount(1);
  });

  test('older launch years are shown in a muted grey badge', async ({ page }) => {
    await gotoFresh(page);
    await expect(page.locator('tbody tr:has-text("Harmony of the Seas") .col-launch .launch-year-badge')).toHaveClass(/newness-legacy/);
  });

  test('sea days render in the new column', async ({ page }) => {
    await gotoFresh(page);
    await expect(page.locator('tbody tr:first-child .col-sea-days')).toContainText('3');
  });

  test('sea days sort orders by the new column', async ({ page }) => {
    await gotoFresh(page);
    await page.selectOption('#sortSelect', '19');
    await expect(page.locator('tbody tr:first-child .col-ship')).toContainText('Celebrity Edge');
  });

  test('sort dropdown + direction toggle reorders rows', async ({ page }) => {
    await gotoFresh(page);
    // Picking from the dropdown applies ascending by default; the toggle
    // button flips direction.
    await page.selectOption('#sortSelect', '17');        // £/night, ascending
    await page.click('#sortDirBtn');                     // flip to descending
    // Harmony 14n £1200 = £85/n, Anthem 7n £500 = £71/n, Edge 10n £900 = £90/n
    // Edge (90) > Harmony (85) > Anthem (71)
    await expect(page.locator('tbody tr:first-child .col-ship')).toContainText('Celebrity Edge');
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

  test('cabin prices highlight the amount only after multiple higher history prices', async ({ page }) => {
    await gotoFresh(page);
    const anthem = page.locator('tbody tr:has-text("Anthem of the Seas")');
    await expect(anthem.locator('.best-price-val')).toHaveCount(4);
    await expect(anthem.locator('.best-price-val').first()).toHaveText('£500');
    await expect(anthem.locator('.best-price-val').first()).toHaveAttribute('title', /2 previous prices were higher/);

    await page.locator('.col-filter[data-field="provider"]').selectOption('Celebrity Cruises');
    const edge = page.locator('tbody tr:has-text("Celebrity Edge")');
    await expect(edge.locator('.best-price-val')).toHaveCount(0);
  });

  test('peak discount star tiers do not change price row geometry', async ({ page }) => {
    await gotoFresh(page);
    await page.setViewportSize({ width: 1920, height: 900 });
    const anthem = page.locator('tbody tr:has-text("Anthem of the Seas")');
    const slots = anthem.locator('.peak-drop-star-slot');
    await expect(slots).toHaveCount(4);
    await expect(anthem.locator('.peak-drop-star-slot.is-visible')).toHaveCount(3);
    await expect(anthem.locator('.peak-drop-star-slot.tier-gold')).toHaveCount(1);
    await expect(anthem.locator('.peak-drop-star-slot.tier-silver')).toHaveCount(1);
    await expect(anthem.locator('.peak-drop-star-slot.tier-outline')).toHaveCount(1);
    await expect(anthem.locator('.peak-drop-star-slot.tier-gold')).toHaveAttribute('title', /50% below recorded peak of £1,000/);
    await expect(anthem.locator('.peak-drop-star-slot.tier-silver')).toHaveAttribute('title', /33% below recorded peak of £1,200/);
    await expect(anthem.locator('.peak-drop-star-slot.tier-outline')).toHaveAttribute('title', /28% below recorded peak of £900/);
    await expect(anthem.locator('.price-val').first()).toHaveText('£500');

    const amountBoxes = await anthem.locator('.price-amount').evaluateAll(elements => elements.slice(0, 2).map(el => el.getBoundingClientRect().toJSON()));
    expect(Math.abs(amountBoxes[0].width - amountBoxes[1].width)).toBeLessThanOrEqual(1);
    const desktopAmount = await anthem.locator('.price-amount').first().boundingBox();
    const desktopStar = await anthem.locator('.peak-drop-star-slot.tier-gold').boundingBox();
    expect(desktopStar.x).toBeLessThan(desktopAmount.x + desktopAmount.width);
    expect(desktopStar.x + desktopStar.width).toBeGreaterThan(desktopAmount.x + desktopAmount.width);
    expect(desktopStar.y).toBeLessThan(desktopAmount.y);
    expect(desktopStar.y + desktopStar.height).toBeGreaterThan(desktopAmount.y);

    const harmony = page.locator('tbody tr:has-text("Harmony of the Seas")');
    await expect(harmony.locator('.peak-drop-star-slot')).toHaveCount(4);
    await expect(harmony.locator('.peak-drop-star-slot.is-visible')).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(anthem.locator('.peak-drop-star-slot.tier-gold')).toBeVisible();
    const mobileAmount = await anthem.locator('.price-amount').first().boundingBox();
    const mobileStar = await anthem.locator('.peak-drop-star-slot.tier-gold').boundingBox();
    expect(mobileStar.x).toBeLessThan(mobileAmount.x + mobileAmount.width);
    expect(mobileStar.x + mobileStar.width).toBeGreaterThan(mobileAmount.x + mobileAmount.width);
  });

  test('direction button is disabled until a sort column is picked', async ({ page }) => {
    await gotoFresh(page);
    await expect(page.locator('#sortDirBtn')).toBeDisabled();
    await page.selectOption('#sortSelect', '11');
    await expect(page.locator('#sortDirBtn')).toBeEnabled();
    await expect(page.locator('#sortDirBtn')).toHaveText('↑');
  });

  test('recently found sort defaults to newest first', async ({ page }) => {
    await gotoFresh(page);
    await page.selectOption('#sortSelect', '18');
    await expect(page.locator('tbody tr:first-child .col-ship')).toContainText('Harmony');
    await expect(page.locator('#sortDirBtn')).toHaveText('↓');
  });

  test('24-hour price reduction sort puts the largest recent drop first', async ({ page }) => {
    await gotoFresh(page);
    await page.selectOption('#sortSelect', '20');
    await expect(page.locator('tbody tr:first-child .col-ship')).toContainText('Celebrity Edge');
    await expect(page.locator('#sortDirBtn')).toHaveText('↓');
  });

  test('column filter narrows results and updates summary count', async ({ page }) => {
    await gotoFresh(page);
    await page.locator('.col-filter[data-field="provider"]').selectOption('Celebrity Cruises');
    await expect(page.locator('#summary')).toContainText('1 of 3');
    await expect(page.locator('#summary')).toContainText('Celebrity Cruises');
    expect(await page.locator('tbody tr').count()).toBe(1);
  });

  test('sea days filter narrows results and updates summary count', async ({ page }) => {
    await gotoFresh(page);
    await page.locator('.col-filter[data-field="seaDays"]').fill('4');
    await page.locator('.col-filter[data-field="seaDays"]').dispatchEvent('input');
    await expect(page.locator('#summary')).toContainText('2 of 3');
    await expect(page.locator('#summary')).toContainText('Max 4 sea days');
    expect(await page.locator('tbody tr').count()).toBe(2);
    await expect(page.locator('tbody tr:first-child .col-ship')).toContainText('Anthem of the Seas');
    await expect(page.locator('tbody tr:nth-child(2) .col-ship')).toContainText('Celebrity Edge');
  });

  test('recent price reduction filters support 24 hours and one week', async ({ page }) => {
    await gotoFresh(page);
    const filter = page.locator('.col-filter[data-field="priceDropWindow"]');
    await filter.selectOption('24h');
    await expect(page.locator('#summary')).toContainText('2 of 3');
    await expect(page.locator('#summary')).toContainText('Price reduced in 24h');
    await expect(page.locator('#cruiseBody')).toContainText('Anthem of the Seas');
    await expect(page.locator('#cruiseBody')).toContainText('Celebrity Edge');
    await expect(page.locator('#cruiseBody')).not.toContainText('Harmony of the Seas');

    await filter.selectOption('7d');
    await expect(page.locator('#summary')).toContainText('2 of 3');
    await expect(page.locator('#summary')).toContainText('Price reduced in 1 week');
  });

  test('new cruise filters support 24 hours and one week', async ({ page }) => {
    await gotoFresh(page);
    const filter = page.locator('.col-filter[data-field="newWithin"]');
    await filter.selectOption('24h');
    await expect(page.locator('#summary')).toContainText('1 of 3');
    await expect(page.locator('#summary')).toContainText('Added in 24h');
    await expect(page.locator('#cruiseBody')).toContainText('Harmony of the Seas');

    await filter.selectOption('7d');
    await expect(page.locator('#summary')).toContainText('2 of 3');
    await expect(page.locator('#summary')).toContainText('Added in 1 week');
    await expect(page.locator('#cruiseBody')).toContainText('Harmony of the Seas');
    await expect(page.locator('#cruiseBody')).toContainText('Celebrity Edge');
  });

  test('itinerary filter matches every word and highlights each one', async ({ page }) => {
    await gotoFresh(page);
    await page.locator('.col-filter[data-field="itinerary"]').fill('Barcelona Spain');
    await page.locator('.col-filter[data-field="itinerary"]').dispatchEvent('input');
    await expect(page.locator('#summary')).toContainText('1 of 3');
    await expect(page.locator('tbody tr:first-child .col-itinerary')).toContainText('Barcelona');
    await expect(page.locator('tbody tr:first-child .col-itinerary')).toContainText('Spain');
    await expect(page.locator('tbody tr:first-child .col-itinerary .itinerary-highlight')).toHaveCount(2);
  });

  test('clear button resets an individual filter', async ({ page }) => {
    await gotoFresh(page);
    const provider = page.locator('.col-filter[data-field="provider"]');
    await provider.selectOption('Celebrity Cruises');
    await expect(page.locator('#summary')).toContainText('1 of 3');
    await page.locator('#filterRow .col-provider .filter-clear-btn').click();
    await expect(provider).toHaveValue('');
    await expect(page.locator('#summary')).toContainText('all 3');
  });

  test('departure date range filters inclusively', async ({ page }) => {
    await gotoFresh(page);
    await page.click('#departureRangeBtn');
    await page.fill('#departureRangeStart', '2026-08-31');
    await page.fill('#departureRangeEnd', '2026-09-01');
    await page.click('#departureRangeApply');

    await expect(page.locator('#summary')).toContainText('2 of 3');
    await expect(page.locator('#summary')).toContainText('Departure 31 Aug 2026 - 1 Sept 2026');
    await expect(page.locator('#cruiseBody')).toContainText('Anthem of the Seas');
    await expect(page.locator('#cruiseBody')).toContainText('Harmony of the Seas');
    await expect(page.locator('#cruiseBody')).not.toContainText('Celebrity Edge');
    await expect(page.locator('#departureRangeBtn')).toContainText('31 Aug 2026 - 1 Sept 2026');
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

  test('cruise share URL reloads to only that sailing', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async data => { window.__lastShare = data; },
      });
    });
    await gotoFresh(page);

    await page.locator('.desktop-cruise-share[data-share-cruise="rc_a"]').click();
    const shared = await page.evaluate(() => window.__lastShare);
    expect(shared.url).toContain('#cruise=rc_a');
    expect(shared.url).not.toContain('provider=');

    await setupRoutes(page);
    await page.goto(shared.url);
    await page.reload();
    await page.waitForSelector('tbody tr:not(.empty-row)');
    await expect(page.locator('#cruiseBody')).toContainText('Anthem of the Seas');
    await expect(page.locator('#cruiseBody')).not.toContainText('Harmony of the Seas');
    await expect(page.locator('#cruiseBody')).not.toContainText('Celebrity Edge');
    await expect(page.locator('#summary')).toContainText('Showing Anthem of the Seas only');
  });

  test('search share URL preserves the current filters and sort', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async data => { window.__lastShare = data; },
      });
    });
    await gotoFresh(page);
    await page.selectOption('#sortSelect', '14');
    await page.locator('.col-filter[data-field="provider"]').selectOption('Royal Caribbean');
    await page.waitForFunction(() => location.hash.includes('provider=Royal'));

    await page.click('#shareSearchBtn');
    const shared = await page.evaluate(() => window.__lastShare);
    expect(shared.url).toContain('sort=14-asc');
    expect(shared.url).toContain('provider=Royal+Caribbean');
    expect(shared.url).not.toContain('cruise=');
  });
});

test.describe('Mobile filters', () => {
  test('close button remains reachable below browser chrome', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 640 });
    await gotoFresh(page);
    await page.click('#mobFilterToggle');
    await page.waitForSelector('dialog#mobFilters[open]');
    await page.waitForTimeout(300);
    await expect(page.locator('#mobFiltersClose')).toBeInViewport();
    const box = await page.locator('dialog#mobFilters').boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(60);
    expect(box.y + box.height).toBeLessThanOrEqual(640);
  });

  test('share actions remain visible in the mobile card layout', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoFresh(page);
    await expect(page.locator('.share-view-mobile')).toBeVisible();
    await expect(page.locator('.mobile-cruise-share[data-share-cruise="rc_a"]')).toBeVisible();
    await expect(page.locator('tbody tr:has-text("Anthem of the Seas") .col-book')).toHaveCount(0);
  });
});

test.describe('Saved views', () => {
  test('suggests an editable name from current filters and sort', async ({ page }) => {
    await gotoFresh(page);
    await page.selectOption('#sortSelect', '14');
    await page.locator('.col-filter[data-field="departurePort"]').fill('Southampton');
    await page.locator('.col-filter[data-field="duration"]').fill('7');
    await page.locator('.col-filter[data-field="destination"]').fill('Mediterranean');

    await page.click('#savedViewsBtn');
    await page.waitForSelector('dialog#savedViewsDialog[open]');
    await expect(page.locator('#svNameInput')).toHaveValue('Southampton 7N Mediterranean');

    await page.locator('#svNameInput').fill('My balcony shortlist');
    await page.locator('#svSaveForm button[type="submit"]').click();
    await expect(page.locator('.sv-name').first()).toHaveText('My balcony shortlist');
    await expect(page.locator('.sv-hash').first()).toContainText('Sort: Price (Balcony)');
    await expect(page.locator('.sv-hash').first()).toContainText('destination=Mediterranean');
  });
});

test.describe('Settings dialog', () => {
  test('price-star legend explains all tiers', async ({ page }) => {
    await gotoFresh(page);
    await page.click('#settingsBtn');
    const legend = page.locator('.price-star-legend');
    await legend.locator('summary').click();
    await expect(legend).toContainText('50% or more below peak');
    await expect(legend).toContainText('30–49% below peak');
    await expect(legend).toContainText('15–29% below peak');
    await expect(legend).toContainText('less than 15%');
    await expect(legend.locator('.price-star-legend-icon')).toHaveCount(3);
  });

  test('close button stays visible while display options content scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 560 });
    await gotoFresh(page);
    await page.click('#settingsBtn');
    await page.waitForSelector('dialog#settingsDialog[open]');
    await page.locator('.settings-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(page.locator('#settingsClose')).toBeInViewport();
  });

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

  test('mobile per-night value sits beside first seen and above cabin prices', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoFresh(page, ALL_ON);

    const row = page.locator('#cruiseBody tr').first();
    const firstSeenBox = await row.locator('.col-first-seen').boundingBox();
    const perNightBox = await row.locator('.col-per-night').boundingBox();
    const priceBox = await row.locator('.col-price').boundingBox();

    expect(Math.abs(firstSeenBox.y - perNightBox.y)).toBeLessThanOrEqual(1);
    expect(priceBox.y).toBeGreaterThanOrEqual(perNightBox.y + perNightBox.height - 1);
  });

  test('link target toggle switches ship links from Wikipedia to cruise company pages', async ({ page }) => {
    await gotoFresh(page);
    await page.waitForFunction(() => document.querySelector('tbody tr:first-child .col-ship a')?.href.includes('wikipedia.org'));
    await expect(page.locator('#cruiseBody tr:first-child .col-ship a').first()).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Anthem_of_the_Seas');

    await page.click('#settingsBtn');
    await page.waitForSelector('dialog#settingsDialog[open]');
    await page.locator('#settingsDialog input[data-setting="companyLinks"]').check();
    await expect(page.locator('#cruiseBody tr:first-child .col-ship a').first()).toHaveAttribute('href', 'https://www.royalcaribbean.com/gbr/en/cruise-ships/anthem-of-the-seas');
  });

  test('home port setting is saved and highlighted in cruise rows', async ({ page }) => {
    await gotoFresh(page);
    await page.click('#settingsBtn');
    await page.waitForSelector('dialog#settingsDialog[open]');
    await page.fill('#settingsHomePort', 'Southampton');
    await expect(page.locator('#settingsHomePortStatus')).toHaveText('Saved');
    expect(await page.evaluate(() => localStorage.getItem('cruise-explorer-home-port'))).toBe('Southampton');
    await page.click('#settingsClose');

    const firstRow = page.locator('tbody tr:first-child');
    await expect(firstRow.locator('.col-itinerary .home-port-highlight')).toContainText('Southampton');
    await expect(firstRow.locator('.col-port .home-port-highlight')).toContainText('Southampton');
    await expect(firstRow.locator('.col-destination-port .home-port-highlight')).toContainText('Southampton');
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
    expect(await page.locator('#settingsDialog input[data-setting="companyLinks"]').isChecked()).toBe(false);
    await expect(page.locator('body')).toHaveClass(/hide-sparklines/);
  });
});

test.describe('Site changes dialog', () => {
  test('close button stays visible while the changes list scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 560 });
    await gotoFresh(page);
    await page.click('#siteChangesBtn');
    await page.waitForSelector('dialog#siteChangesDialog[open]');
    await page.locator('.changes-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(page.locator('#changesClose')).toBeInViewport();
  });
});

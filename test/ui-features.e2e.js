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
function cruise({ id, shipName, provider, priceFrom, prices, history, firstSeenAt, departureDate = '2026-09-01', arrivalDate = '', days = 7, port = 'Southampton', destinationPort = port, itinerary = `${days}-Night ${port} Sample`, shipLaunchYear = 2020, seaDays = null, currency = 'GBP' }) {
  return {
    id, shipName, provider,
    shipClass:       'Oasis',
    shipLaunchYear,
    itinerary,
    departureDate,
    arrivalDate,
    duration:        `${days} Nights`,
    seaDays,
    departurePort:   port,
    departureRegion: 'UK & Ireland',
    destination:     'Northern Europe',
    destinationPort,
    priceFrom:       String(priceFrom),
    currency,
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
      priceFrom: 500, days: 7, departureDate: '2026-08-31', arrivalDate: '2026-09-07', firstSeenAt: isoAgo(20 * DAY),
      shipLaunchYear: 2025,
      seaDays: 3,
      destinationPort: 'Southampton (for London), England',
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
async function setupRoutes(page, fixtures = {}) {
  await page.route('**/providers/index.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVIDER_INDEX) }));
  await page.route('**/providers/royal-caribbean/cruises.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures.royalCaribbean || CRUISES_RC) }));
  await page.route('**/providers/celebrity-cruises/cruises.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures.celebrity || CRUISES_CEL) }));
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
  await page.route('**/ports.json', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ports: fixtures.ports || [
        { name: 'Southampton', lat: 50.897, lon: -1.404, land: 'great-britain', aliases: ['southampton'] },
        { name: 'Barcelona', lat: 41.353, lon: 2.178, land: 'continental-europe', aliases: ['barcelona'] },
        { name: 'Miami', lat: 25.775, lon: -80.176, land: 'north-america', aliases: ['miami'] },
        { name: 'Fort Lauderdale', lat: 26.092, lon: -80.117, land: 'north-america', aliases: ['lauderdale', 'fort lauderdale'] },
      ],
    }),
  }));
  await page.route('**/open.er-api.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rates: { GBP: fixtures.gbpRate || 1 } }) }));
}

// Pre-seed display settings before the page boots. Pass `null` to leave
// localStorage untouched so first-time-visitor defaults apply.
async function gotoFresh(page, settings = null, fixtures = {}) {
  if (settings) {
    await page.addInitScript((s) => {
      localStorage.setItem('cruise-explorer-settings', JSON.stringify(s));
    }, settings);
  }
  await setupRoutes(page, fixtures);
  await page.goto('/');
  await page.waitForSelector('tbody tr:not(.empty-row)');
}

// Settings preset for tests that need sparklines + per-night visible
// (they're off by default for first-time visitors).
const ALL_ON = {
  darkMode: false,
  sparklines: true,
  perNight: true,
  priceStars: true,
  lowestPriceHighlight: true,
  linkTarget: 'wikipedia',
  classDots: true,
  launchYear: true,
  shipIcons: true,
};

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

  test('mobile header overlays utility buttons without detaching the waves', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoFresh(page);

    const headerBox = await page.locator('header').boundingBox();
    const titleBox = await page.locator('header h1').boundingBox();
    const waveBox = await page.locator('.header-wave').boundingBox();
    const settingsBox = await page.locator('#settingsBtn').boundingBox();
    const changesBox = await page.locator('#siteChangesBtn').boundingBox();

    expect(headerBox.height).toBeLessThanOrEqual(165);
    expect(titleBox.y - headerBox.y).toBeLessThanOrEqual(18);
    expect(waveBox.y).toBeGreaterThanOrEqual(titleBox.y);
    expect(waveBox.y + waveBox.height).toBeLessThanOrEqual(titleBox.y + titleBox.height + 4);
    for (const buttonBox of [settingsBox, changesBox]) {
      expect(buttonBox.y).toBeLessThan(titleBox.y + titleBox.height);
      expect(buttonBox.y + buttonBox.height).toBeGreaterThan(titleBox.y);
    }
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

  test('port filters use simplified precomputed names', async ({ page }) => {
    await gotoFresh(page, null, {
      royalCaribbean: {
        scrapedAt: CRUISES_RC.scrapedAt,
        cruises: [
          cruise({
            id: 'rc_variant', shipName: 'Port Variant of the Seas', provider: 'Royal Caribbean',
            priceFrom: 700, departureDate: '2026-09-08', firstSeenAt: isoAgo(DAY),
            port: 'Southampton (for London), England',
            destinationPort: 'Barcelona, Spain',
          }),
        ],
      },
      celebrity: { scrapedAt: CRUISES_CEL.scrapedAt, cruises: [] },
    });

    await page.locator('.col-filter[data-field="departurePort"]').fill('Southampton');
    await page.locator('.col-filter[data-field="departurePort"]').dispatchEvent('input');
    await expect(page.locator('#cruiseBody')).toContainText('Port Variant of the Seas');
    await expect(page.locator('#summary')).toContainText('Showing all 1 sailings');
    await expect(page.locator('#summary')).toContainText('From Southampton');
  });

  test('endpoint port filter separates round trips from open-jaw cruises', async ({ page }) => {
    await gotoFresh(page, null, {
      royalCaribbean: {
        scrapedAt: CRUISES_RC.scrapedAt,
        cruises: [
          cruise({
            id: 'rc_roundtrip', shipName: 'Round Trip of the Seas', provider: 'Royal Caribbean',
            priceFrom: 700, departureDate: '2026-09-08', firstSeenAt: isoAgo(DAY),
            port: 'Southampton (for London), England',
            destinationPort: 'Southampton',
          }),
          cruise({
            id: 'rc_openjaw', shipName: 'Open Jaw of the Seas', provider: 'Royal Caribbean',
            priceFrom: 800, departureDate: '2026-09-09', firstSeenAt: isoAgo(DAY),
            port: 'Southampton',
            destinationPort: 'Barcelona, Spain',
          }),
        ],
      },
      celebrity: { scrapedAt: CRUISES_CEL.scrapedAt, cruises: [] },
    });

    const filter = page.locator('.col-filter[data-field="endpointMatch"]');
    await filter.selectOption('same');
    await expect(page.locator('#summary')).toContainText('1 of 2');
    await expect(page.locator('#summary')).toContainText('Returns to departure port');
    await expect(page.locator('#cruiseBody')).toContainText('Round Trip of the Seas');
    await expect(page.locator('#cruiseBody')).not.toContainText('Open Jaw of the Seas');
    await expect(page).toHaveURL(/endpointMatch=same/);

    await filter.selectOption('different');
    await expect(page.locator('#summary')).toContainText('1 of 2');
    await expect(page.locator('#summary')).toContainText('Different destination port');
    await expect(page.locator('#cruiseBody')).toContainText('Open Jaw of the Seas');
    await expect(page.locator('#cruiseBody')).not.toContainText('Round Trip of the Seas');
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

  test('follow-on button opens a search from destination port after arrival', async ({ page }) => {
    const followOnFixtures = {
      royalCaribbean: {
        scrapedAt: CRUISES_RC.scrapedAt,
        cruises: [
          ...CRUISES_RC.cruises,
          cruise({
            id: 'rc_follow', shipName: 'Follow On of the Seas', provider: 'Royal Caribbean',
            priceFrom: 700, days: 7, departureDate: '2026-09-08', firstSeenAt: isoAgo(DAY),
            port: 'Southampton (for London), England',
            destinationPort: 'Barcelona, Spain',
            prices: { inside: '700', oceanView: null, balcony: null, suite: null },
          }),
        ],
      },
    };
    await page.addInitScript(() => {
      window.open = (url, target, features) => {
        window.__openedFollowOn = { url, target, features };
        return {};
      };
    });
    await gotoFresh(page, null, followOnFixtures);

    await page.locator('.cruise-follow-on-btn[data-follow-on-cruise="rc_a"]').click();
    const opened = await page.evaluate(() => window.__openedFollowOn);
    expect(opened.target).toBe('_blank');
    expect(opened.features).toContain('noopener');
    expect(opened.url).toContain('#');
    expect(opened.url).toContain('departurePort=Southampton');
    expect(opened.url).toContain('departureStart=2026-09-07');
    expect(opened.url).toContain('departureEnd=2026-09-10');

    const followOnPage = await page.context().newPage();
    await setupRoutes(followOnPage, followOnFixtures);
    await followOnPage.goto(opened.url);
    await expect(followOnPage.locator('.col-filter[data-field="departurePort"]')).toHaveValue('Southampton');
    await expect(followOnPage.locator('.col-filter[data-field="departureStart"]')).toHaveValue('2026-09-07');
    await expect(followOnPage.locator('.col-filter[data-field="departureEnd"]')).toHaveValue('2026-09-10');
    await expect(followOnPage.locator('#cruiseBody')).toContainText('Follow On of the Seas');
    await followOnPage.close();
  });

  test('follow-on search window setting widens the departure range', async ({ page }) => {
    await page.addInitScript(() => {
      window.open = (url) => { window.__openedFollowOn = { url }; return {}; };
    });
    // rc_a arrives 2026-09-07; a 7-day window should search through 2026-09-14.
    await gotoFresh(page, { ...ALL_ON, followOnDays: 7 });

    await page.locator('.cruise-follow-on-btn[data-follow-on-cruise="rc_a"]').click();
    const opened = await page.evaluate(() => window.__openedFollowOn);
    expect(opened.url).toContain('departureStart=2026-09-07');
    expect(opened.url).toContain('departureEnd=2026-09-14');

    // The row tooltip reflects the configured window too.
    await expect(page.locator('.cruise-follow-on-btn[data-follow-on-cruise="rc_a"]'))
      .toHaveAttribute('title', /within 7 days of arrival/);
  });

  test('cruise-before button opens a search for a cruise arriving before departure', async ({ page }) => {
    const beforeFixtures = {
      royalCaribbean: {
        scrapedAt: CRUISES_RC.scrapedAt,
        cruises: [
          ...CRUISES_RC.cruises,
          cruise({
            // Arrives at Southampton 2026-08-30, the day before rc_a sails from there.
            id: 'rc_pre', shipName: 'Pre Cruise of the Seas', provider: 'Royal Caribbean',
            priceFrom: 600, days: 7, departureDate: '2026-08-23', arrivalDate: '2026-08-30',
            firstSeenAt: isoAgo(DAY), port: 'Barcelona', destinationPort: 'Southampton',
            prices: { inside: '600', oceanView: null, balcony: null, suite: null },
          }),
        ],
      },
    };
    await page.addInitScript(() => {
      window.open = (url) => { window.__openedBefore = { url }; return {}; };
    });
    await gotoFresh(page, null, beforeFixtures);

    // rc_a departs Southampton 2026-08-31; default 3-day window → arrivals 08-28…08-31.
    await page.locator('.cruise-before-btn[data-before-cruise="rc_a"]').click();
    const opened = await page.evaluate(() => window.__openedBefore);
    expect(opened.url).toContain('destinationPort=Southampton');
    expect(opened.url).toContain('arrivalStart=2026-08-28');
    expect(opened.url).toContain('arrivalEnd=2026-08-31');

    const beforePage = await page.context().newPage();
    await setupRoutes(beforePage, beforeFixtures);
    await beforePage.goto(opened.url);
    await expect(beforePage.locator('#cruiseBody')).toContainText('Pre Cruise of the Seas');
    // rc_a arrives 09-07 and rc_b 09-15 — both outside the window, so filtered out.
    await expect(beforePage.locator('#cruiseBody')).not.toContainText('Anthem of the Seas');
    await beforePage.close();
  });

  test('port search radius matches nearby departure ports', async ({ page }) => {
    const fixtures = {
      royalCaribbean: {
        scrapedAt: CRUISES_RC.scrapedAt,
        cruises: [
          cruise({ id: 'p_mia', shipName: 'Miami Ship', provider: 'Royal Caribbean', priceFrom: 500, port: 'Miami', firstSeenAt: isoAgo(DAY) }),
          cruise({ id: 'p_ftl', shipName: 'Lauderdale Ship', provider: 'Royal Caribbean', priceFrom: 600, port: 'Fort Lauderdale', firstSeenAt: isoAgo(DAY) }),
          cruise({ id: 'p_bcn', shipName: 'Barca Ship', provider: 'Royal Caribbean', priceFrom: 700, port: 'Barcelona', firstSeenAt: isoAgo(DAY) }),
        ],
      },
    };

    // Radius 100mi: filtering "Miami" also matches Fort Lauderdale (~22mi) but not Barcelona.
    await page.addInitScript(s => localStorage.setItem('cruise-explorer-settings', JSON.stringify(s)), { ...ALL_ON, proximityMiles: 100 });
    await setupRoutes(page, fixtures);
    await page.goto('/#departurePort=Miami');
    await page.waitForSelector('tbody tr:not(.empty-row)');

    await expect(page.locator('#cruiseBody')).toContainText('Miami Ship');
    await expect(page.locator('#cruiseBody')).toContainText('Lauderdale Ship'); // within 100mi (after ports.json loads)
    await expect(page.locator('#cruiseBody')).not.toContainText('Barca Ship');
  });

  test('port search radius off falls back to exact port match', async ({ page }) => {
    const fixtures = {
      royalCaribbean: {
        scrapedAt: CRUISES_RC.scrapedAt,
        cruises: [
          cruise({ id: 'p_mia', shipName: 'Miami Ship', provider: 'Royal Caribbean', priceFrom: 500, port: 'Miami', firstSeenAt: isoAgo(DAY) }),
          cruise({ id: 'p_ftl', shipName: 'Lauderdale Ship', provider: 'Royal Caribbean', priceFrom: 600, port: 'Fort Lauderdale', firstSeenAt: isoAgo(DAY) }),
        ],
      },
    };
    await page.addInitScript(s => localStorage.setItem('cruise-explorer-settings', JSON.stringify(s)), { ...ALL_ON, proximityMiles: 0 });
    await setupRoutes(page, fixtures);
    await page.goto('/#departurePort=Miami');
    await page.waitForSelector('tbody tr:not(.empty-row)');

    await expect(page.locator('#cruiseBody')).toContainText('Miami Ship');
    await expect(page.locator('#cruiseBody')).not.toContainText('Lauderdale Ship');
  });
});

test.describe('Mobile filters', () => {
  test('highlights and counts filters that are not at their defaults', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoFresh(page, { ...ALL_ON, darkMode: true });
    await page.click('#mobFilterToggle');

    const itinerary = page.locator('#mobFilterItinerary');
    await itinerary.fill('Norway');
    await expect(itinerary.locator('xpath=ancestor::div[contains(@class, "mob-filter-group")]')).toHaveClass(/has-active-filter/);
    await expect(page.locator('#mobActiveFilterCount')).toHaveText('1 active');

    await page.selectOption('#mobFilterPriceDrop', '7d');
    await expect(page.locator('#mobActiveFilterCount')).toHaveText('2 active');
    await expect(page.locator('#mobFilterPriceDrop')).toHaveCSS('border-top-color', 'rgb(96, 165, 250)');
    await expect(itinerary).toHaveCSS('color', 'rgb(241, 245, 249)');

    await page.click('#mobFilterItinerary + .filter-clear-btn');
    await expect(page.locator('#mobActiveFilterCount')).toHaveText('1 active');
    await expect(itinerary.locator('xpath=ancestor::div[contains(@class, "mob-filter-group")]')).not.toHaveClass(/has-active-filter/);
  });

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
    await expect(page.locator('#shareSearchBtn')).toBeHidden();
    await expect(page.locator('.share-view-mobile')).toBeVisible();
    await expect(page.locator('.share-view-btn:visible')).toHaveCount(1);
    await expect(page.locator('.mobile-cruise-share[data-share-cruise="rc_a"]')).toBeVisible();
    await expect(page.locator('tbody tr:has-text("Anthem of the Seas") .col-book')).toHaveCount(0);
    await expect(page.locator('.mob-sort-row').first().locator('button')).toHaveCount(2);
    await expect(page.locator('.mob-sort-row').first().locator('button').nth(0)).toHaveAttribute('id', 'mobFilterToggle');
    await expect(page.locator('.mob-sort-row').first().locator('button').nth(1)).toHaveClass(/share-view-mobile/);

    const savedSelectBox = await page.locator('#mobileSavedSelect').boundingBox();
    expect(savedSelectBox.width).toBeGreaterThanOrEqual(210);
  });

  test('desktop keeps the labelled share-search action without the mobile duplicate', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoFresh(page);
    await expect(page.locator('#shareSearchBtn')).toBeVisible();
    await expect(page.locator('#shareSearchBtn')).toContainText('Share search');
    await expect(page.locator('.share-view-mobile')).toBeHidden();
    // The toolbar now has two pill actions on desktop: Find route + Share search.
    await expect(page.locator('.share-view-btn:visible')).toHaveCount(2);
  });
});

test.describe('Saved views', () => {
  test('favorites persist and the built-in view filters favorite cruises', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoFresh(page);

    const favoritesOption = page.locator('#mobileSavedSelect option').nth(1);
    await expect(favoritesOption).toHaveAttribute('value', '__favorites__');
    await expect(favoritesOption).toHaveText('❤️ Favorites');

    const anthemFavorite = page.locator('tbody tr:has-text("Anthem of the Seas") .ship-favorite-btn');
    await expect(anthemFavorite).toHaveAttribute('aria-pressed', 'false');
    await anthemFavorite.click();
    await expect(page.locator('tbody tr:has-text("Anthem of the Seas") .ship-favorite-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('tbody tr:has-text("Anthem of the Seas") .favorite-heart')).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cruise-explorer-favorite-cruises')))).toEqual(['rc_a']);

    await page.reload();
    await page.waitForSelector('tbody tr:not(.empty-row)');
    await expect(page.locator('tbody tr:has-text("Anthem of the Seas") .ship-favorite-btn')).toHaveAttribute('aria-pressed', 'true');

    await page.selectOption('#mobileSavedSelect', '__manage__');
    await page.waitForSelector('dialog#savedViewsDialog[open]');
    await expect(page.locator('#svList .sv-item').first()).toHaveClass(/sv-built-in/);
    await expect(page.locator('#svList .sv-item').first().locator('.sv-name')).toHaveText('❤️ Favorites');
    await page.click('#svClose');

    await page.selectOption('#mobileSavedSelect', '__favorites__');
    await expect(page.locator('#summary')).toContainText('Showing 1 favorite');
    await expect(page.locator('#cruiseBody')).toContainText('Anthem of the Seas');
    await expect(page.locator('#cruiseBody')).not.toContainText('Harmony of the Seas');
    await expect(page.locator('#cruiseBody')).not.toContainText('Celebrity Edge');

    await page.locator('.ship-favorite-btn').click();
    await expect(page.locator('#summary')).toContainText('Showing 0 favorites');
    await expect(page.locator('#cruiseBody tr.empty-row')).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cruise-explorer-favorite-cruises')))).toEqual([]);
  });

  test('suggests an editable name from current filters and sort', async ({ page }) => {
    await gotoFresh(page);
    await page.selectOption('#sortSelect', '14');
    await page.locator('.col-filter[data-field="departurePort"]').fill('Southampton');
    await page.locator('.col-filter[data-field="duration"]').fill('7');
    await page.locator('.col-filter[data-field="destinationPort"]').fill('Barcelona');

    await page.click('#savedViewsBtn');
    await page.waitForSelector('dialog#savedViewsDialog[open]');
    await expect(page.locator('#svNameInput')).toHaveValue('Southampton 7N To Barcelona');

    await page.locator('#svNameInput').fill('My balcony shortlist');
    await page.locator('#svSaveForm button[type="submit"]').click();
    const customView = page.locator('.sv-item:not(.sv-built-in)').first();
    await expect(customView.locator('.sv-name')).toHaveText('My balcony shortlist');
    await expect(customView.locator('.sv-hash')).toContainText('Sort: Price (Balcony)');
    await expect(customView.locator('.sv-hash')).toContainText('destinationPort=Barcelona');
  });
});

test.describe('Settings dialog', () => {
  test('dark mode toggles and persists across reload', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoFresh(page);
    await page.click('#settingsBtn');
    const toggle = page.locator('#settingsDialog input[data-setting="darkMode"]');
    await toggle.check();

    await expect(page.locator('body')).toHaveClass(/dark-mode/);
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(11, 17, 32)');
    await expect(page.locator('#cruiseBody td.ship-name').first()).toHaveCSS('color', 'rgb(241, 245, 249)');
    await expect(page.locator('#cruiseBody .col-itinerary').first()).toHaveCSS('border-bottom-color', 'rgba(0, 0, 0, 0)');
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem('cruise-explorer-settings')))).darkMode).toBe(true);

    await setupRoutes(page);
    await page.reload();
    await page.waitForSelector('#cruiseBody tr');
    await expect(page.locator('body')).toHaveClass(/dark-mode/);
    await page.click('#settingsBtn');
    await expect(toggle).toBeChecked();
  });

  test('shows the last successful scrape time for each provider', async ({ page }) => {
    await gotoFresh(page);
    await page.click('#settingsBtn');
    await page.waitForSelector('dialog#settingsDialog[open]');

    const rows = page.locator('#settingsProviderScrapes li');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Royal Caribbean');
    await expect(rows.nth(0)).toContainText('31 May 2026');
    await expect(rows.nth(0)).toContainText('10:00 UTC');
    await expect(rows.nth(1)).toContainText('Celebrity Cruises');
    await expect(rows.nth(1).locator('time')).toHaveAttribute('datetime', '2026-05-31T10:00:00.000Z');
  });

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
    await expect(page.locator('body')).not.toHaveClass(/hide-price-stars/);
    await expect(page.locator('body')).not.toHaveClass(/hide-lowest-price-highlight/);
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

  test('USD cruises are converted once when calculating price per night', async ({ page }) => {
    const usdCruise = cruise({
      id: 'usd_7n', shipName: 'Enchanted Princess', provider: 'Royal Caribbean',
      priceFrom: 872, prices: { inside: '872', oceanView: null, balcony: null, suite: null },
      days: 7, currency: 'USD',
    });
    await gotoFresh(page, ALL_ON, {
      gbpRate: 0.756,
      royalCaribbean: { scrapedAt: '2026-06-21T10:00:00Z', cruises: [usdCruise] },
    });

    const row = page.locator('#cruiseBody tr').filter({ hasText: 'Enchanted Princess' });
    await expect(row.locator('.col-price .price-val')).toHaveText('£659');
    await expect(row.locator('.col-per-night')).toHaveText('£94/night');
  });

  test('price stars and lowest-price highlighting can be toggled independently', async ({ page }) => {
    await gotoFresh(page, ALL_ON);
    const anthem = page.locator('#cruiseBody tr').filter({ hasText: 'Anthem of the Seas' });
    const star = anthem.locator('.peak-drop-star-slot.is-visible').first();
    const bestPrice = anthem.locator('.best-price-val').first();
    await expect(star).toBeVisible();
    await expect(bestPrice).toHaveCSS('background-color', 'rgb(220, 252, 231)');

    await page.click('#settingsBtn');
    await page.locator('#settingsDialog input[data-setting="priceStars"]').uncheck();
    await expect(star).toBeHidden();
    await expect(bestPrice).toHaveCSS('background-color', 'rgb(220, 252, 231)');

    await page.locator('#settingsDialog input[data-setting="lowestPriceHighlight"]').uncheck();
    await expect(bestPrice).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('body')).toHaveClass(/hide-price-stars/);
    await expect(page.locator('body')).toHaveClass(/hide-lowest-price-highlight/);
  });

  test('link target menu supports Wikipedia, Cruise Company, and None', async ({ page }) => {
    await gotoFresh(page);
    await page.waitForFunction(() => document.querySelector('tbody tr:first-child .col-ship a')?.href.includes('wikipedia.org'));
    await expect(page.locator('#cruiseBody tr:first-child .col-ship a').first()).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Anthem_of_the_Seas');

    await page.click('#settingsBtn');
    await page.waitForSelector('dialog#settingsDialog[open]');
    await page.selectOption('#settingsLinkTarget', 'company');
    await expect(page.locator('#cruiseBody tr:first-child .col-ship a').first()).toHaveAttribute('href', 'https://www.royalcaribbean.com/gbr/en/cruise-ships/anthem-of-the-seas');

    await page.selectOption('#settingsLinkTarget', 'none');
    await expect(page.locator('#cruiseBody tr:first-child a.wiki-link')).toHaveCount(0);
    await expect(page.locator('#cruiseBody tr:first-child .col-ship')).toContainText('Anthem of the Seas');
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem('cruise-explorer-settings')))).linkTarget).toBe('none');
  });

  test('legacy link preferences migrate to the link target menu', async ({ page }) => {
    await gotoFresh(page, { wikiLinks: false, companyLinks: false });
    await expect(page.locator('#cruiseBody tr:first-child a.wiki-link')).toHaveCount(0);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('cruise-explorer-settings')));
    expect(stored.linkTarget).toBe('none');
    expect(stored.wikiLinks).toBeUndefined();
    expect(stored.companyLinks).toBeUndefined();
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
    expect(await page.locator('#settingsDialog input[data-setting="priceStars"]').isChecked()).toBe(true);
    expect(await page.locator('#settingsDialog input[data-setting="lowestPriceHighlight"]').isChecked()).toBe(true);
    await expect(page.locator('#settingsLinkTarget')).toHaveValue('wikipedia');
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

// A deliberate chain of onward legs: Southampton →(root)→ Reykjavik →
// New York (two options) → Miami → Nassau, plus a cycle back to Reykjavik
// and an out-of-window sailing to Oslo. Prices/dates are chosen so the
// aggregation, window and cycle-guard behaviour is deterministic. Shared by
// the onward-explorer and route-finder suites.
function chainFixtures() {
  const leg = (id, shipName, port, destinationPort, departureDate, arrivalDate, inside) =>
    cruise({ id, shipName, provider: 'Royal Caribbean', priceFrom: inside, days: 7,
      departureDate, arrivalDate, firstSeenAt: isoAgo(DAY), port, destinationPort,
      prices: { inside: String(inside), oceanView: null, balcony: null, suite: null } });
  return {
    royalCaribbean: {
      scrapedAt: CRUISES_RC.scrapedAt,
      cruises: [
        leg('rc_root',  'Root Ship',  'Southampton', 'Reykjavik', '2026-09-01', '2026-09-08', 500),
        leg('rc_hop1',  'Hop One',    'Reykjavik',   'New York',  '2026-09-09', '2026-09-16', 400),
        leg('rc_hop1b', 'Hop One B',  'Reykjavik',   'New York',  '2026-09-10', '2026-09-18', 300),
        leg('rc_hop2',  'Hop Two',    'New York',    'Miami',     '2026-09-17', '2026-09-24', 250),
        leg('rc_hop3',  'Hop Three',  'Miami',       'Nassau',    '2026-09-25', '2026-09-29', 200),
        leg('rc_cycle', 'Cycle Ship', 'New York',    'Reykjavik', '2026-09-17', '2026-09-22', 999),
        leg('rc_far',   'Far Ship',   'Reykjavik',   'Oslo',      '2026-09-20', '2026-09-26', 111),
      ],
    },
    celebrity: { scrapedAt: CRUISES_CEL.scrapedAt, cruises: [] },
  };
}

test.describe('Onward journey explorer', () => {

  test('buildCruiseTree aggregates onward legs and guards the date window + cycles', async ({ page }) => {
    const fixtures = chainFixtures();
    await gotoFresh(page, null, fixtures);

    const result = await page.evaluate((cruises) => {
      const T = window.__cruiseTree;
      const ctx = T.makeTreeCtx(cruises, { windowDays: 3, radiusMiles: 0, maxDepth: 4 });
      const root = cruises.find(c => c.id === 'rc_root');
      const tree = T.buildCruiseTree(root, ctx);
      const ny = tree.children.find(n => n.portDisplay === 'New York');
      const hop2 = T.buildTreeChildren(ny.portRaw, ny.earliestArrivalKey, new Set([tree.portKey, ny.portKey]), ctx);
      return {
        rootPort: tree.portDisplay,
        childPorts: tree.children.map(n => n.portDisplay),
        ny: { optionCount: ny.optionCount, lowestPrice: ny.lowestPrice, earliest: ny.earliestArrivalKey },
        hop2Ports: hop2.map(n => n.portDisplay),
      };
    }, fixtures.royalCaribbean.cruises);

    expect(result.rootPort).toBe('Reykjavik');
    // Only New York is within 3 days of the 2026-09-08 arrival; Oslo (09-20) is out.
    expect(result.childPorts).toEqual(['New York']);
    expect(result.ny.optionCount).toBe(2);          // two Reykjavik→New York sailings
    expect(result.ny.lowestPrice).toBe(300);        // cheapest of the two
    expect(result.ny.earliest).toBe('2026-09-16');  // earliest onward arrival drives the next hop
    // From New York, Miami is reachable but the cycle back to Reykjavik is dropped.
    expect(result.hop2Ports).toEqual(['Miami']);
  });

  test('explorer opens from a row, shows nodes, expands lazily, and opens a leg in a new tab', async ({ page }) => {
    await page.addInitScript(() => {
      window.open = (url, target, features) => { window.__opened = { url, target, features }; return {}; };
    });
    await gotoFresh(page, null, chainFixtures());

    await page.locator('.cruise-explore-btn[data-explore-cruise="rc_root"]').click();
    await page.waitForSelector('dialog#treeExplorerDialog[open]');

    // The origin node shows the selected cruise's own leg (departure → destination).
    await expect(page.locator('.tree-origin')).toContainText('Southampton → Reykjavik');

    const nyRow = page.locator('.tree-item', { hasText: 'New York' }).first();
    await expect(nyRow).toContainText('from £300');
    await expect(nyRow).toContainText('2 options');

    // Lazily expand the New York leg → its two individual cruise options appear.
    await nyRow.locator('[data-tree-expand]').first().click();
    await expect(nyRow.locator('.tree-children .tree-cruise')).toHaveCount(2);
    await expect(nyRow.locator('.tree-children')).toContainText('Hop One');

    // Clicking the port opens that leg (Reykjavik → New York, in the 3-day window).
    await page.locator('.tree-port', { hasText: 'New York' }).first().click();
    const opened = await page.evaluate(() => window.__opened);
    expect(opened.target).toBe('_blank');
    expect(opened.features).toContain('noopener');
    expect(opened.url).toContain('departurePort=Reykjavik');
    expect(opened.url).toContain('destinationPort=New+York');
    expect(opened.url).toContain('departureStart=2026-09-08');
    expect(opened.url).toContain('departureEnd=2026-09-11');
  });

  test('onward legs show source → target ports, cruise lines, and a cumulative total', async ({ page }) => {
    await gotoFresh(page, null, chainFixtures());
    await page.locator('.cruise-explore-btn[data-explore-cruise="rc_root"]').click();
    await page.waitForSelector('dialog#treeExplorerDialog[open]');

    // Hop 1 shows its own leg's source → destination, the cruise line, and the
    // running total: root £500 + this leg's cheapest £300 = £800.
    const nyRow = page.locator('.tree-item', { hasText: 'New York' }).first();
    await expect(nyRow.locator('.tree-port-name')).toHaveText('Reykjavik → New York');
    await expect(nyRow.locator('.tree-summary')).toContainText('(RC)');
    await expect(nyRow.locator('.tree-summary')).toContainText('total from £800');

    // Expanding the leg lists its cruises, cheapest first (£300, then £400),
    // each showing nights + ship + its own fare, plus an EXACT running total
    // (not a "from"): £500 root + £300 = £800.
    await nyRow.locator('[data-tree-expand]').first().click();
    const cruiseRows = nyRow.locator('.tree-children > .tree-item');
    await expect(cruiseRows.first()).toContainText('7N');
    await expect(cruiseRows.first().locator('.tree-price')).toHaveText('£300');
    // Exact total + cumulative nights (root 7N + this 7N = 14N).
    await expect(cruiseRows.first().locator('.tree-summary')).toContainText('total £800');
    await expect(cruiseRows.first().locator('.tree-summary')).toContainText('14N');

    // The £400 cruise (nth 1) — exact total £500 + £400 = £900 over 14 nights —
    // arrives in time to sail on to Miami; expanding it shows the onward leg with
    // the running total £500 + £400 + £250 = £1,150.
    const hop1Cruise = cruiseRows.nth(1);
    await expect(hop1Cruise.locator('.tree-price')).toHaveText('£400');
    await expect(hop1Cruise.locator('.tree-summary').first()).toContainText('total £900');
    await expect(hop1Cruise.locator('.tree-summary').first()).toContainText('14N');
    await hop1Cruise.locator('[data-tree-expand]').first().click();
    const miamiRow = hop1Cruise.locator('.tree-item', { hasText: 'Miami' }).first();
    await expect(miamiRow.locator('.tree-port-name').first()).toHaveText('New York → Miami');
    await expect(miamiRow.locator('.tree-summary').first()).toContainText('total from £1,150');
  });

  test('clicking a cruise opens that sailing in the main table (new tab)', async ({ page }) => {
    await page.addInitScript(() => {
      window.open = (url, target, features) => { window.__opened = { url, target, features }; return {}; };
    });
    await gotoFresh(page, null, chainFixtures());
    await page.locator('.cruise-explore-btn[data-explore-cruise="rc_root"]').click();
    await page.waitForSelector('dialog#treeExplorerDialog[open]');

    const nyRow = page.locator('.tree-item', { hasText: 'New York' }).first();
    await nyRow.locator('[data-tree-expand]').first().click();
    // The cheapest cruise (£300) is rc_hop1b; clicking it opens its shared view.
    await nyRow.locator('.tree-cruise').first().click();
    const opened = await page.evaluate(() => window.__opened);
    expect(opened.target).toBe('_blank');
    expect(opened.url).toContain('cruise=rc_hop1b');
  });

  test('onward journey depth setting limits how deep the tree expands', async ({ page }) => {
    await gotoFresh(page, { ...ALL_ON, treeDepth: 2 }, chainFixtures());
    await page.locator('.cruise-explore-btn[data-explore-cruise="rc_root"]').click();
    await page.waitForSelector('dialog#treeExplorerDialog[open]');

    // Depth 2 = two onward hops. Expand New York leg → cruises (hop 1); expand
    // the £400 cruise → Miami leg (hop 2); expand it → the Hop Two cruise, which
    // sits at the depth cap and so has no caret.
    const nyLeg = page.locator('.tree-item', { hasText: 'New York' }).first();
    await nyLeg.locator('[data-tree-expand]').first().click();
    const hop1Cruise = nyLeg.locator('.tree-children > .tree-item').nth(1); // £400, reaches Miami
    await hop1Cruise.locator('[data-tree-expand]').first().click();
    const miamiLeg = hop1Cruise.locator('.tree-item', { hasText: 'Miami' }).first();
    await miamiLeg.locator('[data-tree-expand]').first().click();
    const hopTwoCruise = miamiLeg.locator('.tree-item', { hasText: 'Hop Two' }).first();
    await expect(hopTwoCruise).toContainText('Hop Two');
    await expect(hopTwoCruise.locator('[data-tree-expand]')).toHaveCount(0);
  });

  test('expand all / collapse all toggles the whole tree', async ({ page }) => {
    await gotoFresh(page, null, chainFixtures());
    await page.locator('.cruise-explore-btn[data-explore-cruise="rc_root"]').click();
    await page.waitForSelector('dialog#treeExplorerDialog[open]');

    const toggle = page.locator('#treeExpandAll');
    await expect(toggle).toHaveText('Expand all');

    await toggle.click();
    await expect(toggle).toHaveText('Collapse all');
    // The whole reachable path is now open: New York → Miami → Nassau (terminal).
    await expect(page.locator('#treeExplorerBody')).toContainText('Nassau');
    expect(await page.locator('.tree-children').count()).toBeGreaterThan(1);

    await toggle.click();
    await expect(toggle).toHaveText('Expand all');
    expect(await page.locator('.tree-children').count()).toBe(0);
    // Back to just the root ports.
    await expect(page.locator('.tree-root')).toContainText('New York');
    await expect(page.locator('#treeExplorerBody')).not.toContainText('Miami');
  });

  test('explore button only appears when the destination has onward cruises', async ({ page }) => {
    await gotoFresh(page, null, chainFixtures());
    // Reykjavik (rc_root) has onward sailings → button shown.
    await expect(page.locator('.cruise-explore-btn[data-explore-cruise="rc_root"]')).toHaveCount(1);
    // Nassau (rc_hop3) and Oslo (rc_far) are terminal — no onward sailing departs
    // them, so the explorer button is omitted entirely.
    await expect(page.locator('.cruise-explore-btn[data-explore-cruise="rc_hop3"]')).toHaveCount(0);
    await expect(page.locator('.cruise-explore-btn[data-explore-cruise="rc_far"]')).toHaveCount(0);
  });
});

test.describe('Route finder', () => {
  test('findRoutes chains connecting cruises within budget, cheapest first', async ({ page }) => {
    const fixtures = chainFixtures();
    await gotoFresh(page, null, fixtures);

    const res = await page.evaluate((cruises) => {
      const T = window.__cruiseTree;
      const ctx = T.makeTreeCtx(cruises, { windowDays: 3, radiusMiles: 0, maxDepth: 4 });
      const route = (to, maxPrice) => T.findRoutes({ ctx, fromPortRaw: 'Southampton', toPortRaw: to, maxPrice, notBeforeKey: '' })
        .routes.map(r => ({ ids: r.cruises.map(c => c.id), total: r.total }));
      const routeVia = (to, maxPrice, waypoints) => T.findRoutes({ ctx, fromPortRaw: 'Southampton', toPortRaw: to, maxPrice, waypoints, notBeforeKey: '' })
        .routes.map(r => ({ ids: r.cruises.map(c => c.id), total: r.total }));
      return {
        nassau: route('Nassau', 2000),
        ny: route('New York', 1000),
        tightCount: route('Nassau', 1300).length,
        viaOrdered: routeVia('Nassau', 2000, ['New York', 'Miami']),
        viaWrongOrder: routeVia('Nassau', 2000, ['Miami', 'New York']),
        viaMissing: routeVia('Nassau', 2000, ['Oslo']),
      };
    }, fixtures.royalCaribbean.cruises);

    // Southampton → Nassau: one 4-cruise chain, £500+£400+£250+£200 = £1,350.
    expect(res.nassau).toEqual([{ ids: ['rc_root', 'rc_hop1', 'rc_hop2', 'rc_hop3'], total: 1350 }]);
    // Southampton → New York within £1,000: two routes, cheapest first (£800, £900).
    expect(res.ny.map(r => r.total)).toEqual([800, 900]);
    expect(res.ny[0].ids).toEqual(['rc_root', 'rc_hop1b']);
    // A £1,300 budget can't afford the £1,350 Nassau chain → no routes.
    expect(res.tightCount).toBe(0);
    // Waypoints must be called at in order: New York then Miami is on the path…
    expect(res.viaOrdered).toEqual([{ ids: ['rc_root', 'rc_hop1', 'rc_hop2', 'rc_hop3'], total: 1350 }]);
    // …but Miami-then-New-York (wrong order) or a port not on the path → none.
    expect(res.viaWrongOrder).toEqual([]);
    expect(res.viaMissing).toEqual([]);
  });

  test('the Find route button opens the finder, lists routes, and links each leg', async ({ page }) => {
    await page.addInitScript(() => {
      window.open = (url, target, features) => { window.__opened = { url, target, features }; return {}; };
    });
    await gotoFresh(page, null, chainFixtures());

    await page.locator('#findRouteBtn').click();
    await page.waitForSelector('dialog#routeFinderDialog[open]');
    await page.fill('#routeFrom', 'Southampton');
    await page.fill('#routeTo', 'New York');
    await page.fill('#routeMax', '1000');
    await page.locator('.route-search-btn').click();

    const firstRoute = page.locator('.route-result').first();
    await expect(firstRoute.locator('.route-result-path')).toHaveText('Southampton → Reykjavik → New York');
    await expect(firstRoute.locator('.route-result-total')).toContainText('total £800');

    // Each leg links to that sailing in the main table (new tab).
    await firstRoute.locator('.route-leg').first().click();
    const opened = await page.evaluate(() => window.__opened);
    expect(opened.target).toBe('_blank');
    expect(opened.url).toContain('cruise=rc_root');
  });
});

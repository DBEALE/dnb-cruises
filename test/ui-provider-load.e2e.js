'use strict';

const { test, expect } = require('@playwright/test');

// The cruise/history cache lives in IndexedDB (localStorage's ~5 MB quota
// couldn't hold the multi-MB payloads). Read a scoped-cache entry back the
// same way the app stores it: DB 'cruise-explorer-cache', store 'kv'.
function readIdbCache(page, key) {
  return page.evaluate((k) => new Promise((resolve) => {
    let request;
    try { request = indexedDB.open('cruise-explorer-cache', 1); }
    catch { resolve(null); return; }
    request.onupgradeneeded = () => { try { request.result.createObjectStore('kv'); } catch {} };
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('kv')) { resolve(null); return; }
      try {
        const get = db.transaction('kv', 'readonly').objectStore('kv').get(k);
        get.onsuccess = () => resolve(get.result ?? null);
        get.onerror = () => resolve(null);
      } catch { resolve(null); }
    };
  }), key);
}

test('provider-specific cruises load on page open and persist the scoped cache', async ({ page }) => {
  let apiRequestCount = 0;

  await page.route('**/providers/index.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        defaultProviderId: 'royal-caribbean',
        providers: [
          {
            id: 'royal-caribbean',
            name: 'Royal Caribbean',
            cruisesUrl: './providers/royal-caribbean/cruises.json',
          },
        ],
      }),
    });
  });

  await page.route('**/providers/royal-caribbean/cruises.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cruises: [
          {
            provider: 'Royal Caribbean',
            shipName: 'Harmony of the Seas',
            itinerary: 'Adriatic Escape',
            departureDate: '',
            duration: '7 Nights',
            departurePort: 'Barcelona',
            destination: 'Mediterranean',
            destinationPort: 'Venice',
            priceFrom: '899',
            currency: 'GBP',
            bookingUrl: '/cruises/harmony',
          },
        ],
        scrapedAt: '2026-04-27T20:00:00.000Z',
      }),
    });
  });

  await page.route('**/api/cruises**', async (route) => {
    apiRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        cruises: [],
        scrapedAt: '2026-04-27T00:00:00.000Z',
      }),
    });
  });

  await page.route('**/open.er-api.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rates: { GBP: 0.79 } }),
    });
  });

  await page.goto('/');

  await expect(page).toHaveTitle(/Cruise Explorer/);
  await expect(page.locator('#statusBar')).not.toHaveClass(/visible/);
  await expect(page.locator('#summary')).toContainText('Showing all 1 sailings');
  await expect(page.locator('#cruiseBody')).toContainText('Harmony of the Seas');
  await expect(page.locator('#cruiseBody .col-destination-port')).toContainText('Venice');
  await expect(page.locator('#totalProviders')).toHaveText('1');
  await expect(page.locator('#updatedAt')).toHaveCount(0);
  await expect(page.locator('.header-stats')).not.toContainText('Latest sync');
  await expect.poll(async () => readIdbCache(page, 'cached_cruises:royal-caribbean')).toBeTruthy();
  expect(apiRequestCount).toBe(0);
});

test('all three providers load and display cruise data', async ({ page }) => {
  await page.route('**/providers/index.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        defaultProviderId: 'royal-caribbean',
        providers: [
          { id: 'royal-caribbean',  name: 'Royal Caribbean',        cruisesUrl: './providers/royal-caribbean/cruises.json' },
          { id: 'celebrity-cruises', name: 'Celebrity Cruises',      cruisesUrl: './providers/celebrity-cruises/cruises.json' },
          { id: 'ncl-cruises',       name: 'Norwegian Cruise Line',  cruisesUrl: './providers/ncl-cruises/cruises.json' },
        ],
      }),
    });
  });

  await page.route('**/providers/royal-caribbean/cruises.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cruises: [{
          provider: 'Royal Caribbean',
          id: 'rc_1',
          shipName: 'Harmony of the Seas',
          itinerary: 'Adriatic Escape',
          departureDate: '2026-06-01',
          duration: '7 Nights',
          departurePort: 'Barcelona',
          destination: 'Mediterranean',
          priceFrom: '899',
          currency: 'GBP',
          bookingUrl: '/cruises/harmony',
        }],
        scrapedAt: '2026-04-27T20:00:00.000Z',
      }),
    });
  });

  await page.route('**/providers/celebrity-cruises/cruises.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cruises: [{
          provider: 'Celebrity Cruises',
          id: 'celebrity_1',
          shipName: 'Celebrity Apex',
          itinerary: 'Greek Isles',
          departureDate: '2026-07-15',
          duration: '10 Nights',
          departurePort: 'Athens',
          destination: 'Mediterranean',
          priceFrom: '1299',
          currency: 'GBP',
          bookingUrl: 'https://www.celebritycruises.com/gb/cruise/celebrity-apex',
        }],
        scrapedAt: '2026-04-27T20:00:00.000Z',
      }),
    });
  });

  await page.route('**/providers/ncl-cruises/cruises.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cruises: [{
          provider: 'Norwegian Cruise Line',
          id: 'ncl_1',
          shipName: 'Norwegian Bliss',
          itinerary: 'Alaska Explorer',
          departureDate: '2026-08-10',
          duration: '7 Nights',
          departurePort: 'Seattle',
          destination: 'Alaska',
          priceFrom: '1099',
          currency: 'USD',
          bookingUrl: 'https://www.ncl.com/cruise/B710',
        }],
        scrapedAt: '2026-04-27T20:00:00.000Z',
      }),
    });
  });

  await page.route('**/open.er-api.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rates: { GBP: 0.79 } }),
    });
  });

  await page.goto('/');

  await expect(page).toHaveTitle(/Cruise Explorer/);
  await expect(page.locator('#statusBar')).not.toHaveClass(/visible/);
  await expect(page.locator('#summary')).toContainText('Showing all 3 sailings');

  await expect(page.locator('#cruiseBody')).toContainText('Harmony of the Seas');
  await expect(page.locator('#cruiseBody')).toContainText('Celebrity Apex');
  await expect(page.locator('#cruiseBody')).toContainText('Norwegian Bliss');

  await expect(page.locator('#totalProviders')).toHaveText('3');

  await expect.poll(async () => readIdbCache(page, 'cached_cruises:royal-caribbean')).toBeTruthy();
  await expect.poll(async () => readIdbCache(page, 'cached_cruises:celebrity-cruises')).toBeTruthy();
  await expect.poll(async () => readIdbCache(page, 'cached_cruises:ncl-cruises')).toBeTruthy();
});

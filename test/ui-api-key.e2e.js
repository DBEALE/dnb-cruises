'use strict';

const { test, expect } = require('@playwright/test');

test('cached cruises load on page open and refresh uses the key in browser requests', async ({ page }) => {
  const cached = {
    cruises: [
      {
        shipName: 'Harmony of the Seas',
        itinerary: 'Adriatic Escape',
        departureDate: '',
        duration: '7 Nights',
        departurePort: 'Barcelona',
        destination: 'Mediterranean',
        priceFrom: '899',
        currency: 'GBP',
        bookingUrl: '/cruises/harmony',
      },
    ],
    scrapedAt: '2026-04-27T20:00:00.000Z',
  };

  await page.addInitScript((value) => {
    localStorage.setItem('cached_cruises', JSON.stringify(value));
    localStorage.setItem('firecrawl_api_key', 'fc-browser-test-key');
  }, cached);

  let scrapeHeaders;
  let cruisesHeaders;
  let apiRequestCount = 0;

  await page.route('**/api/scrape**', async (route) => {
    apiRequestCount += 1;
    scrapeHeaders = route.request().headers();
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'not found' }),
    });
  });

  await page.route('**/api/cruises**', async (route) => {
    apiRequestCount += 1;
    cruisesHeaders = route.request().headers();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        cruises: [
          {
            shipName: 'Quantum of the Seas',
            itinerary: 'Greek Isles',
            departureDate: '',
            duration: '7 Nights',
            departurePort: 'Athens',
            destination: 'Mediterranean',
            priceFrom: '999',
            currency: 'GBP',
            bookingUrl: '/cruises/quantum',
          },
        ],
        scrapedAt: '2026-04-27T00:00:00.000Z',
      }),
    });
  });

  await page.goto('/');
  await expect(page.locator('#status')).toContainText('cached');
  await expect(page.locator('#summary')).toContainText('Showing 1 result');
  await expect(page.locator('#cruiseBody')).toContainText('Harmony of the Seas');
  expect(apiRequestCount).toBe(0);

  await page.locator('#apiKeyInput').fill('fc-browser-test-key');
  await page.locator('#fetchBtn').click();

  await expect(page.locator('#status')).toHaveText(/Loaded 1 cruise/);
  await expect(page.locator('#searchInput')).toBeEnabled();
  await expect(page.locator('#summary')).toContainText('Showing 1 result');

  expect(apiRequestCount).toBeGreaterThan(0);
  expect(scrapeHeaders['x-firecrawl-api-key']).toBe('fc-browser-test-key');
  expect(cruisesHeaders['x-firecrawl-api-key']).toBe('fc-browser-test-key');
  await expect(page.locator('#apiKeyInput')).toHaveValue('fc-browser-test-key');

  const persisted = await page.evaluate(() => localStorage.getItem('firecrawl_api_key'));
  expect(persisted).toBe('fc-browser-test-key');
});

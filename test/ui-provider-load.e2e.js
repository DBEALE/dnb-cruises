'use strict';

const { test, expect } = require('@playwright/test');

test('provider-specific cruises load on page open and persist the scoped cache', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('cached_cruises:royal-caribbean', JSON.stringify({
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
    }));
  });

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
  await expect(page.locator('#providerStats')).toContainText('Royal Caribbean');
  await expect(page.locator('#providerStats')).toContainText('Updated:');
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('cached_cruises:royal-caribbean'))).toBeTruthy();
  expect(apiRequestCount).toBe(0);
});

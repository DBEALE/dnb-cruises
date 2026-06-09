'use strict';

// E2E coverage for the post-MVP features: sparklines + price-history dialog,
// filter / sort / per-cabin sort, URL state, settings dialog with localStorage.
//
// All tests stub out the provider catalog and cruises.json so they don't
// depend on the live data file (which is gitignored and might be absent
// locally) and so the assertions are deterministic.
const {
  test,
  expect
} = require('@playwright/test');
const PROVIDER_INDEX = {
  defaultProviderId: 'royal-caribbean',
  providers: [{
    id: 'royal-caribbean',
    name: 'Royal Caribbean',
    cruisesUrl: './providers/royal-caribbean/cruises.json'
  }, {
    id: 'celebrity-cruises',
    name: 'Celebrity Cruises',
    cruisesUrl: './providers/celebrity-cruises/cruises.json'
  }]
};

// Helper — build a cruise with the priceHistory shape the UI expects.
function cruise({
  id,
  shipName,
  provider,
  priceFrom,
  prices,
  history,
  firstSeenAt,
  departureDate = '2026-09-01',
  days = 7,
  port = 'Southampton',
  itinerary = `${days}-Night ${port} Sample`,
  shipLaunchYear = 2020,
  seaDays = null
}) {
  return {
    id,
    shipName,
    provider,
    shipClass: 'Oasis',
    shipLaunchYear,
    itinerary,
    departureDate,
    duration: `${days} Nights`,
    seaDays,
    departurePort: port,
    departureRegion: 'UK & Ireland',
    destination: 'Northern Europe',
    priceFrom: String(priceFrom),
    currency: 'GBP',
    bookingUrl: `/booking/${id}`,
    prices: prices || {
      inside: null,
      oceanView: null,
      balcony: null,
      suite: null
    },
    priceHistory: history || [],
    firstSeenAt
  };
}
const CRUISES_RC = {
  scrapedAt: '2026-05-31T10:00:00Z',
  cruises: [cruise({
    id: 'rc_a',
    shipName: 'Anthem of the Seas',
    provider: 'Royal Caribbean',
    priceFrom: 500,
    days: 7,
    departureDate: '2026-08-31',
    firstSeenAt: '2026-05-01T10:00:00Z',
    shipLaunchYear: 2025,
    seaDays: 3,
    prices: {
      inside: '500',
      oceanView: '650',
      balcony: '800',
      suite: '1800'
    },
    history: [{
      at: '2026-05-01T10:00:00Z',
      prices: {
        inside: 600,
        oceanView: 720,
        balcony: 900,
        suite: 2000
      }
    }, {
      at: '2026-05-15T10:00:00Z',
      prices: {
        inside: 550,
        oceanView: 680,
        balcony: 850,
        suite: 1900
      }
    }, {
      at: '2026-05-31T10:00:00Z',
      prices: {
        inside: 500,
        oceanView: 650,
        balcony: 800,
        suite: 1800
      }
    }]
  }), cruise({
    id: 'rc_b',
    shipName: 'Harmony of the Seas',
    provider: 'Royal Caribbean',
    priceFrom: 1200,
    days: 14,
    firstSeenAt: '2026-06-05T10:00:00Z',
    shipLaunchYear: 2000,
    seaDays: 9,
    prices: {
      inside: '1200',
      oceanView: '1500',
      balcony: '1800',
      suite: '3500'
    },
    history: [{
      at: '2026-05-01T10:00:00Z',
      prices: {
        inside: 1100,
        oceanView: 1400,
        balcony: 1700,
        suite: 3400
      }
    }, {
      at: '2026-05-31T10:00:00Z',
      prices: {
        inside: 1200,
        oceanView: 1500,
        balcony: 1800,
        suite: 3500
      }
    }]
  })]
};
const CRUISES_CEL = {
  scrapedAt: '2026-05-31T10:00:00Z',
  cruises: [cruise({
    id: 'cel_a',
    shipName: 'Celebrity Edge',
    provider: 'Celebrity Cruises',
    priceFrom: 900,
    days: 10,
    port: 'Barcelona',
    departureDate: '2026-09-02',
    firstSeenAt: '2026-05-20T10:00:00Z',
    itinerary: 'Barcelona, Spain Mediterranean Escape',
    seaDays: 2,
    prices: {
      inside: '900',
      oceanView: null,
      balcony: '1300',
      suite: '2500'
    }
  })]
};

// Stub every network call so the test exercises the UI in isolation.
async function setupRoutes(page) {
  await page.route('**/providers/index.json', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(PROVIDER_INDEX)
  }));
  await page.route('**/providers/royal-caribbean/cruises.json', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(CRUISES_RC)
  }));
  await page.route('**/providers/celebrity-cruises/cruises.json', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(CRUISES_CEL)
  }));
  await page.route('**/ship-wiki-links.json', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ships: {
        'anthem of the seas': 'https://en.wikipedia.org/wiki/Anthem_of_the_Seas'
      },
      providers: {
        'royal caribbean': 'https://en.wikipedia.org/wiki/Royal_Caribbean_International'
      },
      classes: {
        oasis: 'https://en.wikipedia.org/wiki/Oasis-class_cruise_ship'
      }
    })
  }));
  await page.route('**/build-info.json', r => r.fulfill({
    status: 404,
    body: ''
  }));
  await page.route('**/open.er-api.com/**', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      rates: {
        GBP: 1
      }
    })
  }));
}

// Pre-seed display settings before the page boots. Pass `null` to leave
// localStorage untouched so first-time-visitor defaults apply.
async function gotoFresh(page, settings = null) {
  if (settings) {
    await page.addInitScript(s => {
      localStorage.setItem('cruise-explorer-settings', JSON.stringify(s));
    }, settings);
  }
  await setupRoutes(page);
  await page.goto('/');
  await page.waitForSelector('tbody tr:not(.empty-row)');
}

// Settings preset for tests that need sparklines + per-night visible
// (they're off by default for first-time visitors).
const ALL_ON = {
  sparklines: true,
  perNight: true,
  wikiLinks: true,
  classDots: true,
  launchYear: true
};
test.describe('Sparklines', () => {
  test('per-cabin sparklines render as lazy placeholders and fill on intersection', async ({
    page
  }) => {
    await gotoFresh(page, ALL_ON);
    // Anthem (3 history points) → 4 cabin sparks; Harmony (2 points) → 4 cabin sparks
    const sparkCount = await page.locator('.cabin-spark').count();
    expect(sparkCount).toBeGreaterThanOrEqual(8);
    // First viewport's placeholders should have filled with SVGs synchronously.
    await page.waitForFunction(() => document.querySelector('.cabin-spark[data-spark-filled="1"]') !== null);
    expect(await page.locator('.cabin-spark svg').count()).toBeGreaterThan(0);
  });
  test('clicking a sparkline opens the price-history dialog with multi-cabin chart', async ({
    page
  }) => {
    await gotoFresh(page, ALL_ON);
    await page.locator('.cabin-spark').first().click();
    await page.waitForSelector('dialog#priceHistoryDialog[open]');
    const legend = await page.locator('#phChart .ph-legend-item').allTextContents();
    expect(legend).toEqual(expect.arrayContaining(['Inside', 'Sea view', 'Balcony', 'Suite']));
    // Chart path per cabin
    expect(await page.locator('#phChart svg path').count()).toBe(4);
    // Latest at the top
    const firstRowDate = await page.locator('#phTableBody tr:first-child td:first-child').innerText();
    expect(firstRowDate).toMatch(/31 May/);
  });
});
test.describe('Header wave', () => {
  test('pressing the title triggers a single slower sweep', async ({
    page
  }) => {
    await gotoFresh(page);
    const wave = page.locator('.header-wave');
    await expect(page.locator('.header-wave .wave')).toHaveCount(4);
    await expect(page.locator('.header-wave .wave-crest')).toHaveCount(1);
    await page.locator('header h1').dispatchEvent('pointerdown', {
      button: 0
    });
    await expect(wave).toHaveClass(/is-sweeping/);
    await expect(wave).not.toHaveClass(/is-sweeping/, {
      timeout: 3500
    });
  });
});
test.describe('Sort and filter', () => {
  test('ship launch years render with newness badges', async ({
    page
  }) => {
    await gotoFresh(page);
    await expect(page.locator('tbody tr:first-child .col-launch .launch-year-badge')).toHaveClass(/newness-newest/);
    await expect(page.locator('tbody tr:first-child .col-launch .launch-year-star')).toHaveCount(1);
  });
  test('older launch years are shown in a muted grey badge', async ({
    page
  }) => {
    await gotoFresh(page);
    await expect(page.locator('tbody tr:has-text("Harmony of the Seas") .col-launch .launch-year-badge')).toHaveClass(/newness-legacy/);
  });
  test('sea days render in the new column', async ({
    page
  }) => {
    await gotoFresh(page);
    await expect(page.locator('tbody tr:first-child .col-sea-days')).toContainText('3');
  });
  test('sea days sort orders by the new column', async ({
    page
  }) => {
    await gotoFresh(page);
    await page.selectOption('#sortSelect', '19');
    await expect(page.locator('tbody tr:first-child .col-ship')).toContainText('Celebrity Edge');
  });
  test('sort dropdown + direction toggle reorders rows', async ({
    page
  }) => {
    await gotoFresh(page);
    // Picking from the dropdown applies ascending by default; the toggle
    // button flips direction.
    await page.selectOption('#sortSelect', '17'); // £/night, ascending
    await page.click('#sortDirBtn'); // flip to descending
    // Harmony 14n £1200 = £85/n, Anthem 7n £500 = £71/n, Edge 10n £900 = £90/n
    // Edge (90) > Harmony (85) > Anthem (71)
    await expect(page.locator('tbody tr:first-child .col-ship')).toContainText('Celebrity Edge');
    // Direction button reflects the flipped state
    await expect(page.locator('#sortDirBtn')).toHaveText('↓');
  });
  test('per-cabin sort uses that cabin\'s price', async ({
    page
  }) => {
    await gotoFresh(page);
    await page.selectOption('#sortSelect', '15'); // Suite, ascending
    // Anthem suite 1800, Edge suite 2500, Harmony suite 3500
    const firstShip = await page.locator('tbody tr:first-child .col-ship').innerText();
    expect(firstShip).toContain('Anthem');
  });
  test('direction button is disabled until a sort column is picked', async ({
    page
  }) => {
    await gotoFresh(page);
    await expect(page.locator('#sortDirBtn')).toBeDisabled();
    await page.selectOption('#sortSelect', '11');
    await expect(page.locator('#sortDirBtn')).toBeEnabled();
    await expect(page.locator('#sortDirBtn')).toHaveText('↑');
  });
  test('recently found sort defaults to newest first', async ({
    page
  }) => {
    await gotoFresh(page);
    await page.selectOption('#sortSelect', '18');
    await expect(page.locator('tbody tr:first-child .col-ship')).toContainText('Harmony');
    await expect(page.locator('#sortDirBtn')).toHaveText('↓');
  });
  test('column filter narrows results and updates summary count', async ({
    page
  }) => {
    await gotoFresh(page);
    await page.locator('.col-filter[data-field="provider"]').selectOption('Celebrity Cruises');
    await expect(page.locator('#summary')).toContainText('1 of 3');
    await expect(page.locator('#summary')).toContainText('Celebrity Cruises');
    expect(await page.locator('tbody tr').count()).toBe(1);
  });
  test('sea days filter narrows results and updates summary count', async ({
    page
  }) => {
    await gotoFresh(page);
    await page.locator('.col-filter[data-field="seaDays"]').fill('4');
    await page.locator('.col-filter[data-field="seaDays"]').dispatchEvent('input');
    await expect(page.locator('#summary')).toContainText('2 of 3');
    await expect(page.locator('#summary')).toContainText('Max 4 sea days');
    expect(await page.locator('tbody tr').count()).toBe(2);
    await expect(page.locator('tbody tr:first-child .col-ship')).toContainText('Anthem of the Seas');
    await expect(page.locator('tbody tr:nth-child(2) .col-ship')).toContainText('Celebrity Edge');
  });
  test('itinerary filter matches every word and highlights each one', async ({
    page
  }) => {
    await gotoFresh(page);
    await page.locator('.col-filter[data-field="itinerary"]').fill('Barcelona Spain');
    await page.locator('.col-filter[data-field="itinerary"]').dispatchEvent('input');
    await expect(page.locator('#summary')).toContainText('1 of 3');
    await expect(page.locator('tbody tr:first-child .col-itinerary')).toContainText('Barcelona');
    await expect(page.locator('tbody tr:first-child .col-itinerary')).toContainText('Spain');
    await expect(page.locator('tbody tr:first-child .col-itinerary .itinerary-highlight')).toHaveCount(2);
  });
  test('clear button resets an individual filter', async ({
    page
  }) => {
    await gotoFresh(page);
    const provider = page.locator('.col-filter[data-field="provider"]');
    await provider.selectOption('Celebrity Cruises');
    await expect(page.locator('#summary')).toContainText('1 of 3');
    await page.locator('#filterRow .col-provider .filter-clear-btn').click();
    await expect(provider).toHaveValue('');
    await expect(page.locator('#summary')).toContainText('all 3');
  });
  test('departure date range filters inclusively', async ({
    page
  }) => {
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
  test('ship-size filter (tier:large) keeps only ships whose class maps to large', async ({
    page
  }) => {
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
  test('sort + filter persist across reload via URL hash', async ({
    page
  }) => {
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
test.describe('Saved views', () => {
  test('suggests an editable name from current filters and sort', async ({
    page
  }) => {
    await gotoFresh(page);
    await page.selectOption('#sortSelect', '14');
    await page.locator('.col-filter[data-field="provider"]').selectOption('Royal Caribbean');
    await page.click('#savedViewsBtn');
    await page.waitForSelector('dialog#savedViewsDialog[open]');
    await expect(page.locator('#svNameInput')).toHaveValue('Royal Caribbean · Balcony');
    await page.locator('#svNameInput').fill('My balcony shortlist');
    await page.locator('#svSaveForm button[type="submit"]').click();
    await expect(page.locator('.sv-name').first()).toHaveText('My balcony shortlist');
    await expect(page.locator('.sv-hash').first()).toContainText('Sort: Price (Balcony)');
    await expect(page.locator('.sv-hash').first()).toContainText('provider=Royal Caribbean');
  });
});
test.describe('Settings dialog', () => {
  test('close button stays visible while display options content scrolls', async ({
    page
  }) => {
    await page.setViewportSize({
      width: 390,
      height: 560
    });
    await gotoFresh(page);
    await page.click('#settingsBtn');
    await page.waitForSelector('dialog#settingsDialog[open]');
    await page.locator('.settings-scroll').evaluate(el => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.locator('#settingsClose')).toBeInViewport();
  });
  test('first-time visitors get sparklines and £/night off; the body class reflects it', async ({
    page
  }) => {
    await gotoFresh(page);
    await expect(page.locator('body')).toHaveClass(/hide-sparklines/);
    await expect(page.locator('body')).toHaveClass(/hide-per-night/);
  });
  test('toggling sparklines on persists across reload', async ({
    page
  }) => {
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
  test('per-night toggle on shows the £/night column', async ({
    page
  }) => {
    await gotoFresh(page);
    await expect(page.locator('.col-per-night').first()).toBeHidden();
    await page.click('#settingsBtn');
    await page.waitForSelector('dialog#settingsDialog[open]');
    await page.locator('#settingsDialog input[data-setting="perNight"]').check();
    await expect(page.locator('.col-per-night').first()).toBeVisible();
  });
  test('link target toggle switches ship links from Wikipedia to cruise company pages', async ({
    page
  }) => {
    await gotoFresh(page);
    await page.waitForFunction(() => document.querySelector('tbody tr:first-child .col-ship a')?.href.includes('wikipedia.org'));
    await expect(page.locator('#cruiseBody tr:first-child .col-ship a').first()).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Anthem_of_the_Seas');
    await page.click('#settingsBtn');
    await page.waitForSelector('dialog#settingsDialog[open]');
    await page.locator('#settingsDialog input[data-setting="companyLinks"]').check();
    await expect(page.locator('#cruiseBody tr:first-child .col-ship a').first()).toHaveAttribute('href', 'https://www.royalcaribbean.com/gbr/en/cruise-ships/anthem-of-the-seas');
  });
  test('Reset to defaults restores first-time-visitor state', async ({
    page
  }) => {
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
  test('close button stays visible while the changes list scrolls', async ({
    page
  }) => {
    await page.setViewportSize({
      width: 390,
      height: 560
    });
    await gotoFresh(page);
    await page.click('#siteChangesBtn');
    await page.waitForSelector('dialog#siteChangesDialog[open]');
    await page.locator('.changes-scroll').evaluate(el => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.locator('#changesClose')).toBeInViewport();
  });
});
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJ0ZXN0IiwiZXhwZWN0IiwicmVxdWlyZSIsIlBST1ZJREVSX0lOREVYIiwiZGVmYXVsdFByb3ZpZGVySWQiLCJwcm92aWRlcnMiLCJpZCIsIm5hbWUiLCJjcnVpc2VzVXJsIiwiY3J1aXNlIiwic2hpcE5hbWUiLCJwcm92aWRlciIsInByaWNlRnJvbSIsInByaWNlcyIsImhpc3RvcnkiLCJmaXJzdFNlZW5BdCIsImRlcGFydHVyZURhdGUiLCJkYXlzIiwicG9ydCIsIml0aW5lcmFyeSIsInNoaXBMYXVuY2hZZWFyIiwic2VhRGF5cyIsInNoaXBDbGFzcyIsImR1cmF0aW9uIiwiZGVwYXJ0dXJlUG9ydCIsImRlcGFydHVyZVJlZ2lvbiIsImRlc3RpbmF0aW9uIiwiU3RyaW5nIiwiY3VycmVuY3kiLCJib29raW5nVXJsIiwiaW5zaWRlIiwib2NlYW5WaWV3IiwiYmFsY29ueSIsInN1aXRlIiwicHJpY2VIaXN0b3J5IiwiQ1JVSVNFU19SQyIsInNjcmFwZWRBdCIsImNydWlzZXMiLCJhdCIsIkNSVUlTRVNfQ0VMIiwic2V0dXBSb3V0ZXMiLCJwYWdlIiwicm91dGUiLCJyIiwiZnVsZmlsbCIsInN0YXR1cyIsImNvbnRlbnRUeXBlIiwiYm9keSIsIkpTT04iLCJzdHJpbmdpZnkiLCJzaGlwcyIsImNsYXNzZXMiLCJvYXNpcyIsInJhdGVzIiwiR0JQIiwiZ290b0ZyZXNoIiwic2V0dGluZ3MiLCJhZGRJbml0U2NyaXB0IiwicyIsImxvY2FsU3RvcmFnZSIsInNldEl0ZW0iLCJnb3RvIiwid2FpdEZvclNlbGVjdG9yIiwiQUxMX09OIiwic3BhcmtsaW5lcyIsInBlck5pZ2h0Iiwid2lraUxpbmtzIiwiY2xhc3NEb3RzIiwibGF1bmNoWWVhciIsImRlc2NyaWJlIiwic3BhcmtDb3VudCIsImxvY2F0b3IiLCJjb3VudCIsInRvQmVHcmVhdGVyVGhhbk9yRXF1YWwiLCJ3YWl0Rm9yRnVuY3Rpb24iLCJkb2N1bWVudCIsInF1ZXJ5U2VsZWN0b3IiLCJ0b0JlR3JlYXRlclRoYW4iLCJmaXJzdCIsImNsaWNrIiwibGVnZW5kIiwiYWxsVGV4dENvbnRlbnRzIiwidG9FcXVhbCIsImFycmF5Q29udGFpbmluZyIsInRvQmUiLCJmaXJzdFJvd0RhdGUiLCJpbm5lclRleHQiLCJ0b01hdGNoIiwid2F2ZSIsInRvSGF2ZUNvdW50IiwiZGlzcGF0Y2hFdmVudCIsImJ1dHRvbiIsInRvSGF2ZUNsYXNzIiwibm90IiwidGltZW91dCIsInRvQ29udGFpblRleHQiLCJzZWxlY3RPcHRpb24iLCJ0b0hhdmVUZXh0IiwiZmlyc3RTaGlwIiwidG9Db250YWluIiwidG9CZURpc2FibGVkIiwidG9CZUVuYWJsZWQiLCJmaWxsIiwidG9IYXZlVmFsdWUiLCJsb2NhdGlvbiIsImhhc2giLCJpbmNsdWRlcyIsInVybEJlZm9yZSIsInVybCIsImlucHV0VmFsdWUiLCJzZXRWaWV3cG9ydFNpemUiLCJ3aWR0aCIsImhlaWdodCIsImV2YWx1YXRlIiwiZWwiLCJzY3JvbGxUb3AiLCJzY3JvbGxIZWlnaHQiLCJ0b0JlSW5WaWV3cG9ydCIsImNoZWNrIiwic3RvcmVkIiwicGFyc2UiLCJnZXRJdGVtIiwicmVsb2FkIiwidG9CZUhpZGRlbiIsInRvQmVWaXNpYmxlIiwiaHJlZiIsInRvSGF2ZUF0dHJpYnV0ZSIsImlzQ2hlY2tlZCJdLCJzb3VyY2VzIjpbInVpLWZlYXR1cmVzLmUyZS5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIndXNlIHN0cmljdCc7XG5cbi8vIEUyRSBjb3ZlcmFnZSBmb3IgdGhlIHBvc3QtTVZQIGZlYXR1cmVzOiBzcGFya2xpbmVzICsgcHJpY2UtaGlzdG9yeSBkaWFsb2csXG4vLyBmaWx0ZXIgLyBzb3J0IC8gcGVyLWNhYmluIHNvcnQsIFVSTCBzdGF0ZSwgc2V0dGluZ3MgZGlhbG9nIHdpdGggbG9jYWxTdG9yYWdlLlxuLy9cbi8vIEFsbCB0ZXN0cyBzdHViIG91dCB0aGUgcHJvdmlkZXIgY2F0YWxvZyBhbmQgY3J1aXNlcy5qc29uIHNvIHRoZXkgZG9uJ3Rcbi8vIGRlcGVuZCBvbiB0aGUgbGl2ZSBkYXRhIGZpbGUgKHdoaWNoIGlzIGdpdGlnbm9yZWQgYW5kIG1pZ2h0IGJlIGFic2VudFxuLy8gbG9jYWxseSkgYW5kIHNvIHRoZSBhc3NlcnRpb25zIGFyZSBkZXRlcm1pbmlzdGljLlxuXG5jb25zdCB7IHRlc3QsIGV4cGVjdCB9ID0gcmVxdWlyZSgnQHBsYXl3cmlnaHQvdGVzdCcpO1xuXG5jb25zdCBQUk9WSURFUl9JTkRFWCA9IHtcbiAgZGVmYXVsdFByb3ZpZGVySWQ6ICdyb3lhbC1jYXJpYmJlYW4nLFxuICBwcm92aWRlcnM6IFtcbiAgICB7IGlkOiAncm95YWwtY2FyaWJiZWFuJywgbmFtZTogJ1JveWFsIENhcmliYmVhbicsIGNydWlzZXNVcmw6ICcuL3Byb3ZpZGVycy9yb3lhbC1jYXJpYmJlYW4vY3J1aXNlcy5qc29uJyB9LFxuICAgIHsgaWQ6ICdjZWxlYnJpdHktY3J1aXNlcycsIG5hbWU6ICdDZWxlYnJpdHkgQ3J1aXNlcycsIGNydWlzZXNVcmw6ICcuL3Byb3ZpZGVycy9jZWxlYnJpdHktY3J1aXNlcy9jcnVpc2VzLmpzb24nIH0sXG4gIF0sXG59O1xuXG4vLyBIZWxwZXIg4oCUIGJ1aWxkIGEgY3J1aXNlIHdpdGggdGhlIHByaWNlSGlzdG9yeSBzaGFwZSB0aGUgVUkgZXhwZWN0cy5cbmZ1bmN0aW9uIGNydWlzZSh7IGlkLCBzaGlwTmFtZSwgcHJvdmlkZXIsIHByaWNlRnJvbSwgcHJpY2VzLCBoaXN0b3J5LCBmaXJzdFNlZW5BdCwgZGVwYXJ0dXJlRGF0ZSA9ICcyMDI2LTA5LTAxJywgZGF5cyA9IDcsIHBvcnQgPSAnU291dGhhbXB0b24nLCBpdGluZXJhcnkgPSBgJHtkYXlzfS1OaWdodCAke3BvcnR9IFNhbXBsZWAsIHNoaXBMYXVuY2hZZWFyID0gMjAyMCwgc2VhRGF5cyA9IG51bGwgfSkge1xuICByZXR1cm4ge1xuICAgIGlkLCBzaGlwTmFtZSwgcHJvdmlkZXIsXG4gICAgc2hpcENsYXNzOiAgICAgICAnT2FzaXMnLFxuICAgIHNoaXBMYXVuY2hZZWFyLFxuICAgIGl0aW5lcmFyeSxcbiAgICBkZXBhcnR1cmVEYXRlLFxuICAgIGR1cmF0aW9uOiAgICAgICAgYCR7ZGF5c30gTmlnaHRzYCxcbiAgICBzZWFEYXlzLFxuICAgIGRlcGFydHVyZVBvcnQ6ICAgcG9ydCxcbiAgICBkZXBhcnR1cmVSZWdpb246ICdVSyAmIElyZWxhbmQnLFxuICAgIGRlc3RpbmF0aW9uOiAgICAgJ05vcnRoZXJuIEV1cm9wZScsXG4gICAgcHJpY2VGcm9tOiAgICAgICBTdHJpbmcocHJpY2VGcm9tKSxcbiAgICBjdXJyZW5jeTogICAgICAgICdHQlAnLFxuICAgIGJvb2tpbmdVcmw6ICAgICAgYC9ib29raW5nLyR7aWR9YCxcbiAgICBwcmljZXM6ICAgICAgICAgIHByaWNlcyB8fCB7IGluc2lkZTogbnVsbCwgb2NlYW5WaWV3OiBudWxsLCBiYWxjb255OiBudWxsLCBzdWl0ZTogbnVsbCB9LFxuICAgIHByaWNlSGlzdG9yeTogICAgaGlzdG9yeSB8fCBbXSxcbiAgICBmaXJzdFNlZW5BdCxcbiAgfTtcbn1cblxuY29uc3QgQ1JVSVNFU19SQyA9IHtcbiAgc2NyYXBlZEF0OiAnMjAyNi0wNS0zMVQxMDowMDowMFonLFxuICBjcnVpc2VzOiBbXG4gICAgY3J1aXNlKHtcbiAgICAgIGlkOiAncmNfYScsIHNoaXBOYW1lOiAnQW50aGVtIG9mIHRoZSBTZWFzJywgcHJvdmlkZXI6ICdSb3lhbCBDYXJpYmJlYW4nLFxuICAgICAgcHJpY2VGcm9tOiA1MDAsIGRheXM6IDcsIGRlcGFydHVyZURhdGU6ICcyMDI2LTA4LTMxJywgZmlyc3RTZWVuQXQ6ICcyMDI2LTA1LTAxVDEwOjAwOjAwWicsXG4gICAgICBzaGlwTGF1bmNoWWVhcjogMjAyNSxcbiAgICAgIHNlYURheXM6IDMsXG4gICAgICBwcmljZXM6IHsgaW5zaWRlOiAnNTAwJywgb2NlYW5WaWV3OiAnNjUwJywgYmFsY29ueTogJzgwMCcsIHN1aXRlOiAnMTgwMCcgfSxcbiAgICAgIGhpc3Rvcnk6IFtcbiAgICAgICAgeyBhdDogJzIwMjYtMDUtMDFUMTA6MDA6MDBaJywgcHJpY2VzOiB7IGluc2lkZTogNjAwLCBvY2VhblZpZXc6IDcyMCwgYmFsY29ueTogOTAwLCBzdWl0ZTogMjAwMCB9IH0sXG4gICAgICAgIHsgYXQ6ICcyMDI2LTA1LTE1VDEwOjAwOjAwWicsIHByaWNlczogeyBpbnNpZGU6IDU1MCwgb2NlYW5WaWV3OiA2ODAsIGJhbGNvbnk6IDg1MCwgc3VpdGU6IDE5MDAgfSB9LFxuICAgICAgICB7IGF0OiAnMjAyNi0wNS0zMVQxMDowMDowMFonLCBwcmljZXM6IHsgaW5zaWRlOiA1MDAsIG9jZWFuVmlldzogNjUwLCBiYWxjb255OiA4MDAsIHN1aXRlOiAxODAwIH0gfSxcbiAgICAgIF0sXG4gICAgfSksXG4gICAgY3J1aXNlKHtcbiAgICAgIGlkOiAncmNfYicsIHNoaXBOYW1lOiAnSGFybW9ueSBvZiB0aGUgU2VhcycsIHByb3ZpZGVyOiAnUm95YWwgQ2FyaWJiZWFuJyxcbiAgICAgIHByaWNlRnJvbTogMTIwMCwgZGF5czogMTQsIGZpcnN0U2VlbkF0OiAnMjAyNi0wNi0wNVQxMDowMDowMFonLFxuICAgICAgc2hpcExhdW5jaFllYXI6IDIwMDAsXG4gICAgICBzZWFEYXlzOiA5LFxuICAgICAgcHJpY2VzOiB7IGluc2lkZTogJzEyMDAnLCBvY2VhblZpZXc6ICcxNTAwJywgYmFsY29ueTogJzE4MDAnLCBzdWl0ZTogJzM1MDAnIH0sXG4gICAgICBoaXN0b3J5OiBbXG4gICAgICAgIHsgYXQ6ICcyMDI2LTA1LTAxVDEwOjAwOjAwWicsIHByaWNlczogeyBpbnNpZGU6IDExMDAsIG9jZWFuVmlldzogMTQwMCwgYmFsY29ueTogMTcwMCwgc3VpdGU6IDM0MDAgfSB9LFxuICAgICAgICB7IGF0OiAnMjAyNi0wNS0zMVQxMDowMDowMFonLCBwcmljZXM6IHsgaW5zaWRlOiAxMjAwLCBvY2VhblZpZXc6IDE1MDAsIGJhbGNvbnk6IDE4MDAsIHN1aXRlOiAzNTAwIH0gfSxcbiAgICAgIF0sXG4gICAgfSksXG4gIF0sXG59O1xuXG5jb25zdCBDUlVJU0VTX0NFTCA9IHtcbiAgc2NyYXBlZEF0OiAnMjAyNi0wNS0zMVQxMDowMDowMFonLFxuICBjcnVpc2VzOiBbXG4gICAgY3J1aXNlKHtcbiAgICAgIGlkOiAnY2VsX2EnLCBzaGlwTmFtZTogJ0NlbGVicml0eSBFZGdlJywgcHJvdmlkZXI6ICdDZWxlYnJpdHkgQ3J1aXNlcycsXG4gICAgICBwcmljZUZyb206IDkwMCwgZGF5czogMTAsIHBvcnQ6ICdCYXJjZWxvbmEnLCBkZXBhcnR1cmVEYXRlOiAnMjAyNi0wOS0wMicsIGZpcnN0U2VlbkF0OiAnMjAyNi0wNS0yMFQxMDowMDowMFonLFxuICAgICAgaXRpbmVyYXJ5OiAnQmFyY2Vsb25hLCBTcGFpbiBNZWRpdGVycmFuZWFuIEVzY2FwZScsXG4gICAgICBzZWFEYXlzOiAyLFxuICAgICAgcHJpY2VzOiB7IGluc2lkZTogJzkwMCcsIG9jZWFuVmlldzogbnVsbCwgYmFsY29ueTogJzEzMDAnLCBzdWl0ZTogJzI1MDAnIH0sXG4gICAgfSksXG4gIF0sXG59O1xuXG4vLyBTdHViIGV2ZXJ5IG5ldHdvcmsgY2FsbCBzbyB0aGUgdGVzdCBleGVyY2lzZXMgdGhlIFVJIGluIGlzb2xhdGlvbi5cbmFzeW5jIGZ1bmN0aW9uIHNldHVwUm91dGVzKHBhZ2UpIHtcbiAgYXdhaXQgcGFnZS5yb3V0ZSgnKiovcHJvdmlkZXJzL2luZGV4Lmpzb24nLCByID0+IHIuZnVsZmlsbCh7IHN0YXR1czogMjAwLCBjb250ZW50VHlwZTogJ2FwcGxpY2F0aW9uL2pzb24nLCBib2R5OiBKU09OLnN0cmluZ2lmeShQUk9WSURFUl9JTkRFWCkgfSkpO1xuICBhd2FpdCBwYWdlLnJvdXRlKCcqKi9wcm92aWRlcnMvcm95YWwtY2FyaWJiZWFuL2NydWlzZXMuanNvbicsIHIgPT4gci5mdWxmaWxsKHsgc3RhdHVzOiAyMDAsIGNvbnRlbnRUeXBlOiAnYXBwbGljYXRpb24vanNvbicsIGJvZHk6IEpTT04uc3RyaW5naWZ5KENSVUlTRVNfUkMpIH0pKTtcbiAgYXdhaXQgcGFnZS5yb3V0ZSgnKiovcHJvdmlkZXJzL2NlbGVicml0eS1jcnVpc2VzL2NydWlzZXMuanNvbicsIHIgPT4gci5mdWxmaWxsKHsgc3RhdHVzOiAyMDAsIGNvbnRlbnRUeXBlOiAnYXBwbGljYXRpb24vanNvbicsIGJvZHk6IEpTT04uc3RyaW5naWZ5KENSVUlTRVNfQ0VMKSB9KSk7XG4gIGF3YWl0IHBhZ2Uucm91dGUoJyoqL3NoaXAtd2lraS1saW5rcy5qc29uJywgciA9PiByLmZ1bGZpbGwoe1xuICAgIHN0YXR1czogMjAwLFxuICAgIGNvbnRlbnRUeXBlOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgc2hpcHM6IHsgJ2FudGhlbSBvZiB0aGUgc2Vhcyc6ICdodHRwczovL2VuLndpa2lwZWRpYS5vcmcvd2lraS9BbnRoZW1fb2ZfdGhlX1NlYXMnIH0sXG4gICAgICBwcm92aWRlcnM6IHsgJ3JveWFsIGNhcmliYmVhbic6ICdodHRwczovL2VuLndpa2lwZWRpYS5vcmcvd2lraS9Sb3lhbF9DYXJpYmJlYW5fSW50ZXJuYXRpb25hbCcgfSxcbiAgICAgIGNsYXNzZXM6IHsgb2FzaXM6ICdodHRwczovL2VuLndpa2lwZWRpYS5vcmcvd2lraS9PYXNpcy1jbGFzc19jcnVpc2Vfc2hpcCcgfSxcbiAgICB9KSxcbiAgfSkpO1xuICBhd2FpdCBwYWdlLnJvdXRlKCcqKi9idWlsZC1pbmZvLmpzb24nLCByID0+IHIuZnVsZmlsbCh7IHN0YXR1czogNDA0LCBib2R5OiAnJyB9KSk7XG4gIGF3YWl0IHBhZ2Uucm91dGUoJyoqL29wZW4uZXItYXBpLmNvbS8qKicsIHIgPT4gci5mdWxmaWxsKHsgc3RhdHVzOiAyMDAsIGNvbnRlbnRUeXBlOiAnYXBwbGljYXRpb24vanNvbicsIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcmF0ZXM6IHsgR0JQOiAxIH0gfSkgfSkpO1xufVxuXG4vLyBQcmUtc2VlZCBkaXNwbGF5IHNldHRpbmdzIGJlZm9yZSB0aGUgcGFnZSBib290cy4gUGFzcyBgbnVsbGAgdG8gbGVhdmVcbi8vIGxvY2FsU3RvcmFnZSB1bnRvdWNoZWQgc28gZmlyc3QtdGltZS12aXNpdG9yIGRlZmF1bHRzIGFwcGx5LlxuYXN5bmMgZnVuY3Rpb24gZ290b0ZyZXNoKHBhZ2UsIHNldHRpbmdzID0gbnVsbCkge1xuICBpZiAoc2V0dGluZ3MpIHtcbiAgICBhd2FpdCBwYWdlLmFkZEluaXRTY3JpcHQoKHMpID0+IHtcbiAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdjcnVpc2UtZXhwbG9yZXItc2V0dGluZ3MnLCBKU09OLnN0cmluZ2lmeShzKSk7XG4gICAgfSwgc2V0dGluZ3MpO1xuICB9XG4gIGF3YWl0IHNldHVwUm91dGVzKHBhZ2UpO1xuICBhd2FpdCBwYWdlLmdvdG8oJy8nKTtcbiAgYXdhaXQgcGFnZS53YWl0Rm9yU2VsZWN0b3IoJ3Rib2R5IHRyOm5vdCguZW1wdHktcm93KScpO1xufVxuXG4vLyBTZXR0aW5ncyBwcmVzZXQgZm9yIHRlc3RzIHRoYXQgbmVlZCBzcGFya2xpbmVzICsgcGVyLW5pZ2h0IHZpc2libGVcbi8vICh0aGV5J3JlIG9mZiBieSBkZWZhdWx0IGZvciBmaXJzdC10aW1lIHZpc2l0b3JzKS5cbmNvbnN0IEFMTF9PTiA9IHsgc3BhcmtsaW5lczogdHJ1ZSwgcGVyTmlnaHQ6IHRydWUsIHdpa2lMaW5rczogdHJ1ZSwgY2xhc3NEb3RzOiB0cnVlLCBsYXVuY2hZZWFyOiB0cnVlIH07XG5cbnRlc3QuZGVzY3JpYmUoJ1NwYXJrbGluZXMnLCAoKSA9PiB7XG4gIHRlc3QoJ3Blci1jYWJpbiBzcGFya2xpbmVzIHJlbmRlciBhcyBsYXp5IHBsYWNlaG9sZGVycyBhbmQgZmlsbCBvbiBpbnRlcnNlY3Rpb24nLCBhc3luYyAoeyBwYWdlIH0pID0+IHtcbiAgICBhd2FpdCBnb3RvRnJlc2gocGFnZSwgQUxMX09OKTtcbiAgICAvLyBBbnRoZW0gKDMgaGlzdG9yeSBwb2ludHMpIOKGkiA0IGNhYmluIHNwYXJrczsgSGFybW9ueSAoMiBwb2ludHMpIOKGkiA0IGNhYmluIHNwYXJrc1xuICAgIGNvbnN0IHNwYXJrQ291bnQgPSBhd2FpdCBwYWdlLmxvY2F0b3IoJy5jYWJpbi1zcGFyaycpLmNvdW50KCk7XG4gICAgZXhwZWN0KHNwYXJrQ291bnQpLnRvQmVHcmVhdGVyVGhhbk9yRXF1YWwoOCk7XG4gICAgLy8gRmlyc3Qgdmlld3BvcnQncyBwbGFjZWhvbGRlcnMgc2hvdWxkIGhhdmUgZmlsbGVkIHdpdGggU1ZHcyBzeW5jaHJvbm91c2x5LlxuICAgIGF3YWl0IHBhZ2Uud2FpdEZvckZ1bmN0aW9uKCgpID0+IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jYWJpbi1zcGFya1tkYXRhLXNwYXJrLWZpbGxlZD1cIjFcIl0nKSAhPT0gbnVsbCk7XG4gICAgZXhwZWN0KGF3YWl0IHBhZ2UubG9jYXRvcignLmNhYmluLXNwYXJrIHN2ZycpLmNvdW50KCkpLnRvQmVHcmVhdGVyVGhhbigwKTtcbiAgfSk7XG5cbiAgdGVzdCgnY2xpY2tpbmcgYSBzcGFya2xpbmUgb3BlbnMgdGhlIHByaWNlLWhpc3RvcnkgZGlhbG9nIHdpdGggbXVsdGktY2FiaW4gY2hhcnQnLCBhc3luYyAoeyBwYWdlIH0pID0+IHtcbiAgICBhd2FpdCBnb3RvRnJlc2gocGFnZSwgQUxMX09OKTtcbiAgICBhd2FpdCBwYWdlLmxvY2F0b3IoJy5jYWJpbi1zcGFyaycpLmZpcnN0KCkuY2xpY2soKTtcbiAgICBhd2FpdCBwYWdlLndhaXRGb3JTZWxlY3RvcignZGlhbG9nI3ByaWNlSGlzdG9yeURpYWxvZ1tvcGVuXScpO1xuICAgIGNvbnN0IGxlZ2VuZCA9IGF3YWl0IHBhZ2UubG9jYXRvcignI3BoQ2hhcnQgLnBoLWxlZ2VuZC1pdGVtJykuYWxsVGV4dENvbnRlbnRzKCk7XG4gICAgZXhwZWN0KGxlZ2VuZCkudG9FcXVhbChleHBlY3QuYXJyYXlDb250YWluaW5nKFsnSW5zaWRlJywgJ1NlYSB2aWV3JywgJ0JhbGNvbnknLCAnU3VpdGUnXSkpO1xuICAgIC8vIENoYXJ0IHBhdGggcGVyIGNhYmluXG4gICAgZXhwZWN0KGF3YWl0IHBhZ2UubG9jYXRvcignI3BoQ2hhcnQgc3ZnIHBhdGgnKS5jb3VudCgpKS50b0JlKDQpO1xuICAgIC8vIExhdGVzdCBhdCB0aGUgdG9wXG4gICAgY29uc3QgZmlyc3RSb3dEYXRlID0gYXdhaXQgcGFnZS5sb2NhdG9yKCcjcGhUYWJsZUJvZHkgdHI6Zmlyc3QtY2hpbGQgdGQ6Zmlyc3QtY2hpbGQnKS5pbm5lclRleHQoKTtcbiAgICBleHBlY3QoZmlyc3RSb3dEYXRlKS50b01hdGNoKC8zMSBNYXkvKTtcbiAgfSk7XG59KTtcblxudGVzdC5kZXNjcmliZSgnSGVhZGVyIHdhdmUnLCAoKSA9PiB7XG4gIHRlc3QoJ3ByZXNzaW5nIHRoZSB0aXRsZSB0cmlnZ2VycyBhIHNpbmdsZSBzbG93ZXIgc3dlZXAnLCBhc3luYyAoeyBwYWdlIH0pID0+IHtcbiAgICBhd2FpdCBnb3RvRnJlc2gocGFnZSk7XG4gICAgY29uc3Qgd2F2ZSA9IHBhZ2UubG9jYXRvcignLmhlYWRlci13YXZlJyk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignLmhlYWRlci13YXZlIC53YXZlJykpLnRvSGF2ZUNvdW50KDQpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJy5oZWFkZXItd2F2ZSAud2F2ZS1jcmVzdCcpKS50b0hhdmVDb3VudCgxKTtcbiAgICBhd2FpdCBwYWdlLmxvY2F0b3IoJ2hlYWRlciBoMScpLmRpc3BhdGNoRXZlbnQoJ3BvaW50ZXJkb3duJywgeyBidXR0b246IDAgfSk7XG4gICAgYXdhaXQgZXhwZWN0KHdhdmUpLnRvSGF2ZUNsYXNzKC9pcy1zd2VlcGluZy8pO1xuICAgIGF3YWl0IGV4cGVjdCh3YXZlKS5ub3QudG9IYXZlQ2xhc3MoL2lzLXN3ZWVwaW5nLywgeyB0aW1lb3V0OiAzNTAwIH0pO1xuICB9KTtcbn0pO1xuXG50ZXN0LmRlc2NyaWJlKCdTb3J0IGFuZCBmaWx0ZXInLCAoKSA9PiB7XG4gIHRlc3QoJ3NoaXAgbGF1bmNoIHllYXJzIHJlbmRlciB3aXRoIG5ld25lc3MgYmFkZ2VzJywgYXN5bmMgKHsgcGFnZSB9KSA9PiB7XG4gICAgYXdhaXQgZ290b0ZyZXNoKHBhZ2UpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJ3Rib2R5IHRyOmZpcnN0LWNoaWxkIC5jb2wtbGF1bmNoIC5sYXVuY2gteWVhci1iYWRnZScpKS50b0hhdmVDbGFzcygvbmV3bmVzcy1uZXdlc3QvKTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCd0Ym9keSB0cjpmaXJzdC1jaGlsZCAuY29sLWxhdW5jaCAubGF1bmNoLXllYXItc3RhcicpKS50b0hhdmVDb3VudCgxKTtcbiAgfSk7XG5cbiAgdGVzdCgnb2xkZXIgbGF1bmNoIHllYXJzIGFyZSBzaG93biBpbiBhIG11dGVkIGdyZXkgYmFkZ2UnLCBhc3luYyAoeyBwYWdlIH0pID0+IHtcbiAgICBhd2FpdCBnb3RvRnJlc2gocGFnZSk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcigndGJvZHkgdHI6aGFzLXRleHQoXCJIYXJtb255IG9mIHRoZSBTZWFzXCIpIC5jb2wtbGF1bmNoIC5sYXVuY2gteWVhci1iYWRnZScpKS50b0hhdmVDbGFzcygvbmV3bmVzcy1sZWdhY3kvKTtcbiAgfSk7XG5cbiAgdGVzdCgnc2VhIGRheXMgcmVuZGVyIGluIHRoZSBuZXcgY29sdW1uJywgYXN5bmMgKHsgcGFnZSB9KSA9PiB7XG4gICAgYXdhaXQgZ290b0ZyZXNoKHBhZ2UpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJ3Rib2R5IHRyOmZpcnN0LWNoaWxkIC5jb2wtc2VhLWRheXMnKSkudG9Db250YWluVGV4dCgnMycpO1xuICB9KTtcblxuICB0ZXN0KCdzZWEgZGF5cyBzb3J0IG9yZGVycyBieSB0aGUgbmV3IGNvbHVtbicsIGFzeW5jICh7IHBhZ2UgfSkgPT4ge1xuICAgIGF3YWl0IGdvdG9GcmVzaChwYWdlKTtcbiAgICBhd2FpdCBwYWdlLnNlbGVjdE9wdGlvbignI3NvcnRTZWxlY3QnLCAnMTknKTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCd0Ym9keSB0cjpmaXJzdC1jaGlsZCAuY29sLXNoaXAnKSkudG9Db250YWluVGV4dCgnQ2VsZWJyaXR5IEVkZ2UnKTtcbiAgfSk7XG5cbiAgdGVzdCgnc29ydCBkcm9wZG93biArIGRpcmVjdGlvbiB0b2dnbGUgcmVvcmRlcnMgcm93cycsIGFzeW5jICh7IHBhZ2UgfSkgPT4ge1xuICAgIGF3YWl0IGdvdG9GcmVzaChwYWdlKTtcbiAgICAvLyBQaWNraW5nIGZyb20gdGhlIGRyb3Bkb3duIGFwcGxpZXMgYXNjZW5kaW5nIGJ5IGRlZmF1bHQ7IHRoZSB0b2dnbGVcbiAgICAvLyBidXR0b24gZmxpcHMgZGlyZWN0aW9uLlxuICAgIGF3YWl0IHBhZ2Uuc2VsZWN0T3B0aW9uKCcjc29ydFNlbGVjdCcsICcxNycpOyAgICAgICAgLy8gwqMvbmlnaHQsIGFzY2VuZGluZ1xuICAgIGF3YWl0IHBhZ2UuY2xpY2soJyNzb3J0RGlyQnRuJyk7ICAgICAgICAgICAgICAgICAgICAgLy8gZmxpcCB0byBkZXNjZW5kaW5nXG4gICAgLy8gSGFybW9ueSAxNG4gwqMxMjAwID0gwqM4NS9uLCBBbnRoZW0gN24gwqM1MDAgPSDCozcxL24sIEVkZ2UgMTBuIMKjOTAwID0gwqM5MC9uXG4gICAgLy8gRWRnZSAoOTApID4gSGFybW9ueSAoODUpID4gQW50aGVtICg3MSlcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCd0Ym9keSB0cjpmaXJzdC1jaGlsZCAuY29sLXNoaXAnKSkudG9Db250YWluVGV4dCgnQ2VsZWJyaXR5IEVkZ2UnKTtcbiAgICAvLyBEaXJlY3Rpb24gYnV0dG9uIHJlZmxlY3RzIHRoZSBmbGlwcGVkIHN0YXRlXG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI3NvcnREaXJCdG4nKSkudG9IYXZlVGV4dCgn4oaTJyk7XG4gIH0pO1xuXG4gIHRlc3QoJ3Blci1jYWJpbiBzb3J0IHVzZXMgdGhhdCBjYWJpblxcJ3MgcHJpY2UnLCBhc3luYyAoeyBwYWdlIH0pID0+IHtcbiAgICBhd2FpdCBnb3RvRnJlc2gocGFnZSk7XG4gICAgYXdhaXQgcGFnZS5zZWxlY3RPcHRpb24oJyNzb3J0U2VsZWN0JywgJzE1Jyk7ICAgICAgICAvLyBTdWl0ZSwgYXNjZW5kaW5nXG4gICAgLy8gQW50aGVtIHN1aXRlIDE4MDAsIEVkZ2Ugc3VpdGUgMjUwMCwgSGFybW9ueSBzdWl0ZSAzNTAwXG4gICAgY29uc3QgZmlyc3RTaGlwID0gYXdhaXQgcGFnZS5sb2NhdG9yKCd0Ym9keSB0cjpmaXJzdC1jaGlsZCAuY29sLXNoaXAnKS5pbm5lclRleHQoKTtcbiAgICBleHBlY3QoZmlyc3RTaGlwKS50b0NvbnRhaW4oJ0FudGhlbScpO1xuICB9KTtcblxuICB0ZXN0KCdkaXJlY3Rpb24gYnV0dG9uIGlzIGRpc2FibGVkIHVudGlsIGEgc29ydCBjb2x1bW4gaXMgcGlja2VkJywgYXN5bmMgKHsgcGFnZSB9KSA9PiB7XG4gICAgYXdhaXQgZ290b0ZyZXNoKHBhZ2UpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJyNzb3J0RGlyQnRuJykpLnRvQmVEaXNhYmxlZCgpO1xuICAgIGF3YWl0IHBhZ2Uuc2VsZWN0T3B0aW9uKCcjc29ydFNlbGVjdCcsICcxMScpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJyNzb3J0RGlyQnRuJykpLnRvQmVFbmFibGVkKCk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI3NvcnREaXJCdG4nKSkudG9IYXZlVGV4dCgn4oaRJyk7XG4gIH0pO1xuXG4gIHRlc3QoJ3JlY2VudGx5IGZvdW5kIHNvcnQgZGVmYXVsdHMgdG8gbmV3ZXN0IGZpcnN0JywgYXN5bmMgKHsgcGFnZSB9KSA9PiB7XG4gICAgYXdhaXQgZ290b0ZyZXNoKHBhZ2UpO1xuICAgIGF3YWl0IHBhZ2Uuc2VsZWN0T3B0aW9uKCcjc29ydFNlbGVjdCcsICcxOCcpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJ3Rib2R5IHRyOmZpcnN0LWNoaWxkIC5jb2wtc2hpcCcpKS50b0NvbnRhaW5UZXh0KCdIYXJtb255Jyk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI3NvcnREaXJCdG4nKSkudG9IYXZlVGV4dCgn4oaTJyk7XG4gIH0pO1xuXG4gIHRlc3QoJ2NvbHVtbiBmaWx0ZXIgbmFycm93cyByZXN1bHRzIGFuZCB1cGRhdGVzIHN1bW1hcnkgY291bnQnLCBhc3luYyAoeyBwYWdlIH0pID0+IHtcbiAgICBhd2FpdCBnb3RvRnJlc2gocGFnZSk7XG4gICAgYXdhaXQgcGFnZS5sb2NhdG9yKCcuY29sLWZpbHRlcltkYXRhLWZpZWxkPVwicHJvdmlkZXJcIl0nKS5zZWxlY3RPcHRpb24oJ0NlbGVicml0eSBDcnVpc2VzJyk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI3N1bW1hcnknKSkudG9Db250YWluVGV4dCgnMSBvZiAzJyk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI3N1bW1hcnknKSkudG9Db250YWluVGV4dCgnQ2VsZWJyaXR5IENydWlzZXMnKTtcbiAgICBleHBlY3QoYXdhaXQgcGFnZS5sb2NhdG9yKCd0Ym9keSB0cicpLmNvdW50KCkpLnRvQmUoMSk7XG4gIH0pO1xuXG4gIHRlc3QoJ3NlYSBkYXlzIGZpbHRlciBuYXJyb3dzIHJlc3VsdHMgYW5kIHVwZGF0ZXMgc3VtbWFyeSBjb3VudCcsIGFzeW5jICh7IHBhZ2UgfSkgPT4ge1xuICAgIGF3YWl0IGdvdG9GcmVzaChwYWdlKTtcbiAgICBhd2FpdCBwYWdlLmxvY2F0b3IoJy5jb2wtZmlsdGVyW2RhdGEtZmllbGQ9XCJzZWFEYXlzXCJdJykuZmlsbCgnNCcpO1xuICAgIGF3YWl0IHBhZ2UubG9jYXRvcignLmNvbC1maWx0ZXJbZGF0YS1maWVsZD1cInNlYURheXNcIl0nKS5kaXNwYXRjaEV2ZW50KCdpbnB1dCcpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJyNzdW1tYXJ5JykpLnRvQ29udGFpblRleHQoJzIgb2YgMycpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJyNzdW1tYXJ5JykpLnRvQ29udGFpblRleHQoJ01heCA0IHNlYSBkYXlzJyk7XG4gICAgZXhwZWN0KGF3YWl0IHBhZ2UubG9jYXRvcigndGJvZHkgdHInKS5jb3VudCgpKS50b0JlKDIpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJ3Rib2R5IHRyOmZpcnN0LWNoaWxkIC5jb2wtc2hpcCcpKS50b0NvbnRhaW5UZXh0KCdBbnRoZW0gb2YgdGhlIFNlYXMnKTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCd0Ym9keSB0cjpudGgtY2hpbGQoMikgLmNvbC1zaGlwJykpLnRvQ29udGFpblRleHQoJ0NlbGVicml0eSBFZGdlJyk7XG4gIH0pO1xuXG4gIHRlc3QoJ2l0aW5lcmFyeSBmaWx0ZXIgbWF0Y2hlcyBldmVyeSB3b3JkIGFuZCBoaWdobGlnaHRzIGVhY2ggb25lJywgYXN5bmMgKHsgcGFnZSB9KSA9PiB7XG4gICAgYXdhaXQgZ290b0ZyZXNoKHBhZ2UpO1xuICAgIGF3YWl0IHBhZ2UubG9jYXRvcignLmNvbC1maWx0ZXJbZGF0YS1maWVsZD1cIml0aW5lcmFyeVwiXScpLmZpbGwoJ0JhcmNlbG9uYSBTcGFpbicpO1xuICAgIGF3YWl0IHBhZ2UubG9jYXRvcignLmNvbC1maWx0ZXJbZGF0YS1maWVsZD1cIml0aW5lcmFyeVwiXScpLmRpc3BhdGNoRXZlbnQoJ2lucHV0Jyk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI3N1bW1hcnknKSkudG9Db250YWluVGV4dCgnMSBvZiAzJyk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcigndGJvZHkgdHI6Zmlyc3QtY2hpbGQgLmNvbC1pdGluZXJhcnknKSkudG9Db250YWluVGV4dCgnQmFyY2Vsb25hJyk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcigndGJvZHkgdHI6Zmlyc3QtY2hpbGQgLmNvbC1pdGluZXJhcnknKSkudG9Db250YWluVGV4dCgnU3BhaW4nKTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCd0Ym9keSB0cjpmaXJzdC1jaGlsZCAuY29sLWl0aW5lcmFyeSAuaXRpbmVyYXJ5LWhpZ2hsaWdodCcpKS50b0hhdmVDb3VudCgyKTtcbiAgfSk7XG5cbiAgdGVzdCgnY2xlYXIgYnV0dG9uIHJlc2V0cyBhbiBpbmRpdmlkdWFsIGZpbHRlcicsIGFzeW5jICh7IHBhZ2UgfSkgPT4ge1xuICAgIGF3YWl0IGdvdG9GcmVzaChwYWdlKTtcbiAgICBjb25zdCBwcm92aWRlciA9IHBhZ2UubG9jYXRvcignLmNvbC1maWx0ZXJbZGF0YS1maWVsZD1cInByb3ZpZGVyXCJdJyk7XG4gICAgYXdhaXQgcHJvdmlkZXIuc2VsZWN0T3B0aW9uKCdDZWxlYnJpdHkgQ3J1aXNlcycpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJyNzdW1tYXJ5JykpLnRvQ29udGFpblRleHQoJzEgb2YgMycpO1xuICAgIGF3YWl0IHBhZ2UubG9jYXRvcignI2ZpbHRlclJvdyAuY29sLXByb3ZpZGVyIC5maWx0ZXItY2xlYXItYnRuJykuY2xpY2soKTtcbiAgICBhd2FpdCBleHBlY3QocHJvdmlkZXIpLnRvSGF2ZVZhbHVlKCcnKTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCcjc3VtbWFyeScpKS50b0NvbnRhaW5UZXh0KCdhbGwgMycpO1xuICB9KTtcblxuICB0ZXN0KCdkZXBhcnR1cmUgZGF0ZSByYW5nZSBmaWx0ZXJzIGluY2x1c2l2ZWx5JywgYXN5bmMgKHsgcGFnZSB9KSA9PiB7XG4gICAgYXdhaXQgZ290b0ZyZXNoKHBhZ2UpO1xuICAgIGF3YWl0IHBhZ2UuY2xpY2soJyNkZXBhcnR1cmVSYW5nZUJ0bicpO1xuICAgIGF3YWl0IHBhZ2UuZmlsbCgnI2RlcGFydHVyZVJhbmdlU3RhcnQnLCAnMjAyNi0wOC0zMScpO1xuICAgIGF3YWl0IHBhZ2UuZmlsbCgnI2RlcGFydHVyZVJhbmdlRW5kJywgJzIwMjYtMDktMDEnKTtcbiAgICBhd2FpdCBwYWdlLmNsaWNrKCcjZGVwYXJ0dXJlUmFuZ2VBcHBseScpO1xuXG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI3N1bW1hcnknKSkudG9Db250YWluVGV4dCgnMiBvZiAzJyk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI3N1bW1hcnknKSkudG9Db250YWluVGV4dCgnRGVwYXJ0dXJlIDMxIEF1ZyAyMDI2IC0gMSBTZXB0IDIwMjYnKTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCcjY3J1aXNlQm9keScpKS50b0NvbnRhaW5UZXh0KCdBbnRoZW0gb2YgdGhlIFNlYXMnKTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCcjY3J1aXNlQm9keScpKS50b0NvbnRhaW5UZXh0KCdIYXJtb255IG9mIHRoZSBTZWFzJyk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI2NydWlzZUJvZHknKSkubm90LnRvQ29udGFpblRleHQoJ0NlbGVicml0eSBFZGdlJyk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI2RlcGFydHVyZVJhbmdlQnRuJykpLnRvQ29udGFpblRleHQoJzMxIEF1ZyAyMDI2IC0gMSBTZXB0IDIwMjYnKTtcbiAgfSk7XG5cbiAgdGVzdCgnc2hpcC1zaXplIGZpbHRlciAodGllcjpsYXJnZSkga2VlcHMgb25seSBzaGlwcyB3aG9zZSBjbGFzcyBtYXBzIHRvIGxhcmdlJywgYXN5bmMgKHsgcGFnZSB9KSA9PiB7XG4gICAgYXdhaXQgZ290b0ZyZXNoKHBhZ2UpO1xuICAgIC8vIEFsbCB0aHJlZSBmaXh0dXJlcyBhcmUgT2FzaXMgY2xhc3MgKG1lZ2EpLCBzbyB0aWVyOm1lZ2Ega2VlcHMgYWxsIGFuZFxuICAgIC8vIHRpZXI6c21hbGwgZHJvcHMgdGhlbSBhbGwg4oCUIHByb3ZlcyB0aGUgdGllciBmaWx0ZXIgaXMgd2lyZWQuXG4gICAgYXdhaXQgcGFnZS5sb2NhdG9yKCcuY29sLWZpbHRlcltkYXRhLWZpZWxkPVwic2hpcENsYXNzXCJdJykuc2VsZWN0T3B0aW9uKCd0aWVyOnNtYWxsJyk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI3N1bW1hcnknKSkudG9Db250YWluVGV4dCgnMCBvZiAzJyk7XG4gICAgYXdhaXQgcGFnZS5sb2NhdG9yKCcuY29sLWZpbHRlcltkYXRhLWZpZWxkPVwic2hpcENsYXNzXCJdJykuc2VsZWN0T3B0aW9uKCd0aWVyOm1lZ2EnKTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCcjc3VtbWFyeScpKS50b0NvbnRhaW5UZXh0KCdhbGwgMycpO1xuICB9KTtcbn0pO1xuXG50ZXN0LmRlc2NyaWJlKCdVUkwgc3RhdGUnLCAoKSA9PiB7XG4gIHRlc3QoJ3NvcnQgKyBmaWx0ZXIgcGVyc2lzdCBhY3Jvc3MgcmVsb2FkIHZpYSBVUkwgaGFzaCcsIGFzeW5jICh7IHBhZ2UgfSkgPT4ge1xuICAgIGF3YWl0IGdvdG9GcmVzaChwYWdlKTtcbiAgICBhd2FpdCBwYWdlLnNlbGVjdE9wdGlvbignI3NvcnRTZWxlY3QnLCAnMTQnKTtcbiAgICBhd2FpdCBwYWdlLmxvY2F0b3IoJy5jb2wtZmlsdGVyW2RhdGEtZmllbGQ9XCJwcm92aWRlclwiXScpLnNlbGVjdE9wdGlvbignUm95YWwgQ2FyaWJiZWFuJyk7XG4gICAgYXdhaXQgcGFnZS53YWl0Rm9yRnVuY3Rpb24oKCkgPT4gbG9jYXRpb24uaGFzaC5pbmNsdWRlcygnc29ydD0xNC1hc2MnKSAmJiBsb2NhdGlvbi5oYXNoLmluY2x1ZGVzKCdwcm92aWRlcj1Sb3lhbCcpKTtcbiAgICBjb25zdCB1cmxCZWZvcmUgPSBwYWdlLnVybCgpO1xuICAgIGF3YWl0IHNldHVwUm91dGVzKHBhZ2UpOyAvLyByZS1hcm0gcm91dGVzIGZvciB0aGUgcmVsb2FkXG4gICAgYXdhaXQgcGFnZS5nb3RvKHVybEJlZm9yZSk7XG4gICAgYXdhaXQgcGFnZS53YWl0Rm9yU2VsZWN0b3IoJ3Rib2R5IHRyOm5vdCguZW1wdHktcm93KScpO1xuICAgIC8vIERyb3Bkb3duIGhvbGRzIGNvbHVtbiBpbmRleDsgZGlyZWN0aW9uIGxpdmVzIG9uIHRoZSB0b2dnbGUgYnV0dG9uLlxuICAgIGV4cGVjdChhd2FpdCBwYWdlLmxvY2F0b3IoJyNzb3J0U2VsZWN0JykuaW5wdXRWYWx1ZSgpKS50b0JlKCcxNCcpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJyNzb3J0RGlyQnRuJykpLnRvSGF2ZVRleHQoJ+KGkScpO1xuICAgIGV4cGVjdChhd2FpdCBwYWdlLmxvY2F0b3IoJy5jb2wtZmlsdGVyW2RhdGEtZmllbGQ9XCJwcm92aWRlclwiXScpLmlucHV0VmFsdWUoKSkudG9CZSgnUm95YWwgQ2FyaWJiZWFuJyk7XG4gIH0pO1xufSk7XG5cbnRlc3QuZGVzY3JpYmUoJ1NhdmVkIHZpZXdzJywgKCkgPT4ge1xuICB0ZXN0KCdzdWdnZXN0cyBhbiBlZGl0YWJsZSBuYW1lIGZyb20gY3VycmVudCBmaWx0ZXJzIGFuZCBzb3J0JywgYXN5bmMgKHsgcGFnZSB9KSA9PiB7XG4gICAgYXdhaXQgZ290b0ZyZXNoKHBhZ2UpO1xuICAgIGF3YWl0IHBhZ2Uuc2VsZWN0T3B0aW9uKCcjc29ydFNlbGVjdCcsICcxNCcpO1xuICAgIGF3YWl0IHBhZ2UubG9jYXRvcignLmNvbC1maWx0ZXJbZGF0YS1maWVsZD1cInByb3ZpZGVyXCJdJykuc2VsZWN0T3B0aW9uKCdSb3lhbCBDYXJpYmJlYW4nKTtcblxuICAgIGF3YWl0IHBhZ2UuY2xpY2soJyNzYXZlZFZpZXdzQnRuJyk7XG4gICAgYXdhaXQgcGFnZS53YWl0Rm9yU2VsZWN0b3IoJ2RpYWxvZyNzYXZlZFZpZXdzRGlhbG9nW29wZW5dJyk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI3N2TmFtZUlucHV0JykpLnRvSGF2ZVZhbHVlKCdSb3lhbCBDYXJpYmJlYW4gwrcgQmFsY29ueScpO1xuXG4gICAgYXdhaXQgcGFnZS5sb2NhdG9yKCcjc3ZOYW1lSW5wdXQnKS5maWxsKCdNeSBiYWxjb255IHNob3J0bGlzdCcpO1xuICAgIGF3YWl0IHBhZ2UubG9jYXRvcignI3N2U2F2ZUZvcm0gYnV0dG9uW3R5cGU9XCJzdWJtaXRcIl0nKS5jbGljaygpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJy5zdi1uYW1lJykuZmlyc3QoKSkudG9IYXZlVGV4dCgnTXkgYmFsY29ueSBzaG9ydGxpc3QnKTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCcuc3YtaGFzaCcpLmZpcnN0KCkpLnRvQ29udGFpblRleHQoJ1NvcnQ6IFByaWNlIChCYWxjb255KScpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJy5zdi1oYXNoJykuZmlyc3QoKSkudG9Db250YWluVGV4dCgncHJvdmlkZXI9Um95YWwgQ2FyaWJiZWFuJyk7XG4gIH0pO1xufSk7XG5cbnRlc3QuZGVzY3JpYmUoJ1NldHRpbmdzIGRpYWxvZycsICgpID0+IHtcbiAgdGVzdCgnY2xvc2UgYnV0dG9uIHN0YXlzIHZpc2libGUgd2hpbGUgZGlzcGxheSBvcHRpb25zIGNvbnRlbnQgc2Nyb2xscycsIGFzeW5jICh7IHBhZ2UgfSkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Vmlld3BvcnRTaXplKHsgd2lkdGg6IDM5MCwgaGVpZ2h0OiA1NjAgfSk7XG4gICAgYXdhaXQgZ290b0ZyZXNoKHBhZ2UpO1xuICAgIGF3YWl0IHBhZ2UuY2xpY2soJyNzZXR0aW5nc0J0bicpO1xuICAgIGF3YWl0IHBhZ2Uud2FpdEZvclNlbGVjdG9yKCdkaWFsb2cjc2V0dGluZ3NEaWFsb2dbb3Blbl0nKTtcbiAgICBhd2FpdCBwYWdlLmxvY2F0b3IoJy5zZXR0aW5ncy1zY3JvbGwnKS5ldmFsdWF0ZShlbCA9PiB7IGVsLnNjcm9sbFRvcCA9IGVsLnNjcm9sbEhlaWdodDsgfSk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI3NldHRpbmdzQ2xvc2UnKSkudG9CZUluVmlld3BvcnQoKTtcbiAgfSk7XG5cbiAgdGVzdCgnZmlyc3QtdGltZSB2aXNpdG9ycyBnZXQgc3BhcmtsaW5lcyBhbmQgwqMvbmlnaHQgb2ZmOyB0aGUgYm9keSBjbGFzcyByZWZsZWN0cyBpdCcsIGFzeW5jICh7IHBhZ2UgfSkgPT4ge1xuICAgIGF3YWl0IGdvdG9GcmVzaChwYWdlKTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCdib2R5JykpLnRvSGF2ZUNsYXNzKC9oaWRlLXNwYXJrbGluZXMvKTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCdib2R5JykpLnRvSGF2ZUNsYXNzKC9oaWRlLXBlci1uaWdodC8pO1xuICB9KTtcblxuICB0ZXN0KCd0b2dnbGluZyBzcGFya2xpbmVzIG9uIHBlcnNpc3RzIGFjcm9zcyByZWxvYWQnLCBhc3luYyAoeyBwYWdlIH0pID0+IHtcbiAgICBhd2FpdCBnb3RvRnJlc2gocGFnZSk7XG4gICAgYXdhaXQgcGFnZS5jbGljaygnI3NldHRpbmdzQnRuJyk7XG4gICAgYXdhaXQgcGFnZS53YWl0Rm9yU2VsZWN0b3IoJ2RpYWxvZyNzZXR0aW5nc0RpYWxvZ1tvcGVuXScpO1xuICAgIGF3YWl0IHBhZ2UubG9jYXRvcignI3NldHRpbmdzRGlhbG9nIGlucHV0W2RhdGEtc2V0dGluZz1cInNwYXJrbGluZXNcIl0nKS5jaGVjaygpO1xuICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJ2JvZHknKSkubm90LnRvSGF2ZUNsYXNzKC9oaWRlLXNwYXJrbGluZXMvKTtcbiAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2NydWlzZS1leHBsb3Jlci1zZXR0aW5ncycpKSk7XG4gICAgZXhwZWN0KHN0b3JlZC5zcGFya2xpbmVzKS50b0JlKHRydWUpO1xuICAgIC8vIFJlbG9hZCDigJQgY2hvaWNlIHN1cnZpdmVzXG4gICAgYXdhaXQgc2V0dXBSb3V0ZXMocGFnZSk7XG4gICAgYXdhaXQgcGFnZS5yZWxvYWQoKTtcbiAgICBhd2FpdCBwYWdlLndhaXRGb3JTZWxlY3RvcigndGJvZHkgdHI6bm90KC5lbXB0eS1yb3cpJyk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignYm9keScpKS5ub3QudG9IYXZlQ2xhc3MoL2hpZGUtc3BhcmtsaW5lcy8pO1xuICB9KTtcblxuICB0ZXN0KCdwZXItbmlnaHQgdG9nZ2xlIG9uIHNob3dzIHRoZSDCoy9uaWdodCBjb2x1bW4nLCBhc3luYyAoeyBwYWdlIH0pID0+IHtcbiAgICBhd2FpdCBnb3RvRnJlc2gocGFnZSk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignLmNvbC1wZXItbmlnaHQnKS5maXJzdCgpKS50b0JlSGlkZGVuKCk7XG4gICAgYXdhaXQgcGFnZS5jbGljaygnI3NldHRpbmdzQnRuJyk7XG4gICAgYXdhaXQgcGFnZS53YWl0Rm9yU2VsZWN0b3IoJ2RpYWxvZyNzZXR0aW5nc0RpYWxvZ1tvcGVuXScpO1xuICAgIGF3YWl0IHBhZ2UubG9jYXRvcignI3NldHRpbmdzRGlhbG9nIGlucHV0W2RhdGEtc2V0dGluZz1cInBlck5pZ2h0XCJdJykuY2hlY2soKTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCcuY29sLXBlci1uaWdodCcpLmZpcnN0KCkpLnRvQmVWaXNpYmxlKCk7XG4gIH0pO1xuXG4gIHRlc3QoJ2xpbmsgdGFyZ2V0IHRvZ2dsZSBzd2l0Y2hlcyBzaGlwIGxpbmtzIGZyb20gV2lraXBlZGlhIHRvIGNydWlzZSBjb21wYW55IHBhZ2VzJywgYXN5bmMgKHsgcGFnZSB9KSA9PiB7XG4gICAgYXdhaXQgZ290b0ZyZXNoKHBhZ2UpO1xuICAgIGF3YWl0IHBhZ2Uud2FpdEZvckZ1bmN0aW9uKCgpID0+IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ3Rib2R5IHRyOmZpcnN0LWNoaWxkIC5jb2wtc2hpcCBhJyk/LmhyZWYuaW5jbHVkZXMoJ3dpa2lwZWRpYS5vcmcnKSk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignI2NydWlzZUJvZHkgdHI6Zmlyc3QtY2hpbGQgLmNvbC1zaGlwIGEnKS5maXJzdCgpKS50b0hhdmVBdHRyaWJ1dGUoJ2hyZWYnLCAnaHR0cHM6Ly9lbi53aWtpcGVkaWEub3JnL3dpa2kvQW50aGVtX29mX3RoZV9TZWFzJyk7XG5cbiAgICBhd2FpdCBwYWdlLmNsaWNrKCcjc2V0dGluZ3NCdG4nKTtcbiAgICBhd2FpdCBwYWdlLndhaXRGb3JTZWxlY3RvcignZGlhbG9nI3NldHRpbmdzRGlhbG9nW29wZW5dJyk7XG4gICAgYXdhaXQgcGFnZS5sb2NhdG9yKCcjc2V0dGluZ3NEaWFsb2cgaW5wdXRbZGF0YS1zZXR0aW5nPVwiY29tcGFueUxpbmtzXCJdJykuY2hlY2soKTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCcjY3J1aXNlQm9keSB0cjpmaXJzdC1jaGlsZCAuY29sLXNoaXAgYScpLmZpcnN0KCkpLnRvSGF2ZUF0dHJpYnV0ZSgnaHJlZicsICdodHRwczovL3d3dy5yb3lhbGNhcmliYmVhbi5jb20vZ2JyL2VuL2NydWlzZS1zaGlwcy9hbnRoZW0tb2YtdGhlLXNlYXMnKTtcbiAgfSk7XG5cbiAgdGVzdCgnUmVzZXQgdG8gZGVmYXVsdHMgcmVzdG9yZXMgZmlyc3QtdGltZS12aXNpdG9yIHN0YXRlJywgYXN5bmMgKHsgcGFnZSB9KSA9PiB7XG4gICAgLy8gU3RhcnQgd2l0aCBldmVyeXRoaW5nIG9uLCB0aGVuIHJlc2V0IOKAlCBzaG91bGQgbGFuZCBvbiBzcGFya2xpbmVzL3Blck5pZ2h0IG9mZi5cbiAgICBhd2FpdCBnb3RvRnJlc2gocGFnZSwgQUxMX09OKTtcbiAgICBhd2FpdCBwYWdlLmNsaWNrKCcjc2V0dGluZ3NCdG4nKTtcbiAgICBhd2FpdCBwYWdlLndhaXRGb3JTZWxlY3RvcignZGlhbG9nI3NldHRpbmdzRGlhbG9nW29wZW5dJyk7XG4gICAgYXdhaXQgcGFnZS5jbGljaygnI3NldHRpbmdzUmVzZXQnKTtcbiAgICBleHBlY3QoYXdhaXQgcGFnZS5sb2NhdG9yKCcjc2V0dGluZ3NEaWFsb2cgaW5wdXRbZGF0YS1zZXR0aW5nPVwic3BhcmtsaW5lc1wiXScpLmlzQ2hlY2tlZCgpKS50b0JlKGZhbHNlKTtcbiAgICBleHBlY3QoYXdhaXQgcGFnZS5sb2NhdG9yKCcjc2V0dGluZ3NEaWFsb2cgaW5wdXRbZGF0YS1zZXR0aW5nPVwicGVyTmlnaHRcIl0nKS5pc0NoZWNrZWQoKSkudG9CZShmYWxzZSk7XG4gICAgZXhwZWN0KGF3YWl0IHBhZ2UubG9jYXRvcignI3NldHRpbmdzRGlhbG9nIGlucHV0W2RhdGEtc2V0dGluZz1cIndpa2lMaW5rc1wiXScpLmlzQ2hlY2tlZCgpKS50b0JlKHRydWUpO1xuICAgIGV4cGVjdChhd2FpdCBwYWdlLmxvY2F0b3IoJyNzZXR0aW5nc0RpYWxvZyBpbnB1dFtkYXRhLXNldHRpbmc9XCJjb21wYW55TGlua3NcIl0nKS5pc0NoZWNrZWQoKSkudG9CZShmYWxzZSk7XG4gICAgYXdhaXQgZXhwZWN0KHBhZ2UubG9jYXRvcignYm9keScpKS50b0hhdmVDbGFzcygvaGlkZS1zcGFya2xpbmVzLyk7XG4gIH0pO1xufSk7XG5cbnRlc3QuZGVzY3JpYmUoJ1NpdGUgY2hhbmdlcyBkaWFsb2cnLCAoKSA9PiB7XG4gIHRlc3QoJ2Nsb3NlIGJ1dHRvbiBzdGF5cyB2aXNpYmxlIHdoaWxlIHRoZSBjaGFuZ2VzIGxpc3Qgc2Nyb2xscycsIGFzeW5jICh7IHBhZ2UgfSkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Vmlld3BvcnRTaXplKHsgd2lkdGg6IDM5MCwgaGVpZ2h0OiA1NjAgfSk7XG4gICAgYXdhaXQgZ290b0ZyZXNoKHBhZ2UpO1xuICAgIGF3YWl0IHBhZ2UuY2xpY2soJyNzaXRlQ2hhbmdlc0J0bicpO1xuICAgIGF3YWl0IHBhZ2Uud2FpdEZvclNlbGVjdG9yKCdkaWFsb2cjc2l0ZUNoYW5nZXNEaWFsb2dbb3Blbl0nKTtcbiAgICBhd2FpdCBwYWdlLmxvY2F0b3IoJy5jaGFuZ2VzLXNjcm9sbCcpLmV2YWx1YXRlKGVsID0+IHsgZWwuc2Nyb2xsVG9wID0gZWwuc2Nyb2xsSGVpZ2h0OyB9KTtcbiAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCcjY2hhbmdlc0Nsb3NlJykpLnRvQmVJblZpZXdwb3J0KCk7XG4gIH0pO1xufSk7XG4iXSwibWFwcGluZ3MiOiJBQUFBLFlBQVk7O0FBRVo7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBRUEsTUFBTTtFQUFFQSxJQUFJO0VBQUVDO0FBQU8sQ0FBQyxHQUFHQyxPQUFPLENBQUMsa0JBQWtCLENBQUM7QUFFcEQsTUFBTUMsY0FBYyxHQUFHO0VBQ3JCQyxpQkFBaUIsRUFBRSxpQkFBaUI7RUFDcENDLFNBQVMsRUFBRSxDQUNUO0lBQUVDLEVBQUUsRUFBRSxpQkFBaUI7SUFBRUMsSUFBSSxFQUFFLGlCQUFpQjtJQUFFQyxVQUFVLEVBQUU7RUFBMkMsQ0FBQyxFQUMxRztJQUFFRixFQUFFLEVBQUUsbUJBQW1CO0lBQUVDLElBQUksRUFBRSxtQkFBbUI7SUFBRUMsVUFBVSxFQUFFO0VBQTZDLENBQUM7QUFFcEgsQ0FBQzs7QUFFRDtBQUNBLFNBQVNDLE1BQU1BLENBQUM7RUFBRUgsRUFBRTtFQUFFSSxRQUFRO0VBQUVDLFFBQVE7RUFBRUMsU0FBUztFQUFFQyxNQUFNO0VBQUVDLE9BQU87RUFBRUMsV0FBVztFQUFFQyxhQUFhLEdBQUcsWUFBWTtFQUFFQyxJQUFJLEdBQUcsQ0FBQztFQUFFQyxJQUFJLEdBQUcsYUFBYTtFQUFFQyxTQUFTLEdBQUcsR0FBR0YsSUFBSSxVQUFVQyxJQUFJLFNBQVM7RUFBRUUsY0FBYyxHQUFHLElBQUk7RUFBRUMsT0FBTyxHQUFHO0FBQUssQ0FBQyxFQUFFO0VBQ3BPLE9BQU87SUFDTGYsRUFBRTtJQUFFSSxRQUFRO0lBQUVDLFFBQVE7SUFDdEJXLFNBQVMsRUFBUSxPQUFPO0lBQ3hCRixjQUFjO0lBQ2RELFNBQVM7SUFDVEgsYUFBYTtJQUNiTyxRQUFRLEVBQVMsR0FBR04sSUFBSSxTQUFTO0lBQ2pDSSxPQUFPO0lBQ1BHLGFBQWEsRUFBSU4sSUFBSTtJ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
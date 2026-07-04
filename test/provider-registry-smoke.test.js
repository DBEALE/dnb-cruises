'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../providers');

const CABIN_BUCKETS = ['balcony', 'inside', 'oceanView', 'suite'];

function graphCruise(id, shipName) {
  return {
    id,
    masterSailing: {
      itinerary: {
        name: 'Northern Europe',
        totalNights: 7,
        ship: { name: shipName },
        departurePort: { name: 'Southampton, England' },
        destination: { name: 'Northern Europe' },
      },
    },
    lowestPriceSailing: {
      sailDate: '2026-09-01',
      bookingLink: '/booking/smoke',
      lowestStateroomClassPrice: {
        price: { value: 799, currency: { code: 'GBP' } },
      },
      stateroomClassPricing: [],
    },
  };
}

const smokeCases = {
  'royal-caribbean': provider => provider.normalizeCruise(graphCruise('SMOKE-RC', 'Anthem of the Seas')),
  'celebrity-cruises': provider => provider.normalizeCruise(graphCruise('SMOKE-CEL', 'Celebrity Edge')),
  'ncl-cruises': provider => provider.normalizeCruise({
    code: 'EPIC7BCNSMOKE',
    title: 'Mediterranean: Nice & Florence',
    shortTitle: 'Mediterranean: Nice & Florence',
    duration: { text: '7 Nights' },
    currency: 'GBP',
    ship: { title: 'Norwegian Epic' },
    destination: { title: 'Mediterranean' },
    embarkationPort: { title: 'Barcelona, Spain' },
    sailings: [{
      departureDate: '2026-09-01',
      staterooms: [{ code: 'INSIDE', title: 'Inside', combinedPrice: '799' }],
    }],
  }, 'https://www.ncl.com/uk/en/cruises/smoke?itineraryCode=EPIC7BCNSMOKE'),
  'princess-cruises': provider => provider.normalizeCruise(
    {
      id: 'SMOKE-PRINCESS',
      trades: [{ id: 'E' }],
      embkDbkPortIds: ['SOU', 'SOU'],
      cruiseDuration: 7,
    },
    '20260901',
    'YP',
    'Sky Princess',
    'Southampton (for London), England',
  ),
  'p-and-o': provider => provider.normalizeCruise({
    id: 'SMOKE-PANDO',
    shipName: 'Iona',
    departureDate: '2026-09-01',
    duration: '7 Nights',
    departurePort: 'Southampton, UK',
    prices: { I: '799', O: '899', B: '999', S: '1299' },
  }),
};

// Which real providers launch a headless Chromium. The scrape scheduler
// serialises exactly these so two never contend and starve into empty results;
// keep this in lockstep with the `usesBrowser` flags on the provider modules.
const BROWSER_PROVIDER_IDS = new Set(['ncl-cruises', 'p-and-o', 'princess-cruises']);

test('browser providers are flagged usesBrowser so the scheduler serialises them', () => {
  for (const provider of providers) {
    const expected = BROWSER_PROVIDER_IDS.has(provider.id);
    assert.equal(
      Boolean(provider.usesBrowser),
      expected,
      `${provider.id} usesBrowser should be ${expected} (it ${expected ? 'launches' : 'does not launch'} Chromium)`,
    );
  }
});

test('every registered provider normalizes a representative sailing', () => {
  assert.deepEqual(providers.map(provider => provider.id), Object.keys(smokeCases));

  for (const provider of providers) {
    assert.equal(typeof provider.fetchCruises, 'function', `${provider.id} must expose fetchCruises()`);
    assert.equal(typeof provider.normalizeCruise, 'function', `${provider.id} must expose normalizeCruise()`);

    const cruise = smokeCases[provider.id](provider);
    assert.equal(cruise.provider, provider.name, `${provider.id} provider name`);
    assert.ok(cruise.id, `${provider.id} cruise id`);
    assert.ok(cruise.shipName, `${provider.id} ship name`);
    assert.ok(cruise.departureDate, `${provider.id} departure date`);
    assert.ok(cruise.duration, `${provider.id} duration`);
    assert.ok(cruise.departurePort, `${provider.id} departure port`);
    assert.ok(cruise.bookingUrl, `${provider.id} booking URL`);
    assert.deepEqual(Object.keys(cruise.prices).sort(), CABIN_BUCKETS, `${provider.id} cabin buckets`);
  }
});

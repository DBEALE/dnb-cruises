'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
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
    cruiseId: 'SMOKE1',
    shipName: 'Iona',
    departDate: '2026-09-01T00:00:00Z',
    duration: 7,
    embarkPortCode: 'SOU',
    disembarkPortCode: 'BGI',
    destinationIds: ['Caribbean'],
    name: 'Caribbean Fly-Cruise, 14 Nights',
    cabins: [{ roomTypeId: 'I', lowerPrice: 799 }],
    portOfCallIds: ['SOU', 'ATSEADAY', 'BGI'],
    arrivalAtArrivalPort: '2026-09-08T00:00:00Z',
  }),
  'virgin-voyages': provider => provider.normalizeCruise({
    shipCode: 'SC',
    packageCode: '5NCM',
    startDate: '2026-09-01',
    endDate: '2026-09-06',
    duration: 5,
    homePort: 'MIA',
    ports: ['MIA', 'CZM', 'BIM', 'MIA'],
    minPrice: 899,
    region: 'CARIBBEAN',
  }),
};

// Which real providers launch a headless Chromium. The scrape scheduler
// serialises exactly these so two never contend and starve into empty results;
// keep this in lockstep with the `usesBrowser` flags on the provider modules.
const BROWSER_PROVIDER_IDS = new Set(['ncl-cruises', 'princess-cruises', 'virgin-voyages']);

test('committed providers/index.json manifest lists exactly the registered providers', () => {
  // The push-deploy workflow ships this committed manifest, so if it drifts
  // from the registry a provider silently disappears from the site (its data
  // deploys but the frontend never loads it). Keep them in lockstep.
  const manifestPath = path.join(__dirname, '..', 'public', 'providers', 'index.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(
    (manifest.providers || []).map(p => p.id),
    providers.map(p => p.id),
    'public/providers/index.json is out of sync with providers/index.js',
  );
});

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

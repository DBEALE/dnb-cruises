'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../providers/virgin-voyages');

function voyage(overrides = {}) {
  return {
    homePort: 'SEA',
    region: 'NORTH ..',
    startDate: '2026-07-09',
    endDate: '2026-07-16',
    packageCode: '7NSBE',
    shipCode: 'BR',
    duration: 7,
    maxPrice: 12880,
    minPrice: 2692,
    ports: ['SEA', 'KTN', 'SIT', 'PRR'],
    ...overrides,
  };
}

const PORT_MAP = {
  SEA: 'Seattle, Washington',
  KTN: 'Ketchikan, Alaska',
  SIT: 'Sitka, Alaska',
  PRR: 'Prince Rupert, British Columbia',
  MIA: 'Miami, Florida',
  CZM: 'Cozumel, Mexico',
  BIM: 'The Beach Club at Bimini, Bahamas',
};

test('normalizes a voyage into the shared cruise contract', () => {
  const c = provider.normalizeVoyage(voyage(), PORT_MAP);
  assert.equal(c.id, 'virgin-BR2607097NSBE');
  assert.equal(c.provider, 'Virgin Voyages');
  assert.equal(c.shipName, 'Brilliant Lady');
  assert.equal(c.shipClass, 'Lady');
  assert.equal(c.shipLaunchYear, 2025);
  assert.equal(c.departureDate, '2026-07-09');
  assert.equal(c.arrivalDate, '2026-07-16');
  assert.equal(c.duration, '7 Nights');
  assert.equal(c.departurePort, 'Seattle, Washington');
  assert.equal(c.destinationPort, 'Prince Rupert, British Columbia');
  assert.equal(c.departureRegion, 'Americas');
  assert.equal(c.priceFrom, '2692');
  assert.equal(c.currency, 'GBP');
  assert.deepEqual(c.prices, { inside: null, oceanView: null, balcony: null, suite: null });
  assert.equal(c.itinerary, 'Seattle, Washington → Ketchikan, Alaska → Sitka, Alaska → Prince Rupert, British Columbia');
  assert.match(c.bookingUrl, /voyageId=BR2607097NSBE/);
});

test('maps all four Lady ships from their codes', () => {
  for (const [code, name] of [['BR', 'Brilliant Lady'], ['RS', 'Resilient Lady'], ['SC', 'Scarlet Lady'], ['VL', 'Valiant Lady']]) {
    assert.equal(provider.normalizeVoyage(voyage({ shipCode: code }), PORT_MAP).shipName, name);
  }
});

test('normalizeVoyage returns null without ship/package/date', () => {
  assert.equal(provider.normalizeVoyage({ shipCode: 'BR' }), null);
  assert.equal(provider.normalizeVoyage(voyage({ packageCode: '' })), null);
});

test('buildItinerary resolves codes, collapses consecutive duplicates', () => {
  assert.equal(
    provider.buildItinerary(['MIA', 'MIA', 'CZM', 'BIM'], PORT_MAP),
    'Miami, Florida → Cozumel, Mexico → The Beach Club at Bimini, Bahamas',
  );
  // Unknown code falls back to the raw code rather than dropping it.
  assert.equal(provider.buildItinerary(['MIA', 'ZZZ'], PORT_MAP), 'Miami, Florida → ZZZ');
});

test('parseVoyages extracts the embedded sailingsAvailability array', () => {
  const page = `x self.__next_f.push([1,"..."])"sailingsAvailability":{"data":{"data":[${JSON.stringify(voyage())},${JSON.stringify(voyage({ packageCode: '5NCM' }))}]},"other":1}`;
  const voyages = provider.parseVoyages(page);
  assert.equal(voyages.length, 2);
  assert.equal(voyages[0].packageCode, '7NSBE');
});

test('parsePortMap reads code→name pairs and decodes JSON escapes', () => {
  const page = '{"code":"SEA","name":"Seattle, Washington"} {"code":"END","name":"Endicott Arm \\u0026 Dawes Glacier, Alaska"} {"name":"Miami","code":"MIA"}';
  const map = provider.parsePortMap(page);
  assert.equal(map.SEA, 'Seattle, Washington');
  assert.equal(map.END, 'Endicott Arm & Dawes Glacier, Alaska');
  assert.equal(map.MIA, 'Miami');
});

test('fetchCruises parses the page and dedupes voyages', async () => {
  const html = `<html>"sailingsAvailability":{"data":{"data":[${JSON.stringify(voyage())},${JSON.stringify(voyage())},${JSON.stringify(voyage({ shipCode: 'SC', packageCode: '5NCM' }))}]}} {"code":"SEA","name":"Seattle, Washington"}</html>`;
  const fetchImpl = async () => ({ ok: true, text: async () => html });
  const cruises = await provider.fetchCruises({ fetchImpl, enrichPrices: false });
  assert.equal(cruises.length, 2, 'the two identical voyages dedupe to one');
  assert.ok(cruises.some(c => c.shipName === 'Scarlet Lady'));
});

test('fetchCruises throws when no voyages are found (never overwrites good data)', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => '<html>no data here</html>' });
  await assert.rejects(() => provider.fetchCruises({ fetchImpl, enrichPrices: false }), /no voyages/);
});

// ── Per-cabin pricing (CabinCategoriesAvailability) ──────────────────────────

// A realistic slice of the GraphQL response: one seq, several categories, each
// with multiple cabin types so the "cheapest type wins" reduction is exercised.
function cabinResponse() {
  const price = amount => ({ lowestAvailablePrice: { totalPrice: { amount } } });
  return {
    data: {
      cabinCategoriesAvailability: [{
        availableCategories: [
          { code: 'INSIDER', submetas: [{ cabinTypes: [price(2530)] }] },
          { code: 'SEA VIEW', submetas: [{ cabinTypes: [price(3668), price(2800)] }] },
          { code: 'SEA TERRACE', submetas: [{ cabinTypes: [price(4580)] }, { cabinTypes: [price(3360)] }] },
          { code: 'ROCKSTAR SUITES', submetas: [{ cabinTypes: [price(7200)] }] },
          { code: 'MEGA ROCKSTAR', submetas: [{ cabinTypes: [price(20000)] }] },
        ],
      }],
    },
  };
}

test('parseCabinPrices halves 2-guest totals and takes the cheapest per bucket', () => {
  const prices = provider.parseCabinPrices(cabinResponse().data.cabinCategoriesAvailability);
  assert.deepEqual(prices, {
    inside: 1265,      // 2530 / 2
    oceanView: 1400,   // min(3668, 2800) / 2
    balcony: 1680,     // min(4580, 3360) / 2
    suite: 3600,       // min(ROCKSTAR 7200, MEGA 20000) / 2
  });
});

test('parseCabinPrices leaves sold-out / unknown categories null', () => {
  assert.deepEqual(
    provider.parseCabinPrices([{ availableCategories: [{ code: 'MYSTERY', submetas: [] }] }]),
    { inside: null, oceanView: null, balcony: null, suite: null },
  );
  assert.deepEqual(provider.parseCabinPrices(null), { inside: null, oceanView: null, balcony: null, suite: null });
});

test('buildCabinVars asks for 2 adults in GBP for the given voyage', () => {
  const v = provider.buildCabinVars('BR2607097NSBE').value;
  assert.equal(v.voyageId, 'BR2607097NSBE');
  assert.equal(v.currencyCode, 'GBP');
  assert.deepEqual(v.cabins[0].travelParty, [{ ageCategory: 'ADULT', count: 2 }]);
});

test('canReuseCabinPrices reuses fresh priced records and refuses stale/empty ones', () => {
  const now = Date.parse('2026-07-03T12:00:00Z');
  const priced = { id: 'virgin-X', prices: { inside: 1000, oceanView: null, balcony: null, suite: null }, pricesEnrichedAt: '2026-07-03T09:00:00Z' };
  assert.equal(provider.canReuseCabinPrices(priced, now), true, 'fresh (3h old) → reuse');
  assert.equal(provider.canReuseCabinPrices({ ...priced, pricesEnrichedAt: '2026-07-01T00:00:00Z' }, now), false, 'stale (>1 day) → refetch');
  assert.equal(provider.canReuseCabinPrices({ ...priced, prices: { inside: null, oceanView: null, balcony: null, suite: null } }, now), false, 'no prior price → refetch');
  assert.equal(provider.canReuseCabinPrices({ ...priced, pricesEnrichedAt: undefined }, now), false, 'never enriched → refetch');
  assert.equal(provider.canReuseCabinPrices(null, now), false);
});

test('enrichCabinPrices fetches with a stub token and populates buckets', async () => {
  const cruises = [{ id: 'virgin-BR2607097NSBE', prices: { inside: null, oceanView: null, balcony: null, suite: null } }];
  const fetchCabinImpl = async () => ({ ok: true, json: async () => cabinResponse() });
  await provider.enrichCabinPrices(cruises, { token: 'stub', fetchCabinImpl, priorEnrichmentById: new Map() });
  assert.equal(cruises[0].prices.inside, 1265);
  assert.equal(cruises[0].prices.suite, 3600);
  assert.ok(cruises[0].pricesEnrichedAt, 'stamps enrichment time on a fresh fetch');
});

test('enrichCabinPrices reuses prior prices within TTL instead of fetching', async () => {
  const prior = new Map([['virgin-BR2607097NSBE', {
    id: 'virgin-BR2607097NSBE',
    prices: { inside: 999, oceanView: null, balcony: null, suite: null },
    pricesEnrichedAt: new Date().toISOString(),
  }]]);
  const cruises = [{ id: 'virgin-BR2607097NSBE', prices: { inside: null, oceanView: null, balcony: null, suite: null } }];
  let called = false;
  const fetchCabinImpl = async () => { called = true; throw new Error('should not fetch'); };
  await provider.enrichCabinPrices(cruises, { token: 'stub', fetchCabinImpl, priorEnrichmentById: prior });
  assert.equal(called, false, 'a fresh prior is reused, no fetch');
  assert.equal(cruises[0].prices.inside, 999);
});

test('enrichCabinPrices carries prior prices forward when a fetch fails', async () => {
  const prior = new Map([['virgin-BR2607097NSBE', {
    id: 'virgin-BR2607097NSBE',
    prices: { inside: 888, oceanView: null, balcony: null, suite: null },
    pricesEnrichedAt: '2026-01-01T00:00:00Z', // stale → would refetch, but fetch fails
  }]]);
  const cruises = [{ id: 'virgin-BR2607097NSBE', prices: { inside: null, oceanView: null, balcony: null, suite: null } }];
  const fetchCabinImpl = async () => ({ ok: false, status: 500 });
  await provider.enrichCabinPrices(cruises, { token: 'stub', fetchCabinImpl, priorEnrichmentById: prior });
  assert.equal(cruises[0].prices.inside, 888, 'prior price preserved on failure — never regresses to null');
});

test('enrichCabinPrices without a token carries prior prices forward (no regression)', async () => {
  const prior = new Map([['virgin-BR2607097NSBE', {
    id: 'virgin-BR2607097NSBE',
    prices: { inside: 777, oceanView: null, balcony: null, suite: null },
    pricesEnrichedAt: '2026-07-03T09:00:00Z',
  }]]);
  const cruises = [{ id: 'virgin-BR2607097NSBE', prices: { inside: null, oceanView: null, balcony: null, suite: null } }];
  await provider.enrichCabinPrices(cruises, { grabToken: async () => null, priorEnrichmentById: prior });
  assert.equal(cruises[0].prices.inside, 777);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../providers/p-and-o');

// A representative `searchResults` entry from the cruise-query-processor API.
function apiResult(overrides = {}) {
  return {
    entityId: 'A627A_A627A',
    itineraryId: 'A627A',
    cruiseId: 'A627A',
    name: 'Mediterranean Fly-Cruise, 14 Nights',
    duration: 14,
    departDate: '2026-07-09T00:00:00Z',
    destinationIds: ['Mediterranean'],
    portOfCallIds: ['MLA', 'ATSEADAY', 'ARM', 'CFU', 'ATSEADAY', 'MLA'],
    shipName: 'Azura',
    embarkPortCode: 'MLA',
    disembarkPortCode: 'MLA',
    arrivalAtArrivalPort: '2026-07-23T06:00:00Z',
    availableRoomTypes: ['B', 'I'],
    avgPerPersonPrice: 2532.33,
    cabins: [{ roomTypeId: 'B', lowerPrice: 2409 }],
    ...overrides,
  };
}

test('classifies P&O room-type ids into the application cabin buckets', () => {
  assert.equal(provider.classifyCabinType('I'), 'inside');
  assert.equal(provider.classifyCabinType('O'), 'oceanView');
  assert.equal(provider.classifyCabinType('B'), 'balcony');
  assert.equal(provider.classifyCabinType('S'), 'suite');
  assert.equal(provider.classifyCabinType('?'), null);
});

test('maps known embark/disembark port codes to display names', () => {
  assert.equal(provider.portName('SOU'), 'Southampton');
  assert.equal(provider.portName('BGI'), 'Bridgetown, Barbados');
  // Unknown codes fall back to the raw code rather than dropping the port.
  assert.equal(provider.portName('ZZZ'), 'ZZZ');
  assert.equal(provider.portName(''), '');
});

test('counts sea days from the ATSEADAY itinerary markers', () => {
  assert.equal(provider.countSeaDays(['MLA', 'ATSEADAY', 'ARM', 'ATSEADAY', 'MLA']), 2);
  assert.equal(provider.countSeaDays(['MLA', 'ARM']), null);
  assert.equal(provider.countSeaDays(undefined), null);
});

test('normalizes an API search result into the shared cruise contract', () => {
  const cruise = provider.normalizeApiCruise(apiResult());
  assert.equal(cruise.id, 'pando-A627A');
  assert.equal(cruise.provider, 'P&O Cruises');
  assert.equal(cruise.shipName, 'Azura');
  assert.equal(cruise.shipClass, 'Grand');
  assert.equal(cruise.shipLaunchYear, 2010);
  assert.equal(cruise.itinerary, 'Mediterranean Fly-Cruise, 14 Nights');
  assert.equal(cruise.departureDate, '2026-07-09');
  assert.equal(cruise.arrivalDate, '2026-07-23');
  assert.equal(cruise.duration, '14 Nights');
  assert.equal(cruise.departurePort, 'Valletta, Malta');
  assert.equal(cruise.departureRegion, 'Mediterranean');
  assert.equal(cruise.destination, 'Mediterranean');
  assert.equal(cruise.destinationPort, 'Valletta, Malta');
  assert.equal(cruise.seaDays, 2);
  assert.equal(cruise.priceFrom, '2409');
  assert.equal(cruise.currency, 'GBP');
  // The cheapest cabin's bucket is populated; the rest stay null.
  assert.deepEqual(cruise.prices, { inside: null, oceanView: null, balcony: '2409', suite: null });
  assert.equal(cruise.bookingUrl, 'https://www.pocruises.com/find-a-cruise/A627A/A627A');
});

test('normalizeApiCruise falls back to avgPerPersonPrice when no cabin fare is present', () => {
  const cruise = provider.normalizeApiCruise(apiResult({ cabins: [] }));
  assert.equal(cruise.priceFrom, '2532');
  assert.deepEqual(cruise.prices, provider.emptyPrices());
});

test('normalizeApiCruise returns null without a cruise id', () => {
  assert.equal(provider.normalizeApiCruise({ shipName: 'Iona' }), null);
});

test('normalizeCruise is idempotent for already-normalized cruises', () => {
  const once = provider.normalizeApiCruise(apiResult());
  assert.equal(provider.normalizeCruise(once), once);
});

test('fetchCruises runs one pass per cabin type and merges per-cabin fares', async () => {
  const seen = new Set();
  // One sailing priced differently in the Inside and Balcony passes only.
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const roomType = u.searchParams.get('roomTypes');
    const start = Number(u.searchParams.get('start')) || 0;
    seen.add(roomType);
    const fare = { I: 500, B: 900 }[roomType];
    const rows = (start === 0 && fare)
      ? [apiResult({ cruiseId: 'C1', cabins: [{ roomTypeId: roomType, lowerPrice: fare }] })]
      : [];
    return { ok: true, json: async () => ({ results: rows.length, searchResults: rows }) };
  };

  const cruises = await provider.fetchCruises({ fetchImpl, logger: { warn() {} } });

  assert.deepEqual([...seen].sort(), ['B', 'I', 'O', 'S'], 'one pass per cabin type');
  assert.equal(cruises.length, 1);
  assert.equal(cruises[0].prices.inside, '500');
  assert.equal(cruises[0].prices.balcony, '900');
  assert.equal(cruises[0].prices.oceanView, null);
  assert.equal(cruises[0].priceFrom, '500', 'priceFrom is the cheapest populated cabin');
});

test('fetchCruises paginates each pass by start offset and dedupes across passes', async () => {
  const all = Array.from({ length: 25 }, (_, i) => apiResult({ cruiseId: `C${i}` }));
  const starts = [];
  const fetchImpl = async (url) => {
    const start = Number(new URL(url).searchParams.get('start')) || 0;
    starts.push(start);
    return { ok: true, json: async () => ({ results: all.length, searchResults: all.slice(start, start + 10) }) };
  };

  const cruises = await provider.fetchCruises({ fetchImpl, logger: { warn() {} } });

  assert.equal(cruises.length, 25, 'deduped across the four passes');
  assert.deepEqual([...new Set(starts)].sort((a, b) => a - b), [0, 10, 20], 'paginated by start offset');
  assert.equal(starts.length, 12, 'four cabin passes × three pages each');
});

test('fetchCruises throws when the API returns nothing (never overwrites good data)', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ results: 0, searchResults: [] }) });
  await assert.rejects(
    () => provider.fetchCruises({ fetchImpl, logger: { warn() {} } }),
    /P&O returned no cruise results/,
  );
});

test('fetchCruises keeps successful pages when one page request fails', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => apiResult({ cruiseId: `C${i}` }));
  const fetchImpl = async (url) => {
    const start = Number(new URL(url).searchParams.get('start')) || 0;
    if (start === 10) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => ({ results: 20, searchResults: rows.slice(start, start + 10) }) };
  };
  const warnings = [];
  const cruises = await provider.fetchCruises({ fetchImpl, logger: { warn: m => warnings.push(m) } });
  assert.equal(cruises.length, 10, 'first page kept despite the second failing');
  assert.match(warnings.join(' '), /page start=10 failed/);
});

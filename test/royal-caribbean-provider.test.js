'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../providers/royal-caribbean');
const { getDestinationPort } = require('../providers/shared');

const SAMPLE_CHAPTERS = [
  { days: [1], port: { name: 'Tampa', region: 'Florida' } },
  { days: [2], port: { name: 'Cruising', region: '' } },
  { days: [3], port: { name: 'George Town', region: 'Grand Cayman' } },
  { days: [4], port: { name: 'Oranjestad', region: 'Aruba' } },
  { days: [5], port: { name: 'Colon', region: 'Panama' } },
];

test('extractPortSequenceFromChapters reads ports from chapter objects', () => {
  assert.deepEqual(provider.extractPortSequenceFromChapters(SAMPLE_CHAPTERS), [
    'Tampa, Florida',
    'Cruising',
    'George Town, Grand Cayman',
    'Oranjestad, Aruba',
    'Colon, Panama',
  ]);
});

test('buildDetailedItinerary appends the full non-cruising route after the summary name', () => {
  assert.equal(
    provider.buildDetailedItinerary('7 Night Southern Caribbean Cruise', [
      'Tampa, Florida',
      'Cruising',
      'George Town, Grand Cayman',
      'Oranjestad, Aruba',
      'Willemstad, Curacao',
      'Colon, Panama',
    ]),
    '7 Night Southern Caribbean Cruise: Tampa, Florida, George Town, Grand Cayman, Oranjestad, Aruba, Willemstad, Curacao, Colon, Panama',
  );
});

test('round-trip room-selection ports keep departure and return endpoints', () => {
  const ports = provider.extractPortSequenceFromChapters([
    { days: [1], port: { name: 'Southampton', region: 'England' } },
    { days: [2], port: { name: 'Cruising', region: '' } },
    { days: [3], port: { name: 'Hamburg', region: 'Germany' } },
    { days: [4], port: { name: 'Bruges/Zeebrugge (Brussels)', region: 'Belgium' } },
    { days: [5], port: { name: 'Cruising', region: '' } },
    { days: [6], port: { name: 'Southampton', region: 'England' } },
  ]);

  assert.deepEqual(ports, [
    'Southampton, England',
    'Cruising',
    'Hamburg, Germany',
    'Bruges/Zeebrugge (Brussels), Belgium',
    'Southampton, England',
  ]);
  assert.equal(getDestinationPort(ports), 'Southampton, England');
  assert.equal(
    provider.buildDetailedItinerary('Hamburg & Bruges Cruise', ports),
    'Hamburg & Bruges Cruise: Southampton, England, Hamburg, Germany, Bruges/Zeebrugge (Brussels), Belgium, Southampton, England',
  );
});

test('parseBookingContext extracts room-selection filter fields from booking URL', () => {
  assert.deepEqual(
    provider.parseBookingContext('https://www.royalcaribbean.com/booking/landing?groupId=GR07TPA-670505416&sailDate=2026-05-02&shipCode=GR&packageCode=GR07D501&destinationCode=ISLAN&selectedCurrencyCode=USD&country=USA'),
    {
      packageCode: 'GR07D501',
      sailDate: '2026-05-02',
      selectedCurrencyCode: 'USD',
      country: 'USA',
    },
  );
});

test('classifyRoomType identifies inside / ocean view / balcony / suite entries', () => {
  assert.equal(provider.classifyRoomType({ id: 'X', name: 'Interior' }), 'inside');
  assert.equal(provider.classifyRoomType({ id: 'I', name: 'Inside' }), 'inside');
  assert.equal(provider.classifyRoomType({ id: 'N', name: 'Ocean View' }), 'oceanView');
  assert.equal(provider.classifyRoomType({ id: 'OV', name: 'Oceanview' }), 'oceanView');
  assert.equal(provider.classifyRoomType({ id: 'B', name: 'Balcony' }), 'balcony');
  assert.equal(provider.classifyRoomType({ id: 'S', name: 'Suite' }), 'suite');
  assert.equal(provider.classifyRoomType({ id: 'JS', name: 'Junior Suite' }), 'suite');
  assert.equal(provider.classifyRoomType({ id: 'ZZ', name: 'Unknown' }), null);
});

test('extractRoomTypePricesFromPayload reads per-class prices from sailing.stateroomClasses', () => {
  const payload = {
    sailing: {
      itinerary: { chapters: [] },
      stateroomClasses: [
        { id: 'X', name: 'Interior',   lowestPrice: { amount: 299 } },
        { id: 'N', name: 'Ocean View', lowestPrice: { amount: 449 } },
        { id: 'B', name: 'Balcony',    lowestPrice: { amount: 649 } },
        { id: 'S', name: 'Suite',      lowestPrice: { amount: 1299 } },
      ],
    },
  };
  assert.deepEqual(provider.extractRoomTypePricesFromPayload(payload), {
    inside:    '299',
    oceanView: '449',
    balcony:   '649',
    suite:     '1299',
  });
});

test('extractRoomTypePricesFromPayload returns all nulls when payload has no stateroom data', () => {
  assert.deepEqual(provider.extractRoomTypePricesFromPayload({}), {
    inside: null, oceanView: null, balcony: null, suite: null,
  });
});

test('extractRoomTypePricesFromPayload reads prices from top-level categories fallback', () => {
  const payload = {
    categories: [
      { id: 'B', name: 'Balcony', lowestPrice: { amount: 799 } },
      { id: 'S', name: 'Suite',   price:       { value:  2499 } },
    ],
  };
  const result = provider.extractRoomTypePricesFromPayload(payload);
  assert.equal(result.balcony, '799');
  assert.equal(result.suite,   '2499');
  assert.equal(result.inside,  null);
});

test('resolveBookingUrl passes absolute URLs through unchanged', () => {
  assert.equal(
    provider.resolveBookingUrl('https://www.royalcaribbean.com/booking/landing?x=1'),
    'https://www.royalcaribbean.com/booking/landing?x=1',
  );
});

test('resolveBookingUrl keeps absolute /booking paths host-prefixed (global handoff)', () => {
  assert.equal(
    provider.resolveBookingUrl('/booking/landing?selectedCurrencyCode=GBP&country=GBR'),
    'https://www.royalcaribbean.com/booking/landing?selectedCurrencyCode=GBP&country=GBR',
  );
});

test('resolveBookingUrl prefixes /gbr/en/ for bare itinerary paths so users land on the UK site', () => {
  assert.equal(
    provider.resolveBookingUrl('itinerary/4-night-western-caribbean-getaway-from-tampa-on-radiance-RD04W232?country=GBR'),
    'https://www.royalcaribbean.com/gbr/en/itinerary/4-night-western-caribbean-getaway-from-tampa-on-radiance-RD04W232?country=GBR',
  );
});

test('resolveBookingUrl returns "" for empty/falsy input', () => {
  assert.equal(provider.resolveBookingUrl(''), '');
  assert.equal(provider.resolveBookingUrl(undefined), '');
  assert.equal(provider.resolveBookingUrl(null), '');
});

// ── Sailing expansion ────────────────────────────────────────────────────────
// A cruiseSearch result is a cruise product holding every departure of a route;
// `lowestPriceSailing` is only its cheapest date. See normalizeCruise.

const BOOKING = (sailDate, packageCode = 'IC07E479') =>
  `/booking/landing?groupId=IC07MIA-2623281014&sailDate=${sailDate}&shipCode=IC&packageCode=${packageCode}&destinationCode=CARIB&selectedCurrencyCode=GBP&country=GBR`;

function searchResult(overrides = {}) {
  return {
    id: 'IC07MIA-2623281014',
    productViewLink: 'itinerary/7-night-eastern-caribbean-IC07MIA',
    sailings: [
      {
        id: 'IC07E479_2026-10-03',
        sailDate: '2026-10-03',
        bookingLink: BOOKING('2026-10-03'),
        lowestStateroomClassPrice: { price: { value: 838, currency: { code: 'GBP' } } },
        stateroomClassPricing: [
          { stateroomClass: { name: 'Interior' }, price: { value: 838 } },
          { stateroomClass: { name: 'Balcony' },  price: { value: 1030 } },
        ],
      },
      {
        id: 'IC07E479_2026-10-17',
        sailDate: '2026-10-17',
        bookingLink: BOOKING('2026-10-17'),
        lowestStateroomClassPrice: { price: { value: 901, currency: { code: 'GBP' } } },
        stateroomClassPricing: [{ stateroomClass: { name: 'Interior' }, price: { value: 901 } }],
      },
    ],
    lowestPriceSailing: {
      sailDate: '2026-10-03',
      bookingLink: BOOKING('2026-10-03'),
      lowestStateroomClassPrice: { price: { value: 838, currency: { code: 'GBP' } } },
      stateroomClassPricing: [{ stateroomClass: { name: 'Interior' }, price: { value: 838 } }],
    },
    masterSailing: {
      itinerary: {
        name: 'Eastern Caribbean & Perfect Day',
        totalNights: 7,
        departurePort: { name: 'Miami, Florida' },
        destination: { name: 'Caribbean' },
        ship: { name: 'Icon of the Seas', code: 'IC' },
      },
    },
    ...overrides,
  };
}

test('normalizeCruise emits one record per departure, not just the cheapest', () => {
  const rows = provider.normalizeSearchResult(searchResult());

  assert.equal(rows.length, 2, 'both sailings of the product are published');
  assert.deepEqual(rows.map(r => r.departureDate), ['2026-10-03', '2026-10-17']);
  assert.deepEqual(rows.map(r => r.id), ['rc_IC07E479_2026-10-03', 'rc_IC07E479_2026-10-17']);
  // Each record carries its OWN price and booking link, not the product's cheapest.
  assert.deepEqual(rows.map(r => r.priceFrom), ['838', '901']);
  assert.deepEqual(rows.map(r => r.prices.inside), ['838', '901']);
  assert.equal(rows[0].prices.balcony, '1030');
  assert.equal(rows[1].prices.balcony, null);
  assert.match(rows[1].bookingUrl, /sailDate=2026-10-17/);
  // Route-level fields are shared.
  rows.forEach(r => {
    assert.equal(r.shipName, 'Icon of the Seas');
    assert.equal(r.shipClass, 'Icon');
    assert.equal(r.duration, '7 Nights');
    assert.equal(r.departurePort, 'Miami, Florida');
    assert.equal(r.currency, 'GBP');
  });
});

test('normalizeCruise falls back to lowestPriceSailing when no sailings are returned', () => {
  for (const sailings of [[], undefined]) {
    const rows = provider.normalizeSearchResult(searchResult({ sailings }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].departureDate, '2026-10-03');
    assert.equal(rows[0].id, 'rc_IC07E479_2026-10-03', 'id derives from the booking link');
  }
});

test('normalizeCruise skips a product with no sailings at all', () => {
  assert.deepEqual(
    provider.normalizeSearchResult(searchResult({ sailings: [], lowestPriceSailing: null })),
    [],
  );
});

test('sailingKey prefers the API sailing id, then the booking link, then product+date', () => {
  const cruise = { id: 'IC07MIA-2623281014' };
  assert.equal(provider.sailingKey(cruise, { id: 'IC07E479_2026-10-03' }), 'IC07E479_2026-10-03');
  assert.equal(
    provider.sailingKey(cruise, { sailDate: '2026-10-03', bookingLink: BOOKING('2026-10-03') }),
    'IC07E479_2026-10-03',
  );
  assert.equal(
    provider.sailingKey(cruise, { sailDate: '2026-10-03' }),
    'IC07MIA-2623281014_2026-10-03',
  );
});

test('a departure already published keeps its existing id so price history survives', () => {
  // Before expansion this departure was published under the PRODUCT id.
  const prior = new Map([['rc_IC07MIA-2623281014', {
    id: 'rc_IC07MIA-2623281014',
    bookingUrl: `https://www.royalcaribbean.com${BOOKING('2026-10-03')}`,
  }]]);

  const index = provider.buildPriorIdIndex(prior);
  assert.equal(index.get('IC07E479_2026-10-03'), 'rc_IC07MIA-2623281014');

  const rows = provider.normalizeSearchResult(searchResult(), index);
  assert.equal(rows[0].id, 'rc_IC07MIA-2623281014', 'known departure keeps its id');
  assert.equal(rows[1].id, 'rc_IC07E479_2026-10-17', 'newly-found departure uses its own key');
});

test('buildPriorIdIndex ignores records whose booking URL carries no package/date', () => {
  const index = provider.buildPriorIdIndex(new Map([
    ['rc_a', { id: 'rc_a', bookingUrl: 'https://www.royalcaribbean.com/gbr/en/itinerary/some-slug' }],
    ['rc_b', { id: 'rc_b', bookingUrl: '' }],
  ]));
  assert.equal(index.size, 0);
  assert.equal(provider.buildPriorIdIndex(null).size, 0);
});

// ── Route-level itinerary enrichment ─────────────────────────────────────────
// Port sequences are fixed per package, so expanding a product into N departures
// must not multiply room-selection calls by N — that endpoint is the one that
// 503s under load.

const { roomSelectionCacheKey, routeCacheKey } = require('../providers/rci-room-selection');

test('routeCacheKey ignores the sail date; roomSelectionCacheKey keeps it', () => {
  const a = { packageCode: 'IC07E479', sailDate: '2026-10-03', selectedCurrencyCode: 'GBP', country: 'GBR' };
  const b = { ...a, sailDate: '2026-10-17' };

  assert.equal(routeCacheKey(a), routeCacheKey(b), 'same route → one cache entry');
  assert.notEqual(roomSelectionCacheKey(a), roomSelectionCacheKey(b), 'price data stays per-departure');
  assert.equal(routeCacheKey({ sailDate: '2026-10-03' }), null, 'no package → no key');
  assert.equal(routeCacheKey(null), null);
});

test('enrichment fetches each route once and applies its ports to every departure', async () => {
  const ports = ['Miami, Florida', 'Cruising', 'Nassau, Bahamas', 'Miami, Florida'];
  const calls = [];
  const stub = Object.create(provider);
  stub.fetchPage = async () => ({ total: 1, cruises: [searchResult()] });
  stub.fetchItineraryPorts = async (context) => { calls.push(context.packageCode); return ports; };

  const rows = await stub.fetchCruises();

  assert.deepEqual(calls, ['IC07E479'], 'two departures, one route, one request');
  assert.equal(rows.length, 2);
  rows.forEach((row) => {
    assert.equal(row.itinerary, 'Eastern Caribbean & Perfect Day: Miami, Florida, Nassau, Bahamas, Miami, Florida');
    assert.equal(row.destinationPort, 'Miami, Florida');
    assert.equal(typeof row.seaDays, 'number');
    assert.ok(row.enrichedAt, 'stamped on success so the next run can reuse it');
  });
  // Per-departure data is still that departure's own.
  assert.deepEqual(rows.map(r => r.departureDate), ['2026-10-03', '2026-10-17']);
  assert.deepEqual(rows.map(r => r.priceFrom), ['838', '901']);
});

test('enrichment failure degrades one route without dropping its sailings', async () => {
  const stub = Object.create(provider);
  stub.fetchPage = async () => ({ total: 1, cruises: [searchResult()] });
  stub.fetchItineraryPorts = async () => { throw new Error('503 Service Unavailable'); };

  const rows = await stub.fetchCruises();

  assert.equal(rows.length, 2, 'sailings are still published');
  rows.forEach((row) => {
    assert.equal(row.itinerary, 'Eastern Caribbean & Perfect Day', 'summary name, un-enriched');
    assert.equal(row.enrichedAt, undefined, 'not stamped, so the next run retries');
  });
});

test('enrichment reuses the prior run instead of re-fetching an unchanged sailing', async () => {
  const calls = [];
  const stub = Object.create(provider);
  stub.fetchPage = async () => ({ total: 1, cruises: [searchResult()] });
  stub.fetchItineraryPorts = async (context) => { calls.push(context.packageCode); return ['Miami, Florida']; };

  const prior = new Map([['rc_IC07E479_2026-10-03', {
    id: 'rc_IC07E479_2026-10-03',
    bookingUrl: `https://www.royalcaribbean.com${BOOKING('2026-10-03')}`,
    shipName: 'Icon of the Seas',
    departureDate: '2026-10-03',
    duration: '7 Nights',
    departurePort: 'Miami, Florida',
    itinerary: 'Eastern Caribbean & Perfect Day: Miami, Nassau, Miami',
    destinationPort: 'Nassau',
    seaDays: 3,
    enrichedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  }]]);

  const rows = await stub.fetchCruises({ priorEnrichmentById: prior });

  assert.equal(rows[0].itinerary, 'Eastern Caribbean & Perfect Day: Miami, Nassau, Miami', 'reused');
  assert.equal(rows[0].seaDays, 3);
  assert.equal(rows[0].priceFrom, '838', 'price still comes from this run');
  assert.deepEqual(calls, ['IC07E479'], 'only the un-reused departure triggered a fetch');
});

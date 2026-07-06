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
  const cruises = await provider.fetchCruises({ fetchImpl });
  assert.equal(cruises.length, 2, 'the two identical voyages dedupe to one');
  assert.ok(cruises.some(c => c.shipName === 'Scarlet Lady'));
});

test('fetchCruises throws when no voyages are found (never overwrites good data)', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => '<html>no data here</html>' });
  await assert.rejects(() => provider.fetchCruises({ fetchImpl }), /no voyages/);
});

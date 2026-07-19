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

test('buildItinerary resolves port codes, drops sea days, and keeps the return endpoint', () => {
  const map = { SOU: 'Southampton, UK', LIS: 'Lisbon, Portugal', VGO: 'Vigo, Spain' };
  assert.equal(
    provider.buildItinerary('Iberia, 7 Nights', ['SOU', 'ATSEADAY', 'LIS', 'VGO', 'ATSEADAY', 'SOU'], map),
    'Southampton, UK → Lisbon, Portugal → Vigo, Spain → Southampton, UK',
  );
  // No resolvable ports → fall back to the cruise name.
  assert.equal(provider.buildItinerary('Transatlantic Crossing', ['ATSEADAY', 'ZZZ'], {}), 'Transatlantic Crossing');
});

test('fetchPortMap parses the port code→name map from the find-a-cruise page', async () => {
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    x: { portOfCalls: { items: [{ id: 'MLA', txName: 'Valletta, Malta' }, { id: 'CFU', txName: 'Corfu, Greece' }] } },
  })}</script></html>`;
  const fetchImpl = async () => ({ ok: true, text: async () => html });
  const map = await provider.fetchPortMap(fetchImpl);
  assert.equal(map.MLA, 'Valletta, Malta');
  assert.equal(map.CFU, 'Corfu, Greece');
});

test('fetchPortMap returns an empty map (not an error) when every attempt fails', async () => {
  assert.deepEqual(await provider.fetchPortMap(async () => ({ ok: false, status: 500 }), { attempts: 1 }), {});
  assert.deepEqual(await provider.fetchPortMap(async () => { throw new Error('offline'); }, { attempts: 1 }), {});
});

test('fetchPortMap retries a transient failure before succeeding', async () => {
  let calls = 0;
  const html = `<html>${JSON.stringify({ portOfCalls: { items: [{ id: 'MLA', txName: 'Valletta, Malta' }] } })}</html>`;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw new Error('transient blip');
    return { ok: true, text: async () => html };
  };
  const map = await provider.fetchPortMap(fetchImpl, { retryDelayMs: 0 });
  assert.equal(calls, 3, 'kept retrying until the fetch succeeded');
  assert.equal(map.MLA, 'Valletta, Malta');
});

test('counts sea days from the ATSEADAY itinerary markers', () => {
  assert.equal(provider.countSeaDays(['MLA', 'ATSEADAY', 'ARM', 'ATSEADAY', 'MLA']), 2);
  assert.equal(provider.countSeaDays(['MLA', 'ARM']), null);
  assert.equal(provider.countSeaDays(undefined), null);
});

const PORT_MAP = { MLA: 'Valletta, Malta', ARM: 'Cephalonia, Argostoli', CFU: 'Corfu, Greece' };

test('normalizes an API search result into the shared cruise contract', () => {
  const cruise = provider.normalizeApiCruise(apiResult(), PORT_MAP);
  assert.equal(cruise.id, 'pando-A627A');
  assert.equal(cruise.provider, 'P&O Cruises');
  assert.equal(cruise.shipName, 'Azura');
  assert.equal(cruise.shipClass, 'Grand');
  assert.equal(cruise.shipLaunchYear, 2010);
  // Itinerary is the arrow-joined port sequence (sea days dropped) resolved
  // from the port map; the return endpoint is kept.
  assert.equal(cruise.itinerary, 'Valletta, Malta → Cephalonia, Argostoli → Corfu, Greece → Valletta, Malta');
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

test('resolves the ship name from shipId when the API omits shipName', () => {
  // The API sends `shipName: undefined` on ~half the records but always a shipId.
  const cruise = provider.normalizeApiCruise(apiResult({ shipName: undefined, shipId: 'AC' }));
  assert.equal(cruise.shipName, 'Arcadia');
  assert.equal(cruise.shipClass, 'Vista');
  assert.equal(cruise.shipLaunchYear, 2005);

  // shipId is authoritative even when a stale name is present.
  assert.equal(provider.resolveShipName({ shipId: 'IA', shipName: 'undefined' }), 'Iona');
  // Falls back to an explicit name for an unmapped id.
  assert.equal(provider.resolveShipName({ shipId: 'ZZ', shipName: 'Future Ship' }), 'Future Ship');
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

  const cruises = await provider.fetchCruises({ fetchImpl, portMap: {}, logger: { warn() {} } });

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

  const cruises = await provider.fetchCruises({ fetchImpl, portMap: {}, logger: { warn() {} } });

  assert.equal(cruises.length, 25, 'deduped across the four passes');
  assert.deepEqual([...new Set(starts)].sort((a, b) => a - b), [0, 10, 20], 'paginated by start offset');
  assert.equal(starts.length, 12, 'four cabin passes × three pages each');
});

test('fetchCruises throws when the self-fetched port map is empty (never degrades itineraries)', async () => {
  // Port-map page fails; search API would return good rows. Without the guard
  // these rows would be written with single-port itineraries, overwriting good
  // data — so the pass must abort instead.
  const fetchImpl = async (url) => {
    if (String(url).includes('/find-a-cruise')) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ results: 1, searchResults: [apiResult({ cruiseId: 'C1' })] }) };
  };
  await assert.rejects(
    () => provider.fetchCruises({ fetchImpl, portMapOptions: { attempts: 1 }, logger: { warn() {} } }),
    /port map unavailable/,
  );
});

// A fake ~150-entry map — big enough to clear MIN_PORT_MAP_SIZE (100).
function bigPortMap() {
  const map = {};
  for (let i = 0; i < 150; i++) map[`P${i}`] = `Port ${i}`;
  map.MLA = 'Valletta, Malta';
  return map;
}

test('fetchCruises reuses a prior port map when the site blocks the fresh fetch', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/find-a-cruise')) return { ok: false, status: 403 };
    return {
      ok: true,
      json: async () => ({ results: 1, searchResults: [apiResult({ cruiseId: 'C1', portOfCallIds: ['MLA'] })] }),
    };
  };
  const warnings = [];
  const cruises = await provider.fetchCruises({
    fetchImpl,
    portMapOptions: { attempts: 1 },
    priorPortMap: bigPortMap(),
    logger: { warn: m => warnings.push(m) },
  });
  assert.equal(cruises.length, 1, 'falls back instead of throwing');
  assert.equal(cruises[0].departurePort, 'Valletta, Malta', 'itinerary resolved via the prior map');
  assert.match(warnings.join(' '), /reusing last known-good map/);
});

test('fetchCruises still throws when neither the fresh fetch nor the prior map are usable', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/find-a-cruise')) return { ok: false, status: 403 };
    return { ok: true, json: async () => ({ results: 1, searchResults: [apiResult({ cruiseId: 'C1' })] }) };
  };
  await assert.rejects(
    () => provider.fetchCruises({
      fetchImpl,
      portMapOptions: { attempts: 1 },
      priorPortMap: { MLA: 'Valletta, Malta' }, // far below MIN_PORT_MAP_SIZE
      logger: { warn() {} },
    }),
    /port map unavailable/,
  );
});

test('fetchCruises reports the resolved port map via onPortMap so the orchestrator can persist it', async () => {
  // Needs 100+ items to clear MIN_PORT_MAP_SIZE so it's used as-is (not treated
  // as a failed fetch requiring a fallback).
  const items = Array.from({ length: 150 }, (_, i) => ({ id: `P${i}`, txName: `Port ${i}` }));
  items.push({ id: 'MLA', txName: 'Valletta, Malta' });
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    x: { portOfCalls: { items } },
  })}</script></html>`;
  const fetchImpl = async (url) => {
    if (String(url).includes('/find-a-cruise')) return { ok: true, text: async () => html };
    return { ok: true, json: async () => ({ results: 0, searchResults: [] }) };
  };
  let reported = null;
  await assert.rejects(
    () => provider.fetchCruises({ fetchImpl, onPortMap: (m) => { reported = m; }, logger: { warn() {} } }),
    /P&O returned no cruise results/,
  );
  assert.equal(reported?.MLA, 'Valletta, Malta', 'onPortMap still fires even though the search pass came up empty');
});

test('fetchCruises throws when the API returns nothing (never overwrites good data)', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ results: 0, searchResults: [] }) });
  await assert.rejects(
    () => provider.fetchCruises({ fetchImpl, portMap: {}, logger: { warn() {} } }),
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
  const cruises = await provider.fetchCruises({ fetchImpl, portMap: {}, logger: { warn: m => warnings.push(m) } });
  assert.equal(cruises.length, 10, 'first page kept despite the second failing');
  assert.match(warnings.join(' '), /page start=10 failed/);
});

// createBrowserFetch wraps a Playwright `page` as a fetchImpl by running the
// request as page.evaluate(() => fetch(...)). These tests fake `page.evaluate`
// by invoking the callback directly (with global.fetch stubbed for the
// duration) rather than spinning up a real browser — real Chromium behaviour
// is only verified by an actual scrape run.
test('createBrowserFetch translates an in-page fetch into a Response-like object', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    assert.equal(url, 'https://example.com/x');
    assert.deepEqual(opts.headers, { accept: 'application/json' });
    return { ok: true, status: 200, statusText: 'OK', text: async () => '{"a":1}' };
  };
  try {
    const fakePage = { evaluate: async (fn, arg) => fn(arg) };
    const browserFetch = provider.createBrowserFetch(fakePage);
    const res = await browserFetch('https://example.com/x', { headers: { accept: 'application/json' } });
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"a":1}');
    assert.deepEqual(await res.json(), { a: 1 });
  } finally {
    global.fetch = realFetch;
  }
});

test('createBrowserFetch surfaces a failed in-page fetch as a non-ok response instead of throwing', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('blocked'); };
  try {
    const fakePage = { evaluate: async (fn, arg) => fn(arg) };
    const browserFetch = provider.createBrowserFetch(fakePage);
    const res = await browserFetch('https://example.com/x');
    assert.equal(res.ok, false);
    assert.equal(res.status, 0);
    assert.match(res.statusText, /blocked/);
  } finally {
    global.fetch = realFetch;
  }
});

test('fetchCruises routes to the browser path only when no fetchImpl is supplied', async () => {
  // Sanity check for the dispatcher itself: passing fetchImpl (as every other
  // test in this file does) must never attempt to launch a real browser.
  const fetchImpl = async () => ({ ok: true, json: async () => ({ results: 0, searchResults: [] }) });
  await assert.rejects(
    () => provider.fetchCruises({ fetchImpl, portMap: {}, logger: { warn() {} } }),
    /P&O returned no cruise results/,
  );
});

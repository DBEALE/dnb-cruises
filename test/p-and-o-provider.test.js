'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../providers/p-and-o');

// A representative `searchResults` entry from the orchestrator cruisesearch API.
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
    arrivalDate: '2026-07-23T00:00:00Z',
    availableRoomTypes: ['B', 'I'],
    avgPerPersonPrice: 2532.33,
    cabins: [{ roomTypeId: 'B', lowerPrice: 2409 }],
    ...overrides,
  };
}

// Fakes the orchestrator search API: GET /cruiselist returns every id, and a
// POST returns the rows for the requested ids (at most 10), as filtered by the
// roomType encoded in the base64 `cabins` spec. `rowFor(id, roomType)` builds
// each row (or returns null to omit it); `fail(ids)` forces a batch to error.
function fakeSearchApi(ids, rowFor, { fail = () => false, calls = [] } = {}) {
  return async (url, opts = {}) => {
    if (String(url).includes('/cruiselist')) {
      return { ok: true, json: async () => ({ availableCruiseList: ids.join(',') }) };
    }
    const body = JSON.parse(opts.body);
    const batch = body.availableCruiseList.split(',');
    const roomType = JSON.parse(Buffer.from(body.cabins, 'base64').toString())[0].roomType || '';
    calls.push({ method: opts.method, roomType, batch });
    if (fail(batch)) return { ok: false, status: 500, json: async () => ({}) };
    const rows = batch.map(id => rowFor(id, roomType)).filter(Boolean).slice(0, 10);
    return { ok: true, json: async () => ({ results: rows.length, searchResults: rows }) };
  };
}

// Zero pacing so fetchCruises tests don't sleep between or retry batches.
const FAST = { delayMs: 0, retryMs: 0, attempts: 1 };

test('encodeCabins matches the SPA party spec', () => {
  assert.equal(provider.encodeCabins(), Buffer.from('[{"party":2}]').toString('base64'));
  assert.equal(provider.encodeCabins('I'), 'W3sicGFydHkiOjIsInJvb21UeXBlIjoiSSJ9XQ==');
});

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
  // One sailing priced differently in the Inside and Balcony passes only.
  const calls = [];
  const fetchImpl = fakeSearchApi(['C1'], (id, roomType) => {
    const fare = { I: 500, B: 900 }[roomType];
    return apiResult({ cruiseId: id, cabins: fare ? [{ roomTypeId: roomType, lowerPrice: fare }] : [] });
  }, { calls });

  const cruises = await provider.fetchCruises({ fetchImpl, pacing: FAST, portMap: {}, logger: { warn() {} } });

  assert.deepEqual(calls.map(c => c.roomType).sort(), ['B', 'I', 'O', 'S'], 'one pass per cabin type');
  assert.ok(calls.every(c => c.method === 'POST'));
  assert.equal(cruises.length, 1);
  assert.equal(cruises[0].prices.inside, '500');
  assert.equal(cruises[0].prices.balcony, '900');
  assert.equal(cruises[0].prices.oceanView, null);
  assert.equal(cruises[0].priceFrom, '500', 'priceFrom is the cheapest populated cabin');
});

test('fetchCruises posts the cruise id list in batches of 10 and dedupes across passes', async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `C${i}`);
  const calls = [];
  const fetchImpl = fakeSearchApi(ids, id => apiResult({ cruiseId: id }), { calls });

  const cruises = await provider.fetchCruises({ fetchImpl, pacing: FAST, portMap: {}, logger: { warn() {} } });

  assert.equal(cruises.length, 25, 'deduped across the four passes');
  assert.deepEqual([...new Set(calls.map(c => c.batch.length))].sort((a, b) => a - b), [5, 10], 'batched by 10');
  assert.equal(calls.length, 12, 'four cabin passes × three batches each');
});

test('fetchCruises throws when the self-fetched port map is empty (never degrades itineraries)', async () => {
  // Port-map page fails; search API would return good rows. Without the guard
  // these rows would be written with single-port itineraries, overwriting good
  // data — so the pass must abort instead.
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('/find-a-cruise')) return { ok: false, status: 503 };
    return fakeSearchApi(['C1'], id => apiResult({ cruiseId: id }))(url, opts);
  };
  await assert.rejects(
    () => provider.fetchCruises({ fetchImpl, pacing: FAST, portMapOptions: { attempts: 1 }, logger: { warn() {} } }),
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
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('/find-a-cruise')) return { ok: false, status: 403 };
    return fakeSearchApi(['C1'], id => apiResult({ cruiseId: id, portOfCallIds: ['MLA'] }))(url, opts);
  };
  const warnings = [];
  const cruises = await provider.fetchCruises({
    fetchImpl,
    pacing: FAST,
    portMapOptions: { attempts: 1 },
    priorPortMap: bigPortMap(),
    logger: { warn: m => warnings.push(m) },
  });
  assert.equal(cruises.length, 1, 'falls back instead of throwing');
  assert.equal(cruises[0].departurePort, 'Valletta, Malta', 'itinerary resolved via the prior map');
  assert.match(warnings.join(' '), /reusing last known-good map/);
});

test('fetchCruises still throws when neither the fresh fetch nor the prior map are usable', async () => {
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('/find-a-cruise')) return { ok: false, status: 403 };
    return fakeSearchApi(['C1'], id => apiResult({ cruiseId: id }))(url, opts);
  };
  await assert.rejects(
    () => provider.fetchCruises({
      fetchImpl,
      pacing: FAST,
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
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('/find-a-cruise')) return { ok: true, text: async () => html };
    return fakeSearchApi([], () => null)(url, opts);
  };
  let reported = null;
  await assert.rejects(
    () => provider.fetchCruises({ fetchImpl, pacing: FAST, onPortMap: (m) => { reported = m; }, logger: { warn() {} } }),
    /P&O returned no cruise results/,
  );
  assert.equal(reported?.MLA, 'Valletta, Malta', 'onPortMap still fires even though the search pass came up empty');
});

test('fetchCruises throws when the API returns nothing (never overwrites good data)', async () => {
  const fetchImpl = fakeSearchApi(['C1'], () => null);
  await assert.rejects(
    () => provider.fetchCruises({ fetchImpl, pacing: FAST, portMap: {}, logger: { warn() {} } }),
    /P&O returned no cruise results/,
  );
});

test('fetchCruises skips an isolated failed batch but keeps the rest', async () => {
  // 60 batches per pass, one of which always fails — under the abort threshold.
  const ids = Array.from({ length: 600 }, (_, i) => `C${i}`);
  const fetchImpl = fakeSearchApi(ids, id => apiResult({ cruiseId: id }), { fail: batch => batch[0] === 'C10' });
  const warnings = [];
  const cruises = await provider.fetchCruises({ fetchImpl, pacing: FAST, portMap: {}, logger: { warn: m => warnings.push(m) } });
  assert.equal(cruises.length, 590, 'every other batch kept');
  assert.match(warnings.join(' '), /batch C10… failed/);
});

test('fetchCruises retries a batch that fails transiently', async () => {
  let failures = 0;
  const fetchImpl = fakeSearchApi(['C1'], id => apiResult({ cruiseId: id }), {
    fail: () => failures++ === 0,
  });
  const cruises = await provider.fetchCruises({
    fetchImpl,
    pacing: { ...FAST, attempts: 2 },
    portMap: {},
    logger: { warn() {} },
  });
  assert.equal(cruises.length, 1, 'second attempt succeeded');
});

test('fetchCruises aborts when the WAF blocks a large share of batches', async () => {
  // Mirrors a real rate-limit block: partial results would silently drop sailings.
  const ids = Array.from({ length: 100 }, (_, i) => `C${i}`);
  const fetchImpl = fakeSearchApi(ids, id => apiResult({ cruiseId: id }), { fail: batch => batch[0] >= 'C5' });
  await assert.rejects(
    () => provider.fetchCruises({ fetchImpl, pacing: FAST, portMap: {}, logger: { warn() {} } }),
    /pass lost \d+\/10 batches/,
  );
});

test('fetchCruises throws when the cruise list is empty', async () => {
  const fetchImpl = fakeSearchApi([], () => null);
  await assert.rejects(
    () => provider.fetchCruises({ fetchImpl, pacing: FAST, portMap: {}, logger: { warn() {} } }),
    /P&O returned no cruise results/,
  );
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

test('createBrowserFetch forwards the method and body for POST requests', async () => {
  const realFetch = global.fetch;
  let seen;
  global.fetch = async (url, opts) => {
    seen = opts;
    return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' };
  };
  try {
    const fakePage = { evaluate: async (fn, arg) => fn(arg) };
    const browserFetch = provider.createBrowserFetch(fakePage);
    await browserFetch('https://example.com/x', { method: 'POST', headers: { brand: 'po' }, body: '{"a":1}' });
    assert.deepEqual(seen, { method: 'POST', headers: { brand: 'po' }, body: '{"a":1}' });
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
    () => provider.fetchCruises({ fetchImpl, pacing: FAST, portMap: {}, logger: { warn() {} } }),
    /P&O returned no cruise results/,
  );
});

test('createBrowserFetch strips user-agent overrides so requests match the session UA', async () => {
  const realFetch = global.fetch;
  let seenHeaders;
  global.fetch = async (url, opts) => {
    seenHeaders = opts.headers;
    return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' };
  };
  try {
    const fakePage = { evaluate: async (fn, arg) => fn(arg) };
    const browserFetch = provider.createBrowserFetch(fakePage);
    await browserFetch('https://example.com/x', { headers: { 'User-Agent': 'Spoofed/1.0', brand: 'po' } });
    assert.deepEqual(seenHeaders, { brand: 'po' }, 'user-agent removed, API headers kept');
  } finally {
    global.fetch = realFetch;
  }
});

test('chromeUserAgent tracks the running binary version and never says Headless', () => {
  const ua = provider.chromeUserAgent('143.0.6900.21');
  assert.match(ua, /Chrome\/143\.0\.0\.0/, 'major version from the binary, reduced-UA format');
  assert.doesNotMatch(ua, /Headless/i);
});

// A fake in-page environment for the browser-cascade tests: global.fetch plays
// the browser's fetch, the fake page's evaluate just runs the callback in-process.
function stubBrowserEnvironment() {
  const items = Array.from({ length: 150 }, (_, i) => ({ id: `P${i}`, txName: `Port ${i}` }));
  const html = `<html>${JSON.stringify({ portOfCalls: { items } })}</html>`;
  const row = apiResult({ cruiseId: 'C1' });
  global.fetch = async (url) => {
    let body;
    if (String(url).includes('/cruiselist')) body = JSON.stringify({ availableCruiseList: 'C1' });
    else if (String(url).includes('find-a-cruise')) body = html;
    else body = JSON.stringify({ results: 1, searchResults: [row] });
    return { ok: true, status: 200, statusText: 'OK', text: async () => body };
  };
  return {
    page: {
      evaluate: async (fn, arg) => fn(arg),
      goto: async () => ({ status: () => 200 }),
      waitForTimeout: async () => {},
    },
  };
}

test('browser cascade falls through failed launch configs to a working session', async () => {
  const realFetch = global.fetch;
  const { page } = stubBrowserEnvironment();
  const attempts = [];
  const launchImpl = async (launchOptions) => {
    attempts.push(launchOptions.channel || 'default');
    // First config (system Chrome) unavailable — e.g. not installed locally.
    if (attempts.length === 1) throw new Error("Chromium distribution 'chrome' is not found");
    return { newPage: async () => page, close: async () => {}, version: () => '143.0.1.2' };
  };
  try {
    const cruises = await provider.fetchCruises({ launchImpl, pacing: FAST, logger: { warn() {}, log() {} } });
    assert.deepEqual(attempts, ['chrome', 'chromium'], 'stopped at the first config that worked');
    assert.equal(cruises.length, 1);
    assert.equal(cruises[0].id, 'pando-C1');
  } finally {
    global.fetch = realFetch;
  }
});

test('browser cascade reports every config when all of them are blocked', async () => {
  const launchImpl = async () => { throw new Error('net::ERR_HTTP2_PROTOCOL_ERROR'); };
  await assert.rejects(
    () => provider.fetchCruises({ launchImpl, pacing: FAST, logger: { warn() {}, log() {} } }),
    (err) => {
      assert.match(err.message, /blocked across all browser configs/);
      assert.match(err.message, /system Chrome/);
      assert.match(err.message, /Chromium new-headless/);
      assert.match(err.message, /headless shell HTTP\/1\.1/);
      return true;
    },
  );
});

test('browser cascade rejects a session whose search-API probe fails despite the page loading', async () => {
  // A challenge page can come back as a clean 200 — the probe must catch that.
  const realFetch = global.fetch;
  global.fetch = async (url) => (String(url).includes('cruise-query-processor')
    ? { ok: false, status: 403, statusText: 'Forbidden', text: async () => '' }
    : { ok: true, status: 200, statusText: 'OK', text: async () => '<html>challenge</html>' });
  const page = {
    evaluate: async (fn, arg) => fn(arg),
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {},
  };
  const launchImpl = async () => ({ newPage: async () => page, close: async () => {}, version: () => '143.0.1.2' });
  try {
    await assert.rejects(
      () => provider.fetchCruises({ launchImpl, pacing: FAST, logger: { warn() {}, log() {} } }),
      /search API probe HTTP 403/,
    );
  } finally {
    global.fetch = realFetch;
  }
});

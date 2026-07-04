'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const {
  countCurrentPrices,
  fetchProviderSnapshot,
  fetchAllSnapshots,
  mergePriceHistory,
  sanitizePriceHistoryForProvider,
  getProviderOutputPath,
  getProviderHistoryPath,
  writeProviderSnapshot,
  readPreviousProviderSnapshot,
} = require('../scripts/fetch-cruises');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── Concurrent scrape scheduling (must never introduce empty results) ─────────

// Builds a fake provider that records how many of its "kind" (browser vs
// network) are executing at once, so a test can assert the concurrency shape.
function makeInstrumentedProvider(id, usesBrowser, counters, { result } = {}) {
  return {
    id, name: id, usesBrowser,
    async fetchCruises() {
      const key = usesBrowser ? 'browser' : 'network';
      counters[key].active++;
      counters[key].max = Math.max(counters[key].max, counters[key].active);
      await delay(15);
      counters[key].active--;
      return result !== undefined ? result : [{ id: `${id}_1`, shipName: 'Ship' }];
    },
  };
}

test('fetchAllSnapshots never runs two browser (Chromium) providers at once', async () => {
  const counters = { browser: { active: 0, max: 0 }, network: { active: 0, max: 0 } };
  const providers = [
    makeInstrumentedProvider('rc', false, counters),
    makeInstrumentedProvider('celebrity', false, counters),
    makeInstrumentedProvider('ncl', true, counters),
    makeInstrumentedProvider('p-and-o', true, counters),
    makeInstrumentedProvider('princess', true, counters),
  ];

  const settled = await fetchAllSnapshots(providers, { emptyResultRetries: 0 });

  // The failure mode that used to force sequential scraping — two headless
  // Chromium instances contending — is structurally impossible now.
  assert.equal(counters.browser.max, 1, 'at most one browser provider runs at a time');
  assert.ok(counters.network.max >= 2, 'network providers still run concurrently');
  assert.equal(settled.filter(s => s.status === 'fulfilled').length, 5);
});

test('fetchAllSnapshots excludes empty/throwing providers so they cannot overwrite good data', async () => {
  const counters = { browser: { active: 0, max: 0 }, network: { active: 0, max: 0 } };
  const providers = [
    makeInstrumentedProvider('good', false, counters),
    makeInstrumentedProvider('empty-browser', true, counters, { result: [] }),
    { id: 'boom', name: 'boom', fetchCruises: async () => { throw new Error('network down'); } },
  ];

  const settled = await fetchAllSnapshots(providers, { emptyResultRetries: 0 });

  const fulfilled = settled.filter(s => s.status === 'fulfilled').map(s => s.value.provider.id);
  assert.deepEqual(fulfilled, ['good'], 'only the non-empty provider is a snapshot');
  assert.equal(settled.filter(s => s.status === 'rejected').length, 2, 'empty + throwing both rejected');
});

test('fetchAllSnapshots sequential mode runs providers strictly one at a time', async () => {
  const counters = { browser: { active: 0, max: 0 }, network: { active: 0, max: 0 } };
  const providers = [
    makeInstrumentedProvider('a', false, counters),
    makeInstrumentedProvider('b', false, counters),
    makeInstrumentedProvider('c', false, counters),
  ];

  const settled = await fetchAllSnapshots(providers, { sequential: true, emptyResultRetries: 0 });

  assert.equal(counters.network.max, 1, 'sequential mode never overlaps providers');
  assert.equal(settled.filter(s => s.status === 'fulfilled').length, 3);
});

test('writeProviderSnapshot refuses to overwrite an existing file with an empty snapshot', () => {
  const providerId = `__test-empty-guard-${process.pid}`;
  const provider = { id: providerId, name: 'Empty Guard' };
  const cruisesPath = getProviderOutputPath(providerId);

  try {
    // A good snapshot writes and returns true.
    assert.equal(
      writeProviderSnapshot(provider, [{ id: 'a', shipName: 'Ship', prices: { inside: '500' } }], '2026-06-01T00:00:00Z'),
      true,
    );
    const goodContents = fs.readFileSync(cruisesPath, 'utf8');

    // An empty snapshot is refused (returns false) and leaves the file intact.
    assert.equal(writeProviderSnapshot(provider, [], '2026-06-02T00:00:00Z'), false);
    assert.equal(fs.readFileSync(cruisesPath, 'utf8'), goodContents, 'existing good data is untouched');
  } finally {
    fs.rmSync(path.dirname(cruisesPath), { recursive: true, force: true });
  }
});

test('snapshot write splits price history into a sibling file and read reattaches it', () => {
  const providerId = `__test-split-${process.pid}`;
  const provider = { id: providerId, name: 'Test Split Provider' };
  const cruisesPath = getProviderOutputPath(providerId);
  const historyPath = getProviderHistoryPath(providerId);

  try {
    const priceHistory = [
      { at: '2026-06-01T00:00:00Z', prices: { inside: 799, balcony: 1099 } },
      { at: '2026-06-02T00:00:00Z', prices: { inside: 750, balcony: 1050 } },
    ];
    writeProviderSnapshot(provider, [
      { id: 'x1', shipName: 'Test Ship', prices: { inside: '750' }, priceHistory },
      { id: 'x2', shipName: 'No History', prices: { inside: '500' }, priceHistory: [] },
    ], '2026-06-02T00:00:00Z');

    // cruises.json is slim — no priceHistory field on any cruise.
    const written = JSON.parse(fs.readFileSync(cruisesPath, 'utf8'));
    assert.equal(written.count, 2);
    assert.ok(written.cruises.every(c => !('priceHistory' in c)), 'cruises.json must not inline priceHistory');

    // price-history.json holds history only for cruises that have entries.
    const historyFile = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    assert.deepEqual(historyFile.history.x1, priceHistory);
    assert.ok(!('x2' in historyFile.history), 'empty history is omitted from the sidecar');

    // Reading the previous snapshot reattaches history from the sidecar.
    const prev = readPreviousProviderSnapshot(providerId);
    assert.deepEqual(prev.get('x1').priceHistory, priceHistory);

    // …so history keeps accumulating across runs via mergePriceHistory.
    const merged = mergePriceHistory(providerId, prev.get('x1'), {
      prices: { inside: '700', balcony: '1000' },
    }, '2026-06-03T00:00:00Z');
    assert.equal(merged.length, 3);
    assert.equal(merged[2].prices.inside, 700);
  } finally {
    fs.rmSync(path.dirname(cruisesPath), { recursive: true, force: true });
  }
});

test('counts current cabin prices for scrape metadata', () => {
  assert.equal(countCurrentPrices([
    { prices: { inside: 799, oceanView: null, balcony: '1099', suite: 0 } },
    { prices: { inside: 899, oceanView: 999, balcony: 1199, suite: 1599 } },
    { priceFrom: 500 },
  ]), 6);
});

test('provider snapshots reject empty scrape results', async () => {
  await assert.rejects(
    fetchProviderSnapshot({
      name: 'Empty Provider',
      fetchCruises: async () => [],
    }, { emptyResultRetries: 0 }),
    /Empty Provider returned no cruise results/,
  );
});

test('provider snapshots retry an empty scrape result once', async () => {
  let attempts = 0;
  const snapshot = await fetchProviderSnapshot({
    name: 'Flaky Provider',
    fetchCruises: async () => {
      attempts++;
      return attempts === 1 ? [] : [{ id: 'ok' }];
    },
  }, { emptyResultRetries: 1, emptyResultRetryDelayMs: 0 });

  assert.equal(attempts, 2);
  assert.deepEqual(snapshot.cruises, [{ id: 'ok' }]);
});

test('NCL history drops the earliest all-cabin-equal price entry', () => {
  const history = sanitizePriceHistoryForProvider('ncl-cruises', [
    { at: '2026-06-02T00:00:00Z', prices: { inside: 799, oceanView: 899, balcony: 1099, suite: 1599 } },
    { at: '2026-06-01T00:00:00Z', prices: { inside: 999, oceanView: 999, balcony: 999, suite: 999 } },
  ]);

  assert.deepEqual(history, [
    { at: '2026-06-02T00:00:00Z', prices: { inside: 799, oceanView: 899, balcony: 1099, suite: 1599 } },
  ]);
});

test('NCL history keeps all-cabin-equal entries when they are not earliest', () => {
  const history = sanitizePriceHistoryForProvider('ncl-cruises', [
    { at: '2026-06-01T00:00:00Z', prices: { inside: 799, oceanView: 899, balcony: 1099, suite: 1599 } },
    { at: '2026-06-02T00:00:00Z', prices: { inside: 999, oceanView: 999, balcony: 999, suite: 999 } },
  ]);

  assert.equal(history.length, 2);
});

test('uniform first history cleanup does not affect unrelated providers', () => {
  const history = sanitizePriceHistoryForProvider('royal-caribbean', [
    { at: '2026-06-01T00:00:00Z', prices: { inside: 999, oceanView: 999, balcony: 999, suite: 999 } },
  ]);

  assert.equal(history.length, 1);
});

test('Princess history drops the oldest partial all-cabin-equal entry', () => {
  const history = sanitizePriceHistoryForProvider('princess-cruises', [
    { at: '2026-05-30T00:00:00Z', prices: { inside: 811, balcony: 1330, suite: 1692 } },
    { at: '2026-05-29T09:33:00Z', prices: { inside: 811, balcony: 811, suite: 811 } },
  ]);

  assert.deepEqual(history, [
    { at: '2026-05-30T00:00:00Z', prices: { inside: 811, balcony: 1330, suite: 1692 } },
  ]);
});

test('Princess history drops repeated suspicious entries only while they are oldest', () => {
  const laterUniform = { at: '2026-06-02T00:00:00Z', prices: { inside: 900, balcony: 900, suite: 900 } };
  const history = sanitizePriceHistoryForProvider('princess-cruises', [
    laterUniform,
    { at: '2026-05-31T00:00:00Z', prices: { inside: 811, balcony: 1330, suite: 1692 } },
    { at: '2026-05-29T09:33:00Z', prices: { inside: 811, balcony: 811, suite: 811 } },
    { at: '2026-05-30T09:33:00Z', prices: { inside: 822, balcony: 822 } },
  ]);

  assert.deepEqual(history, [
    laterUniform,
    { at: '2026-05-31T00:00:00Z', prices: { inside: 811, balcony: 1330, suite: 1692 } },
  ]);
});

test('Princess history keeps a single populated cabin entry', () => {
  const entry = { at: '2026-05-29T09:33:00Z', prices: { inside: 811 } };
  assert.deepEqual(sanitizePriceHistoryForProvider('princess-cruises', [entry]), [entry]);
});

test('all providers drop legacy single-value entries wherever they appear', () => {
  const cabinEntry = { at: '2026-05-29T18:29:37.417Z', prices: { inside: 1072, balcony: 1800 } };
  for (const providerId of ['princess-cruises', 'ncl-cruises', 'royal-caribbean', 'celebrity-cruises']) {
    const history = sanitizePriceHistoryForProvider(providerId, [
      { at: '2026-05-29T09:33:04.484Z', price: 1072 },
      cabinEntry,
      { at: '2026-05-30T09:33:04.484Z', price: 1100 },
    ]);
    assert.deepEqual(history, [cabinEntry], providerId);
  }
});

test('merge does not create history from priceFrom without cabin prices', () => {
  const history = mergePriceHistory(
    'royal-caribbean',
    null,
    { prices: {}, priceFrom: '999' },
    '2026-06-01T00:00:00Z'
  );
  assert.deepEqual(history, []);
});

test('Princess merge does not store a first partial all-cabin-equal scrape', () => {
  const history = mergePriceHistory(
    'princess-cruises',
    null,
    {
      prices: { inside: '811', oceanView: null, balcony: '811', suite: '811' },
      priceFrom: '811',
    },
    '2026-05-29T09:33:00Z'
  );

  assert.deepEqual(history, []);
});

test('NCL merge does not store a first all-cabin-equal scrape', () => {
  const history = mergePriceHistory(
    'ncl-cruises',
    null,
    {
      prices: { inside: '999', oceanView: '999', balcony: '999', suite: '999' },
      priceFrom: '999',
    },
    '2026-06-01T00:00:00Z'
  );

  assert.deepEqual(history, []);
});

test('NCL history drops legacy entries before applying seeded-price cleanup', () => {
  const history = sanitizePriceHistoryForProvider('ncl-cruises', [
    { at: '2026-06-02T00:00:00Z', prices: { inside: 799, oceanView: 899, balcony: 1099, suite: 1599 } },
    { at: '2026-06-01T00:00:00Z', price: 999 },
  ]);

  assert.deepEqual(history, [
    { at: '2026-06-02T00:00:00Z', prices: { inside: 799, oceanView: 899, balcony: 1099, suite: 1599 } },
  ]);
});

test('NCL history drops repeated leading seeded entries', () => {
  const history = sanitizePriceHistoryForProvider('ncl-cruises', [
    { at: '2026-06-03T00:00:00Z', prices: { inside: 799, oceanView: 899, balcony: 1099, suite: 1599 } },
    { at: '2026-06-01T00:00:00Z', price: 999 },
    { at: '2026-06-02T00:00:00Z', prices: { inside: 888, oceanView: 888, balcony: 888, suite: 888 } },
  ]);

  assert.deepEqual(history, [
    { at: '2026-06-03T00:00:00Z', prices: { inside: 799, oceanView: 899, balcony: 1099, suite: 1599 } },
  ]);
});

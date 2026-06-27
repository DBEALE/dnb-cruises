'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  countCurrentPrices,
  fetchProviderSnapshot,
  mergePriceHistory,
  sanitizePriceHistoryForProvider,
} = require('../scripts/fetch-cruises');

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

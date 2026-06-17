'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  mergePriceHistory,
  sanitizePriceHistoryForProvider,
} = require('../scripts/fetch-cruises');

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

test('uniform first history cleanup is limited to NCL', () => {
  const history = sanitizePriceHistoryForProvider('royal-caribbean', [
    { at: '2026-06-01T00:00:00Z', prices: { inside: 999, oceanView: 999, balcony: 999, suite: 999 } },
  ]);

  assert.equal(history.length, 1);
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

test('NCL history drops the earliest legacy single-price entry', () => {
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

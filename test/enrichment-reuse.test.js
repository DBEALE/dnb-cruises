'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  enrichmentSignature,
  canReuseEnrichment,
  applyReusedEnrichment,
} = require('../providers/rci-room-selection');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-04T00:00:00Z');

function sailing(overrides = {}) {
  return {
    id: 'rc_123',
    shipName: 'Icon of the Seas',
    departureDate: '2026-09-01',
    duration: '7 Nights',
    departurePort: 'Miami, Florida',
    itinerary: 'Western Caribbean',
    ...overrides,
  };
}

function enriched(overrides = {}) {
  return sailing({
    itinerary: 'Western Caribbean: Miami, Cozumel, Miami',
    destinationPort: 'Cozumel',
    seaDays: 4,
    enrichedAt: new Date(NOW - DAY).toISOString(),
    ...overrides,
  });
}

test('enrichmentSignature matches on sailing identity, ignores enrichment/price fields', () => {
  const a = enriched();
  const b = sailing({ itinerary: 'different summary', priceFrom: '999' });
  assert.equal(enrichmentSignature(a), enrichmentSignature(b), 'same ship/date/duration/port → same signature');

  assert.notEqual(enrichmentSignature(a), enrichmentSignature(sailing({ departureDate: '2026-09-08' })));
  assert.notEqual(enrichmentSignature(a), enrichmentSignature(sailing({ duration: '10 Nights' })));
  assert.notEqual(enrichmentSignature(a), enrichmentSignature(sailing({ departurePort: 'Barcelona' })));
});

test('canReuseEnrichment reuses a fresh, unchanged sailing', () => {
  assert.equal(canReuseEnrichment(enriched(), sailing(), NOW), true);
});

test('canReuseEnrichment refuses when the prior was never successfully enriched', () => {
  const notEnriched = enriched({ enrichedAt: undefined });
  assert.equal(canReuseEnrichment(notEnriched, sailing(), NOW), false);
});

test('canReuseEnrichment refuses when the sailing identity changed', () => {
  const prior = enriched();
  const changed = sailing({ duration: '10 Nights' });
  assert.equal(canReuseEnrichment(prior, changed, NOW), false, 'route may differ → re-enrich');
});

test('canReuseEnrichment refuses once the enrichment is past its jittered TTL', () => {
  // 20 days is beyond the maximum reuse window (7-day min + up to 7-day jitter).
  const stale = enriched({ enrichedAt: new Date(NOW - 20 * DAY).toISOString() });
  assert.equal(canReuseEnrichment(stale, sailing(), NOW), false);

  // Under a week is always within the window regardless of jitter.
  const recent = enriched({ enrichedAt: new Date(NOW - 6 * DAY).toISOString() });
  assert.equal(canReuseEnrichment(recent, sailing(), NOW), true);
});

test('canReuseEnrichment refuses on a missing/unparseable enrichedAt', () => {
  assert.equal(canReuseEnrichment(enriched({ enrichedAt: 'not-a-date' }), sailing(), NOW), false);
  assert.equal(canReuseEnrichment(null, sailing(), NOW), false);
});

test('applyReusedEnrichment copies route fields but keeps the fresh price/date', () => {
  const prior = enriched({ destinationPort: 'Cozumel', seaDays: 4 });
  const fresh = sailing({ priceFrom: '849', prices: { inside: '849' }, departureDate: '2026-09-01' });

  const merged = applyReusedEnrichment(fresh, prior);
  // Route-derived detail comes from the prior run…
  assert.equal(merged.itinerary, 'Western Caribbean: Miami, Cozumel, Miami');
  assert.equal(merged.destinationPort, 'Cozumel');
  assert.equal(merged.seaDays, 4);
  assert.equal(merged.enrichedAt, prior.enrichedAt);
  // …but the freshly-scraped price is preserved (never frozen).
  assert.equal(merged.priceFrom, '849');
  assert.deepEqual(merged.prices, { inside: '849' });
});

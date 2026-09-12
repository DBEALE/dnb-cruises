'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { refreshNcl } = require('../providers/ncl-incremental');
const NOW = Date.parse('2026-09-12T12:00:00Z');
const old = code => ({ id: 'ncl_' + code, shipName: 'Test ship', departureDate: '2027-11-07',
  bookingUrl: 'https://www.ncl.com/uk/en/cruises/test?itineraryCode=' + code, prices: { inside: '100' }, lastSeenAt: '2026-09-01T12:00:00Z' });
const prior = new Map(['A', 'B', 'C'].map(code => [code, old(code)]));
const base = { now: NOW, priorCruises: prior, batchSize: 1, requestDelayMs: 0, delay: async () => {},
  normalize: (card, api) => [{ ...old(card.code), id: card.code + '_2027-11-07', prices: { inside: api.price } }],
  loadItinerary: async () => ({ price: '120' }) };

test('successes persist and the next run resumes the remaining queue while retaining older prices', async () => {
  let saved;
  const first = await refreshNcl({ ...base, save: s => { saved = JSON.parse(JSON.stringify(s)); } });
  assert.equal(first.cruises.length, 3);
  assert.equal(saved.status.freshItineraries, 1);
  assert.equal(saved.status.pendingItineraries, 2);
  assert.equal(first.cruises.find(c => c.id === 'ncl_B').priceCheckedAt, old('B').lastSeenAt);
  const requested = [];
  const next = await refreshNcl({ ...base, priorState: saved, now: NOW + 7200000,
    loadItinerary: async code => { requested.push(code); return { price: '125' }; } });
  assert.deepEqual(requested, ['B']);
  assert.equal(next.state.status.freshItineraries, 2);
  assert.equal(next.cruises.find(c => c.id.startsWith('A_')).prices.inside, '120');
});

test('403 stops the batch immediately and persists a cooldown across runs', async () => {
  let requests = 0;
  const loadItinerary = async () => { requests++; throw Object.assign(new Error('denied'), { status: 403 }); };
  const first = await refreshNcl({ ...base, batchSize: 3, loadItinerary });
  assert.equal(requests, 1);
  assert.equal(first.cruises.length, 3);
  assert.equal(first.state.status.lastError, 'NCL denied access');
  assert.equal(Date.parse(first.state.nextAttemptAt), NOW + 6 * 3600000);
  await refreshNcl({ ...base, now: NOW + 7200000, priorState: first.state, loadItinerary,
    discover: () => { throw new Error('must not discover during cooldown'); } });
  assert.equal(requests, 1);
});

test('429 respects Retry-After and a later run retries a different pending itinerary first', async () => {
  const first = await refreshNcl({ ...base, loadItinerary: async () => {
    throw Object.assign(new Error('rate limit'), { status: 429, retryAfterMs: 86400000 });
  } });
  assert.equal(Date.parse(first.state.nextAttemptAt), NOW + 86400000);
  const requested = [];
  await refreshNcl({ ...base, now: NOW + 86400001, priorState: first.state,
    loadItinerary: async code => { requested.push(code); return { price: '150' }; } });
  assert.deepEqual(requested, ['B']);
});

test('partial discovery is checkpointed without declaring full coverage', async () => {
  let saved;
  const result = await refreshNcl({ ...base, batchSize: 0,
    save: s => { saved = JSON.parse(JSON.stringify(s)); },
    discover: async checkpoint => {
      await checkpoint([{ code: 'D', bookingUrl: old('D').bookingUrl }], new Map([['D', { sailings: [{}], price: '160' }]]));
      throw new Error('pagination stopped');
    } });
  assert.equal(saved.status.knownItineraries, 4);
  assert.equal(saved.status.discoveryComplete, false);
  assert.equal(result.cruises.length, 4);
  assert.equal(saved.itineraries.D.cruises[0].prices.inside, '160');
});

test('fresh cached itineraries make no price request and successful empty results retire only that itinerary', async () => {
  const first = await refreshNcl({ ...base, batchSize: 3 });
  const next = await refreshNcl({ ...base, priorState: first.state, now: NOW + 3600000,
    loadItinerary: () => { throw new Error('must reuse fresh data'); } });
  assert.equal(next.state.lastError, '');
  const retired = await refreshNcl({ ...base, priorState: first.state, now: NOW + 3 * 86400000, normalize: () => [] });
  assert.equal(retired.cruises.length, 2);
  assert.equal(retired.state.itineraries.A.cruises.length, 0);
});

test('an unexpected crash after a checkpoint does not lose the completed itinerary', async () => {
  let saved;
  await assert.rejects(refreshNcl({ ...base, batchSize: 3, save: s => {
    saved = JSON.parse(JSON.stringify(s));
    throw new Error('simulated process interruption');
  } }), /interruption/);
  assert.equal(saved.itineraries.A.cruises[0].prices.inside, '120');
});

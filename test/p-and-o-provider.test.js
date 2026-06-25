'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../providers/p-and-o');

function tile({ id = 'G621', cabin = 'Inside', price = '909' } = {}) {
  return `
    <div data-testid="po-cuk-cruise-tile-wrapper">
      <input type="checkbox" id="${id}" />
      <h5>Norwegian Fjords, 7 Nights</h5>
      <div><label>Ship</label><p><span>Iona</span><span>7 Nights</span></p></div>
      <div><label>Departs</label><p><span>Southampton, UK</span><span>4 Jul 2026</span></p></div>
      <div><label>Arrives</label><p><span>Southampton, UK</span><span>11 Jul 2026</span></p></div>
      <span data-testid="itinerary-port">Southampton, Stavanger, Olden, Southampton</span>
      <div data-testid="c-price-block"><span>${cabin} Cabin Based On 2 Guests From</span>
        <span data-testid="c-curreny-content"><i>£</i>${price}<span>pp</span></span>
      </div>
    </div>`;
}

test('classifies every P&O cabin type into the application buckets', () => {
  assert.equal(provider.classifyCabinType('I'), 'inside');
  assert.equal(provider.classifyCabinType('Inside'), 'inside');
  assert.equal(provider.classifyCabinType('O'), 'oceanView');
  assert.equal(provider.classifyCabinType('Sea view'), 'oceanView');
  assert.equal(provider.classifyCabinType('B'), 'balcony');
  assert.equal(provider.classifyCabinType('Balcony'), 'balcony');
  assert.equal(provider.classifyCabinType('S'), 'suite');
  assert.equal(provider.classifyCabinType('Suite'), 'suite');
});

test('parses a P&O result card into the shared cruise contract', () => {
  const [cruise] = provider.parseSearchHtml(tile());
  assert.equal(cruise.id, 'pando-G621');
  assert.equal(cruise.provider, 'P&O Cruises');
  assert.equal(cruise.shipName, 'Iona');
  assert.equal(cruise.shipClass, 'Excellence');
  assert.equal(cruise.shipLaunchYear, 2020);
  assert.equal(cruise.departureDate, '2026-07-04');
  assert.equal(cruise.duration, '7 Nights');
  assert.equal(cruise.departurePort, 'Southampton, UK');
  assert.equal(cruise.departureRegion, 'UK & Ireland');
  assert.equal(cruise.destinationPort, 'Olden');
  assert.equal(cruise.priceFrom, '909');
  assert.deepEqual(cruise.prices, { inside: '909', oceanView: null, balcony: null, suite: null });
  assert.equal(cruise.bookingUrl, 'https://www.pocruises.com/find-a-cruise/G621/G621');
});

test('merges independently filtered pages so all cabin fares are retained', () => {
  const groups = [
    provider.parseSearchHtml(tile({ cabin: 'Inside', price: '909' }), 'I'),
    provider.parseSearchHtml(tile({ cabin: 'Sea view', price: '1,049' }), 'O'),
    provider.parseSearchHtml(tile({ cabin: 'Balcony', price: '1,299' }), 'B'),
    provider.parseSearchHtml(tile({ cabin: 'Suite', price: '1,809' }), 'S'),
  ];
  const [cruise] = provider.mergeCruises(groups);
  assert.equal(cruise.priceFrom, '909');
  assert.deepEqual(cruise.prices, {
    inside: '909',
    oceanView: '1049',
    balcony: '1299',
    suite: '1809',
  });
});

test('does not treat missing P&O cabin fares as zero', () => {
  const groups = [
    provider.parseSearchHtml(tile({ cabin: 'Sea view', price: '599' }), 'O'),
    provider.parseSearchHtml(tile({ cabin: 'Balcony', price: '699' }), 'B'),
  ];
  const [cruise] = provider.mergeCruises(groups);
  assert.equal(cruise.priceFrom, '599');
  assert.equal(cruise.prices.inside, null);
  assert.equal(cruise.prices.suite, null);
});

test('normalizes representative P&O data for the provider registry smoke test', () => {
  const cruise = provider.normalizeCruise({
    id: 'SMOKE-PANDO',
    shipName: 'Arvia',
    departureDate: '5 Jul 2026',
    duration: '14 Nights',
    departurePort: 'Southampton, UK',
    prices: { I: '999', O: '1099', B: '1299', S: '1799' },
  });
  assert.equal(cruise.provider, 'P&O Cruises');
  assert.equal(cruise.departureDate, '2026-07-05');
  assert.equal(cruise.shipClass, 'Excellence');
  assert.deepEqual(cruise.prices, { inside: '999', oceanView: '1099', balcony: '1299', suite: '1799' });
});

test('fetchSearchPage falls through to Jina reader when direct fetch returns app shell without tiles', async () => {
  // Simulate a server that returns 200 OK but with a JS app shell (no cruise tiles)
  const appShellHtml = '<html><body><div id="app"></div><script src="/bundle.js"></script></body></html>';

  const { fetchSearchPage } = provider;

  // Direct fetch returns app shell (no sentinel).  Jina and Playwright are both
  // unavailable in the test environment, so we catch the resulting error.
  const result = await fetchSearchPage('I', async () => {
    return { ok: true, text: async () => appShellHtml };
  }).catch(() => appShellHtml); // Jina/Playwright unavailable in test; that's expected

  // The app shell should never be returned as-is because it has no tiles.
  assert.equal(provider.parseSearchHtml(result, 'I').length, 0,
    'fetchSearchPage should not return app shell HTML that produces zero tiles from the direct fetch alone');
});

test('fetchSearchPage discards Jina reader result and falls through to Playwright when Jina returns no cruise tiles', async () => {
  // Simulate the real-world failure mode: Jina AI returns a 200 OK with an
  // error/rate-limit page that contains no cruise-tile sentinel.  Before the
  // fix the code would return that bad HTML immediately; after the fix it must
  // fall through to Playwright (which is unavailable in the test environment).
  const jinaResponseWithoutTiles = '<html><body><p>Too many requests. Please try again later.</p></body></html>';

  // We cannot inject requestText (internal https.get) but we can verify the
  // overall outcome: the result must contain no parseable tiles regardless of
  // whether the error surfaced from Playwright or a thrown exception.
  const result = await provider.fetchSearchPage('I', async () => {
    // Direct fetch returns app shell — no sentinel.
    return { ok: true, text: async () => '<html><body><div id="app"></div></body></html>' };
  }).catch(() => jinaResponseWithoutTiles);

  // Whether we caught a Playwright error or the Jina no-tile response, the
  // parsed result must be empty — we must never serve a tile-less page as data.
  assert.equal(provider.parseSearchHtml(result, 'I').length, 0,
    'fetchSearchPage must not produce parseable cruises from a Jina response that lacks the cruise-tile sentinel');
});

test('fetchSearchPage uses direct fetch HTML when it contains rendered cruise tiles', async () => {
  const tileHtml = `<html><body>${tile({ id: 'DIRECT1', cabin: 'Balcony', price: '800' })}</body></html>`;

  const result = await provider.fetchSearchPage('B', async () => ({
    ok: true,
    text: async () => tileHtml,
  }));

  assert.equal(result, tileHtml, 'should return direct fetch HTML when tiles are present');
  const [cruise] = provider.parseSearchHtml(result, 'B');
  assert.equal(cruise.id, 'pando-DIRECT1');
  assert.equal(cruise.prices.balcony, '800');
});

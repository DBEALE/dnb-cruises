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
  const tileHtml = tile({ id: 'X999', cabin: 'Inside', price: '500' });
  const rendered = `<html><body>${tileHtml}</body></html>`;

  let jinaCallCount = 0;
  const result = await provider.fetchSearchPage(
    'I',
    async () => ({ ok: true, text: async () => appShellHtml }),
    {
      platform: 'linux',
      requestText: async () => {
        jinaCallCount++;
        return rendered;
      },
      fetchWithPlaywright: async () => {
        throw new Error('Playwright fallback should not be needed');
      },
    },
  );

  assert.equal(jinaCallCount, 1);
  const [cruise] = provider.parseSearchHtml(result, 'I');
  assert.equal(cruise.id, 'pando-X999');
  assert.equal(cruise.prices.inside, '500');
});

test('fetchSearchPage on Windows validates Jina output before falling back to Playwright', async () => {
  const appShellHtml = '<html><body><div id="app"></div><script src="/bundle.js"></script></body></html>';
  const rendered = `<html><body>${tile({ id: 'PLAY1', cabin: 'Inside', price: '600' })}</body></html>`;

  let powershellReaderCalls = 0;
  let playwrightCalls = 0;
  const result = await provider.fetchSearchPage(
    'I',
    async () => ({ ok: true, text: async () => appShellHtml }),
    {
      platform: 'win32',
      requestTextViaPowerShell: async () => {
        powershellReaderCalls++;
        return appShellHtml;
      },
      fetchWithPlaywright: async () => {
        playwrightCalls++;
        return rendered;
      },
    },
  );

  assert.equal(powershellReaderCalls, 1);
  assert.equal(playwrightCalls, 1);
  const [cruise] = provider.parseSearchHtml(result, 'I');
  assert.equal(cruise.id, 'pando-PLAY1');
  assert.equal(cruise.prices.inside, '600');
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

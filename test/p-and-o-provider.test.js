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
  assert.equal(cruise.destinationPort, 'Southampton');
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

test('fetchSearchPage sends browser-compatible headers to P&O', async () => {
  const tileHtml = `<html><body>${tile({ id: 'HEADER1', cabin: 'Inside', price: '700' })}</body></html>`;
  let requestOptions = null;

  await provider.fetchSearchPage('I', async (_url, options) => {
    requestOptions = options;
    return {
      ok: true,
      text: async () => tileHtml,
    };
  });

  assert.equal(requestOptions.headers['user-agent'], provider.PANDO_BROWSER_HEADERS['user-agent']);
  assert.equal(requestOptions.headers['accept-language'], 'en-GB,en;q=0.9');
  assert.equal(requestOptions.headers['sec-fetch-mode'], 'navigate');
  assert.equal(requestOptions.headers['upgrade-insecure-requests'], '1');
});

test('fetchSearchPage skips the browser tier and fails fast when skipPlaywright is set', async () => {
  const appShellHtml = '<html><body><div id="app"></div></body></html>';
  const warnings = [];
  let playwrightCalls = 0;

  await assert.rejects(
    () => provider.fetchSearchPage('I', async () => ({ ok: true, text: async () => appShellHtml }), {
      platform: 'linux',
      skipPlaywright: true,
      logger: { warn: message => warnings.push(message) },
      requestText: async () => appShellHtml, // Jina also returns no tiles
      fetchWithPlaywright: async () => { playwrightCalls++; return ''; },
    }),
    /browser tier skipped \(PANDO_SKIP_PLAYWRIGHT\)/,
  );

  assert.equal(playwrightCalls, 0, 'browser tier must not be invoked when skipped');
  // Each fallen-through tier explains itself so CI logs pinpoint the failure.
  assert.ok(warnings.some(w => /direct fetch → JS app shell/.test(w)), 'logs the direct-fetch reason');
  assert.ok(warnings.some(w => /Jina reader → no tiles/.test(w)), 'logs the Jina reason');
});

test('fetchSearchPage logs the direct-fetch HTTP status before falling through', async () => {
  const warnings = [];
  const rendered = `<html><body>${tile({ id: 'JINA1', cabin: 'Inside', price: '450' })}</body></html>`;

  const result = await provider.fetchSearchPage('O', async () => ({ ok: false, status: 403, text: async () => '' }), {
    platform: 'linux',
    logger: { warn: message => warnings.push(message) },
    requestText: async () => rendered,
    fetchWithPlaywright: async () => { throw new Error('should not reach browser'); },
  });

  assert.ok(warnings.some(w => /direct fetch → HTTP 403/.test(w)), 'logs the HTTP status');
  const [cruise] = provider.parseSearchHtml(result, 'O');
  assert.equal(cruise.id, 'pando-JINA1');
});

test('fetchCruises keeps successful P&O cabin pages when another cabin page fails', async () => {
  const warnings = [];
  const cruises = await provider.fetchCruises({
    logger: { warn: message => warnings.push(message) },
    fetchSearchPage: async cabinCode => {
      if (cabinCode === 'I') return `<html><body>${tile({ id: 'PARTIAL1', cabin: 'Inside', price: '700' })}</body></html>`;
      if (cabinCode === 'B') return `<html><body>${tile({ id: 'PARTIAL1', cabin: 'Balcony', price: '1200' })}</body></html>`;
      throw new Error(`blocked ${cabinCode}`);
    },
  });

  assert.equal(cruises.length, 1);
  assert.equal(cruises[0].id, 'pando-PARTIAL1');
  assert.equal(cruises[0].priceFrom, '700');
  assert.deepEqual(cruises[0].prices, {
    inside: '700',
    oceanView: null,
    balcony: '1200',
    suite: null,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2 cabin page\(s\) failed/);
});

test('fetchCruises reports all P&O cabin failures before failing closed', async () => {
  const warnings = [];

  await assert.rejects(
    () => provider.fetchCruises({
      logger: { warn: message => warnings.push(message) },
      fetchSearchPage: async cabinCode => {
        throw new Error(`blocked ${cabinCode}`);
      },
    }),
    /P&O returned no parseable cruise results.*I: blocked I.*O: blocked O.*B: blocked B.*S: blocked S/,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /4 cabin page\(s\) failed/);
});

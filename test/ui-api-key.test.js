'use strict';

/**
 * UI tests for the Firecrawl API key flow.
 *
 * These tests execute the inline frontend script from public/index.html in a
 * sandboxed DOM-like environment. That lets us verify that the page persists
 * the entered key and forwards it to the backend as X-Firecrawl-API-Key.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readFrontendScript() {
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const match = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/i);

  if (!match) {
    throw new Error('Could not find the inline frontend script in public/index.html');
  }

  return match[1];
}

function createElement(initial = {}) {
  return {
    value: initial.value || '',
    textContent: initial.textContent || '',
    innerHTML: initial.innerHTML || '',
    disabled: Boolean(initial.disabled),
    className: initial.className || '',
    focused: false,
    classList: {
      add() {},
      remove() {},
    },
    focus() {
      this.focused = true;
    },
  };
}

function createSandbox({ apiKey = '', fileProtocol = false, cachedCruises = null } = {}) {
  const elements = {
    apiKeyInput: createElement({ value: apiKey }),
    fetchBtn: createElement(),
    searchInput: createElement({ disabled: true }),
    status: createElement({ textContent: 'Click "Fetch Cruises" to load live data.' }),
    summary: createElement(),
    cruiseBody: createElement(),
    buildInfo: createElement(),
  };

  const calls = [];
  const sandbox = {
    console,
    localStorage: {
      data: new Map(),
      getItem(key) {
        return this.data.has(key) ? this.data.get(key) : null;
      },
      setItem(key, value) {
        this.data.set(key, String(value));
      },
    },
    window: {
      location: fileProtocol
        ? { protocol: 'file:', origin: 'file://' }
        : { protocol: 'http:', origin: 'http://127.0.0.1:3000' },
    },
    document: {
      getElementById(id) {
        return elements[id];
      },
      querySelectorAll() {
        return [];
      },
    },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });

      if (String(url).includes('/build-info.json')) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        };
      }

      if (String(url).includes('/api/scrape')) {
        return {
          status: 404,
          ok: false,
          json: async () => ({})
        };
      }

      if (String(url).includes('/api/cruises')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            cruises: [
              {
                shipName: 'Quantum of the Seas',
                itinerary: 'Greek Isles',
                departureDate: '',
                duration: '7 Nights',
                departurePort: 'Athens',
                destination: 'Mediterranean',
                priceFrom: '999',
                currency: 'GBP',
                bookingUrl: '/cruises/quantum',
              },
            ],
            scrapedAt: '2026-04-27T00:00:00.000Z',
          }),
        };
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Promise,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    RegExp,
    Map,
    Error,
    URL,
  };

  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.calls = calls;
  sandbox.elements = elements;

  if (cachedCruises) {
    sandbox.localStorage.setItem('cached_cruises', JSON.stringify(cachedCruises));
  }

  vm.createContext(sandbox);
  vm.runInContext(readFrontendScript(), sandbox, { filename: 'public/index.html' });

  return { sandbox, elements, calls };
}

test('fetchCruises persists and forwards the entered API key', async () => {
  const { sandbox, elements, calls } = createSandbox({ apiKey: 'fc-test-key' });

  await sandbox.fetchCruises();

  const scrapeCall = calls.find((call) => String(call.url).includes('/api/scrape'));
  const cruisesCall = calls.find((call) => String(call.url).includes('/api/cruises'));

  assert.equal(sandbox.localStorage.getItem('firecrawl_api_key'), 'fc-test-key');
  assert.ok(scrapeCall, 'Expected the UI to trigger the scrape endpoint');
  assert.ok(cruisesCall, 'Expected the UI to poll or fetch cruise results');
  assert.ok(String(scrapeCall.url).includes('limit=500'));
  assert.ok(String(cruisesCall.url).includes('limit=500'));
  assert.equal(scrapeCall.options.method, 'POST');
  assert.equal(scrapeCall.options.headers['X-Firecrawl-API-Key'], 'fc-test-key');
  assert.equal(cruisesCall.options.headers['X-Firecrawl-API-Key'], 'fc-test-key');
  assert.equal(elements.searchInput.disabled, false);
  assert.equal(elements.status.textContent.startsWith('Loaded 1 cruise'), true);
});

test('getApiBaseUrl falls back to localhost for file:// previews', () => {
  const { sandbox } = createSandbox({ fileProtocol: true });

  assert.equal(sandbox.getApiBaseUrl(), 'http://localhost:3000');
});

test('cached cruises are rendered immediately on init', () => {
  const cached = {
    cruises: [
      {
        shipName: 'Wonder of the Seas',
        itinerary: 'Western Mediterranean',
        departureDate: '',
        duration: '7 Nights',
        departurePort: 'Barcelona',
        destination: 'Mediterranean',
        priceFrom: '1234',
        currency: 'GBP',
        bookingUrl: '/cruises/wonder',
      },
    ],
    scrapedAt: '2026-04-27T20:00:00.000Z',
  };

  const { sandbox, elements } = createSandbox({ cachedCruises: cached });

  assert.match(elements.status.textContent, /Loaded 1 cruise/);
  assert.match(elements.status.textContent, /cached/);
  assert.match(elements.summary.textContent, /Showing 1 result/);
  assert.match(elements.cruiseBody.innerHTML, /Wonder of the Seas/);
});
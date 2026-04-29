'use strict';

/**
 * UI tests for the provider manifest and static cruise loading flow.
 *
 * These tests execute the inline frontend script from public/index.html in a
 * sandboxed DOM-like environment. That lets us verify that the page loads the
 * provider manifest, fetches provider-scoped cruise JSON files, and persists
 * provider-specific cache entries.
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

test('ship, cruise line, and class filters are dropdowns and port is labeled departure port', () => {
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  assert.match(html, /<select class="col-filter" data-field="shipName" onchange="applyFilters\(\)">/);
  assert.match(html, /<select class="col-filter" data-field="provider" onchange="applyFilters\(\)">/);
  assert.match(html, /<select class="col-filter" data-field="shipClass" onchange="applyFilters\(\)">/);
  assert.match(html, /<select id="mobFilterShip" class="mob-filter" data-field="shipName" onchange="mobileFilterSync\(this\)">/);
  assert.match(html, /Departure port/);
});

function createElement(initial = {}) {
  return {
    value: initial.value || '',
    textContent: initial.textContent || '',
    innerHTML: initial.innerHTML || '',
    disabled: Boolean(initial.disabled),
    className: initial.className || '',
    placeholder: initial.placeholder || '',
    checked: Boolean(initial.checked),
    style: initial.style || {},
    focused: false,
    classList: {
      add() {},
      remove() {},
    },
    querySelector() {
      return { style: {} };
    },
    focus() {
      this.focused = true;
    },
  };
}

function buildCruise({ shipName, itinerary, departurePort, destination, priceFrom, currency, scrapedAt }) {
  return {
    provider: 'Royal Caribbean',
    shipName,
    itinerary,
    departureDate: '',
    duration: '7 Nights',
    departurePort,
    destination,
    priceFrom,
    currency,
    bookingUrl: `/cruises/${shipName.toLowerCase().replace(/\s+/g, '-')}`,
    scrapedAt,
  };
}

async function createSandbox({
  cachedCruises = null,
  providerCruises = [buildCruise({
    shipName: 'Harmony of the Seas',
    itinerary: 'Adriatic Escape',
    departurePort: 'Barcelona',
    destination: 'Mediterranean',
    priceFrom: '899',
    currency: 'GBP',
    scrapedAt: '2026-04-27T20:00:00.000Z',
  })],
} = {}) {
  const elements = {
    statusBar: createElement({ className: 'visible' }),
    statusText: createElement({ textContent: 'Loading cruise data…' }),
    summary: createElement(),
    rateNote: createElement(),
    totalCount: createElement(),
    totalShips: createElement(),
    updatedAt: createElement(),
    providerStats: createElement(),
    cruiseBody: createElement(),
    buildInfo: createElement(),
    gbpToggle: createElement({ checked: true }),
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
      location: { protocol: 'http:', origin: 'http://127.0.0.1:3000' },
    },
    document: {
      getElementById(id) {
        return elements[id];
      },
      querySelectorAll(selector) {
        if (selector === '.col-filter') return [];
        return [];
      },
      querySelector(selector) {
        if (selector === '[data-field="maxPrice"]') {
          return createElement({ placeholder: 'Max £…' });
        }
        return null;
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

      if (String(url).includes('/providers/index.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            defaultProviderId: 'royal-caribbean',
            providers: [
              {
                id: 'royal-caribbean',
                name: 'Royal Caribbean',
                cruisesUrl: './providers/royal-caribbean/cruises.json',
              },
            ],
          }),
        };
      }

      if (String(url).includes('/providers/royal-caribbean/cruises.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            cruises: providerCruises,
            scrapedAt: providerCruises[0]?.scrapedAt || '2026-04-27T20:00:00.000Z',
          }),
        };
      }

      if (String(url).includes('/api/cruises')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            cruises: [buildCruise({
              shipName: 'Quantum of the Seas',
              itinerary: 'Greek Isles',
              departurePort: 'Athens',
              destination: 'Mediterranean',
              priceFrom: '999',
              currency: 'GBP',
              scrapedAt: '2026-04-27T00:00:00.000Z',
            })],
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
  await new Promise((resolve) => setImmediate(resolve));

  return { sandbox, elements, calls };
}

test('loads the provider manifest and provider-specific cruise file on init', async () => {
  const { sandbox, elements, calls } = await createSandbox();

  const providerIndexCall = calls.find((call) => String(call.url).includes('/providers/index.json'));
  const providerCruisesCall = calls.find((call) => String(call.url).includes('/providers/royal-caribbean/cruises.json'));

  assert.ok(providerIndexCall, 'Expected the UI to load the provider manifest');
  assert.ok(providerCruisesCall, 'Expected the UI to load the provider-specific cruise file');
  assert.equal(providerIndexCall.options.cache, 'no-store');
  assert.equal(providerCruisesCall.options.cache, 'no-store');
  assert.equal(elements.statusBar.className, '');
  assert.match(elements.summary.textContent, /Showing all 1 sailings/);
  assert.match(elements.cruiseBody.innerHTML, /Harmony of the Seas/);
  assert.match(elements.cruiseBody.innerHTML, /data-label="Cruise line"/);
  assert.match(elements.cruiseBody.innerHTML, /data-label="Book"/);
  assert.match(elements.cruiseBody.innerHTML, /Royal Caribbean/);
  assert.match(elements.providerStats.innerHTML, /Royal Caribbean/);
  assert.match(elements.providerStats.innerHTML, /Updated:/);
  assert.ok(sandbox.localStorage.getItem('cached_cruises:royal-caribbean'));
  assert.ok(sandbox.localStorage.getItem('cached_cruises'));
});

test('cached cruises are rendered immediately on init', async () => {
  const cached = {
    cruises: [buildCruise({
      shipName: 'Wonder of the Seas',
      itinerary: 'Western Mediterranean',
      departurePort: 'Barcelona',
      destination: 'Mediterranean',
      priceFrom: '1234',
      currency: 'GBP',
      scrapedAt: '2026-04-27T20:00:00.000Z',
    })],
    scrapedAt: '2026-04-27T20:00:00.000Z',
  };

  const { elements } = await createSandbox({ cachedCruises: cached, providerCruises: cached.cruises });

  assert.match(elements.summary.textContent, /Showing all 1 sailings/);
  assert.match(elements.cruiseBody.innerHTML, /Wonder of the Seas/);
});

test('renders class score dots for Celebrity series ships', async () => {
  const { elements } = await createSandbox({
    providerCruises: [{
      ...buildCruise({
        shipName: 'Celebrity Apex',
        itinerary: 'Greek Isles',
        departurePort: 'Athens',
        destination: 'Europe',
        priceFrom: '1499',
        currency: 'GBP',
        scrapedAt: '2026-04-27T20:00:00.000Z',
      }),
      shipClass: 'Edge',
      shipLaunchYear: 2020,
    }],
  });

  assert.match(elements.cruiseBody.innerHTML, /Celebrity Apex/);
  assert.match(elements.cruiseBody.innerHTML, /title="Edge class — 4\/5"/);
});

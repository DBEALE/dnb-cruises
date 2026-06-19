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
  // app.js was previously inline in index.html; since the split it lives
  // alongside index.html in public/. Read it from there directly.
  const scriptPath = path.join(__dirname, '..', 'public', 'app.js');
  return fs.readFileSync(scriptPath, 'utf8');
}

test('ship, cruise line, and class filters are dropdowns and port is labeled departure port', () => {
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const app = readFrontendScript();
  const cssPath = path.join(__dirname, '..', 'public', 'styles.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  assert.match(html, /<select class="col-filter" data-field="shipName" onchange="scheduleApplyFilters\(\)">/);
  assert.match(html, /<select class="col-filter" data-field="provider" onchange="scheduleApplyFilters\(\)">/);
  assert.match(html, /<select class="col-filter" data-field="shipClass" onchange="scheduleApplyFilters\(\)">/);
  assert.match(html, /<select id="mobFilterShip" class="mob-filter" data-field="shipName" onchange="mobileFilterSync\(this\)">/);
  assert.match(html, /<select id="mobilePageSortSelect" onchange="mobilePageSortChange\(\)">/);
  assert.match(html, /id="mobilePageSortDirBtn"/);
  assert.match(html, /data-field="departureStart"/);
  assert.match(html, /data-field="departureEnd"/);
  assert.match(html, /data-field="seaDays"/);
  assert.match(html, /data-field="priceDropWindow"/);
  assert.match(html, /data-field="newWithin"/);
  assert.match(html, /<option value="20">24hr price reduction<\/option>/);
  assert.match(html, /id="mobFilterPriceDrop"/);
  assert.match(html, /id="mobFilterNewWithin"/);
  assert.match(html, /id="departureRangeDialog"/);
  assert.match(html, /Departure port/);
  assert.match(html, /Sea days/);
  assert.match(html, /id="mobClearFilters" onclick="clearMobileFilters\(\)"/);
  assert.match(html, /id="visitorStats"/);
  assert.match(html, /class="ph-table-wrap"/);
  const clearButtonCount = (html.match(/class="filter-clear-btn"/g) || []).length;
  assert.ok(clearButtonCount >= 22, `expected at least 22 filter clear buttons, found ${clearButtonCount}`);
  assert.match(html, /class="settings-scroll"/);
  assert.match(html, /What do the price stars mean\?/);
  assert.match(html, /50% or more below peak/);
  assert.match(html, /30–49% below peak/);
  assert.match(html, /15–29% below peak/);
  assert.match(html, /id="settingsHomePort"/);
  assert.match(html, /id="settingsHomePortStatus"/);
  assert.match(html, /class="changes-scroll"/);
  assert.match(html, /<h1 tabindex="0">/);
  assert.match(html, /class="wave wave-main"/);
  assert.match(html, /class="wave wave-front"/);
  assert.match(html, /class="wave wave-crest"/);
  assert.match(html, /class="wave wave-surge"/);
  assert.match(html, /class="wave-surge-wave"/);
  assert.match(app, /function itinerarySearchTerms\(query\)/);
  assert.match(app, /function highlightItinerary\(text, query\)/);
  assert.match(app, /function cabinBestPriceInfo\(c, bucket, currentRaw = null\)/);
  assert.match(app, /best-price-val/);
  assert.match(app, /function pricePeakDropInfo\(c, currentRaw, bucket = ''\)/);
  assert.doesNotMatch(app, /entry\.price(?!s)/);
  assert.match(app, /dropPct >= 50 \? 'gold'/);
  assert.match(app, /dropPct >= 30 \? 'silver'/);
  assert.match(app, /dropPct >= 15 \? 'outline'/);
  assert.match(app, /const HOME_PORT_KEY = 'cruise-explorer-home-port'/);
  assert.match(app, /function rememberedHomePort\(\)/);
  assert.match(app, /className: 'home-port-highlight'/);
  assert.match(app, /function inferSeaDays\(c\)/);
  assert.match(app, /function getRecentPriceReductionPct\(c, windowMs, now = Date\.now\(\)\)/);
  assert.match(app, /function isFirstSeenWithin\(c, windowMs, now = Date\.now\(\)\)/);
  assert.match(app, /class="ph-price-line"/);
  assert.match(app, /function wireHeaderWavePress\(\)/);
  assert.match(app, /triggerHeaderWavePress\(\)/);
  assert.match(app, /class="first-seen-val"/);
  assert.match(app, /function launchYearBadge\(year, extraClass = ''\)/);
  assert.match(app, /return 'newest'/);
  assert.match(app, /if \(age < 5\) return 'newest'/);
  assert.match(app, /function scheduleApplyFilters\(\{ delay = 0 \} = \{\}\)/);
  assert.match(app, /const FILTER_DEBOUNCE_MS = 320/);
  assert.match(app, /const LAUNCH_YEAR_DEBOUNCE_MS = 650/);
  assert.match(app, /function debouncedLaunchYearFilters\(\)/);
  assert.match(app, /function clearFilterField\(field\)/);
  assert.match(app, /const VISITOR_COUNT_URL = 'https:\/\/yttgqscwgmsnewdjqbcc\.supabase\.co\/functions\/v1\/visitor-count'/);
  assert.match(app, /async function recordVisitorCount\(\)/);
  assert.match(app, /async function clearMobileFilters\(\)/);
  assert.match(app, /btn\.textContent = 'Clearing\.\.\.'/);
  assert.match(css, /#mobClearFilters\.is-busy::before/);
  assert.match(css, /\.ph-table-wrap \{[^}]*overflow-y: auto/);
  assert.match(css, /\.ph-table-wrap \{[^}]*overflow-x: hidden/);
  assert.match(css, /dialog#mobFilters \{[^}]*100dvh - 72px/s);
  assert.match(css, /\.mob-filters-head \{[^}]*position: sticky/s);
  assert.match(css, /dialog#priceHistoryDialog \{[^}]*100dvh - 24px/s);
  assert.match(css, /dialog#priceHistoryDialog \{[^}]*100dvh - 16px/s);
  assert.match(css, /\.ph-table th \{[^}]*position: sticky/);
  assert.match(css, /\.ph-price-line \{[^}]*grid-template-columns: minmax\(0, max-content\) 0\.65em/);
  assert.match(css, /\.settings-box\s+\{[^}]*overflow: hidden/);
  assert.match(css, /\.settings-scroll \{[^}]*overflow: auto/);
  assert.match(css, /\.changes-box \{[^}]*overflow: hidden/);
  assert.match(css, /\.changes-scroll \{[^}]*overflow: auto/);
  assert.match(css, /\.mob-sort-row \{[^}]*padding: 7px 12px/);
  assert.match(css, /\.filter-entry \{/);
  assert.match(css, /\.filter-clear-btn \{/);
  assert.match(css, /\.first-seen-val \{[^}]*font-size: 0\.8rem/);
  assert.match(css, /\.price-val\.best-price-val \{/);
  assert.match(css, /\.price-amount \{[^}]*position: relative/s);
  assert.match(css, /\.peak-drop-star-slot \{[^}]*position: absolute/s);
  assert.match(css, /\.peak-drop-star-slot \{[^}]*transform: translate\(52%, -52%\)/s);
  assert.match(css, /\.peak-drop-star-slot\.tier-gold/);
  assert.match(css, /\.peak-drop-star-slot\.tier-silver/);
  assert.match(css, /\.peak-drop-star-slot\.tier-outline/);
  assert.match(css, /\.price-star-legend-icon/);
  assert.match(css, /\.home-port-highlight \{/);
  assert.match(css, /\.itinerary-highlight \{/);
  assert.match(css, /\.launch-year-badge \{/);
  assert.match(css, /\.launch-year-badge\.newness-legacy/);
  assert.match(css, /\.launch-year-badge\.newness-newest/);
  assert.match(css, /\.launch-year-badge\.newness-newest \.launch-year-star/);
  assert.match(css, /\.class-dots\.unknown span/);
  assert.match(css, /\.header-wave \.wave-main/);
  assert.match(css, /\.header-wave \.wave-front/);
  assert.match(css, /\.header-wave \.wave-crest/);
  assert.match(css, /\.header-wave \.wave-surge/);
  assert.match(css, /\.header-wave\.is-sweeping \.wave-surge/);
  assert.match(css, /@keyframes wave-surge-sweep/);
  assert.match(css, /animation: wave-drift 32s linear infinite/);
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
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains: () => false,
    },
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    querySelector() {
      return { style: {} };
    },
    querySelectorAll() { return []; },
    focus() {
      this.focused = true;
    },
  };
}

function buildCruise({ shipName, itinerary, departurePort, destination, destinationPort = '', priceFrom, currency, scrapedAt, seaDays = null }) {
  return {
    provider: 'Royal Caribbean',
    shipName,
    itinerary,
    departureDate: '',
    duration: '7 Nights',
    departurePort,
    destination,
    ...(destinationPort ? { destinationPort } : {}),
    priceFrom,
    currency,
    seaDays,
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
    destinationPort: 'Venice',
    priceFrom: '899',
    currency: 'GBP',
    seaDays: 3,
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
    totalProviders: createElement(),
    updatedAt: createElement(),
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
      location: { protocol: 'http:', origin: 'http://127.0.0.1:3000', pathname: '/', search: '', hash: '' },
    },
    history: { replaceState() {}, pushState() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    document: {
      // <body> stub — the settings loader toggles classes on it.
      body: {
        className: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      },
      addEventListener() {},
      removeEventListener() {},
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
    URLSearchParams,
    performance: { now: () => Date.now() },
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
  // Summary line is set via innerHTML (it includes an inline "Show all" button).
  assert.match(elements.summary.innerHTML, /Showing all 1 sailings/);
  assert.match(elements.cruiseBody.innerHTML, /Harmony of the Seas/);
  assert.match(elements.cruiseBody.innerHTML, /data-label="Cruise line"/);
  assert.match(elements.cruiseBody.innerHTML, /data-label="Sea days"/);
  assert.match(elements.cruiseBody.innerHTML, /data-label="Destination port"/);
  assert.match(elements.cruiseBody.innerHTML, /launch-share-wrap/);
  assert.match(elements.cruiseBody.innerHTML, /cruise-share-btn/);
  assert.doesNotMatch(elements.cruiseBody.innerHTML, /class="col-book"|>Book</);
  assert.match(elements.cruiseBody.innerHTML, /Royal Caribbean/);
  assert.match(elements.cruiseBody.innerHTML, /<td class="col-destination-port" data-label="Destination port">Venice<\/td>/);
  assert.match(elements.cruiseBody.innerHTML, /<td class="col-sea-days duration" data-label="Sea days">3<\/td>/);
  assert.equal(elements.totalProviders.textContent, '1');
  assert.match(elements.updatedAt.textContent, /27 Apr 2026/);
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

  assert.match(elements.summary.innerHTML, /Showing all 1 sailings/);
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
  assert.match(elements.cruiseBody.innerHTML, /title="Edge class — Modern flagship \(4\/5\)"/);
});

test('renders class dots even for unmapped classes', async () => {
  const { elements } = await createSandbox({
    providerCruises: [{
      ...buildCruise({
        shipName: 'Mystery of the Seas',
        itinerary: 'Atlantic Crossing',
        departurePort: 'Miami',
        destination: 'Transatlantic',
        priceFrom: '899',
        currency: 'GBP',
        scrapedAt: '2026-04-27T20:00:00.000Z',
      }),
      shipClass: 'Unknown Class',
    }],
  });

  assert.match(elements.cruiseBody.innerHTML, /Mystery of the Seas/);
  assert.match(elements.cruiseBody.innerHTML, /class="class-dots unknown"/);
  assert.match(elements.cruiseBody.innerHTML, /Class score unavailable/);
});

test('class dot lookup covers all mapped ship classes', async () => {
  const { sandbox } = await createSandbox();

  assert.match(sandbox.classDots('Royal'), /title="Royal class — Modern flagship \(4\/5\)"/);
  assert.match(sandbox.classDots('Grand'), /title="Grand class — Recent generation \(3\/5\)"/);
  assert.match(sandbox.classDots('Coral'), /title="Coral class — Older generation \(2\/5\)"/);
});

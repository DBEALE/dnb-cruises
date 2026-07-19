'use strict';

/**
 * P&O Cruises provider.
 *
 * P&O's find-a-cruise page is a client-rendered SPA, so scraping the rendered
 * HTML (previously via the Jina reader) only ever captured the first page of
 * results (~24 of 900+). This provider instead calls the same JSON search API
 * the SPA uses — `cruise-query-processor/cruisesearch` — paginating through the
 * whole catalogue. It needs brand/locale/currency request headers and paginates
 * with a `start` offset (fixed page size of 10).
 *
 * pocruises.com started rejecting plain HTTP requests outright (403, on every
 * path including the plain homepage) rather than just this provider's calls,
 * consistent with a bot-management WAF that fingerprints the TLS/HTTP client
 * rather than something request-shape-specific. So all requests now go through
 * a real browser session (see fetchCruisesViaBrowser): page.goto() once to
 * pick up whatever cookies/challenge the WAF requires, then every API call
 * runs as page.evaluate(() => fetch(...)) so it shares that session and
 * carries a genuine browser fingerprint. Several launch flavours are tried in
 * turn (BROWSER_LAUNCH_CONFIGS) because the WAF has been seen resetting the
 * Playwright headless-shell build's HTTP/2 connection outright. The pure
 * fetchImpl-based implementation (fetchCruisesWithFetchImpl) is unchanged and
 * still what the test suite exercises directly.
 */

const { chromium } = require('@playwright/test');

const {
  cleanText,
  fetchWithTimeout,
  getDepartureRegion,
  DEFAULT_USER_AGENT,
} = require('./shared');

const CRUISE_SEARCH_URL = 'https://www.pocruises.com/cruise-query-processor/cruisesearch';
const BOOKING_BASE_URL  = 'https://www.pocruises.com/find-a-cruise';

// The search API rejects requests without these (verified by probing the
// endpoint: 400 "Missing brand, locale or currencycode request headers").
const API_HEADERS = Object.freeze({
  'user-agent': DEFAULT_USER_AGENT,
  accept: 'application/json',
  'accept-language': 'en-GB,en;q=0.9',
  brand: 'po',
  locale: 'en_GB',
  currencycode: 'GBP',
  currency: 'GBP',
});

const PAGE_SIZE        = 10;    // the API's fixed page size (no size param honoured)
const PAGE_CONCURRENCY = 6;
const MAX_PAGES        = 300;   // safety cap (~3000 cruises) against a bad total

// The base search returns only each sailing's cheapest cabin. Filtering by
// roomType surfaces that specific cabin's fare, so we run one pass per cabin
// type and merge the prices. Their union covers the whole catalogue (every
// sailing has at least one of these).
const ROOM_TYPES    = ['I', 'O', 'B', 'S'];
const PRICE_BUCKETS = ['inside', 'oceanView', 'balcony', 'suite'];

const SHIPS = {
  Arcadia:   { shipClass: 'Vista',      shipLaunchYear: 2005 },
  Arvia:     { shipClass: 'Excellence', shipLaunchYear: 2022 },
  Aurora:    { shipClass: 'R',          shipLaunchYear: 2000 },
  Azura:     { shipClass: 'Grand',      shipLaunchYear: 2010 },
  Britannia: { shipClass: 'Royal',      shipLaunchYear: 2015 },
  Iona:      { shipClass: 'Excellence', shipLaunchYear: 2020 },
  Ventura:   { shipClass: 'Grand',      shipLaunchYear: 2008 },
};

// The API omits `shipName` on ~half the records but always sends `shipId`, so
// resolve the name from the id (with shipName as a fallback for any new ship).
const SHIP_IDS = {
  AC: 'Arcadia',
  AR: 'Arvia',
  AU: 'Aurora',
  AZ: 'Azura',
  BR: 'Britannia',
  IA: 'Iona',
  VE: 'Ventura',
};

function resolveShipName(raw) {
  const byId = SHIP_IDS[cleanText(raw?.shipId).toUpperCase()];
  if (byId) return byId;
  const explicit = cleanText(raw?.shipName);
  return explicit && explicit.toLowerCase() !== 'undefined' ? explicit : '';
}

// Embark/disembark port codes P&O actually uses (from aggregating the whole
// catalogue), mapped to display names. Unknown codes fall back to the raw code.
const PORT_NAMES = {
  SOU: 'Southampton',
  TCI: 'Santa Cruz de Tenerife',
  MLA: 'Valletta, Malta',
  BGI: 'Bridgetown, Barbados',
  ANU: "St John's, Antigua",
  SKB: 'Basseterre, St Kitts',
  SYD: 'Sydney, Australia',
  SFO: 'San Francisco',
  BNE: 'Brisbane, Australia',
  HKG: 'Hong Kong',
  SIN: 'Singapore',
  CPT: 'Cape Town, South Africa',
  AKL: 'Auckland, New Zealand',
};

function portName(code) {
  const c = cleanText(code).toUpperCase();
  return c ? (PORT_NAMES[c] || c) : '';
}

function emptyPrices() {
  return { inside: null, oceanView: null, balcony: null, suite: null };
}

// Room-type id from the API (I/O/B/S) → our standard cabin buckets.
function classifyCabinType(roomTypeId) {
  const id = cleanText(roomTypeId).toLowerCase();
  if (id === 'i' || /\binside\b/.test(id)) return 'inside';
  if (id === 'o' || /ocean|sea|outside/.test(id)) return 'oceanView';
  if (id === 'b' || /\bbalcony\b/.test(id)) return 'balcony';
  if (id === 's' || /suite/.test(id)) return 'suite';
  return null;
}

function parsePrice(value) {
  const n = Number.parseFloat(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : null;
}

function toIsoDate(value) {
  const s = cleanText(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

// Sea days = the "ATSEADAY" pseudo-ports the API lists in the itinerary.
function countSeaDays(portOfCallIds) {
  if (!Array.isArray(portOfCallIds)) return null;
  const seaDays = portOfCallIds.filter(p => /atseaday/i.test(cleanText(p))).length;
  return seaDays > 0 ? seaDays : null;
}

// Resolve a port code to a display name: the fetched port map first (full,
// ~1455 ports), then the small hardcoded fallback, then the raw code.
function resolvePort(code, portMap) {
  const c = cleanText(code).toUpperCase();
  if (!c) return '';
  return (portMap && portMap[c]) || PORT_NAMES[c] || c;
}

// Build the itinerary as an arrow-joined port sequence (sea days dropped,
// consecutive duplicates collapsed). Falls back to the cruise name when no
// ports resolve (e.g. the port map couldn't be fetched).
function buildItinerary(name, portOfCallIds, portMap) {
  const ports = (Array.isArray(portOfCallIds) ? portOfCallIds : [])
    .map((code) => {
      const c = cleanText(code).toUpperCase();
      if (!c || /ATSEADAY/i.test(c)) return '';
      return (portMap && portMap[c]) || PORT_NAMES[c] || '';
    })
    .filter(Boolean);
  const sequence = ports.filter((port, i) => i === 0 || port !== ports[i - 1]);
  return sequence.length ? sequence.join(' → ') : cleanText(name);
}

// The port code → name map lives in the find-a-cruise page's __NEXT_DATA__
// (search results only carry codes). Without it, itineraries can only resolve
// the handful of hardcoded PORT_NAMES codes and collapse to a single port, so a
// blip here is treated as fatal by the caller (fetchCruises) rather than
// silently deploying degraded itineraries.
const PORT_MAP_ATTEMPTS   = 3;
const PORT_MAP_RETRY_MS   = 1500;
// A healthy fetch yields ~1400+ ports; a failed/blocked one yields 0. This floor
// never trips on a good parse but catches an empty or partial one.
const MIN_PORT_MAP_SIZE   = 100;

async function fetchPortMapOnce(fetchImpl) {
  const res = await fetchImpl(`${BOOKING_BASE_URL}?web2=true`, {
    headers: { 'user-agent': DEFAULT_USER_AGENT, 'accept-language': 'en-GB,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const match = html.match(/"portOfCalls":\{"items":(\[[^\]]*\])/);
  if (!match) throw new Error('portOfCalls items not found in page');
  const map = {};
  for (const item of JSON.parse(match[1])) {
    const code = cleanText(item?.id).toUpperCase();
    // Some source names have a stray space before the comma ("Chania) , Crete").
    const name = cleanText(item?.txName).replace(/\s+,/g, ',');
    if (code && name) map[code] = name;
  }
  if (!Object.keys(map).length) throw new Error('parsed an empty port map');
  return map;
}

// Fetches the port map, retrying transient failures. Returns {} only when every
// attempt fails; the caller decides whether an empty map is fatal.
async function fetchPortMap(fetchImpl = fetchWithTimeout, options = {}) {
  const attempts     = options.attempts ?? PORT_MAP_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? PORT_MAP_RETRY_MS;
  const logger       = options.logger;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchPortMapOnce(fetchImpl);
    } catch (err) {
      if (logger?.warn) logger.warn(`  [P&O] port map attempt ${attempt}/${attempts} failed: ${err.message}`);
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
  return {};
}

/**
 * Maps one `searchResults` entry from the cruise-query-processor API to the
 * shared cruise contract. `cabins[0]` is the cheapest available cabin (the
 * lead-in fare); we populate that bucket and use it as `priceFrom`.
 */
function normalizeApiCruise(raw, portMap = {}) {
  const cruiseId = cleanText(raw?.cruiseId || raw?.itineraryId);
  if (!cruiseId) return null;

  const shipName = resolveShipName(raw);
  const meta     = SHIPS[shipName] || {};
  const nights   = Number.parseInt(raw?.duration, 10);
  const departurePort   = resolvePort(raw?.embarkPortCode, portMap);
  const destinationPort = resolvePort(raw?.disembarkPortCode, portMap);

  const prices   = emptyPrices();
  const cheapest = Array.isArray(raw?.cabins) ? raw.cabins[0] : null;
  const bucket   = cheapest ? classifyCabinType(cheapest.roomTypeId) : null;
  const lead     = cheapest ? parsePrice(cheapest.lowerPrice) : null;
  if (bucket && lead) prices[bucket] = lead;
  const priceFrom = lead || parsePrice(raw?.avgPerPersonPrice) || '';

  const destination = cleanText(Array.isArray(raw?.destinationIds) ? raw.destinationIds[0] : raw?.destinationIds) || 'Cruise';
  const name        = cleanText(raw?.name);

  return {
    id: `pando-${cruiseId}`,
    provider: 'P&O Cruises',
    shipName,
    shipClass: meta.shipClass || '',
    shipLaunchYear: meta.shipLaunchYear || null,
    itinerary: buildItinerary(name || destination, raw?.portOfCallIds, portMap),
    departureDate: toIsoDate(raw?.departDate),
    duration: Number.isFinite(nights) ? `${nights} Nights` : '',
    departurePort,
    departureRegion: getDepartureRegion(departurePort),
    destination,
    destinationPort,
    seaDays: countSeaDays(raw?.portOfCallIds),
    priceFrom,
    currency: 'GBP',
    prices,
    bookingUrl: `${BOOKING_BASE_URL}/${encodeURIComponent(cruiseId)}/${encodeURIComponent(cruiseId)}`,
    arrivalDate: toIsoDate(raw?.arrivalAtArrivalPort),
  };
}

async function fetchSearchPage(start, fetchImpl = fetchWithTimeout, roomType = '') {
  const rt = roomType ? `&roomTypes=${encodeURIComponent(roomType)}` : '';
  const res = await fetchImpl(`${CRUISE_SEARCH_URL}?start=${start}${rt}`, { headers: API_HEADERS });
  if (!res.ok) throw new Error(`P&O search HTTP ${res.status} at start=${start}${roomType ? ` (${roomType})` : ''}`);
  const data = await res.json();
  return {
    total: Number(data?.results),
    results: Array.isArray(data?.searchResults) ? data.searchResults : [],
  };
}

// Paginate one cabin-type pass fully. A failed page is logged and skipped so a
// single blip doesn't lose the whole pass.
async function fetchRoomTypePages(roomType, fetchImpl, logger) {
  const first = await fetchSearchPage(0, fetchImpl, roomType);
  const total = Number.isFinite(first.total) && first.total > 0 ? first.total : first.results.length;
  const starts = [];
  for (let start = PAGE_SIZE; start < total && starts.length < MAX_PAGES; start += PAGE_SIZE) starts.push(start);
  const pages = await mapWithConcurrency(starts, PAGE_CONCURRENCY, async (start) => {
    try {
      return (await fetchSearchPage(start, fetchImpl, roomType)).results;
    } catch (err) {
      if (logger?.warn) logger.warn(`  [P&O] ${roomType} page start=${start} failed: ${err.message}`);
      return [];
    }
  });
  return [first.results, ...pages].flat();
}

// Small bounded-concurrency map (kept local so this provider stays self-contained).
async function mapWithConcurrency(items, concurrency, mapper) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

// Public entrypoint. Tests always pass an explicit fetchImpl (so they never
// touch a real browser); the orchestrator's production calls don't, and get
// routed through a real Chromium session — see the file-level comment above.
async function fetchCruises(options = {}) {
  if (!options.fetchImpl) return fetchCruisesViaBrowser(options);
  return fetchCruisesWithFetchImpl(options);
}

async function fetchCruisesWithFetchImpl(options = {}) {
  const fetchImpl = options.fetchImpl;
  const logger    = options.logger || console;

  // Port code → name map (for itineraries), fetched once. options.portMap lets
  // tests inject one, bypassing all of the below. In production, a self-fetched
  // map that comes back (near-)empty falls back to the last known-good map
  // (options.priorPortMap, supplied by the orchestrator from a persisted sidecar
  // file) rather than immediately aborting — pocruises.com has started blocking
  // this page outright for stretches of time, and reusing a slightly stale map
  // beats freezing the whole provider indefinitely. Only when neither the fresh
  // fetch nor the prior map are usable do we throw, so the orchestrator keeps
  // the last good cruises.json instead of overwriting it with degraded
  // single-port itineraries.
  const injectedPortMap = options.portMap != null;
  let portMap;
  if (injectedPortMap) {
    portMap = options.portMap;
  } else {
    const freshPortMap = await fetchPortMap(fetchImpl, { logger, ...options.portMapOptions });
    if (Object.keys(freshPortMap).length >= MIN_PORT_MAP_SIZE) {
      portMap = freshPortMap;
    } else {
      const priorPortMap = options.priorPortMap && typeof options.priorPortMap === 'object' ? options.priorPortMap : {};
      if (Object.keys(priorPortMap).length >= MIN_PORT_MAP_SIZE) {
        logger?.warn?.(
          `  [P&O] port map unavailable (${Object.keys(freshPortMap).length} ports) — reusing last known-good map (${Object.keys(priorPortMap).length} ports)`,
        );
        portMap = priorPortMap;
      } else {
        throw new Error(
          `P&O port map unavailable (${Object.keys(freshPortMap).length} ports) and no usable prior map — skipping to preserve existing itineraries`,
        );
      }
    }
    if (typeof options.onPortMap === 'function') options.onPortMap(portMap);
  }

  // One pass per cabin type, merging each sailing's per-cabin fares by id.
  const byId = new Map();
  for (const roomType of ROOM_TYPES) {
    const rows = await fetchRoomTypePages(roomType, fetchImpl, logger);
    for (const raw of rows) {
      const cruise = normalizeApiCruise(raw, portMap);
      if (!cruise) continue;
      const existing = byId.get(cruise.id);
      if (!existing) {
        byId.set(cruise.id, cruise);
        continue;
      }
      for (const bucket of PRICE_BUCKETS) {
        if (existing.prices[bucket] == null && cruise.prices[bucket] != null) {
          existing.prices[bucket] = cruise.prices[bucket];
        }
      }
    }
  }

  const cruises = [...byId.values()];
  // priceFrom = the cheapest populated cabin across all passes.
  for (const cruise of cruises) {
    const fares = PRICE_BUCKETS.map(b => Number(cruise.prices[b])).filter(n => Number.isFinite(n) && n > 0);
    if (fares.length) cruise.priceFrom = String(Math.min(...fares));
  }

  if (!cruises.length) throw new Error('P&O returned no cruise results');
  console.log(`  [P&O] ${cruises.length} cruises with per-cabin prices (${ROOM_TYPES.join('/')} passes)`);
  return cruises;
}

// ── Browser session (WAF evasion) ─────────────────────────────────────────────
//
// What gets blocked, in order of what we've observed:
//   • Node fetch (from every network tried): instant 403 on every path.
//   • Playwright's chromium_headless_shell build from CI (2026-07-19 run):
//     HTTP/2 connection reset during page.goto (net::ERR_HTTP2_PROTOCOL_ERROR)
//     — the classic bot-manager response to a recognised headless TLS/HTTP2
//     fingerprint, served before any page content.
// So no single launch flavour is trustworthy. Each config below changes the
// network-stack fingerprint in a different way; the cascade walks the list
// until a session both loads the page and gets JSON out of the search API.
const BROWSER_LAUNCH_CONFIGS = [
  // GitHub-hosted runners preinstall Google Chrome: a genuine Chrome binary in
  // (new) headless mode, whose TLS/HTTP2 stack matches real browser traffic
  // most closely. Falls through cleanly where Chrome isn't installed.
  { label: 'system Chrome', channel: 'chrome' },
  // Playwright's full Chromium build in new-headless mode — the real binary,
  // not the stripped headless shell that got its connection reset.
  { label: 'Chromium new-headless', channel: 'chromium' },
  // Last resort: the default headless shell forced onto HTTP/1.1, sidestepping
  // HTTP/2-frame fingerprinting entirely.
  { label: 'headless shell HTTP/1.1', extraArgs: ['--disable-http2'] },
];

// Post-goto pause: the WAF's sensor script needs a beat to run and set its
// session cookies before in-page API calls will be trusted.
const SESSION_SETTLE_MS = 3000;

// Headless Chrome advertises "HeadlessChrome/<version>" in its UA — an instant
// bot flag — so every context gets an explicit UA. It's built from the running
// binary's own major version (hardcoding one that drifts behind the binary is
// itself a detectable mismatch) on the Linux platform CI actually runs, in
// Chrome's reduced-UA format (real Chrome sends exactly "<major>.0.0.0").
function chromeUserAgent(browserVersion) {
  const major = String(browserVersion || '').split('.')[0] || '131';
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// Wraps a Playwright `page` as a fetchImpl: every request runs as
// page.evaluate(() => fetch(...)) so it executes inside the browser's own JS
// engine — sharing whatever cookies/session the initial page.goto() picked up
// and carrying a genuine Chromium network fingerprint, unlike a raw Node
// fetch() from this process. Returns a Response-like object (ok/status/
// text()/json()) so it's a drop-in for fetchPortMapOnce and fetchSearchPage.
function createBrowserFetch(page) {
  return async function browserFetch(url, opts = {}) {
    // Drop any user-agent override: browsers honour it on fetch() (UA is no
    // longer a forbidden header), and a request UA disagreeing with the page's
    // own session UA is exactly the inconsistency a bot-manager looks for.
    const headers = { ...(opts.headers || {}) };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'user-agent') delete headers[key];
    }
    const result = await page.evaluate(async ({ url, headers }) => {
      try {
        const res = await fetch(url, { headers });
        return { ok: res.ok, status: res.status, statusText: res.statusText, body: await res.text() };
      } catch (err) {
        return { ok: false, status: 0, statusText: String(err?.message || err), body: '' };
      }
    }, { url: String(url), headers });
    return {
      ok: result.ok,
      status: result.status,
      statusText: result.statusText,
      text: async () => result.body,
      json: async () => JSON.parse(result.body),
    };
  };
}

// Launches one config and proves the session actually works before committing
// to it: the find-a-cruise page must load without a WAF reset or 4xx, AND the
// search API must answer an in-page probe (a challenge page can come back as a
// clean 200, so a loaded page alone proves nothing). Throws — after closing
// the browser — to move the cascade on to the next config.
async function openVerifiedSession(launchImpl, config) {
  const browser = await launchImpl({
    headless: true,
    channel: config.channel,
    args: ['--disable-blink-features=AutomationControlled', ...(config.extraArgs || [])],
  });
  try {
    const page = await browser.newPage({
      userAgent: chromeUserAgent(browser.version()),
      viewport: { width: 1440, height: 900 },
      locale: 'en-GB',
      timezoneId: 'Europe/London',
    });
    const response = await page.goto(`${BOOKING_BASE_URL}?web2=true`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (response && response.status() >= 400) throw new Error(`find-a-cruise HTTP ${response.status()}`);
    await page.waitForTimeout(SESSION_SETTLE_MS);
    const fetchImpl = createBrowserFetch(page);
    const probe = await fetchImpl(`${CRUISE_SEARCH_URL}?start=0`, { headers: API_HEADERS });
    if (!probe.ok) throw new Error(`search API probe HTTP ${probe.status}`);
    return { browser, fetchImpl };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

// Production entrypoint: walks BROWSER_LAUNCH_CONFIGS until one yields a
// verified session, then delegates to the exact same fetchCruisesWithFetchImpl
// logic the test suite exercises — just swapping Node's fetch for one routed
// through the browser. options.launchImpl lets tests inject a fake launcher.
async function fetchCruisesViaBrowser(options = {}) {
  const logger = options.logger || console;
  const launchImpl = options.launchImpl || (launchOptions => chromium.launch(launchOptions));
  const failures = [];
  for (const config of BROWSER_LAUNCH_CONFIGS) {
    let session;
    try {
      session = await openVerifiedSession(launchImpl, config);
    } catch (err) {
      const reason = String(err?.message || err).split('\n')[0];
      failures.push(`${config.label}: ${reason}`);
      logger?.warn?.(`  [P&O] ${config.label} blocked/unavailable: ${reason}`);
      continue;
    }
    logger?.log?.(`  [P&O] session established via ${config.label}`);
    try {
      return await fetchCruisesWithFetchImpl({ ...options, fetchImpl: session.fetchImpl });
    } finally {
      await session.browser.close().catch(() => {});
    }
  }
  throw new Error(`P&O blocked across all browser configs (${failures.join('; ')})`);
}

const provider = {
  id: 'p-and-o',
  name: 'P&O Cruises',
  fetchCruises,
  // Launches its own headless Chromium (see fetchCruisesViaBrowser), so the
  // orchestrator serialises it with the other browser providers rather than
  // running it in the concurrent network-only lane.
  usesBrowser: true,
  // Accept both raw API results and already-normalized cruises (idempotent).
  normalizeCruise(raw) {
    if (raw?.id && raw?.provider === provider.name) return raw;
    return normalizeApiCruise(raw);
  },
};

module.exports = provider;
module.exports.normalizeApiCruise = normalizeApiCruise;
module.exports.fetchSearchPage = fetchSearchPage;
module.exports.classifyCabinType = classifyCabinType;
module.exports.resolveShipName = resolveShipName;
module.exports.buildItinerary = buildItinerary;
module.exports.fetchPortMap = fetchPortMap;
module.exports.portName = portName;
module.exports.countSeaDays = countSeaDays;
module.exports.emptyPrices = emptyPrices;
module.exports.PORT_NAMES = PORT_NAMES;
module.exports.createBrowserFetch = createBrowserFetch;
module.exports.chromeUserAgent = chromeUserAgent;

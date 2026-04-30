'use strict';

const { chromium } = require('@playwright/test');

const { getDepartureRegion } = require('./shared');

const PRINCESS_SEARCH_URL     = 'https://www.princess.com/cruise-search/results/?resType=C';
const PRINCESS_BASE_URL       = 'https://www.princess.com';
const PRINCESS_API_HOST       = 'gw.api.princess.com';
const PRINCESS_API_BASE       = 'https://gw.api.princess.com/pcl-web/internal/resdb/p1.0';
/** Maximum milliseconds to wait for page API calls after domcontentloaded. */
const PRINCESS_PAGE_WAIT_MS   = 25000;
/** Milliseconds to wait after the first API response to allow subsequent calls to settle. */
const PRINCESS_SETTLE_WAIT_MS = 4000;

// ─── Destination / trade code mapping ─────────────────────────────────────────
const TRADE_DESTINATION = {
  A: 'Alaska',
  B: 'Bermuda',
  C: 'Caribbean',
  D: 'Canada & New England',
  E: 'Europe',
  F: 'Transatlantic',
  G: 'Galapagos',
  H: 'Hawaii',
  I: 'Asia',
  J: 'Japan',
  K: 'South America',
  L: 'South America',
  M: 'Mexico',
  N: 'Northern Europe',
  O: 'Other',
  P: 'South Pacific',
  Q: 'World Cruise',
  R: 'Repositioning',
  S: 'Southeast Asia',
  T: 'South Pacific',
  U: 'Middle East',
  V: 'Sea of Cortez',
  W: 'Western Caribbean',
  X: 'Eastern Caribbean',
  Z: 'Australia & New Zealand',
};

// ─── Ship data ─────────────────────────────────────────────────────────────────
const SHIP_CLASS = {
  'Caribbean Princess':  'Grand',
  'Coral Princess':      'Coral',
  'Crown Princess':      'Grand',
  'Diamond Princess':    'Grand',
  'Discovery Princess':  'Royal',
  'Emerald Princess':    'Grand',
  'Enchanted Princess':  'Royal',
  'Grand Princess':      'Grand',
  'Island Princess':     'Coral',
  'Majestic Princess':   'Royal',
  'Pacific Princess':    'R',
  'Regal Princess':      'Royal',
  'Royal Princess':      'Royal',
  'Ruby Princess':       'Grand',
  'Sapphire Princess':   'Grand',
  'Sky Princess':        'Royal',
  'Star Princess':       'Grand',
  'Sun Princess':        'Royal',
};

const SHIP_LAUNCH_YEAR = {
  'Caribbean Princess':  2004,
  'Coral Princess':      2002,
  'Crown Princess':      2006,
  'Diamond Princess':    2004,
  'Discovery Princess':  2022,
  'Emerald Princess':    2007,
  'Enchanted Princess':  2020,
  'Grand Princess':      1998,
  'Island Princess':     2003,
  'Majestic Princess':   2017,
  'Pacific Princess':    1999,
  'Regal Princess':      2014,
  'Royal Princess':      2013,
  'Ruby Princess':       2008,
  'Sapphire Princess':   2004,
  'Sky Princess':        2019,
  'Star Princess':       2002,
  'Sun Princess':        2024,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Converts a Princess API date string (YYYYMMDD) to ISO-8601 (YYYY-MM-DD).
 *
 * @param {string} dateStr - Eight-digit date string, e.g. "20261014".
 * @returns {string} ISO date string or empty string when input is invalid.
 */
function formatSailDate(dateStr) {
  const s = String(dateStr || '');
  if (s.length !== 8) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * Returns the primary destination name from a product's trade-code array.
 *
 * @param {Array<{id: string}>} trades - Trade objects from the Princess products API.
 * @returns {string} Human-readable destination name.
 */
function getDestination(trades) {
  const id = trades?.[0]?.id || '';
  return TRADE_DESTINATION[id] || TRADE_DESTINATION[id.toUpperCase()] || 'Cruise';
}

/**
 * Builds a Princess Cruises booking URL for a specific voyage.
 *
 * @param {string} productId - Princess product/itinerary code (e.g. "ECI12A").
 * @param {string} shipId    - Princess ship code (e.g. "YP").
 * @param {string} sailDate  - Eight-digit sail date string (e.g. "20261014").
 * @returns {string} Absolute booking URL.
 */
function buildBookingUrl(productId, shipId, sailDate) {
  if (!productId || !shipId || !sailDate) return PRINCESS_SEARCH_URL;
  const year = String(sailDate).slice(0, 4);
  return `${PRINCESS_BASE_URL}/en-us/itinerary/${productId}/${shipId}/${year}/`;
}

/**
 * Normalizes a Princess Cruises product + sailing into a standard cruise object.
 *
 * @param {object} product  - Product entry from the Princess products API.
 * @param {string} sailDate - Eight-digit sail date string.
 * @param {string} shipId   - Princess ship code.
 * @param {string} shipName - Human-readable ship name.
 * @param {string} portName - Human-readable embarkation port name.
 * @returns {object} Normalized cruise object.
 */
function normalizeCruise(product, sailDate, shipId, shipName, portName) {
  const productId    = cleanText(product.id);
  const name         = cleanText(shipName);
  const destination  = getDestination(product.trades);
  const nights       = product.cruiseDuration ? String(product.cruiseDuration) : '';
  const itinerary    = nights ? `${nights}-Night ${destination}` : destination;

  return {
    provider:        'Princess Cruises',
    id:              `princess_${productId}_${shipId}_${sailDate}`,
    shipName:        name,
    shipClass:       SHIP_CLASS[name] || '',
    shipLaunchYear:  SHIP_LAUNCH_YEAR[name] || null,
    itinerary,
    departureDate:   formatSailDate(sailDate),
    duration:        nights ? `${nights} Nights` : '',
    departurePort:   cleanText(portName),
    departureRegion: getDepartureRegion(portName),
    destination,
    priceFrom:       '',
    currency:        'GBP',
    bookingUrl:      buildBookingUrl(productId, shipId, sailDate),
  };
}

// ─── Data collection ───────────────────────────────────────────────────────────

/**
 * Launches a headless browser, loads the Princess Cruises search-results page,
 * intercepts JSON responses from the internal API, and returns the captured data.
 *
 * The page automatically triggers calls to gw.api.princess.com while loading.
 * If products are not auto-fetched we use the captured auth credentials to
 * call the products, ships, and ports endpoints ourselves from within the
 * page context (so CORS / auth tokens are handled transparently).
 *
 * @returns {Promise<{products?: object, ships?: object, ports?: object}>}
 */
async function collectCruiseData() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage({
    viewport:  { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const apiData  = {};
  let   appId    = null;
  let   clientId = null;
  let   firstApiResponseAt = 0;

  /** Returns true only when the URL hostname exactly matches the Princess API host. */
  function isPrincessApiUrl(rawUrl) {
    try { return new URL(rawUrl).hostname === PRINCESS_API_HOST; }
    catch { return false; }
  }

  // Capture auth credentials from outgoing requests
  page.on('request', req => {
    if (!isPrincessApiUrl(req.url())) return;
    const h = req.headers();
    if (h.appid && !appId)               appId    = h.appid;
    if (h['pcl-client-id'] && !clientId) clientId = h['pcl-client-id'];
  });

  // Capture JSON responses from the internal API
  page.on('response', async res => {
    if (!isPrincessApiUrl(res.url())) return;
    if (res.status() !== 200) return;
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try {
      const body     = await res.json();
      const pathname = new URL(res.url()).pathname;
      const key      = pathname.split('/').pop().split('?')[0];
      if (!apiData[key]) {
        apiData[key] = body;
        if (!firstApiResponseAt) firstApiResponseAt = Date.now();
      }
    } catch { /* ignore parse errors */ }
  });

  try {
    await page.goto(PRINCESS_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait until the first Princess API response has been received, then give
    // additional time for ships/ports responses to arrive.  Fall back to the
    // maximum timeout when the API is not reached at all.
    const deadline = Date.now() + PRINCESS_PAGE_WAIT_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      if (firstApiResponseAt && Date.now() - firstApiResponseAt >= PRINCESS_SETTLE_WAIT_MS) break;
    }

    // If some endpoints weren't auto-fetched but we captured credentials, request them
    const needed = ['products', 'ships', 'ports'].filter(k => !apiData[k]);
    if (needed.length > 0 && appId && clientId) {
      const fetched = await page.evaluate(
        async ({ base, appId, clientId, needed }) => {
          const results = {};
          await Promise.all(needed.map(async endpoint => {
            const url = endpoint === 'products'
              ? `${base}/${endpoint}?agencyCountry=GB&cruiseType=C&voyageStatus=A&webDisplayOnly=true`
              : `${base}/${endpoint}`;
            try {
              const res = await fetch(url, {
                headers: {
                  appid: appId,
                  'pcl-client-id': clientId,
                  Accept: 'application/json',
                },
              });
              if (res.ok) results[endpoint] = await res.json();
            } catch { /* ignore */ }
          }));
          return results;
        },
        { base: PRINCESS_API_BASE, appId, clientId, needed },
      );
      Object.assign(apiData, fetched);
    }

    return apiData;
  } finally {
    await browser.close();
  }
}

// ─── Provider class ────────────────────────────────────────────────────────────

class PrincessCruisesProvider {
  constructor() {
    this.name = 'Princess Cruises';
    this.id   = 'princess-cruises';
  }

  /** @returns {Promise<object[]>} Array of normalized cruise objects. */
  async fetchCruises() {
    const data     = await collectCruiseData();
    const products = data.products?.products || [];

    if (!products.length) {
      console.log('  [Princess] No products data captured — check page/API access');
      return [];
    }

    // Build id→name lookup maps
    const shipMap = new Map();
    for (const s of data.ships?.ships || []) shipMap.set(s.id, s.name);

    const portMap = new Map();
    for (const p of data.ports?.ports || []) portMap.set(p.id, p.name);

    const cruises = [];
    const seen    = new Set();

    for (const product of products) {
      if (!product.id || !product.ships?.length) continue;

      const embarkPortId = product.embkDbkPortIds?.[0];
      const portName     = portMap.get(embarkPortId) || cleanText(embarkPortId);

      for (const ship of product.ships) {
        const shipId   = ship.id;
        const shipName = shipMap.get(shipId) || cleanText(shipId);

        for (const sailDate of ship.sailDates || []) {
          const key = `${product.id}_${shipId}_${sailDate}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const cruise = normalizeCruise(product, sailDate, shipId, shipName, portName);
          if (cruise?.id && cruise.shipName) cruises.push(cruise);
        }
      }
    }

    console.log(`  [Princess] ${cruises.length} sailings from ${products.length} products`);
    return cruises;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

const provider = new PrincessCruisesProvider();

module.exports               = provider;
module.exports.normalizeCruise = normalizeCruise;
module.exports.buildBookingUrl = buildBookingUrl;
module.exports.formatSailDate  = formatSailDate;
module.exports.getDestination  = getDestination;

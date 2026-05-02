'use strict';

const { chromium } = require('@playwright/test');

const { getDepartureRegion } = require('./shared');

const PRINCESS_SEARCH_URL     = 'https://www.princess.com/cruise-search/results/?resType=C';
const PRINCESS_BASE_URL       = 'https://www.princess.com';
const PRINCESS_API_HOST       = 'gw.api.princess.com';
const PRINCESS_API_BASE       = 'https://gw.api.princess.com/pcl-web/internal/resdb/p1.0';
const PRINCESS_PRICING_URL    = 'https://gw.api.princess.com/pcl-web/internal/caps/pc/pricing/v1/cruises';
/** Maximum milliseconds to wait for page API calls after domcontentloaded. */
const PRINCESS_PAGE_WAIT_MS   = 25000;
/** Milliseconds to wait after the first API response to allow subsequent calls to settle. */
const PRINCESS_SETTLE_WAIT_MS = 4000;
/** Voyage IDs per pricing POST request. */
const PRINCESS_PRICING_BATCH  = 200;

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
 * @param {string} voyageId  - Princess voyage code (e.g. "A643").
 * @returns {string} Absolute booking URL.
 */
function buildBookingUrl(voyageId) {
  const code = cleanText(voyageId);
  if (!code) return PRINCESS_SEARCH_URL;
  return `${PRINCESS_BASE_URL}/itinerary-details/?voyageCode=${encodeURIComponent(code)}`;
}

/**
 * Builds a human-readable itinerary string.
 *
 * When `portNames` contains at least one entry the itinerary is expressed as
 * the ordered port list (e.g. "Southampton → Lisbon → Gibraltar → Barcelona").
 * Otherwise it falls back to the generic "{N}-Night {Destination}" format so
 * that existing snapshots continue to render something meaningful before the
 * next data refresh.
 *
 * @param {string[]} portNames   - Ordered list of port names for the itinerary.
 * @param {string}   nights      - Cruise duration in nights (as a string).
 * @param {string}   destination - Human-readable destination name.
 * @returns {string} Itinerary string.
 */
function buildItinerary(portNames, nights, destination) {
  if (portNames && portNames.length > 0) return portNames.join(' → ');
  return nights ? `${nights}-Night ${destination}` : destination;
}

/**
 * Extracts the lowest per-person fare from a ship entry returned by the
 * Princess products API.  Multiple field-name patterns are tried in priority
 * order so that the extraction continues to work even if the API response
 * structure changes slightly between versions.
 *
 * @param {object} ship - Ship entry nested inside a product's `ships` array.
 * @returns {{amount: string, currency: string} | null}
 */
function getLowestFare(ship) {
  const candidates = [
    ship?.lowestPrice,
    ship?.startingFrom,
    ship?.lowestFare,
    ship?.fare,
    ship?.price,
  ];

  for (const c of candidates) {
    if (c == null) continue;

    // Scalar number or numeric string
    if (typeof c === 'number' || (typeof c === 'string' && c !== '')) {
      const n = parseFloat(c);
      if (Number.isFinite(n) && n > 0) {
        const currency = cleanText(ship?.lowestPriceCurrency ?? '') || 'GBP';
        return { amount: String(Math.round(n)), currency };
      }
    }

    // Object with an amount-like field
    if (typeof c === 'object') {
      const amountField = c.amount ?? c.fare ?? c.value ?? c.price;
      const currencyField = cleanText(c.currencyCode ?? c.currency ?? c.code ?? '');
      const n = parseFloat(amountField);
      if (Number.isFinite(n) && n > 0) {
        return { amount: String(Math.round(n)), currency: currencyField || 'GBP' };
      }
    }
  }

  return null;
}

/**
 * Extracts the lowest total per-person fare (including taxes/fees) from the
 * Princess pricing payload.
 *
 * Priority order:
 *   1. pricing.tfpe.totalPerPerson / totalFare / total (total fare including taxes)
 *   2. pricing.totalFare / totalAmount / grossFare (top-level total fare fields)
 *   3. pricing.tfpe.lowerBth (base cruise fare — excludes port taxes/fees, last resort)
 *   4. Minimum guest fare found in pricing.fares[].categories[].guests[].totalFare
 *      falling back to .fare if totalFare is absent
 *
 * NOTE: tfpe.lowerBth is the BASE cruise fare only and will be significantly
 * lower than the price displayed on the Princess website (which includes port
 * taxes and government fees).  Always prefer a "total" or "gross" field when
 * one is present.
 *
 * @param {object} pricing - Pricing object from caps/pc/pricing/v1/cruises.
 * @returns {{amount: string, currency: string} | null}
 */
function extractPricingFare(pricing) {
  if (!pricing || typeof pricing !== 'object') return null;

  const currency = cleanText(
    pricing.fareCurrency ?? pricing.currencyCode ?? pricing.currency ?? '',
  ) || 'GBP';

  // 1. Total per-person fare inside tfpe (includes taxes)
  const tfpe = pricing.tfpe;
  for (const key of ['totalPerPerson', 'totalFare', 'total', 'grossFare', 'farePlusTax']) {
    const n = parseFloat(tfpe?.[key]);
    if (Number.isFinite(n) && n > 0) return { amount: String(Math.round(n)), currency };
  }

  // 2. Top-level total fare fields
  for (const key of ['totalFare', 'totalAmount', 'grossFare', 'farePlusTax', 'totalPerPerson']) {
    const n = parseFloat(pricing[key]);
    if (Number.isFinite(n) && n > 0) return { amount: String(Math.round(n)), currency };
  }

  // 3. Minimum per-person fare for double-occupancy guests (id 1 or 2) across
  //    all fare categories.  Guests 3+ are discounted extra-berth rates and
  //    must not be included — they are far below the per-person price shown on
  //    the Princess website.
  let lowest = Infinity;
  for (const fare of pricing.fares || []) {
    for (const category of fare.categories || []) {
      for (const guest of category.guests || []) {
        if (guest?.id !== 1 && guest?.id !== 2) continue;
        const n = parseFloat(guest?.totalFare ?? guest?.fare);
        if (Number.isFinite(n) && n > 0 && n < lowest) lowest = n;
      }
    }
  }
  if (Number.isFinite(lowest) && lowest !== Infinity) {
    return { amount: String(Math.round(lowest)), currency };
  }

  // 4. Last resort: base fare only (no port taxes)
  const leadIn = parseFloat(tfpe?.lowerBth);
  if (Number.isFinite(leadIn) && leadIn > 0) {
    return { amount: String(Math.round(leadIn)), currency };
  }

  return null;
}

/**
 * Normalizes a Princess Cruises product + sailing into a standard cruise object.
 *
 * @param {object}   product     - Product entry from the Princess products API.
 * @param {string}   sailDate    - Eight-digit sail date string.
 * @param {string}   shipId      - Princess ship code.
 * @param {string}   shipName    - Human-readable ship name.
 * @param {string}   portName    - Human-readable embarkation port name.
 * @param {string[]} [portNames=[]] - Ordered list of resolved port names for the full itinerary.
 * @param {object}   [ship={}]   - Raw ship entry from the products API (used for price extraction).
 * @param {string}   [voyageId]  - Princess voyage code used for booking link generation.
 * @returns {object} Normalized cruise object.
 */
function normalizeCruise(product, sailDate, shipId, shipName, portName, portNames = [], ship = {}, voyageId = '') {
  const productId    = cleanText(product.id);
  const name         = cleanText(shipName);
  const destination  = getDestination(product.trades);
  const nights       = product.cruiseDuration ? String(product.cruiseDuration) : '';
  const itinerary    = buildItinerary(portNames, nights, destination);

  const fare     = getLowestFare(ship);
  const priceFrom = fare ? fare.amount : '';
  const currency  = fare ? fare.currency : 'GBP';

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
    priceFrom,
    currency,
    bookingUrl:      buildBookingUrl(voyageId),
    prices:          { inside: null, oceanView: null, balcony: null, suite: null },
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
 * Any additional endpoints auto-fetched by the page (e.g. a pricing endpoint)
 * are also captured and returned under their endpoint name as the map key.
 *
 * @returns {Promise<{products?: object, ships?: object, ports?: object, [key: string]: object}>}
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
  let   firstApiResponseAt   = 0;
  let   pricingRequestBody   = null;
  let   pricingHeaders       = null;

  /** Returns true only when the URL hostname exactly matches the Princess API host. */
  function isPrincessApiUrl(rawUrl) {
    try { return new URL(rawUrl).hostname === PRINCESS_API_HOST; }
    catch { return false; }
  }

  // Capture auth credentials and the full pricing request (headers + body) as
  // a reusable template for batch fetches.
  page.on('request', req => {
    if (!isPrincessApiUrl(req.url())) return;
    const h = req.headers();
    if (h.appid && !appId)               appId    = h.appid;
    if (h['pcl-client-id'] && !clientId) clientId = h['pcl-client-id'];
    if (req.url().includes('/caps/pc/pricing/v1/cruises') && !pricingRequestBody) {
      const raw = req.postData();
      if (raw) {
        try {
          pricingRequestBody = JSON.parse(raw);
          // Capture only the API-specific headers needed to replay the request
          const keep = ['appid', 'pcl-client-id', 'bookingcompany', 'productcompany', 'reqsrc',
                        'content-type', 'accept', 'authorization'];
          pricingHeaders = Object.fromEntries(
            Object.entries(h).filter(([k]) => keep.includes(k.toLowerCase())),
          );
        } catch { /* ignore */ }
      }
    }
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

    // Log captured endpoints so we can diagnose missing data in CI
    console.log(`  [Princess] captured API keys: ${Object.keys(apiData).join(', ') || '(none)'}`);

    // If some endpoints weren't auto-fetched but we captured credentials, request them.
    // Only 'products', 'ships', and 'ports' are fetched manually because their URL
    // structure is known.  A separate 'prices' endpoint will only be used if the page
    // auto-fetches it (captured above via the response listener).
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

    // Batch-fetch pricing for all voyages using the captured POST body as a
    // template.  Replaces filters.cruises with the full voyage-ID list so we
    // cover the ~60% of sailings the page auto-fetch misses.
    if (pricingRequestBody && pricingHeaders && apiData.products) {
      const allVoyageIds = [];
      for (const product of apiData.products?.products || []) {
        for (const sailing of product.cruises || []) {
          if (sailing.id) allVoyageIds.push(sailing.id);
        }
      }

      const alreadyFetched = new Set();
      for (const pp of apiData.cruises?.products || []) {
        for (const vc of pp.cruises || []) { if (vc.id) alreadyFetched.add(vc.id); }
      }
      const missing = allVoyageIds.filter(id => !alreadyFetched.has(id));
      console.log(`  [Princess] batch-fetching pricing for ${missing.length} missing voyage(s) in batches of ${PRINCESS_PRICING_BATCH}`);

      const extraProducts = [];
      for (let i = 0; i < missing.length; i += PRINCESS_PRICING_BATCH) {
        const batch = missing.slice(i, i + PRINCESS_PRICING_BATCH);
        const body  = {
          ...pricingRequestBody,
          filters: { ...pricingRequestBody.filters, cruises: batch },
        };
        const result = await page.evaluate(
          async ({ url, headers, body }) => {
            try {
              const res = await fetch(url, {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify(body),
              });
              return res.ok ? await res.json() : null;
            } catch { return null; }
          },
          { url: PRINCESS_PRICING_URL, headers: pricingHeaders, body },
        );
        if (result?.products) extraProducts.push(...result.products);
      }

      if (extraProducts.length > 0) {
        // Merge extra products into the existing cruises data
        const existing = apiData.cruises?.products || [];
        apiData.cruises = { ...apiData.cruises, products: [...existing, ...extraProducts] };
        const totalPriced = (apiData.cruises?.products || []).reduce((n, p) => n + (p.cruises?.length || 0), 0);
        console.log(`  [Princess] after batch-fetch: ${totalPriced} voyage pricing records`);
      } else {
        console.log('  [Princess] batch-fetch returned no additional pricing data');
      }
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

    // Build voyage-id → price lookup from the pricing endpoint (loaded on demand
    // by the page — may only cover a subset of all voyages).
    const priceMap = new Map();
    for (const pp of data.cruises?.products || []) {
      for (const vc of pp.cruises || []) {
        const parsed = extractPricingFare(vc.pricing);
        if (parsed) priceMap.set(vc.id, parsed);
      }
    }
    console.log(`  [Princess] priceMap populated: ${priceMap.size} voyage(s) with price from pricing endpoint`);

    const cruises = [];
    const seen    = new Set();

    for (const product of products) {
      // New API: sailings are in product.cruises[].voyage (old API used product.ships[])
      if (!product.id || !product.cruises?.length) continue;

      for (const sailing of product.cruises) {
        const voyage = sailing.voyage;
        if (!voyage) continue;

        const shipId   = voyage.ship?.id;
        const shipName = shipMap.get(shipId) || cleanText(shipId);
        const sailDate = voyage.sailDate;

        const key = `${product.id}_${shipId}_${sailDate}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const portName  = portMap.get(voyage.startPortId) || cleanText(voyage.startPortId);
        const portNames = (Array.isArray(voyage.ports) ? voyage.ports : [])
          .map(id => portMap.get(id) || cleanText(id))
          .filter(Boolean);

        // Synthesize a product-like object compatible with normalizeCruise.
        // duration moved from product.cruiseDuration to voyage.duration in new API.
        const productProxy = { ...product, cruiseDuration: voyage.duration };

        // Synthesize a ship-like object with pricing if available.
        // Primary: pricing endpoint (partial coverage, ~40% of sailings).
        // Fallback: pricing embedded in the sailing or voyage objects returned
        // by the products API (potentially full coverage).
        const pricingEntry = priceMap.get(sailing.id);
        let shipProxy = {};
        if (pricingEntry) {
          shipProxy = { lowestPrice: parseFloat(pricingEntry.amount), lowestPriceCurrency: pricingEntry.currency };
        } else {
          // Try fields that Princess products API may embed directly on the
          // sailing or voyage objects (e.g. startingFrom, lowestPrice, fare).
          const embeddedFare = getLowestFare(sailing) || getLowestFare(voyage);
          if (embeddedFare) {
            shipProxy = { lowestPrice: parseFloat(embeddedFare.amount), lowestPriceCurrency: embeddedFare.currency };
          }
        }

        const cruise = normalizeCruise(productProxy, sailDate, shipId, shipName, portName, portNames, shipProxy, sailing.id);
        if (cruise?.id && cruise.shipName && cruise.priceFrom !== '') cruises.push(cruise);
      }
    }

    console.log(`  [Princess] ${cruises.length} priced sailings from ${products.length} products`);
    return cruises;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

const provider = new PrincessCruisesProvider();

module.exports               = provider;
module.exports.normalizeCruise = normalizeCruise;
module.exports.buildBookingUrl = buildBookingUrl;
module.exports.buildItinerary  = buildItinerary;
module.exports.formatSailDate  = formatSailDate;
module.exports.getDestination  = getDestination;
module.exports.getLowestFare   = getLowestFare;
module.exports.extractPricingFare = extractPricingFare;

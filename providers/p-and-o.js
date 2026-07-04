'use strict';

/**
 * P&O Cruises provider.
 *
 * P&O's find-a-cruise page is a client-rendered SPA, so scraping the rendered
 * HTML (previously via the Jina reader) only ever captured the first page of
 * results (~24 of 900+). This provider instead calls the same JSON search API
 * the SPA uses — `cruise-query-processor/cruisesearch` — paginating through the
 * whole catalogue. It needs brand/locale/currency request headers and paginates
 * with a `start` offset (fixed page size of 10). No browser required.
 */

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

const SHIPS = {
  Arcadia:   { shipClass: 'Vista',      shipLaunchYear: 2005 },
  Arvia:     { shipClass: 'Excellence', shipLaunchYear: 2022 },
  Aurora:    { shipClass: 'R',          shipLaunchYear: 2000 },
  Azura:     { shipClass: 'Grand',      shipLaunchYear: 2010 },
  Britannia: { shipClass: 'Royal',      shipLaunchYear: 2015 },
  Iona:      { shipClass: 'Excellence', shipLaunchYear: 2020 },
  Ventura:   { shipClass: 'Grand',      shipLaunchYear: 2008 },
};

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

/**
 * Maps one `searchResults` entry from the cruise-query-processor API to the
 * shared cruise contract. `cabins[0]` is the cheapest available cabin (the
 * lead-in fare); we populate that bucket and use it as `priceFrom`.
 */
function normalizeApiCruise(raw) {
  const cruiseId = cleanText(raw?.cruiseId || raw?.itineraryId);
  if (!cruiseId) return null;

  const shipName = cleanText(raw?.shipName);
  const meta     = SHIPS[shipName] || {};
  const nights   = Number.parseInt(raw?.duration, 10);
  const departurePort   = portName(raw?.embarkPortCode);
  const destinationPort = portName(raw?.disembarkPortCode);

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
    itinerary: name || destination,
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

async function fetchSearchPage(start, fetchImpl = fetchWithTimeout) {
  const res = await fetchImpl(`${CRUISE_SEARCH_URL}?start=${start}`, { headers: API_HEADERS });
  if (!res.ok) throw new Error(`P&O search HTTP ${res.status} at start=${start}`);
  const data = await res.json();
  return {
    total: Number(data?.results),
    results: Array.isArray(data?.searchResults) ? data.searchResults : [],
  };
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

async function fetchCruises(options = {}) {
  const fetchImpl = options.fetchImpl || fetchWithTimeout;
  const logger    = options.logger || console;

  const first = await fetchSearchPage(0, fetchImpl);
  const total = Number.isFinite(first.total) && first.total > 0 ? first.total : first.results.length;

  const starts = [];
  for (let start = PAGE_SIZE; start < total && starts.length < MAX_PAGES; start += PAGE_SIZE) starts.push(start);

  let failed = 0;
  const pages = await mapWithConcurrency(starts, PAGE_CONCURRENCY, async (start) => {
    try {
      return (await fetchSearchPage(start, fetchImpl)).results;
    } catch (err) {
      failed += 1;
      if (logger?.warn) logger.warn(`  [P&O] page start=${start} failed: ${err.message}`);
      return [];
    }
  });

  const byId = new Map();
  for (const raw of [first.results, ...pages].flat()) {
    const cruise = normalizeApiCruise(raw);
    if (cruise && !byId.has(cruise.id)) byId.set(cruise.id, cruise);
  }

  const cruises = [...byId.values()];
  if (!cruises.length) throw new Error('P&O returned no cruise results');
  console.log(`  [P&O] ${cruises.length} cruises from ${starts.length + 1} page(s) (API total ${total}${failed ? `, ${failed} page(s) failed` : ''})`);
  return cruises;
}

const provider = {
  id: 'p-and-o',
  name: 'P&O Cruises',
  fetchCruises,
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
module.exports.portName = portName;
module.exports.countSeaDays = countSeaDays;
module.exports.emptyPrices = emptyPrices;
module.exports.PORT_NAMES = PORT_NAMES;

'use strict';

/**
 * Virgin Voyages provider.
 *
 * The find-a-voyage page is a Next.js (app-router) SPA, but the full voyage
 * list is server-rendered into the page's RSC payload (self.__next_f) under
 * `sailingsAvailability.data.data` — 400+ voyages in a single request, no auth
 * and no pagination. The port code → name pairs are embedded in the same page.
 * So this provider fetches one HTML page and parses the embedded JSON.
 *
 * The list page only exposes a min/max range per voyage, so `priceFrom` is the
 * lead-in (min) price. The per-cabin fares come from a second source: Virgin's
 * `CabinCategoriesAvailability` GraphQL query (prod.virginvoyages.com/graphql).
 * That endpoint needs a Keycloak client-credentials JWT rather than the site's
 * static apiKey; the token is minted inside the SPA, so we grab one by loading
 * the find-a-voyage page in a headless browser (usesBrowser) and reading the
 * Bearer header off its own GraphQL calls. One token (valid ~4 weeks) then
 * prices every voyage over plain fetch. To keep the 2-hourly scrape gentle on
 * Virgin's API, cabin prices are refreshed incrementally — new voyages plus a
 * rolling ~1/day slice — carrying prior prices forward otherwise. See
 * canReuseCabinPrices / enrichCabinPrices.
 */

const {
  cleanText,
  getDepartureRegion,
  fetchWithTimeout,
  DEFAULT_USER_AGENT,
} = require('./shared');

const FIND_A_VOYAGE_URL = 'https://www.virginvoyages.com/book/voyage-planner/find-a-voyage?currencyCode=GBP';
const GRAPHQL_URL = 'https://prod.virginvoyages.com/graphql';

// The four "Lady" ships (all one class, ~2,770 guests → medium tier).
const SHIPS = {
  BR: { name: 'Brilliant Lady', shipLaunchYear: 2025 },
  RS: { name: 'Resilient Lady', shipLaunchYear: 2023 },
  SC: { name: 'Scarlet Lady',   shipLaunchYear: 2021 },
  VL: { name: 'Valiant Lady',   shipLaunchYear: 2021 },
};

// Balanced [...] / {...} extractor for pulling JSON out of the RSC stream.
function extractBalanced(text, open) {
  const openCh = text[open];
  const closeCh = openCh === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === openCh) depth += 1;
    else if (c === closeCh) { depth -= 1; if (depth === 0) return text.slice(open, i + 1); }
  }
  return null;
}

// Pull the voyage array out of the (un-escaped) page.
function parseVoyages(unescaped) {
  const at = unescaped.indexOf('"sailingsAvailability":{"data":{"data":');
  if (at < 0) return [];
  const arr = extractBalanced(unescaped, unescaped.indexOf('[', at));
  try { return arr ? JSON.parse(arr) : []; } catch { return []; }
}

// Decode JSON string escapes (e.g. & → &) left in the regex-extracted text.
function decodeName(raw) {
  try { return cleanText(JSON.parse(`"${raw}"`)); } catch { return cleanText(raw); }
}

// Build a port code → name map from the {code,name} objects embedded in the
// page (both field orders appear). Fuller names ("San Juan, Puerto Rico") win.
function parsePortMap(unescaped) {
  const map = {};
  for (const m of unescaped.matchAll(/\{"code":"([A-Z]{3})","name":"([^"]{2,60})"/g)) {
    if (!map[m[1]]) map[m[1]] = decodeName(m[2]);
  }
  for (const m of unescaped.matchAll(/"name":"([^"]{2,60})","code":"([A-Z]{3})"/g)) {
    if (!map[m[2]]) map[m[2]] = decodeName(m[1]);
  }
  return map;
}

function portName(code, portMap) {
  const c = cleanText(code).toUpperCase();
  return c ? ((portMap && portMap[c]) || c) : '';
}

// "2026-08-27" → "260827" (the voyageId date segment).
function compactDate(iso) {
  const m = cleanText(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1].slice(2) + m[2] + m[3] : '';
}

function buildItinerary(ports, portMap) {
  const names = (Array.isArray(ports) ? ports : []).map(code => portName(code, portMap)).filter(Boolean);
  return names.filter((p, i) => i === 0 || p !== names[i - 1]).join(' → ');
}

function normalizeVoyage(voyage, portMap = {}) {
  const shipCode    = cleanText(voyage?.shipCode).toUpperCase();
  const packageCode = cleanText(voyage?.packageCode).toUpperCase();
  const startDate   = cleanText(voyage?.startDate).slice(0, 10);
  if (!shipCode || !packageCode || !startDate) return null;

  const ship  = SHIPS[shipCode] || {};
  const ports = Array.isArray(voyage?.ports) ? voyage.ports : [];
  const voyageId = `${shipCode}${compactDate(startDate)}${packageCode}`;
  const departurePort = portName(voyage?.homePort, portMap);
  const nights = Number.parseInt(voyage?.duration, 10);
  const minPrice = Number(voyage?.minPrice);
  const region = getDepartureRegion(departurePort);

  return {
    id: `virgin-${voyageId}`,
    provider: 'Virgin Voyages',
    shipName: ship.name || shipCode,
    shipClass: 'Lady',
    shipLaunchYear: ship.shipLaunchYear || null,
    itinerary: buildItinerary(ports, portMap) || cleanText(voyage?.region),
    departureDate: startDate,
    duration: Number.isFinite(nights) ? `${nights} Nights` : '',
    departurePort,
    departureRegion: region,
    destination: region,
    destinationPort: ports.length ? portName(ports[ports.length - 1], portMap) : departurePort,
    seaDays: null,
    priceFrom: Number.isFinite(minPrice) && minPrice > 0 ? String(Math.round(minPrice)) : '',
    currency: 'GBP',
    prices: { inside: null, oceanView: null, balcony: null, suite: null },
    bookingUrl: `https://www.virginvoyages.com/book/voyage-planner/find-a-voyage?voyageId=${encodeURIComponent(voyageId)}&currencyCode=GBP`,
    arrivalDate: cleanText(voyage?.endDate).slice(0, 10),
  };
}

// ── Per-cabin pricing (CabinCategoriesAvailability GraphQL) ──────────────────

const PRICE_BUCKETS = ['inside', 'oceanView', 'balcony', 'suite'];

// Virgin cabin category → our per-cabin bucket. The two suite tiers (ROCKSTAR
// SUITES and the pricier MEGA ROCKSTAR) both fold into `suite`; cheapest wins.
const CATEGORY_BUCKET = {
  'INSIDER': 'inside',
  'SEA VIEW': 'oceanView',
  'SEA TERRACE': 'balcony',
  'ROCKSTAR SUITES': 'suite',
  'MEGA ROCKSTAR': 'suite',
};

const CABIN_QUERY = `query CabinCategoriesAvailability($value: CabinCategoriesAvailabilityRequest!) {
  cabinCategoriesAvailability(value: $value) {
    availableCategories {
      code
      submetas { cabinTypes { lowestAvailablePrice { totalPrice { amount } } } }
    }
  }
}`;

// The endpoint prices a specific cabin party; we ask for the standard 2-adult
// occupancy so the returned totals match the site's advertised lead-in fares.
function buildCabinVars(voyageId) {
  return {
    value: {
      accessKeys: [],
      cabins: [{ cabinSeqNo: 1, isAccessible: false, travelParty: [{ ageCategory: 'ADULT', count: 2 }] }],
      currencyCode: 'GBP',
      voyageId,
    },
  };
}

// Pure: a cabinCategoriesAvailability array → per-person bucket prices. Virgin
// quotes the total for two guests, so we halve it to match every other
// provider's per-person lead-in convention. Within a category the cheapest
// cabin type wins; sold-out categories are simply absent (bucket stays null).
function parseCabinPrices(availability) {
  const buckets = { inside: null, oceanView: null, balcony: null, suite: null };
  for (const seq of (Array.isArray(availability) ? availability : [])) {
    for (const cat of (seq?.availableCategories || [])) {
      const bucket = CATEGORY_BUCKET[cleanText(cat?.code).toUpperCase()];
      if (!bucket) continue;
      let minTotal = null;
      for (const sm of (cat?.submetas || [])) {
        for (const ct of (sm?.cabinTypes || [])) {
          const amt = Number(ct?.lowestAvailablePrice?.totalPrice?.amount);
          if (Number.isFinite(amt) && amt > 0 && (minTotal == null || amt < minTotal)) minTotal = amt;
        }
      }
      if (minTotal != null) {
        const perPerson = Math.round(minTotal / 2);
        if (buckets[bucket] == null || perPerson < buckets[bucket]) buckets[bucket] = perPerson;
      }
    }
  }
  return buckets;
}

function hasAnyCabinPrice(prices) {
  return !!prices && PRICE_BUCKETS.some(b => prices[b] != null && Number.isFinite(Number(prices[b])));
}

// Rolling refresh: reuse a voyage's prior cabin prices when they were fetched
// within a jittered ~1-day window, so each 2-hourly run only re-prices new
// voyages plus a rotating ~1/day slice (id-hash jitter spreads them out).
const CABIN_REUSE_MIN_MS    = 20 * 60 * 60 * 1000;  // 20h floor
const CABIN_REUSE_JITTER_MS = 8 * 60 * 60 * 1000;   // + up to 8h → ~1×/day

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function canReuseCabinPrices(prior, now = Date.now()) {
  if (!prior || !prior.pricesEnrichedAt || !hasAnyCabinPrice(prior.prices)) return false;
  const at = Date.parse(prior.pricesEnrichedAt);
  if (!Number.isFinite(at)) return false;
  const ttl = CABIN_REUSE_MIN_MS + (hashString(String(prior.id || '')) % (CABIN_REUSE_JITTER_MS + 1));
  return (now - at) < ttl;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || items.length === 0) return [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
}

// Grab a Keycloak client-credentials JWT by loading find-a-voyage in a headless
// browser and reading the Bearer header off the SPA's own GraphQL calls. The
// token is minted client-side (no observable mint request) but a plain fetch
// with it then works from anywhere. Returns null (enrichment skipped, prices
// left as-is) if Playwright is unavailable or no token appears — never throws.
async function grabApiToken() {
  let chromium;
  try { ({ chromium } = require('@playwright/test')); }
  catch { console.warn('  [Virgin] Playwright unavailable; skipping cabin-price enrichment'); return null; }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ locale: 'en-GB' });
    let token = null;
    page.on('request', req => {
      const auth = req.headers().authorization || '';
      if (!token && /graphql/.test(req.url()) && /^Bearer eyJ/.test(auth)) token = auth.slice(7);
    });
    await page.goto(FIND_A_VOYAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    for (let i = 0; i < 15 && !token; i += 1) await page.waitForTimeout(1000);
    if (!token) console.warn('  [Virgin] no API token seen; skipping cabin-price enrichment');
    return token;
  } catch (err) {
    console.warn(`  [Virgin] token grab failed: ${err.message}; skipping cabin-price enrichment`);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function fetchCabinPrices(token, voyageId, fetchImpl) {
  const res = await fetchImpl(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
    body: JSON.stringify({ query: CABIN_QUERY, variables: buildCabinVars(voyageId) }),
  });
  if (!res.ok) throw new Error(`cabin HTTP ${res.status}`);
  const json = await res.json();
  if (json?.errors?.length) throw new Error(`cabin query error: ${json.errors[0]?.message || 'unknown'}`);
  return parseCabinPrices(json?.data?.cabinCategoriesAvailability);
}

// Populate cruise.prices from the cabin API, incrementally. Reuses prior prices
// within their jittered TTL; otherwise fetches (concurrency-limited). On any
// per-voyage failure the prior prices are carried forward so a transient error
// never wipes a voyage's prices. Stamps pricesEnrichedAt on fresh fetches only.
async function enrichCabinPrices(cruises, options = {}) {
  if (options.enrichPrices === false) return cruises;
  const priorById = options.priorEnrichmentById instanceof Map ? options.priorEnrichmentById : new Map();
  const now = Date.now();
  const token = options.token || (options.grabToken ? await options.grabToken() : await grabApiToken());
  if (!token) {
    // No token: carry any prior prices forward so we don't regress to nulls.
    for (const cruise of cruises) {
      const prior = priorById.get(cruise.id);
      if (prior && hasAnyCabinPrice(prior.prices)) {
        cruise.prices = { ...prior.prices };
        if (prior.pricesEnrichedAt) cruise.pricesEnrichedAt = prior.pricesEnrichedAt;
      }
    }
    return cruises;
  }

  const fetchImpl = options.fetchCabinImpl || fetchWithTimeout;
  const nowIso = new Date(now).toISOString();
  let fetched = 0, reused = 0, failed = 0, priced = 0;

  await mapWithConcurrency(cruises, options.concurrency || 6, async (cruise) => {
    const prior = priorById.get(cruise.id);
    if (canReuseCabinPrices(prior, now)) {
      cruise.prices = { ...prior.prices };
      cruise.pricesEnrichedAt = prior.pricesEnrichedAt;
      reused += 1;
      if (hasAnyCabinPrice(cruise.prices)) priced += 1;
      return;
    }
    const voyageId = cruise.id.replace(/^virgin-/, '');
    try {
      const prices = await fetchCabinPrices(token, voyageId, fetchImpl);
      cruise.prices = prices;
      cruise.pricesEnrichedAt = nowIso;
      fetched += 1;
      if (hasAnyCabinPrice(prices)) priced += 1;
    } catch (err) {
      failed += 1;
      if (prior && hasAnyCabinPrice(prior.prices)) {
        cruise.prices = { ...prior.prices };
        if (prior.pricesEnrichedAt) cruise.pricesEnrichedAt = prior.pricesEnrichedAt;
      }
      if (failed <= 3) console.warn(`  [Virgin] cabin price failed for ${voyageId}: ${err.message}`);
    }
  });

  console.log(`  [Virgin] cabin prices: ${fetched} fetched, ${reused} reused, ${failed} failed → ${priced}/${cruises.length} priced`);
  return cruises;
}

async function fetchCruises(options = {}) {
  const fetchImpl = options.fetchImpl || fetchWithTimeout;
  const res = await fetchImpl(FIND_A_VOYAGE_URL, {
    headers: { 'user-agent': DEFAULT_USER_AGENT, 'accept-language': 'en-GB,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`Virgin Voyages page HTTP ${res.status}`);
  const unescaped = (await res.text()).split('\\"').join('"');

  const voyages = options.voyages || parseVoyages(unescaped);
  const portMap = options.portMap || parsePortMap(unescaped);

  const byId = new Map();
  for (const voyage of voyages) {
    const cruise = normalizeVoyage(voyage, portMap);
    if (cruise && !byId.has(cruise.id)) byId.set(cruise.id, cruise);
  }

  const cruises = [...byId.values()];
  if (!cruises.length) throw new Error('Virgin Voyages returned no voyages');
  console.log(`  [Virgin] ${cruises.length} voyages (${Object.keys(portMap).length} ports mapped)`);

  await enrichCabinPrices(cruises, options);
  return cruises;
}

const provider = {
  id: 'virgin-voyages',
  name: 'Virgin Voyages',
  // Cabin-price enrichment loads find-a-voyage in a headless Chromium to mint a
  // token, so the scheduler serialises Virgin with the other browser providers.
  usesBrowser: true,
  fetchCruises,
  normalizeCruise(voyage) {
    if (voyage?.id && voyage?.provider === provider.name) return voyage;
    return normalizeVoyage(voyage);
  },
};

module.exports = provider;
module.exports.normalizeVoyage = normalizeVoyage;
module.exports.parseVoyages = parseVoyages;
module.exports.parsePortMap = parsePortMap;
module.exports.buildItinerary = buildItinerary;
module.exports.parseCabinPrices = parseCabinPrices;
module.exports.buildCabinVars = buildCabinVars;
module.exports.canReuseCabinPrices = canReuseCabinPrices;
module.exports.fetchCabinPrices = fetchCabinPrices;
module.exports.enrichCabinPrices = enrichCabinPrices;

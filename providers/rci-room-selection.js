'use strict';

const { cleanText, extractPortSequenceFromChapters, buildDetailedItinerary,
        estimateSeaDays, DEFAULT_USER_AGENT } = require('./shared');

/**
 * Default request timeout (ms) for outbound provider HTTP calls.
 * Overridable per-call by passing { timeoutMs } to fetchRoomSelectionData
 * or fetchRoomSelectionPagePrice.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * AbortSignal.timeout fallback for older runtimes — Node 17.3+ provides
 * AbortSignal.timeout natively; for older Node this constructs a
 * manually-aborted signal. Since this project pins node >= 18, the
 * native path is always used; this guard is defensive only.
 */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

/**
 * Run `items` through `mapper` with at most `concurrency` invocations
 * in flight at any time. Preserves input order in the returned array.
 * Errors from `mapper` reject the returned promise; the loop is
 * fail-fast (does not drain remaining items). Use Promise.allSettled
 * at the call site if partial failure is acceptable.
 */
async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/**
 * Build a room-selection-API filter object — identical shape for both
 * Royal Caribbean and Celebrity.
 */
function buildRoomSelectionFilter(context) {
  return {
    countryCode:  context.country,
    packageId:    context.packageCode,
    sailDate:     context.sailDate,
    currencyCode: context.selectedCurrencyCode,
    language:     'en',
    options:      false,
    roomNumbers:  false,
    rooms:        [{ adultCount: 2, childCount: 0 }],
  };
}

/**
 * Classifies a stateroom entry from the room-selection API into one of the
 * four standard room types: inside, oceanView, balcony, or suite.
 * Returns null when the entry cannot be mapped.
 */
function classifyRoomType(entry) {
  const id   = String(entry?.id   || entry?.classId   || entry?.code  || entry?.type  || '').toUpperCase();
  const name = String(entry?.name || entry?.className || entry?.label || '').toLowerCase();

  if (/^(x|i|int|interior|inside)$/i.test(id) || /\b(interior|inside)\b/.test(name))         return 'inside';
  if (/^(n|o|ov|ocean|oceanview|seaview)$/i.test(id) || /\b(ocean.?view|sea.?view|oceanfront|outside.?view)\b/.test(name)) return 'oceanView';
  if (/^(b|bal|balcony)$/i.test(id) || /\b(balcony|veranda)\b/.test(name))                   return 'balcony';
  if (/^(s|gs|js|suite|suites)$/i.test(id) || /\b(suite|retreat)\b/.test(name))              return 'suite';
  return null;
}

/**
 * Extracts a per-person price amount from various possible price object
 * shapes returned by the room-selection API.
 */
function extractPriceFromEntry(priceObj) {
  if (!priceObj) return null;
  const scalar = parseFloat(
    priceObj?.amount ?? priceObj?.value ?? priceObj?.fare
    ?? (typeof priceObj === 'number' ? priceObj : null),
  );
  if (Number.isFinite(scalar) && scalar > 0) return Math.round(scalar * 100) / 100;
  return null;
}

/**
 * Extracts per-room-type prices from a room-selection API payload.
 * Tries each of the four candidate locations where the API may publish
 * the data and keeps the first non-null price per bucket.
 */
function extractRoomTypePricesFromPayload(payload) {
  const prices = { inside: null, oceanView: null, balcony: null, suite: null };

  const candidates = [
    ...(Array.isArray(payload?.sailing?.stateroomClasses) ? payload.sailing.stateroomClasses : []),
    ...(Array.isArray(payload?.sailing?.categories)       ? payload.sailing.categories       : []),
    ...(Array.isArray(payload?.stateroomClasses)          ? payload.stateroomClasses          : []),
    ...(Array.isArray(payload?.categories)                ? payload.categories                : []),
  ];

  for (const entry of candidates) {
    const type = classifyRoomType(entry);
    if (!type || prices[type] !== null) continue;

    const priceField = entry?.lowestPrice ?? entry?.price ?? entry?.perPersonPrice ?? entry?.startingFrom ?? entry?.fare;
    const amount = extractPriceFromEntry(priceField);
    if (amount !== null) prices[type] = String(amount);
  }

  return prices;
}

/**
 * Extracts per-room-type prices from a `stateroomClassPricing` array as
 * returned inside GraphQL cruiseSearch results.  Falls back to
 * `entry.stateroomClass.name` for room-type classification.
 */
function extractPricesFromClassPricing(stateroomClassPricing) {
  const prices = { inside: null, oceanView: null, balcony: null, suite: null };
  if (!Array.isArray(stateroomClassPricing)) return prices;
  for (const item of stateroomClassPricing) {
    const type = classifyRoomType({ name: item?.stateroomClass?.name || '' });
    if (!type || prices[type] !== null) continue;
    const value = item?.price?.value;
    if (value != null) prices[type] = String(value);
  }
  return prices;
}

/**
 * Cache key for room-selection responses. Same package + sail date +
 * country + currency → same data. Used by the enrichment loop to skip
 * duplicate requests when multiple sailings share an itinerary.
 */
function roomSelectionCacheKey(context) {
  if (!context) return null;
  const { packageCode, sailDate, selectedCurrencyCode, country } = context;
  if (!packageCode || !sailDate) return null;
  return `${packageCode}|${sailDate}|${selectedCurrencyCode || ''}|${country || ''}`;
}

/**
 * Factory: returns the room-selection helpers wired to a specific host
 * (Royal Caribbean or Celebrity). Pass `hostConfig` to point at the
 * right backend; pass `paramAliases` to accept multiple URL parameter
 * spellings (Celebrity uses pID/sDT in addition to packageCode/sailDate).
 *
 *   const rc = createRciRoomSelection({
 *     host:        'royalcaribbean.com',
 *     brand:       'RCL',
 *     or:          'https://www.royalcaribbean.com',
 *     apiUrl:      'https://www.royalcaribbean.com/room-selection/api/v1/rooms',
 *     defaultCountry: 'USA',
 *   });
 *   await rc.fetchRoomSelectionData(context);
 */
function createRciRoomSelection(hostConfig) {
  const { apiUrl, brand, or, defaultCountry = 'USA' } = hostConfig;

  /**
   * Parse a booking URL into the filter context required by the
   * room-selection API. Accepts both RC's
   *   ?packageCode=…&sailDate=…&selectedCurrencyCode=…&country=…
   * and Celebrity's
   *   ?pID=…&sDT=…   (fallback for packageCode/sailDate)
   * query spellings. Returns only the four fields every room-selection
   * request needs; Celebrity-specific extras (groupId/shipCode for the
   * type-and-subtype page) come from parseBookingExtras.
   */
  function parseBookingContext(bookingUrl) {
    if (!bookingUrl) return null;

    try {
      const url = new URL(bookingUrl);
      const packageCode = cleanText(url.searchParams.get('packageCode') || url.searchParams.get('pID'));
      const sailDate    = cleanText(url.searchParams.get('sailDate')    || url.searchParams.get('sDT'));
      const country     = cleanText(url.searchParams.get('country')) || defaultCountry;
      const currencyParam = cleanText(url.searchParams.get('selectedCurrencyCode'));
      const selectedCurrencyCode = currencyParam || (country === 'GBR' ? 'GBP' : 'USD');

      if (!packageCode || !sailDate) return null;

      return { packageCode, sailDate, country, selectedCurrencyCode };
    } catch {
      return null;
    }
  }

  /**
   * Extract the Celebrity-specific extra fields needed to build the
   * type-and-subtype page URL. Returns {} if not Celebrity-shaped.
   */
  function parseBookingExtras(bookingUrl) {
    if (!bookingUrl) return {};
    try {
      const url = new URL(bookingUrl);
      return {
        groupId:  cleanText(url.searchParams.get('groupId')),
        shipCode: cleanText(url.searchParams.get('shipCode') || url.searchParams.get('sCD')),
      };
    } catch {
      return {};
    }
  }

  /**
   * Fetch the room-selection JSON payload (chapters + per-cabin prices)
   * for a parsed booking context.  Always returns a ports+prices object,
   * even on non-2xx responses, so callers can carry on with empty data.
   *
   * @param {{packageCode:string, sailDate:string, country?:string}} context
   * @param {{timeoutMs?: number, log?: function}} [opts]
   */
  async function fetchRoomSelectionData(context, opts = {}) {
    const empty = { ports: [], prices: { inside: null, oceanView: null, balcony: null, suite: null } };
    if (!context?.packageCode || !context?.sailDate) return empty;

    const filter = buildRoomSelectionFilter(context);
    const params = new URLSearchParams({
      filter: JSON.stringify(filter),
      or,
    });

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let response;
    try {
      response = await fetch(`${apiUrl}?${params}`, {
        headers: {
          brand,
          country: context.country,
          'content-type': 'application/json',
          'accept-language': 'en-GB,en;q=0.9',
          'user-agent': DEFAULT_USER_AGENT,
        },
        signal: timeoutSignal(timeoutMs),
      });
    } catch (err) {
      (opts.log ?? console.warn)(`  room-selection fetch failed for ${context.packageCode}: ${err.message}`);
      return empty;
    }

    if (!response.ok) {
      (opts.log ?? console.warn)(`  room-selection HTTP ${response.status} for ${context.packageCode}`);
      return empty;
    }

    const payload = await response.json();
    return {
      ports:  extractPortSequenceFromChapters(payload?.sailing?.itinerary?.chapters),
      prices: extractRoomTypePricesFromPayload(payload),
    };
  }

  /**
   * @deprecated Use fetchRoomSelectionData instead. Kept as a thin wrapper
   * because external callers may import this name.
   */
  async function fetchRoomSelectionPorts(context) {
    const { ports } = await fetchRoomSelectionData(context);
    return ports;
  }

  return {
    parseBookingContext,
    parseBookingExtras,
    fetchRoomSelectionData,
    fetchRoomSelectionPorts,
    extractRoomTypePricesFromPayload,
    extractPricesFromClassPricing,
    classifyRoomType,
    roomSelectionCacheKey,
    mapWithConcurrency,
  };
}

// ── Incremental enrichment reuse ─────────────────────────────────────────────
// Itinerary enrichment (port sequence → detailed itinerary, destination port,
// sea days) is derived from a sailing's fixed route, which barely changes. To
// spare the room-selection endpoint — hundreds of calls per run, and the source
// of the 503s — reuse the previous run's enrichment for an unchanged sailing and
// only re-fetch new/changed ones, plus a slow rolling refresh (a per-cruise
// jittered TTL) so a rare route change still self-heals within a week or two.
//
// SAFETY: only for providers whose enrichment does NOT carry live prices. Royal
// Caribbean qualifies (enrichment = ports only; prices come from the GraphQL
// search). Celebrity's enrichment also fetches live prices, so it MUST run every
// time and must NOT reuse. canReuseEnrichment fails closed (returns false) for
// any cruise lacking `enrichedAt`, so an un-stamped provider never reuses.
const ENRICH_REUSE_MIN_MS    = 7 * 24 * 60 * 60 * 1000;   // reuse for at least a week
const ENRICH_REUSE_JITTER_MS = 7 * 24 * 60 * 60 * 1000;   // spread refresh across the next week

// The fields that identify a specific sailing. If they all match between the
// prior and fresh records, the route (and thus the enrichment) is the same.
function enrichmentSignature(cruise) {
  return ['shipName', 'departureDate', 'duration', 'departurePort']
    .map(key => String(cruise?.[key] ?? '').trim().toLowerCase())
    .join('|');
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

// True when the previous-run `prior` record can stand in for enriching `fresh`,
// so we can skip its room-selection HTTP call this run.
function canReuseEnrichment(prior, fresh, now = Date.now()) {
  if (!prior || !fresh || !prior.enrichedAt) return false;
  if (enrichmentSignature(prior) !== enrichmentSignature(fresh)) return false;
  const enrichedMs = Date.parse(prior.enrichedAt);
  if (!Number.isFinite(enrichedMs)) return false;
  const ttl = ENRICH_REUSE_MIN_MS + (hashString(String(prior.id || '')) % (ENRICH_REUSE_JITTER_MS + 1));
  return (now - enrichedMs) < ttl;
}

// Carry the prior run's itinerary fields onto the fresh (freshly-priced) cruise.
// Only the route-derived fields are copied; price/date/etc. stay fresh.
function applyReusedEnrichment(fresh, prior) {
  return {
    ...fresh,
    itinerary: prior.itinerary || fresh.itinerary,
    destinationPort: prior.destinationPort ?? fresh.destinationPort,
    seaDays: prior.seaDays ?? fresh.seaDays,
    enrichedAt: prior.enrichedAt,
  };
}

module.exports = {
  createRciRoomSelection,
  enrichmentSignature,
  canReuseEnrichment,
  applyReusedEnrichment,
  classifyRoomType,
  extractPriceFromEntry,
  extractRoomTypePricesFromPayload,
  extractPricesFromClassPricing,
  buildRoomSelectionFilter,
  roomSelectionCacheKey,
  mapWithConcurrency,
  timeoutSignal,
  DEFAULT_TIMEOUT_MS,
  // Re-export shared helpers used by the enrichment logic so the two
  // provider files don't need a second `require('./shared')`.
  cleanText,
  buildDetailedItinerary,
  extractPortSequenceFromChapters,
  estimateSeaDays,
};

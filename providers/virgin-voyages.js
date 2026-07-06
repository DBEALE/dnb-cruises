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
 * Virgin only exposes a price range (min/max) per voyage, not per-cabin fares,
 * so `priceFrom` is the lead-in (min) price and the per-cabin buckets stay null.
 */

const {
  cleanText,
  getDepartureRegion,
  fetchWithTimeout,
  DEFAULT_USER_AGENT,
} = require('./shared');

const FIND_A_VOYAGE_URL = 'https://www.virginvoyages.com/book/voyage-planner/find-a-voyage?currencyCode=GBP';

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
  return cruises;
}

const provider = {
  id: 'virgin-voyages',
  name: 'Virgin Voyages',
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

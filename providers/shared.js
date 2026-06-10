'use strict';

/**
 * Single source of truth for the Chrome user-agent string used by all
 * outbound provider HTTP requests. Princess uses 131.0.0.0 in production;
 * we standardize on that. Override at runtime by passing your own
 * 'user-agent' header.
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Default timeout for outbound HTTP. 15s is enough to ride out one
// provider-side hiccup without hanging the whole scrape job — a single
// slow request used to block the deploy-pages workflow for the full
// upstream window. Tune per-call by passing a different value.
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * fetch() with an AbortSignal.timeout() so a hung upstream can no
 * longer block the caller indefinitely. Compatible with Node ≥ 17.3
 * (satisfied by `engines.node: ">=18.0.0"` in package.json).
 *
 * If the caller already passed a `signal`, the new one is composed via
 * AbortSignal.any([…]) so user-supplied cancellation still works.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const userSignal = options.signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = userSignal
    ? AbortSignal.any([userSignal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...options, signal });
}

/**
 * Maps a departure port name to a broad geographic region.
 * Used by all providers to normalise region labelling.
 */
function getDepartureRegion(portName) {
  if (!portName) return '';
  const p = portName.toLowerCase();
  if (/england|scotland|wales|southampton|dover|harwich|tilbury|portsmouth|newcastle|liverpool|belfast|dublin|cork|ireland/.test(p)) return 'UK & Ireland';
  if (/norway|sweden|denmark|finland|iceland|amsterdam|netherlands|hamburg|germany|copenhagen|stockholm|oslo|reykjavik|rotterdam|antwerp|belgium/.test(p)) return 'Northern Europe';
  if (/spain|france|italy|greece|turkey|portugal|croatia|malta|cyprus|montenegro|albania|gibraltar|monaco|barcelona|rome|civitavecchia|naples|genoa|venice|ravenna|trieste|piraeus|athens|istanbul|lisbon|marseille|valletta|palma|dubrovnik|kotor|split|zadar/.test(p)) return 'Mediterranean';
  if (/colon|colón|san juan|seward|florida|miami|fort lauderdale|port canaveral|cape liberty|bayonne|philadelphia|pennsylvania|tampa|galveston|texas|new york|new orleans|louisiana|baltimore|maryland|boston|seattle|washington|vancouver|canada|alaska|los angeles|california|san diego|honolulu|hawaii/.test(p)) return 'Americas';
  if (/bahamas|barbados|antigua|jamaica|puerto rico|st\. lucia|aruba|curacao|trinidad|martinique|guadeloupe|dominica|grenada|nassau|bridgetown|castries|kingston|willemstad|oranjestad|virgin island|cayman|cozumel|belize|haiti|dominican|caribbean/.test(p)) return 'Caribbean';
  if (/singapore|china|japan|tokyo|yokohama|shanghai|hong kong|thailand|vietnam|korea|south korea|seoul|incheon|taiwan|philippines|indonesia|malaysia|bali|tianjin|keelung|hakodate|osaka/.test(p)) return 'Asia & Far East';
  if (/dubai|abu dhabi|uae|oman|muscat|qatar|doha|bahrain|israel|jordan|aqaba|haifa|egypt|alexandria/.test(p)) return 'Middle East';
  if (/south africa|cape town|mauritius|port louis|seychelles|madagascar|mombasa|dar es salaam|zanzibar|africa/.test(p)) return 'Africa';
  if (/australia|new zealand|sydney|melbourne|brisbane|auckland|fiji|tahiti|pacific/.test(p)) return 'Australia & Pacific';
  if (/brazil|argentina|chile|peru|colombia|uruguay|ecuador|quito|baltra|galapagos|buenos aires|rio de janeiro|santiago|lima|cartagena|montevideo/.test(p)) return 'South America';
  return 'Other';
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseNights(value) {
  const match = cleanText(value).match(/(\d+)/);
  if (!match) return null;
  const nights = parseInt(match[1], 10);
  return Number.isFinite(nights) ? nights : null;
}

function isSeaDayLabel(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) return false;
  if (/\bscenic cruising\b/i.test(text)) return false;
  return /\b(at sea|sea day|day at sea)\b/i.test(text) || /\bcruising\s*\(cruising\)\b/i.test(text);
}

function estimateSeaDays({ labels = [], duration = '', portsIncludeEndpoints = true } = {}) {
  const list = Array.isArray(labels)
    ? labels.map(cleanText).filter(Boolean)
    : [];

  const explicitSeaDays = list.filter(isSeaDayLabel).length;
  if (explicitSeaDays > 0) return explicitSeaDays;

  const nights = parseNights(duration);
  if (!Number.isFinite(nights)) return null;
  if (!list.length) return null;

  const portCalls = list.filter(label => !isSeaDayLabel(label)).length;
  const inferred = portsIncludeEndpoints
    ? (nights + 1) - portCalls
    : (nights + 1) - (portCalls + 2);

  return Math.max(0, inferred);
}

/**
 * Returns true only when the chapter port object represents a
 * "cruising" (sea) day rather than a real port stop. Used to drop
 * cruiseline's "Cruising" pseudo-ports from the displayed itinerary.
 */
function isCruisingPortName(name) {
  return /^cruising$/i.test(cleanText(name));
}

/**
 * Joins a port name with its region for display, omitting the region
 * when it's already part of the name or when the entry is a "Cruising"
 * pseudo-port. Royal Caribbean / Celebrity chapter shape.
 */
function formatChapterPort(port) {
  const name   = cleanText(port?.name);
  const region = cleanText(port?.region);
  if (!name) return '';
  if (!region || isCruisingPortName(name)) return name;
  if (name.toLowerCase().includes(region.toLowerCase())) return name;
  return `${name}, ${region}`;
}

/**
 * Maps a room-selection API chapters array to an ordered list of port
 * labels (deduplicated, "Cruising" entries preserved). Royal Caribbean /
 * Celebrity chapter shape.
 */
function extractPortSequenceFromChapters(chapters) {
  if (!Array.isArray(chapters)) return [];
  const seen = new Set();
  const out  = [];
  for (const chapter of chapters) {
    const label = formatChapterPort(chapter?.port);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/**
 * Builds a detailed itinerary string by appending extracted port names
 * to a base summary. Strips "Cruising" pseudo-ports and drops the
 * departure port (first non-cruising entry). Returns the summary name
 * unchanged when no real stops remain.
 *
 * Royal Caribbean / Celebrity shape: ports come from the room-selection
 * chapters array, which starts with the departure port and may include
 * "Cruising" placeholders.
 */
function buildDetailedItinerary(summaryName, ports) {
  const normalizedPorts  = Array.from(new Set((ports || []).map(cleanText).filter(Boolean)));
  const nonCruisingPorts = normalizedPorts.filter(p => !isCruisingPortName(p));
  if (nonCruisingPorts.length <= 1) return cleanText(summaryName);

  const stops = nonCruisingPorts.slice(1);
  if (stops.length === 0) return cleanText(summaryName);

  return `${cleanText(summaryName)}: ${stops.join(', ')}`;
}

module.exports = {
  DEFAULT_USER_AGENT,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  getDepartureRegion,
  estimateSeaDays,
  isSeaDayLabel,
  parseNights,
  cleanText,
  isCruisingPortName,
  formatChapterPort,
  extractPortSequenceFromChapters,
  buildDetailedItinerary,
};

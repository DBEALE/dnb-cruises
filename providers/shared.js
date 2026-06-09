'use strict';

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

module.exports = {
  getDepartureRegion,
  estimateSeaDays,
  isSeaDayLabel,
  parseNights,
};

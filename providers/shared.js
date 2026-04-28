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
  if (/colon|colón|san juan|seward|florida|miami|fort lauderdale|port canaveral|tampa|galveston|texas|new york|new orleans|louisiana|baltimore|maryland|boston|seattle|washington|vancouver|canada|alaska|los angeles|california|san diego|honolulu|hawaii/.test(p)) return 'Americas';
  if (/bahamas|barbados|antigua|jamaica|puerto rico|st\. lucia|aruba|curacao|trinidad|martinique|guadeloupe|dominica|grenada|nassau|bridgetown|castries|kingston|willemstad|oranjestad|virgin island|cayman|cozumel|belize|haiti|dominican|caribbean/.test(p)) return 'Caribbean';
  if (/singapore|china|japan|tokyo|yokohama|shanghai|hong kong|thailand|vietnam|korea|taiwan|philippines|indonesia|malaysia|bali|tianjin|keelung|hakodate|osaka/.test(p)) return 'Asia & Far East';
  if (/dubai|abu dhabi|uae|oman|muscat|qatar|doha|bahrain|israel|jordan|aqaba|haifa|egypt|alexandria/.test(p)) return 'Middle East';
  if (/australia|new zealand|sydney|melbourne|brisbane|auckland|fiji|tahiti|pacific/.test(p)) return 'Australia & Pacific';
  if (/brazil|argentina|chile|peru|colombia|uruguay|buenos aires|rio de janeiro|santiago|lima|cartagena|montevideo/.test(p)) return 'South America';
  return 'Other';
}

module.exports = { getDepartureRegion };

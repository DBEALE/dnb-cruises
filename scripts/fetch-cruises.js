'use strict';

const fs   = require('fs');
const path = require('path');

const CRUISE_GRAPH_URL      = 'https://www.royalcaribbean.com/cruises/graph';
const CRUISE_SEARCH_FILTERS = '';
const CRUISE_SEARCH_SORT    = { by: 'PRICE', order: 'ASC' };
const CRUISE_SEARCH_PAGE_SIZE = 100;
const CRUISE_SEARCH_QUERY = `query cruiseSearch_Cruises($filters: String, $qualifiers: String, $sort: CruiseSearchSort, $pagination: CruiseSearchPagination, $nlSearch: String) {
  cruiseSearch(filters: $filters, qualifiers: $qualifiers, sort: $sort, pagination: $pagination, nlSearch: $nlSearch) {
    results {
      cruises {
        id
        productViewLink
        lowestPriceSailing {
          bookingLink
          sailDate
          lowestStateroomClassPrice {
            price {
              value
              currency {
                code
              }
            }
          }
        }
        masterSailing {
          itinerary {
            name
            totalNights
            departurePort {
              name
            }
            destination {
              name
            }
            ship {
              name
              code
            }
          }
        }
      }
      total
    }
  }
}`;

const SHIP_LAUNCH_YEAR = {
  'Adventure of the Seas':    2001,
  'Allure of the Seas':       2010,
  'Anthem of the Seas':       2015,
  'Brilliance of the Seas':   2002,
  'Enchantment of the Seas':  1997,
  'Explorer of the Seas':     2000,
  'Freedom of the Seas':      2006,
  'Grandeur of the Seas':     1996,
  'Harmony of the Seas':      2016,
  'Icon of the Seas':         2024,
  'Independence of the Seas': 2008,
  'Jewel of the Seas':        2004,
  'Liberty of the Seas':      2007,
  'Mariner of the Seas':      2003,
  'Navigator of the Seas':    2002,
  'Oasis of the Seas':        2009,
  'Odyssey of the Seas':      2021,
  'Ovation of the Seas':      2016,
  'Quantum of the Seas':      2014,
  'Radiance of the Seas':     2001,
  'Rhapsody of the Seas':     1997,
  'Serenade of the Seas':     2003,
  'Spectrum of the Seas':     2019,
  'Symphony of the Seas':     2018,
  'Utopia of the Seas':       2024,
  'Vision of the Seas':       1998,
  'Voyager of the Seas':      1999,
  'Wonder of the Seas':       2022,
};

const SHIP_CLASS = {
  'Icon of the Seas':         'Icon',
  'Utopia of the Seas':       'Oasis',
  'Wonder of the Seas':       'Oasis',
  'Symphony of the Seas':     'Oasis',
  'Harmony of the Seas':      'Oasis',
  'Allure of the Seas':       'Oasis',
  'Oasis of the Seas':        'Oasis',
  'Odyssey of the Seas':      'Quantum',
  'Spectrum of the Seas':     'Quantum',
  'Ovation of the Seas':      'Quantum',
  'Anthem of the Seas':       'Quantum',
  'Quantum of the Seas':      'Quantum',
  'Independence of the Seas': 'Freedom',
  'Liberty of the Seas':      'Freedom',
  'Freedom of the Seas':      'Freedom',
  'Mariner of the Seas':      'Voyager',
  'Navigator of the Seas':    'Voyager',
  'Adventure of the Seas':    'Voyager',
  'Explorer of the Seas':     'Voyager',
  'Voyager of the Seas':      'Voyager',
  'Jewel of the Seas':        'Radiance',
  'Serenade of the Seas':     'Radiance',
  'Brilliance of the Seas':   'Radiance',
  'Radiance of the Seas':     'Radiance',
  'Rhapsody of the Seas':     'Vision',
  'Grandeur of the Seas':     'Vision',
  'Enchantment of the Seas':  'Vision',
  'Vision of the Seas':       'Vision',
};

function getDepartureRegion(portName) {
  if (!portName) return '';
  const p = portName.toLowerCase();
  if (/england|scotland|wales|southampton|dover|harwich|tilbury|portsmouth|newcastle|liverpool|belfast|dublin|cork|ireland/.test(p)) return 'UK & Ireland';
  if (/norway|sweden|denmark|finland|iceland|amsterdam|netherlands|hamburg|germany|copenhagen|stockholm|oslo|reykjavik|rotterdam|antwerp|belgium/.test(p)) return 'Northern Europe';
  if (/spain|france|italy|greece|turkey|portugal|croatia|malta|cyprus|montenegro|albania|gibraltar|monaco|barcelona|rome|civitavecchia|naples|genoa|venice|ravenna|trieste|piraeus|athens|istanbul|lisbon|marseille|valletta|palma|dubrovnik|kotor|split|zadar/.test(p)) return 'Mediterranean';
  if (/bahamas|barbados|antigua|jamaica|puerto rico|st\. lucia|aruba|curacao|trinidad|martinique|guadeloupe|dominica|grenada|nassau|bridgetown|castries|kingston|willemstad|oranjestad|virgin island|cayman|cozumel|belize|haiti|dominican|caribbean/.test(p)) return 'Caribbean';
  if (/florida|miami|fort lauderdale|port canaveral|tampa|galveston|texas|new york|new orleans|louisiana|baltimore|maryland|boston|seattle|washington|vancouver|canada|alaska|los angeles|california|san diego|honolulu|hawaii/.test(p)) return 'Americas';
  if (/singapore|china|japan|tokyo|yokohama|shanghai|hong kong|thailand|vietnam|korea|taiwan|philippines|indonesia|malaysia|bali|tianjin|keelung|hakodate|osaka/.test(p)) return 'Asia & Far East';
  if (/dubai|abu dhabi|uae|oman|muscat|qatar|doha|bahrain|israel|jordan|aqaba|haifa|egypt|alexandria/.test(p)) return 'Middle East';
  if (/australia|new zealand|sydney|melbourne|brisbane|auckland|fiji|tahiti|pacific/.test(p)) return 'Australia & Pacific';
  if (/brazil|argentina|chile|peru|colombia|uruguay|buenos aires|rio de janeiro|santiago|lima|cartagena|montevideo/.test(p)) return 'South America';
  return 'Other';
}

function normalizeCruise(cruise) {
  const itinerary = cruise?.masterSailing?.itinerary || {};
  const sailing   = cruise?.lowestPriceSailing || cruise?.displaySailing || {};
  const price     = sailing?.lowestStateroomClassPrice?.price || {};
  const shipName  = itinerary?.ship?.name || '';
  const departurePort = itinerary?.departurePort?.name || '';
  return {
    shipName,
    shipClass:       SHIP_CLASS[shipName] || '',
    shipLaunchYear:  SHIP_LAUNCH_YEAR[shipName] || null,
    itinerary:       itinerary?.name || '',
    departureDate:   sailing?.sailDate || '',
    duration:        itinerary?.totalNights ? `${itinerary.totalNights} Nights` : '',
    departurePort,
    departureRegion: getDepartureRegion(departurePort),
    destination:     itinerary?.destination?.name || '',
    priceFrom:       price?.value != null ? String(price.value) : '',
    currency:        price?.currency?.code || 'USD',
    bookingUrl:      sailing?.bookingLink || cruise?.productViewLink || '',
  };
}

async function fetchCruiseSearchPage({ filters, pagination }) {
  const body = JSON.stringify({
    operationName: 'cruiseSearch_Cruises',
    variables: { filters, qualifiers: '', nlSearch: '', sort: CRUISE_SEARCH_SORT, pagination },
    query: CRUISE_SEARCH_QUERY,
  });
  const res = await fetch(CRUISE_GRAPH_URL, {
    method: 'POST',
    headers: {
      'content-type':   'application/json',
      'accept':         'application/json',
      'accept-language':'en-GB,en;q=0.9',
      'user-agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'origin':         'https://www.royalcaribbean.com',
      'referer':        'https://www.royalcaribbean.com/gbr/en/cruises',
    },
    body,
  });
  if (!res.ok) throw new Error(`RC API returned HTTP ${res.status}`);
  const payload = await res.json();
  const results = payload?.data?.cruiseSearch?.results;
  if (!results) throw new Error(payload?.errors?.[0]?.message || 'No results in RC API response');
  return results;
}

async function fetchAllCruises() {
  const cruises      = [];
  const seenIds      = new Set();
  let total          = Number.POSITIVE_INFINITY;
  let skip           = 0;

  while (skip < total) {
    const count   = Math.min(CRUISE_SEARCH_PAGE_SIZE, total - skip);
    const results = await fetchCruiseSearchPage({ filters: CRUISE_SEARCH_FILTERS, pagination: { count, skip } });
    total = Number.isFinite(results.total) ? results.total : total;

    const page = Array.isArray(results.cruises) ? results.cruises : [];
    if (page.length === 0) break;

    for (const c of page) {
      if (!c?.id || seenIds.has(c.id)) continue;
      seenIds.add(c.id);
      cruises.push(normalizeCruise(c));
    }

    skip += page.length;
    console.log(`  fetched ${cruises.length} / ${total}`);
  }
  return cruises;
}

async function main() {
  console.log('Fetching Royal Caribbean cruise data…');
  const cruises = await fetchAllCruises();
  const output  = {
    success:   true,
    count:     cruises.length,
    cruises,
    scrapedAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, '../public/cruises.json');
  fs.writeFileSync(outPath, JSON.stringify(output));
  console.log(`✓ Wrote ${cruises.length} cruises to ${outPath}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });

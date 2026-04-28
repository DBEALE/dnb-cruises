'use strict';

const { getDepartureRegion } = require('./shared');

const CRUISE_GRAPH_URL        = 'https://www.royalcaribbean.com/cruises/graph';
const CRUISE_SEARCH_FILTERS   = '';
const CRUISE_SEARCH_SORT      = { by: 'PRICE', order: 'ASC' };
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

function normalizeCruise(cruise) {
  const itinerary     = cruise?.masterSailing?.itinerary || {};
  const sailing       = cruise?.lowestPriceSailing || cruise?.displaySailing || {};
  const price         = sailing?.lowestStateroomClassPrice?.price || {};
  const shipName      = itinerary?.ship?.name || '';
  const departurePort = itinerary?.departurePort?.name || '';
  return {
    provider:        'Royal Caribbean',
    id:              `rc_${cruise.id || ''}`,
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPage({ pagination }, attempt = 1) {
  const body = JSON.stringify({
    operationName: 'cruiseSearch_Cruises',
    variables: {
      filters:    CRUISE_SEARCH_FILTERS,
      qualifiers: '',
      nlSearch:   '',
      sort:       CRUISE_SEARCH_SORT,
      pagination,
    },
    query: CRUISE_SEARCH_QUERY,
  });
  const res = await fetch(CRUISE_GRAPH_URL, {
    method: 'POST',
    headers: {
      'content-type':    'application/json',
      'accept':          'application/json',
      'accept-language': 'en-GB,en;q=0.9',
      'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'origin':          'https://www.royalcaribbean.com',
      'referer':         'https://www.royalcaribbean.com/gbr/en/cruises',
    },
    body,
  });
  if (!res.ok) {
    if (attempt < 4) {
      const delay = attempt * 3000;
      console.log(`  [RC] HTTP ${res.status} — retrying in ${delay / 1000}s (attempt ${attempt}/3)…`);
      await sleep(delay);
      return fetchPage({ pagination }, attempt + 1);
    }
    throw new Error(`RC API returned HTTP ${res.status} after 3 retries`);
  }
  const payload = await res.json();
  const results = payload?.data?.cruiseSearch?.results;
  if (!results) throw new Error(payload?.errors?.[0]?.message || 'No results in RC API response');
  return results;
}

async function fetchCruises() {
  const cruises = [];
  const seenIds = new Set();
  let total     = Number.POSITIVE_INFINITY;
  let skip      = 0;

  while (skip < total) {
    const count   = Math.min(CRUISE_SEARCH_PAGE_SIZE, total - skip);
    const results = await fetchPage({ pagination: { count, skip } });
    total = Number.isFinite(results.total) ? results.total : total;

    const page = Array.isArray(results.cruises) ? results.cruises : [];
    if (page.length === 0) break;

    for (const c of page) {
      if (!c?.id || seenIds.has(c.id)) continue;
      seenIds.add(c.id);
      cruises.push(normalizeCruise(c));
    }

    skip += page.length;
    console.log(`  [RC] ${cruises.length} / ${total}`);
    await sleep(500);
  }
  return cruises;
}

module.exports = { name: 'Royal Caribbean', id: 'royal-caribbean', fetchCruises };

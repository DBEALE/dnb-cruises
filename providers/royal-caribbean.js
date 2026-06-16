'use strict';

const GraphQLCruiseProvider = require('./graphql-cruise-provider');
const { getDepartureRegion, estimateSeaDays, cleanText, DEFAULT_USER_AGENT,
        formatChapterPort, extractPortSequenceFromChapters, buildDetailedItinerary,
        getDestinationPort } = require('./shared');
const { createRciRoomSelection, mapWithConcurrency,
        extractPricesFromClassPricing, extractRoomTypePricesFromPayload,
        classifyRoomType } = require('./rci-room-selection');

const ROOM_SELECTION_API_URL = 'https://www.royalcaribbean.com/room-selection/api/v1/rooms';

const rci = createRciRoomSelection({
  apiUrl: ROOM_SELECTION_API_URL,
  brand:  'RCL',
  or:     'https://www.royalcaribbean.com',
  defaultCountry: 'USA',
});

const parseBookingContext        = rci.parseBookingContext;
const fetchRoomSelectionData     = rci.fetchRoomSelectionData;
const fetchRoomSelectionPorts    = rci.fetchRoomSelectionPorts;

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
          stateroomClassPricing {
            stateroomClass { name }
            price { value currency { code } }
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

// Resolves an RC booking/itinerary URL to an absolute UK URL.
//   /booking/landing?...    → https://www.royalcaribbean.com/booking/landing?...
//                             (booking handoff is global; carries country=GBR
//                              and selectedCurrencyCode=GBP via query params
//                              already supplied by the localised API.)
//   itinerary/<slug>?...    → https://www.royalcaribbean.com/gbr/en/itinerary/<slug>?...
//                             (product pages are region-pathed; prefix /gbr/en/
//                              so the user's URL bar shows the UK site directly
//                              rather than relying on a country= redirect.)
function resolveBookingUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  const path = url.replace(/^\.\//, '');
  if (path.startsWith('/')) return `https://www.royalcaribbean.com${path}`;
  return `https://www.royalcaribbean.com/gbr/en/${path}`;
}

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
    itinerary:       cleanText(itinerary?.name),
    departureDate:   sailing?.sailDate || '',
    duration:        itinerary?.totalNights ? `${itinerary.totalNights} Nights` : '',
    departurePort,
    departureRegion: getDepartureRegion(departurePort),
    destination:     itinerary?.destination?.name || '',
    priceFrom:       price?.value != null ? String(price.value) : '',
    currency:        price?.currency?.code || 'USD',
    bookingUrl:      resolveBookingUrl(sailing?.bookingLink || cruise?.productViewLink || ''),
    prices:          extractPricesFromClassPricing(sailing?.stateroomClassPricing),
  };
}

async function enrichCruiseItinerary(cruise) {
  if (!cruise?.bookingUrl) return cruise;

  const context = parseBookingContext(cruise.bookingUrl);
  if (!context) return cruise;

  try {
    const { ports } = await fetchRoomSelectionData(context);
    const detailedItinerary = buildDetailedItinerary(cruise.itinerary, ports);
    return {
      ...cruise,
      itinerary: detailedItinerary || cruise.itinerary,
      destinationPort: getDestinationPort(ports),
      seaDays: estimateSeaDays({
        labels: ports,
        duration: cruise.duration,
        portsIncludeEndpoints: true,
      }),
    };
  } catch (err) {
    console.warn(`  [RC] enrich failed for ${cruise.id || cruise.bookingUrl}: ${err.message}`);
    return cruise;
  }
}

class RoyalCaribbeanProvider extends GraphQLCruiseProvider {
  constructor() {
    super({
      name: 'Royal Caribbean',
      id: 'royal-caribbean',
      graphUrl: CRUISE_GRAPH_URL,
      pageSize: CRUISE_SEARCH_PAGE_SIZE,
      operationName: 'cruiseSearch_Cruises',
      query: CRUISE_SEARCH_QUERY,
      requestHeaders: {
        'origin':  'https://www.royalcaribbean.com',
        'referer': 'https://www.royalcaribbean.com/gbr/en/cruises',
        // Locale headers: 'currency' is load-bearing for GBP prices on the
        // cruiseSearch GraphQL endpoint; 'country' changes the cruise
        // result set / sort to UK-relevant sailings. Both verified by
        // direct API probing.
        'country':  'GBR',
        'currency': 'GBP',
      },
      requestTimeoutLabel: 'RC',
      progressPrefix: '[RC]',
      dedupeById: true,
      requestDelayMs: 500,
    });
  }

  buildRequestVariables(skip) {
    return {
      filters: CRUISE_SEARCH_FILTERS,
      qualifiers: '',
      nlSearch: '',
      sort: CRUISE_SEARCH_SORT,
      pagination: { count: CRUISE_SEARCH_PAGE_SIZE, skip },
    };
  }

  normalizeCruise(cruise) {
    return normalizeCruise(cruise);
  }

  async fetchCruises() {
    const cruises = await super.fetchCruises();
    const cache = new Map();
    const concurrency = 6;

    const enrichedCruises = await mapWithConcurrency(cruises, concurrency, async (cruise) => {
      const context = parseBookingContext(cruise.bookingUrl);
      const cacheKey = context ? rci.roomSelectionCacheKey(context) : null;
      if (!cacheKey) return cruise;
      if (!cache.has(cacheKey)) cache.set(cacheKey, enrichCruiseItinerary(cruise));
      return cache.get(cacheKey);
    });

    if (enrichedCruises.length > 0) {
      console.log(`  ${this.progressPrefix} itinerary enrichment complete (${enrichedCruises.length} sailings)`);
    }

    return enrichedCruises;
  }
}

const provider = new RoyalCaribbeanProvider();

provider.extractPortSequenceFromChapters  = extractPortSequenceFromChapters;
provider.extractRoomTypePricesFromPayload = extractRoomTypePricesFromPayload;
provider.classifyRoomType                 = classifyRoomType;
provider.buildDetailedItinerary           = buildDetailedItinerary;
provider.resolveBookingUrl                = resolveBookingUrl;
provider.parseBookingContext              = parseBookingContext;

module.exports = provider;

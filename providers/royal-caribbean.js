'use strict';

const GraphQLCruiseProvider = require('./graphql-cruise-provider');
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
        'origin': 'https://www.royalcaribbean.com',
        'referer': 'https://www.royalcaribbean.com/gbr/en/cruises',
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
}

module.exports = new RoyalCaribbeanProvider();

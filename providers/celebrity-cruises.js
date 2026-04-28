'use strict';

const cheerio = require('cheerio');
const { randomUUID } = require('node:crypto');

const GraphQLCruiseProvider = require('./graphql-cruise-provider');
const { getDepartureRegion } = require('./shared');

const CELEBRITY_GRAPH_URL     = 'https://www.celebritycruises.com/cruises/graph';
const CELEBRITY_CRUISES_URL   = 'https://www.celebritycruises.com/gb/cruises?country=GBR';
const CELEBRITY_SEARCH_FILTERS = 'voyageType:OCEAN';
const CELEBRITY_SEARCH_SORT    = { by: 'RECOMMENDED' };
const CELEBRITY_SEARCH_PAGE_SIZE = 100;
const CELEBRITY_SEARCH_QUERY = `query cruiseSearch_CruisesRiver($filters: String, $qualifiers: String, $sort: CruiseSearchSort, $pagination: CruiseSearchPagination, $nlSearch: String) {
  cruiseSearch(filters: $filters, qualifiers: $qualifiers, sort: $sort, pagination: $pagination, nlSearch: $nlSearch) {
    results {
      total
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
        displaySailing {
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
    }
  }
}`;

function buildGraphRequestBody(skip) {
  return {
    operationName: 'cruiseSearch_CruisesRiver',
    variables: {
      filters: CELEBRITY_SEARCH_FILTERS,
      sort: CELEBRITY_SEARCH_SORT,
      pagination: { count: CELEBRITY_SEARCH_PAGE_SIZE, skip },
    },
    query: CELEBRITY_SEARCH_QUERY,
  };
}

const SHIP_CLASS = {
  'Celebrity Apex': 'Edge',
  'Celebrity Ascent': 'Edge',
  'Celebrity Beyond': 'Edge',
  'Celebrity Edge': 'Edge',
  'Celebrity Xcel': 'Edge',
  'Celebrity Equinox': 'Solstice',
  'Celebrity Eclipse': 'Solstice',
  'Celebrity Reflection': 'Solstice',
  'Celebrity Silhouette': 'Solstice',
  'Celebrity Solstice': 'Solstice',
  'Celebrity Constellation': 'Millennium',
  'Celebrity Infinity': 'Millennium',
  'Celebrity Millennium': 'Millennium',
  'Celebrity Summit': 'Millennium',
  'Celebrity Flora': 'Galapagos',
  'Celebrity Xpedition': 'Galapagos',
  'Celebrity Xploration': 'Galapagos',
};

const SHIP_LAUNCH_YEAR = {
  'Celebrity Constellation': 2002,
  'Celebrity Eclipse': 2010,
  'Celebrity Equinox': 2009,
  'Celebrity Infinity': 2001,
  'Celebrity Millennium': 2000,
  'Celebrity Solstice': 2008,
  'Celebrity Reflection': 2012,
  'Celebrity Silhouette': 2011,
  'Celebrity Summit': 2001,
  'Celebrity Edge': 2018,
  'Celebrity Apex': 2020,
  'Celebrity Beyond': 2022,
  'Celebrity Ascent': 2023,
  'Celebrity Xcel': 2025,
  'Celebrity Flora': 2019,
  'Celebrity Xpedition': 2004,
  'Celebrity Xploration': 2017,
};

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function resolveBookingUrl(path) {
  const value = cleanText(path);
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) {
    return `https://www.celebritycruises.com${value}`;
  }
  return `https://www.celebritycruises.com/gb/${value}`;
}

function parseDeparturePort(text) {
  const value = cleanText(text);
  const match = value.match(/^(?:Roundtrip from|One-way from):\s*(.+)$/i);
  if (match) {
    const route = match[1].trim();
    const toIndex = route.toLowerCase().indexOf(' to ');
    return toIndex >= 0 ? route.slice(0, toIndex).trim() : route;
  }
  return value;
}

function parsePrice(text) {
  const value = cleanText(text);
  const match = value.match(/[£$]\s*([\d,.]+)/);
  return match ? match[1].replace(/,/g, '') : '';
}

function parseRouteLabel($card) {
  const roundtripText = cleanText($card.find('[data-testid^="cruise-roundtrip-label-"]').text());
  if (roundtripText) return roundtripText;

  const cardText = cleanText($card.text());
  const match = cardText.match(/(?:Roundtrip from|One-way from):\s*([^]+?)\s*Cruise ports:/i);
  return match ? cleanText(match[0].replace(/\s*Cruise ports:.*/i, '')) : '';
}

function normalizeCruiseFromHtml($card) {
  const shipName      = cleanText($card.find('[data-testid^="cruise-ship-label-"]').text());
  const itinerary     = cleanText($card.find('[data-testid^="cruise-name-label-"]').text());
  const duration      = cleanText($card.find('[data-testid^="cruise-duration-label-"]').text());
  const routeLabel    = parseRouteLabel($card);
  const priceText     = cleanText($card.find('[data-testid^="cruise-price-label-"]').text());
  const departurePort = parseDeparturePort(routeLabel);
  const bookingUrl    = $card.attr('data-product-view-link') || '';
  const sailDate      = $card.attr('data-sail-date') || '';

  return {
    provider: 'Celebrity Cruises',
    id: `celebrity_${$card.attr('data-group-id') || ''}`,
    shipName,
    shipClass: SHIP_CLASS[shipName] || '',
    shipLaunchYear: SHIP_LAUNCH_YEAR[shipName] || null,
    itinerary,
    departureDate: sailDate,
    duration: duration.replace(/^([0-9]+) Nights?$/i, '$1 Nights'),
    departurePort,
    departureRegion: getDepartureRegion(departurePort),
    destination: itinerary,
    priceFrom: parsePrice(priceText),
    currency: 'GBP',
    bookingUrl: bookingUrl ? `https://www.celebritycruises.com/gb/${bookingUrl}` : '',
  };
}

function normalizeCruise(cruise) {
  const itinerary = cruise?.masterSailing?.itinerary || {};
  const sailing = cruise?.lowestPriceSailing || cruise?.displaySailing || {};
  const price = sailing?.lowestStateroomClassPrice?.price || {};
  const shipName = cleanText(itinerary?.ship?.name);
  const departurePort = cleanText(itinerary?.departurePort?.name);
  const itineraryName = cleanText(itinerary?.name);

  return {
    provider: 'Celebrity Cruises',
    id: `celebrity_${cruise?.id || ''}`,
    shipName,
    shipClass: SHIP_CLASS[shipName] || '',
    shipLaunchYear: SHIP_LAUNCH_YEAR[shipName] || null,
    itinerary: itineraryName,
    departureDate: cleanText(sailing?.sailDate),
    duration: itinerary?.totalNights ? `${itinerary.totalNights} Nights` : '',
    departurePort,
    departureRegion: getDepartureRegion(departurePort),
    destination: cleanText(itinerary?.destination?.name),
    priceFrom: price?.value != null ? String(price.value) : '',
    currency: price?.currency?.code || 'GBP',
    bookingUrl: resolveBookingUrl(sailing?.bookingLink || cruise?.productViewLink || ''),
  };
}

function parseCruisesFromHtml(html) {
  const $ = cheerio.load(html);
  return $('[data-testid^="cruise-card-container_"]')
    .map((_, element) => normalizeCruiseFromHtml($(element)))
    .get()
    .filter(cruise => cruise.id && cruise.shipName);
}

class CelebrityCruisesProvider extends GraphQLCruiseProvider {
  constructor() {
    super({
      name: 'Celebrity Cruises',
      id: 'celebrity-cruises',
      graphUrl: CELEBRITY_GRAPH_URL,
      pageSize: CELEBRITY_SEARCH_PAGE_SIZE,
      operationName: 'cruiseSearch_CruisesRiver',
      query: CELEBRITY_SEARCH_QUERY,
      requestHeaders: {
        'origin': 'https://www.celebritycruises.com',
        'referer': CELEBRITY_CRUISES_URL,
        'brand': 'C',
        'country': 'GBR',
        'language': 'en-gb',
        'currency': 'USD',
        'office': 'LON',
        'countryalpha2code': 'GB',
        'apollographql-client-name': 'cel-NextGen-Cruise-Search',
        'skip_authentication': 'true',
        'request-timeout': '20',
        'apollographql-query-name': 'cruiseSearch_CruisesRiver',
      },
      requestTimeoutLabel: 'Celebrity',
      progressPrefix: '[Celebrity]',
      dedupeById: false,
      requestDelayMs: 500,
    });
  }

  buildRequestVariables(skip) {
    return {
      filters: CELEBRITY_SEARCH_FILTERS,
      sort: CELEBRITY_SEARCH_SORT,
      pagination: { count: CELEBRITY_SEARCH_PAGE_SIZE, skip },
    };
  }

  parseCruisesFromHtml(html) {
    return parseCruisesFromHtml(html);
  }

  normalizeCruise(cruise) {
    return normalizeCruise(cruise);
  }
}

module.exports = new CelebrityCruisesProvider();
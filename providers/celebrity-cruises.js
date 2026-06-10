'use strict';

const cheerio = require('cheerio');

const GraphQLCruiseProvider = require('./graphql-cruise-provider');
const { getDepartureRegion, estimateSeaDays, cleanText, DEFAULT_USER_AGENT,
        formatChapterPort, extractPortSequenceFromChapters, buildDetailedItinerary } = require('./shared');
const { createRciRoomSelection, mapWithConcurrency,
        classifyRoomType, extractRoomTypePricesFromPayload,
        extractPricesFromClassPricing, timeoutSignal } = require('./rci-room-selection');

const CELEBRITY_GRAPH_URL              = 'https://www.celebritycruises.com/cruises/graph';
const CELEBRITY_ROOM_SELECTION_API_URL = 'https://www.celebritycruises.com/room-selection/api/v1/rooms';
const CELEBRITY_CRUISES_URL   = 'https://www.celebritycruises.com/gb/cruises?country=GBR';
const CELEBRITY_SEARCH_FILTERS = 'voyageType:OCEAN';
const CELEBRITY_SEARCH_SORT    = { by: 'RECOMMENDED' };
const CELEBRITY_SEARCH_PAGE_SIZE = 100;

const rci = createRciRoomSelection({
  apiUrl: CELEBRITY_ROOM_SELECTION_API_URL,
  brand:  'C',
  or:     'https://www.celebritycruises.com',
  defaultCountry: 'GBR',
});

/**
 * Celebrity parses BOTH URL formats and includes the extras needed to
 * build the type-and-subtype page URL (groupId, shipCode). The shared
 * rci.parseBookingContext returns only the four always-needed fields;
 * we layer the extras on top so the existing tests (which expect
 * groupId/shipCode) continue to pass.
 */
function parseBookingContext(bookingUrl) {
  const base = rci.parseBookingContext(bookingUrl);
  if (!base) return null;
  return { ...base, ...rci.parseBookingExtras(bookingUrl) };
}
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
          stateroomClassPricing {
            stateroomClass { name }
            price { value currency { code } }
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
    }
  }
}`;

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

function resolveBookingUrl(path) {
  const value = cleanText(path);
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) {
    return `https://www.celebritycruises.com${value}`;
  }
  return `https://www.celebritycruises.com/gb/${value}`;
}

/**
 * Parses a Celebrity booking URL and returns the filter fields needed to call
 * the room-selection API.  Celebrity uses two URL formats:
 *   - /booking-cruise/selectRoom/…?pID=<pkg>&sDT=<date>&country=<cc>
 *   - /gb/itinerary/…?packageCode=<pkg>&sailDate=<date>&country=<cc>
 *
 * @param {string} bookingUrl
 * @returns {{packageCode:string, sailDate:string, groupId:string, shipCode:string, selectedCurrencyCode:'GBP', country:string} | null}
 */
function parseBookingContext(bookingUrl) {
  if (!bookingUrl) return null;

  try {
    const url = new URL(bookingUrl);
    const packageCode = cleanText(url.searchParams.get('packageCode') || url.searchParams.get('pID'));
    const sailDate    = cleanText(url.searchParams.get('sailDate')    || url.searchParams.get('sDT'));
    const groupId     = cleanText(url.searchParams.get('groupId'));
    const shipCode    = cleanText(url.searchParams.get('shipCode') || url.searchParams.get('sCD'));
    const country     = cleanText(url.searchParams.get('country')) || 'GBR';

    if (!packageCode || !sailDate) return null;

    return { packageCode, sailDate, groupId, shipCode, selectedCurrencyCode: 'GBP', country };
  } catch {
    return null;
  }
}

function parsePrice(text) {
  const value = cleanText(text);
  const match = value.match(/[£$]\s*([\d,.]+)/);
  return match ? match[1].replace(/,/g, '') : '';
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
    prices: { inside: null, oceanView: null, balcony: null, suite: null },
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
    prices: extractPricesFromClassPricing(sailing?.stateroomClassPricing),
  };
}

// ─── Room-selection itinerary enrichment ──────────────────────────────────────

function buildRoomSelectionTypeUrl(context, roomType = 'INTERIOR') {
  if (!context?.packageCode || !context?.sailDate || !context?.groupId || !context?.shipCode) return '';

  const url = new URL('https://www.celebritycruises.com/gb/room-selection/type-and-subtype');
  url.searchParams.set('groupId', context.groupId);
  url.searchParams.set('country', context.country || 'GBR');
  url.searchParams.set('selectedCurrencyCode', context.selectedCurrencyCode || 'GBP');
  url.searchParams.set('packageCode', context.packageCode);
  url.searchParams.set('sailDate', context.sailDate);
  url.searchParams.set('shipCode', context.shipCode);
  url.searchParams.set('roomIndex', '0');
  url.searchParams.set('r0a', '2');
  url.searchParams.set('r0c', '0');
  url.searchParams.set('r0b', 'n');
  url.searchParams.set('r0r', 'n');
  url.searchParams.set('r0s', 'n');
  url.searchParams.set('r0q', 'n');
  url.searchParams.set('r0t', 'n');
  url.searchParams.set('r0d', roomType || 'INTERIOR');
  url.searchParams.set('r0D', 'y');
  url.searchParams.set('rgVisited', 'true');
  url.searchParams.set('r0C', 'y');
  return url.toString();
}

function inferRoomTypeFromRoomSelectionUrl(url) {
  const value = cleanText(url).toUpperCase();
  const query = value.includes('?') ? value.slice(value.indexOf('?') + 1) : value;
  const params = new URLSearchParams(query);
  const raw = cleanText(params.get('R0D') || params.get('r0d') || '');

  if (/INTERIOR|INSIDE/.test(raw)) return 'inside';
  if (/OCEAN/.test(raw)) return 'oceanView';
  if (/BALCONY|VERANDA/.test(raw)) return 'balcony';
  if (/SUITE/.test(raw)) return 'suite';

  if (/INTERIOR|INSIDE/.test(value)) return 'inside';
  if (/OCEAN/.test(value)) return 'oceanView';
  if (/BALCONY|VERANDA/.test(value)) return 'balcony';
  if (/SUITE/.test(value)) return 'suite';
  return null;
}

function extractRoomSelectionPriceFromHtml(html) {
  const $ = cheerio.load(html || '');
  const primary = cleanText($('[data-testid="main-price-amount"]').first().text());
  return parsePrice(primary);
}

function extractRoomTypePricesFromRoomSelectionHtml(html) {
  const prices = { inside: null, oceanView: null, balcony: null, suite: null };
  const $ = cheerio.load(html || '');

  const readTabPrice = (testId) => {
    const text = cleanText($(`button[data-testid="${testId}"] span[aria-hidden="true"]`).first().text());
    const price = parsePrice(text);
    return price || null;
  };

  prices.inside = readTabPrice('tab-INTERIOR');
  prices.oceanView = readTabPrice('tab-OUTSIDE');
  prices.balcony = readTabPrice('tab-BALCONY');
  prices.suite = readTabPrice('tab-DELUXE');

  if (Object.values(prices).some(Boolean)) return prices;

  const bodyText = cleanText($('body').text() || $.root().text());
  const scriptText = cleanText($('script').map((_, el) => $(el).text()).get().join(' '));
  const text = [scriptText, bodyText].filter(Boolean).join(' ');

  const extractByLabel = (patterns) => {
    const match = patterns
      .map(pattern => {
        const regex = new RegExp(`${pattern.source}[\\s\\S]{0,180}?£\\s*[\\d,.]+`, 'ig');
        return [...text.matchAll(regex)].map(result => result[0]);
      })
      .flat()
      .find(chunk => !/\bstateroom\b/i.test(chunk) && !/\bstarting\s+from\b/i.test(chunk));
    return match ? parsePrice(match) : null;
  };

  prices.inside = prices.inside || extractByLabel([/\bInside\b/i]);
  prices.oceanView = prices.oceanView || extractByLabel([/\bOcean View\b/i]);
  prices.balcony = prices.balcony || extractByLabel([/\bVeranda\b/i, /\bBalcony\b/i]);
  prices.suite = prices.suite || extractByLabel([/\bThe Retreat\b/i, /\bSuite\b/i]);

  return prices;
}

function inferRoomTypeFromRoomSelectionHtml(html) {
  const $ = cheerio.load(html || '');
  const text = cleanText($('body').text() || $.root().text());

  if (/\bInside Stateroom\b/i.test(text) || /\bInside\b/i.test(text)) return 'inside';
  if (/\bOcean View Stateroom\b/i.test(text) || /\bOcean View\b/i.test(text)) return 'oceanView';
  if (/\bConcierge Class\b/i.test(text) || /\bAquaClass\b/i.test(text) || /\bVeranda\b/i.test(text) || /\bBalcony\b/i.test(text)) return 'balcony';
  if (/\bSuite\b/i.test(text)) return 'suite';
  return null;
}

function mergeRoomTypePrices(basePrices, overridePrices) {
  const merged = { inside: null, oceanView: null, balcony: null, suite: null };
  for (const key of Object.keys(merged)) {
    const override = cleanText(overridePrices?.[key]);
    const base = cleanText(basePrices?.[key]);
    merged[key] = override || base || null;
  }
  return merged;
}

function getLowestRoomTypePrice(prices) {
  const values = Object.values(prices || {})
    .map(value => parseFloat(value))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  return values.length > 0 ? String(values[0]) : '';
}

const fetchRoomSelectionData = rci.fetchRoomSelectionData;

async function fetchRoomSelectionPagePrice(context) {
  const roomSelectionUrl = buildRoomSelectionTypeUrl(context);
  if (!roomSelectionUrl) {
    return {
      roomType: null,
      price: '',
      prices: { inside: null, oceanView: null, balcony: null, suite: null },
    };
  }

  let response;
  try {
    response = await fetch(roomSelectionUrl, {
      headers: {
        'accept':        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-GB,en;q=0.9',
        'user-agent':    DEFAULT_USER_AGENT,
      },
      signal: timeoutSignal(15_000),
    });
  } catch (err) {
    console.warn(`  [Celebrity] page-price fetch failed for ${context.packageCode}: ${err.message}`);
    return {
      roomType: null,
      price: '',
      prices: { inside: null, oceanView: null, balcony: null, suite: null },
    };
  }

  if (!response.ok) {
    return {
      roomType: null,
      price: '',
      prices: { inside: null, oceanView: null, balcony: null, suite: null },
    };
  }

  const html = await response.text();
  const roomType = inferRoomTypeFromRoomSelectionHtml(html)
    || inferRoomTypeFromRoomSelectionUrl(roomSelectionUrl)
    || inferRoomTypeFromRoomSelectionUrl(response.url || '');
  return {
    roomType,
    price: extractRoomSelectionPriceFromHtml(html),
    prices: extractRoomTypePricesFromRoomSelectionHtml(html),
  };
}

/** @deprecated Use fetchRoomSelectionData instead. */
async function fetchRoomSelectionPorts(context) {
  const { ports } = await fetchRoomSelectionData(context);
  return ports;
}

async function enrichCruiseItinerary(cruise) {
  if (!cruise?.bookingUrl) return cruise;

  const context = parseBookingContext(cruise.bookingUrl);
  if (!context) return cruise;

  try {
    const [{ ports, prices }, pagePrice] = await Promise.all([
      fetchRoomSelectionData(context),
      fetchRoomSelectionPagePrice(context),
    ]);
    const detailedItinerary = buildDetailedItinerary(cruise.itinerary, ports);
    const mergedPrices = mergeRoomTypePrices(
      mergeRoomTypePrices(cruise.prices, prices),
      pagePrice.prices,
    );
    if (pagePrice.price && pagePrice.roomType) {
      mergedPrices[pagePrice.roomType] = pagePrice.price;
    }
    const livePriceFrom = getLowestRoomTypePrice(mergedPrices) || pagePrice.price;
    const hasLivePagePrices = Object.values(pagePrice.prices || {}).some(value => Boolean(cleanText(value)));
    return {
      ...cruise,
      itinerary: detailedItinerary || cruise.itinerary,
      prices: mergedPrices,
      priceFrom: livePriceFrom || cruise.priceFrom,
      currency: (hasLivePagePrices || pagePrice.price)
        ? (context.selectedCurrencyCode || cruise.currency || 'GBP')
        : cruise.currency,
      seaDays: estimateSeaDays({
        labels: ports,
        duration: cruise.duration,
        portsIncludeEndpoints: true,
      }),
    };
  } catch (err) {
    console.warn(`  [Celebrity] enrich failed for ${cruise.id || cruise.bookingUrl}: ${err.message}`);
    return cruise;
  }
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

  async fetchCruises() {
    const cruises     = await super.fetchCruises();
    const cache       = new Map();
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

const provider = new CelebrityCruisesProvider();

provider.extractPortSequenceFromChapters  = extractPortSequenceFromChapters;
provider.extractRoomTypePricesFromPayload = extractRoomTypePricesFromPayload;
provider.classifyRoomType                 = classifyRoomType;
provider.buildDetailedItinerary          = buildDetailedItinerary;
provider.parseBookingContext             = parseBookingContext;
provider.buildRoomSelectionTypeUrl       = buildRoomSelectionTypeUrl;
provider.extractRoomSelectionPriceFromHtml = extractRoomSelectionPriceFromHtml;
provider.extractRoomTypePricesFromRoomSelectionHtml = extractRoomTypePricesFromRoomSelectionHtml;
provider.inferRoomTypeFromRoomSelectionHtml = inferRoomTypeFromRoomSelectionHtml;
provider.mergeRoomTypePrices             = mergeRoomTypePrices;
provider.getLowestRoomTypePrice          = getLowestRoomTypePrice;

module.exports = provider;

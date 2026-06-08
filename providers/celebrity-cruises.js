'use strict';

const cheerio = require('cheerio');
const { randomUUID } = require('node:crypto');

const GraphQLCruiseProvider = require('./graphql-cruise-provider');
const { getDepartureRegion } = require('./shared');

const CELEBRITY_GRAPH_URL              = 'https://www.celebritycruises.com/cruises/graph';
const CELEBRITY_ROOM_SELECTION_API_URL = 'https://www.celebritycruises.com/room-selection/api/v1/rooms';
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

/**
 * Parses a Celebrity booking URL and returns the filter fields needed to call
 * the room-selection API.  Celebrity uses two URL formats:
 *   - /booking-cruise/selectRoom/…?pID=<pkg>&sDT=<date>&country=<cc>
 *   - /gb/itinerary/…?packageCode=<pkg>&sailDate=<date>&country=<cc>
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

function formatChapterPort(port) {
  const name   = cleanText(port?.name);
  const region = cleanText(port?.region);
  if (!name) return '';
  if (!region || /^cruising$/i.test(name)) return name;
  if (name.toLowerCase().includes(region.toLowerCase())) return name;
  return `${name}, ${region}`;
}

/** Returns an ordered list of port labels from a room-selection API chapters array. */
function extractPortSequenceFromChapters(chapters) {
  if (!Array.isArray(chapters)) return [];
  return chapters.map(chapter => formatChapterPort(chapter?.port)).filter(Boolean);
}

/**
 * Builds a detailed itinerary string of the form:
 *   "<summaryName>: <stop1>, <stop2>, …"
 * The first port in the sequence (the departure port) is omitted from the
 * stops list.  If the ports list is empty or contains only one non-cruising
 * entry the original summary name is returned unchanged.
 */
function buildDetailedItinerary(summaryName, ports) {
  const normalizedPorts  = Array.from(new Set((ports || []).map(cleanText).filter(Boolean)));
  const nonCruisingPorts = normalizedPorts.filter(port => !/^cruising$/i.test(port));
  if (nonCruisingPorts.length <= 1) return cleanText(summaryName);

  const stops = nonCruisingPorts.slice(1);
  if (stops.length === 0) return cleanText(summaryName);

  return `${cleanText(summaryName)}: ${stops.join(', ')}`;
}

function buildRoomSelectionFilter(context) {
  return {
    countryCode:  context.country,
    packageId:    context.packageCode,
    sailDate:     context.sailDate,
    currencyCode: context.selectedCurrencyCode,
    language:     'en',
    options:      false,
    roomNumbers:  false,
    rooms:        [{ adultCount: 2, childCount: 0 }],
  };
}

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

/**
 * Classifies a stateroom entry from the room-selection API into one of the
 * four standard room types: inside, oceanView, balcony, or suite.
 * Returns null when the entry cannot be mapped.
 *
 * @param {object} entry - A stateroom-class / category entry from the API payload.
 * @returns {'inside'|'oceanView'|'balcony'|'suite'|null}
 */
function classifyRoomType(entry) {
  const id   = String(entry?.id   || entry?.classId   || entry?.code  || entry?.type  || '').toUpperCase();
  const name = String(entry?.name || entry?.className || entry?.label || '').toLowerCase();

  if (/^(x|i|int|interior|inside)$/i.test(id) || /\b(interior|inside)\b/.test(name))         return 'inside';
  if (/^(n|o|ov|ocean|oceanview|seaview)$/i.test(id) || /\b(ocean.?view|sea.?view|oceanfront|outside.?view)\b/.test(name)) return 'oceanView';
  if (/^(b|bal|balcony)$/i.test(id) || /\b(balcony|veranda)\b/.test(name))                   return 'balcony';
  if (/^(s|gs|js|suite|suites)$/i.test(id) || /\b(suite|retreat)\b/.test(name))              return 'suite';
  return null;
}

/**
 * Extracts a per-person price amount from various possible price object shapes.
 *
 * @param {*} priceObj - Price field from an API stateroom entry.
 * @returns {number|null}
 */
function extractPriceFromEntry(priceObj) {
  if (!priceObj) return null;
  const scalar = parseFloat(priceObj?.amount ?? priceObj?.value ?? priceObj?.fare ?? (typeof priceObj === 'number' ? priceObj : null));
  if (Number.isFinite(scalar) && scalar > 0) return Math.round(scalar * 100) / 100;
  return null;
}

/**
 * Extracts per-room-type prices from a room-selection API payload.
 *
 * @param {object} payload - Parsed JSON response from the room-selection API.
 * @returns {{ inside: string|null, oceanView: string|null, balcony: string|null, suite: string|null }}
 */
function extractRoomTypePricesFromPayload(payload) {
  const prices = { inside: null, oceanView: null, balcony: null, suite: null };

  const candidates = [
    ...(Array.isArray(payload?.sailing?.stateroomClasses) ? payload.sailing.stateroomClasses : []),
    ...(Array.isArray(payload?.sailing?.categories)       ? payload.sailing.categories       : []),
    ...(Array.isArray(payload?.stateroomClasses)          ? payload.stateroomClasses          : []),
    ...(Array.isArray(payload?.categories)                ? payload.categories                : []),
  ];

  for (const entry of candidates) {
    const type = classifyRoomType(entry);
    if (!type || prices[type] !== null) continue;

    const priceField = entry?.lowestPrice ?? entry?.price ?? entry?.perPersonPrice ?? entry?.startingFrom ?? entry?.fare;
    const amount = extractPriceFromEntry(priceField);
    if (amount !== null) prices[type] = String(amount);
  }

  return prices;
}

function extractPricesFromClassPricing(stateroomClassPricing) {
  const prices = { inside: null, oceanView: null, balcony: null, suite: null };
  if (!Array.isArray(stateroomClassPricing)) return prices;
  for (const item of stateroomClassPricing) {
    const type = classifyRoomType({ name: item?.stateroomClass?.name || '' });
    if (!type || prices[type] !== null) continue;
    const value = item?.price?.value;
    if (value != null) prices[type] = String(value);
  }
  return prices;
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

async function fetchRoomSelectionData(context) {
  const filter = buildRoomSelectionFilter(context);
  const params = new URLSearchParams({
    filter: JSON.stringify(filter),
    or: 'https://www.celebritycruises.com',
  });

  const response = await fetch(`${CELEBRITY_ROOM_SELECTION_API_URL}?${params}`, {
    headers: {
      brand:              'C',
      country:            context.country,
      'content-type':     'application/json',
      'accept-language':  'en-GB,en;q=0.9',
      'user-agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) return { ports: [], prices: { inside: null, oceanView: null, balcony: null, suite: null } };

  const payload = await response.json();
  return {
    ports:  extractPortSequenceFromChapters(payload?.sailing?.itinerary?.chapters),
    prices: extractRoomTypePricesFromPayload(payload),
  };
}

async function fetchRoomSelectionPagePrice(context) {
  const roomSelectionUrl = buildRoomSelectionTypeUrl(context);
  if (!roomSelectionUrl) {
    return {
      roomType: null,
      price: '',
      prices: { inside: null, oceanView: null, balcony: null, suite: null },
    };
  }

  const response = await fetch(roomSelectionUrl, {
    headers: {
      'accept':        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-GB,en;q=0.9',
      'user-agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });

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
    };
  } catch {
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
    const cruises         = await super.fetchCruises();
    const cache           = new Map();
    const enrichedCruises = new Array(cruises.length);
    const concurrency     = 6;
    let cursor            = 0;

    const worker = async () => {
      while (cursor < cruises.length) {
        const index   = cursor;
        cursor       += 1;
        const cruise  = cruises[index];
        const context = parseBookingContext(cruise.bookingUrl);
        const cacheKey = context
          ? `${context.packageCode}|${context.sailDate}|${context.selectedCurrencyCode}|${context.country}`
          : null;

        if (!cacheKey) {
          enrichedCruises[index] = cruise;
          continue;
        }

        if (!cache.has(cacheKey)) {
          cache.set(cacheKey, enrichCruiseItinerary(cruise));
        }

        enrichedCruises[index] = await cache.get(cacheKey);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

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

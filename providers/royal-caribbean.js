'use strict';

const GraphQLCruiseProvider = require('./graphql-cruise-provider');
const { getDepartureRegion, estimateSeaDays, cleanText, DEFAULT_USER_AGENT,
        formatChapterPort, extractPortSequenceFromChapters, buildDetailedItinerary,
        getDestinationPort } = require('./shared');
const { createRciRoomSelection, mapWithConcurrency,
        extractPricesFromClassPricing, extractRoomTypePricesFromPayload,
        classifyRoomType, canReuseEnrichment, applyReusedEnrichment } = require('./rci-room-selection');

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
        sailings {
          id
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
  'Legend of the Seas':       2026,
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
  'Star of the Seas':         2025,
  'Symphony of the Seas':     2018,
  'Utopia of the Seas':       2024,
  'Vision of the Seas':       1998,
  'Voyager of the Seas':      1999,
  'Wonder of the Seas':       2022,
};

const SHIP_CLASS = {
  'Icon of the Seas':         'Icon',
  'Legend of the Seas':       'Icon',
  'Star of the Seas':         'Icon',
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

/**
 * Stable per-departure id for one sailing of a cruise product.
 *
 * RC's own `sailings[].id` is already `<packageCode>_<sailDate>`, which is
 * exactly the identity we want: it survives price changes and re-sorting of the
 * search results. Falls back to deriving the same shape from the sailing's
 * booking link, then to the product id plus the sail date.
 */
function sailingKey(cruise, sailing) {
  const own = cleanText(sailing?.id);
  if (own) return own;

  const sailDate = cleanText(sailing?.sailDate);
  try {
    const packageCode = new URL(resolveBookingUrl(sailing?.bookingLink)).searchParams.get('packageCode');
    if (packageCode && sailDate) return `${packageCode}_${sailDate}`;
  } catch { /* fall through */ }

  const productId = cleanText(cruise?.id);
  if (productId && sailDate) return `${productId}_${sailDate}`;
  return productId;
}

function normalizeSailing(cruise, sailing, id) {
  const itinerary     = cruise?.masterSailing?.itinerary || {};
  const price         = sailing?.lowestStateroomClassPrice?.price || {};
  const shipName      = itinerary?.ship?.name || '';
  const departurePort = itinerary?.departurePort?.name || '';
  return {
    provider:        'Royal Caribbean',
    id,
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

/**
 * Expands one cruiseSearch result into one record per departure.
 *
 * A `cruise` in RC's cruiseSearch is a product (ship × route × package), not a
 * departure: `lowestPriceSailing` is merely its cheapest date, while `sailings`
 * holds every date — each with its own booking link and per-class pricing, in
 * the same response. Reading only `lowestPriceSailing` published one date per
 * route and dropped the rest (~70% of the catalogue).
 *
 * `priorIdByKey` maps a sailing key to the id a previous run published it under,
 * so ids stay stable across the switch from product-level to departure-level
 * records (keeping price history attached and avoiding a phantom archive entry
 * for every product). New sailings simply use their own key.
 */
function normalizeCruise(cruise, priorIdByKey = null) {
  const sailings = Array.isArray(cruise?.sailings) && cruise.sailings.length > 0
    ? cruise.sailings
    : [cruise?.lowestPriceSailing || cruise?.displaySailing].filter(Boolean);

  return sailings.map(sailing => {
    const key = sailingKey(cruise, sailing);
    const id = (key && priorIdByKey?.get(key)) || `rc_${key || ''}`;
    return normalizeSailing(cruise, sailing, id);
  });
}

/**
 * Indexes the previous run's records by sailing key so `normalizeCruise` can
 * keep publishing each departure under the id it already has. Records whose
 * booking URL carries no packageCode/sailDate are skipped — they cannot be
 * matched to a fresh sailing.
 */
function buildPriorIdIndex(priorById) {
  const index = new Map();
  if (!(priorById instanceof Map)) return index;
  for (const cruise of priorById.values()) {
    const context = parseBookingContext(cruise?.bookingUrl);
    if (!context || !cruise.id) continue;
    const key = `${context.packageCode}_${context.sailDate}`;
    if (!index.has(key)) index.set(key, cruise.id);
  }
  return index;
}

/**
 * Fetches the port sequence for a route. Depends only on the package, not the
 * departure date, so one call covers every sailing of the product.
 */
async function fetchItineraryPorts(context) {
  const { ports } = await fetchRoomSelectionData(context);
  return Array.isArray(ports) && ports.length > 0 ? ports : null;
}

function applyItineraryPorts(cruise, ports, enrichedAt) {
  if (!ports) return cruise;
  return {
    ...cruise,
    itinerary: buildDetailedItinerary(cruise.itinerary, ports) || cruise.itinerary,
    destinationPort: getDestinationPort(ports),
    seaDays: estimateSeaDays({
      labels: ports,
      duration: cruise.duration,
      portsIncludeEndpoints: true,
    }),
    // Stamp only on success so a failed (degraded) enrichment is retried next
    // run rather than cached. Enables cross-run reuse (see fetchCruises).
    enrichedAt,
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
      requestDelayMs: 2000,
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
    return normalizeCruise(cruise, this.priorIdByKey);
  }

  // Indirected through the instance so tests can substitute the room-selection
  // call without reaching across modules.
  fetchItineraryPorts(context) {
    return fetchItineraryPorts(context);
  }

  async fetchCruises(options = {}) {
    const priorById = options.priorEnrichmentById instanceof Map ? options.priorEnrichmentById : new Map();
    // Consumed by normalizeCruise() during super.fetchCruises() below.
    this.priorIdByKey = buildPriorIdIndex(priorById);
    const cruises = await super.fetchCruises();
    // Reuse last run's itinerary enrichment for unchanged sailings so we only
    // hit the room-selection endpoint for new/changed ones (plus a rolling
    // refresh). RC prices come from the GraphQL search, not enrichment, so this
    // never staleness-freezes prices. See canReuseEnrichment for the safety net.
    const now = Date.now();
    const enrichedAt = new Date(now).toISOString();
    // Keyed on the route, not the departure: a product's port sequence is fixed,
    // so one room-selection call serves all of its sailings. Keying on sailDate
    // here would multiply the calls by the number of departures per route — and
    // that endpoint is the one that 503s under load.
    const cache = new Map();
    const concurrency = 2;
    let fetched = 0;
    let reused = 0;

    const enrichedCruises = await mapWithConcurrency(cruises, concurrency, async (cruise) => {
      const prior = priorById.get(cruise.id);
      if (canReuseEnrichment(prior, cruise, now)) {
        reused += 1;
        return applyReusedEnrichment(cruise, prior);
      }
      const context = parseBookingContext(cruise.bookingUrl);
      const cacheKey = context ? rci.routeCacheKey(context) : null;
      if (!cacheKey) return cruise;
      if (!cache.has(cacheKey)) {
        fetched += 1;
        cache.set(cacheKey, this.fetchItineraryPorts(context).catch(err => {
          console.warn(`  [RC] enrich failed for ${cruise.id || cruise.bookingUrl}: ${err.message}`);
          return null;
        }));
      }
      return applyItineraryPorts(cruise, await cache.get(cacheKey), enrichedAt);
    });

    if (enrichedCruises.length > 0) {
      console.log(`  ${this.progressPrefix} itinerary enrichment: ${fetched} fetched, ${reused} reused (${enrichedCruises.length} sailings)`);
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
provider.normalizeSearchResult            = normalizeCruise;
provider.buildPriorIdIndex                = buildPriorIdIndex;
provider.sailingKey                       = sailingKey;

module.exports = provider;

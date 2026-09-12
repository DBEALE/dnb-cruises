'use strict';

const { chromium } = require('@playwright/test');

const { getDepartureRegion, estimateSeaDays, cleanText, getDestinationPort, fetchWithTimeout } = require('./shared');
const { refreshNcl } = require('./ncl-incremental');

const NCL_BASE_URL = 'https://www.ncl.com';
const NCL_CRUISES_URL = 'https://www.ncl.com/uk/en/vacations';
const NCL_PAGE_WAIT_MS = 800;
const NCL_MAX_PAGINATION_STEPS = 60;
const NCL_EMPTY_LOAD_RETRIES = 2;

const SHIP_CLASS = {
  'Norwegian Aqua': 'Prima',
  'Norwegian Luna': 'Prima',
  'Norwegian Prima': 'Prima',
  'Norwegian Viva': 'Prima',
  'Norwegian Bliss': 'Breakaway Plus',
  'Norwegian Encore': 'Breakaway Plus',
  'Norwegian Escape': 'Breakaway Plus',
  'Norwegian Joy': 'Breakaway Plus',
  'Norwegian Breakaway': 'Breakaway',
  'Norwegian Getaway': 'Breakaway',
  'Norwegian Dawn': 'Dawn',
  'Norwegian Star': 'Dawn',
  'Norwegian Gem': 'Jewel',
  'Norwegian Jade': 'Jewel',
  'Norwegian Jewel': 'Jewel',
  'Norwegian Pearl': 'Jewel',
  'Norwegian Sun': 'Sun',
  'Norwegian Sky': 'Sun',
  'Norwegian Spirit': 'Spirit',
  'Norwegian Epic': 'Epic',
  'Pride of America': 'America',
};

const SHIP_LAUNCH_YEAR = {
  'Norwegian Sky': 1999,
  'Norwegian Sun': 2001,
  'Norwegian Spirit': 1998,
  'Norwegian Star': 2001,
  'Norwegian Dawn': 2002,
  'Norwegian Jewel': 2005,
  'Norwegian Pearl': 2006,
  'Norwegian Jade': 2006,
  'Norwegian Gem': 2007,
  'Norwegian Epic': 2010,
  'Norwegian Breakaway': 2013,
  'Norwegian Getaway': 2014,
  'Pride of America': 2005,
  'Norwegian Escape': 2015,
  'Norwegian Joy': 2017,
  'Norwegian Bliss': 2018,
  'Norwegian Encore': 2019,
  'Norwegian Prima': 2022,
  'Norwegian Viva': 2023,
  'Norwegian Luna': 2024,
  'Norwegian Aqua': 2025,
};

function toNumber(value) {
  const parsed = Number.parseFloat(String(value || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function extractFirstDateText(value) {
  const text = cleanText(value);
  if (!text) return '';

  const month = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const patterns = [
    new RegExp(`\\b(?:mon|tue|wed|thu|fri|sat|sun)\\s+\\d{1,2}\\s+${month}(?:\\s+\\d{4})?`, 'i'),
    new RegExp(`\\b${month}[,\\s-]*\\d{4}`, 'i'),
    /\b\d{4}-\d{2}-\d{2}\b/,
    new RegExp(`\\b${month}\\s+\\d{1,2}`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return cleanText(match[0]);
  }

  return text;
}

function resolveUrl(path) {
  const value = cleanText(path);
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return `${NCL_BASE_URL}${value}`;
  return `${NCL_BASE_URL}/uk/en/${value.replace(/^\/+/, '')}`;
}

function extractItineraryCode(href) {
  try {
    return new URL(href).searchParams.get('itineraryCode') || '';
  } catch {
    return '';
  }
}

function isRoundTripBookingUrl(bookingUrl) {
  try {
    const fullUrl = bookingUrl.startsWith('/') ? `${NCL_BASE_URL}${bookingUrl}` : bookingUrl;
    return /(?:^|-)round-?trip(?:-|$)/i.test(new URL(fullUrl).pathname);
  } catch {
    return false;
  }
}

/**
 * Extracts itinerary stop names from an NCL booking URL slug.
 * NCL booking URLs encode the itinerary ports in their path, e.g.:
 *   /uk/en/cruises/7-day-caribbean-round-trip-new-orleans-cozumel-and-costa-maya-{CODE}
 * The departure port is excluded from the returned list.
 *
 * @param {string} bookingUrl - Full NCL booking URL or relative path.
 * @param {string} [departurePort] - Known departure port name (used to skip the home port).
 * @returns {string[]} Port names in title case, excluding the departure port.
 */
function extractPortsFromSlug(bookingUrl, departurePort) {
  try {
    const fullUrl = bookingUrl.startsWith('/') ? `${NCL_BASE_URL}${bookingUrl}` : bookingUrl;
    const url = new URL(fullUrl);
    const pathMatch = url.pathname.match(/\/cruises\/(.+)/);
    if (!pathMatch) return [];

    const itineraryCode = url.searchParams.get('itineraryCode') || '';
    let slug = pathMatch[1];

    // Remove itinerary code suffix
    if (itineraryCode) {
      slug = slug.replace(new RegExp(`-?${itineraryCode}$`, 'i'), '');
    }

    // Remove duration prefix (e.g. "7-day-", "14-night-")
    slug = slug.replace(/^\d+(?:-day|-night|-nite)-/i, '');

    if (!/(?:^|[-])(?:round-trip|roundtrip|one-way|oneway|from)-/i.test(slug)) {
      return [];
    }

    // Remove region/destination + trip-type/direction prefix.
    // Handles: "caribbean-round-trip-", "europe-from-", "western-caribbean-from-",
    //          "northern-europe-round-trip-", "british-isles-round-trip-", etc.
    slug = slug.replace(/^.*?-(?:round-trip|roundtrip|one-way|oneway|from)-/i, '');

    // Remove departure city slug from the start of the remaining slug.
    // Extract only the city name (before any parenthetical or comma qualifier).
    if (departurePort) {
      const cityName = cleanText(departurePort.split(/[,(]/)[0]);
      const citySlug = cityName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (citySlug) {
        if (slug.toLowerCase().startsWith(`${citySlug}-`)) {
          slug = slug.slice(citySlug.length + 1);
        } else if (slug.toLowerCase() === citySlug) {
          slug = '';
        }
      }
    }

    // Remove "to-{destination}" only for simple "from X to Y" slugs.
    // If the remainder already contains "-and-", it is usually an itinerary
    // port list (e.g. "to-reykjavik-akureyri-and-stavanger"), so leave it alone.
    if (slug.toLowerCase().startsWith('to-')) {
      if (/-and-/i.test(slug)) {
        slug = slug.slice(3);
      } else {
        slug = slug.replace(/^to-[a-z]+(?:-[a-z]+){0,3}(?:-|$)/i, '');
      }
    }

    if (!slug) return [];

    // Split on "-and-" first: the final segment may be a multi-word port (e.g. "costa-maya").
    const andParts = slug.split(/-and-/i);
    const ports = [];

    // All parts before the last -and-: split on "-" (treats each hyphenated word as a
    // separate port name). This works correctly for single-word ports such as "Cozumel"
    // or "Reykjavik". Multi-word ports (e.g. "new-orleans") only appear reliably after
    // the final "-and-" separator in NCL URL slugs, so they are handled by the last-part
    // branch below.
    for (let i = 0; i < andParts.length - 1; i++) {
      andParts[i].split('-').forEach(p => {
        const port = formatTitleCase(p);
        if (port) ports.push(port);
      });
    }

    // Last part: replace "-" with " " to preserve multi-word port names like "Costa Maya".
    const lastPart = formatTitleCase(andParts[andParts.length - 1].replace(/-/g, ' '));
    if (lastPart) ports.push(lastPart);

    return ports;
  } catch {
    return [];
  }
}

/**
 * Builds a detailed itinerary string by appending extracted port names to the base
 * itinerary title, unless the title already contains port details (indicated by a colon).
 * Mirrors the Royal Caribbean `buildDetailedItinerary` pattern.
 *
 * NCL card titles consistently use the format "Region: Port1, Port2 & PortN" when port
 * detail is present (e.g. "Iceland: Reykjavik, Edinburgh & Bergen"). A colon in the title
 * therefore reliably signals that the card already carries port information and no further
 * enrichment is needed.
 *
 * @param {string} baseItinerary - The raw itinerary title from the cruise card.
 * @param {string[]} ports - Port names extracted from the booking URL slug.
 * @returns {string} Enriched itinerary string, e.g. "Western Caribbean: Cozumel, Costa Maya".
 */
function buildDetailedNclItinerary(baseItinerary, ports) {
  if (!ports || ports.length === 0) return baseItinerary;
  if (!baseItinerary) return ports.join(', ');
  // NCL titles that already include port detail follow the "Region: ports" pattern;
  // the presence of a colon is a reliable indicator that no enrichment is needed.
  if (baseItinerary.includes(':')) return baseItinerary;
  return `${baseItinerary}: ${ports.join(', ')}`;
}

function buildDepartureDate(departureDate, returnDate) {
  const departure = extractFirstDateText(departureDate);
  const returnValue = extractFirstDateText(returnDate);
  if (!departure) return '';

  const yearMatch = returnValue.match(/\b(\d{4})\b/);
  if (yearMatch && !/\b\d{4}\b/.test(departure)) {
    return `${departure} ${yearMatch[1]}`;
  }

  return departure;
}

// NCL's itinerary API returns sail dates as epoch milliseconds (anchored to
// midnight US-Eastern, so the UTC calendar date is the departure day). Convert
// to an ISO YYYY-MM-DD string, which the frontend both filters and displays.
function formatEpochDate(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function getLowestPrice(detail) {
  const sailings = Array.isArray(detail?.sailings) ? detail.sailings : [];
  for (const sailing of sailings) {
    const staterooms = Array.isArray(sailing?.staterooms) ? sailing.staterooms : [];
    const prices = staterooms
      .map(room => toNumber(room?.combinedPrice))
      .filter(price => Number.isFinite(price));
    if (prices.length > 0) return Math.min(...prices);
  }
  return null;
}

function classifyRoomType(room) {
  const code = cleanText(room?.code).toUpperCase();
  const title = cleanText(room?.title);
  const text = `${code} ${title}`.toLowerCase();

  if (
    /^(INSIDE|INTERIOR|STUDIO)$/.test(code) ||
    /\b(inside|interior|studio|family inside|solo inside)\b/i.test(text)
  ) return 'inside';

  if (
    /^(OCEANVIEW|OCEAN VIEW)$/.test(code) ||
    /\b(ocean\s*view|oceanview|sea\s*view|seaview|picture window|obstructed oceanview|obstructed sea view)\b/i.test(text)
  ) return 'oceanView';

  if (
    /^(MINISUITE|MINI SUITE)$/.test(code) ||
    /\b(suite|haven|penthouse|owner'?s?|villa)\b/i.test(text)
  ) return 'suite';

  if (
    /^(BALCONY|BALCONY SUITE)$/.test(code) ||
    /\b(balcony|veranda)\b/i.test(text)
  ) return 'balcony';

  return null;
}

function extractRoomTypeOffers(detail) {
  const prices = { inside: null, oceanView: null, balcony: null, suite: null };
  const bookingCabinCodes = {};
  const lowest = { inside: Infinity, oceanView: Infinity, balcony: Infinity, suite: Infinity };
  const sailings = Array.isArray(detail?.sailings) ? detail.sailings : [];

  for (const sailing of sailings) {
    const rooms = Array.isArray(sailing?.staterooms) ? sailing.staterooms : [];
    for (const room of rooms) {
      const bucket = classifyRoomType(room);
      if (!bucket) continue;
      const price = toNumber(room?.combinedPrice ?? room?.price ?? room?.fare ?? room?.amount);
      if (Number.isFinite(price) && price > 0 && price < lowest[bucket]) {
        lowest[bucket] = price;
        bookingCabinCodes[bucket] = cleanText(room.code).toUpperCase();
      }
    }
  }

  for (const [bucket, amount] of Object.entries(lowest)) {
    if (Number.isFinite(amount) && amount !== Infinity) prices[bucket] = String(Math.round(amount));
  }

  return { prices, bookingCabinCodes };
}

function extractRoomTypePrices(detail) {
  return extractRoomTypeOffers(detail).prices;
}

function extractPriceFromText(text) {
  const value = cleanText(text);
  if (!value) return '';

  const anchor = value.match(/Cruise Offers From[\s\S]{0,200}?£\s?([\d,]+(?:\.\d+)?)/i);
  if (anchor) return anchor[1].replace(/,/g, '');

  const firstPrice = value.match(/£\s?([\d,]+(?:\.\d+)?)/);
  return firstPrice ? firstPrice[1].replace(/,/g, '') : '';
}

function formatTitleCase(value) {
  return cleanText(value).toLowerCase().replace(/\b[a-z]/g, match => match.toUpperCase());
}

function extractDateFromText(text) {
  const value = cleanText(text);
  if (!value) return '';

  const dateMatch = value.match(/\b(?:mon|tue|wed|thu|fri|sat|sun)\s+\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{4})?/i);
  if (dateMatch) {
    const date = formatTitleCase(dateMatch[0]);
    if (/\b\d{4}\b/.test(date)) return date;

    const after = value.slice((dateMatch.index || 0) + dateMatch[0].length);
    const yearMatch = after.match(/\b(19|20)\d{2}\b/);
    return yearMatch ? `${date} ${yearMatch[0]}` : date;
  }

  const monthDateMatch = value.match(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[,\s-]*\d{4}/i);
  if (monthDateMatch) return formatTitleCase(monthDateMatch[0]);

  return '';
}

function normalizeCruise(detail, bookingUrl) {
  const shipName = cleanText(detail?.ship?.title);
  const departurePort = cleanText(detail?.embarkationPort?.title);
  const sailing = Array.isArray(detail?.sailings) ? detail.sailings[0] : null;
  const itineraryCode = cleanText(detail?.code || sailing?.itineraryCode);
  const baseItinerary = cleanText(detail?.shortTitle || detail?.title);

  // Prefer the NCL itinerary API's authoritative port sequence (full port
  // titles, in order). It gives the true final port — the booking-URL slug
  // often ends in a region word (e.g. "…-and-norway"), which the slug parser
  // would otherwise mistake for the destination. Fall back to slug parsing
  // only when the API port list is missing.
  const apiPorts = Array.isArray(detail?.portsOfCall)
    ? detail.portsOfCall.map(port => cleanText(port?.title)).filter(Boolean)
    : [];

  let itineraryPorts;
  let destinationPort;
  let seaDayLabels;
  let seaDaysIncludeEndpoints;
  if (apiPorts.length > 1) {
    itineraryPorts = apiPorts;
    destinationPort = getDestinationPort(apiPorts);
    seaDayLabels = apiPorts;
    seaDaysIncludeEndpoints = true;
  } else {
    const ports = extractPortsFromSlug(bookingUrl, departurePort);
    const isRoundTrip = isRoundTripBookingUrl(bookingUrl);
    itineraryPorts = ports.length > 0
      ? [departurePort, ...ports, ...(isRoundTrip && departurePort ? [departurePort] : [])].filter(Boolean)
      : ports;
    destinationPort = isRoundTrip && departurePort
      ? departurePort
      : ports.length > 0 ? getDestinationPort([departurePort, ...ports]) : '';
    seaDayLabels = ports;
    seaDaysIncludeEndpoints = false;
  }

  // Prices belong to this departure, never the cheapest room on another date.
  const singleSailing = { sailings: sailing ? [sailing] : [] };
  const { prices: roomPrices, bookingCabinCodes } = extractRoomTypeOffers(singleSailing);
  const departureDate = formatEpochDate(sailing?.departureDate ?? sailing?.sailStartDate)
    || buildDepartureDate(sailing?.departureDate || sailing?.sailStartDate, sailing?.returnDate || detail?.returnDate);
  const arrivalDate = formatEpochDate(sailing?.returnDate ?? sailing?.sailEndDate)
    || cleanText(sailing?.returnDate || sailing?.sailEndDate);
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(departureDate) ? `_${departureDate}` : '';

  return {
    provider: 'Norwegian Cruise Line',
    id: `ncl_${itineraryCode || extractItineraryCode(bookingUrl) || ''}${dateKey}`,
    shipName,
    shipClass: SHIP_CLASS[shipName] || '',
    shipLaunchYear: SHIP_LAUNCH_YEAR[shipName] || null,
    itinerary: buildDetailedNclItinerary(baseItinerary, itineraryPorts),
    departureDate,
    duration: cleanText(detail?.duration?.text || ''),
    departurePort,
    departureRegion: getDepartureRegion(departurePort),
    destination: cleanText(detail?.destination?.title || detail?.shortTitle || detail?.title),
    ...(destinationPort ? { destinationPort } : {}),
    ...(arrivalDate ? { arrivalDate } : {}),
    priceFrom: getLowestPrice(singleSailing)?.toString() || '',
    currency: cleanText(detail?.currency?.code || detail?.currency) || 'GBP',
    bookingUrl: resolveUrl(bookingUrl),
    prices: roomPrices,
    bookingCabinCodes,
    seaDays: estimateSeaDays({
      labels: seaDayLabels,
      duration: detail?.duration?.text || '',
      portsIncludeEndpoints: seaDaysIncludeEndpoints,
    }),
  };
}

function expandItineraryCard(card, api) {
  if (Array.isArray(api?.sailings) && api.sailings.length) {
    return api.sailings.map(sailing => {
      const departureDate = formatEpochDate(sailing.departureDate ?? sailing.sailStartDate)
        || cleanText(sailing.departureDate || sailing.sailStartDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate)) {
        throw new Error(`[NCL] Invalid sailing date for ${card.code}`);
      }
      let bookingUrl = card.bookingUrl;
      if (sailing.packageId && api.ship?.code) {
        // NCL's public booking flow calls the API packageId a voyageId.
        const room = (sailing.staterooms || []).find(room => toNumber(room.combinedPrice) > 0);
        const params = new URLSearchParams({
          itineraryCode: sailing.itineraryCode || card.code,
          voyageId: String(sailing.packageId),
          sailDate: departureDate,
          departureDate,
          shipCode: api.ship.code,
          guestCount: '2',
          selectedStateroomMeta: room?.code || 'INSIDE',
        });
        bookingUrl = `${NCL_BASE_URL}/uk/en/booking/stateroom-offers/stateroom?${params}`;
      }
      return {
        code: card.code, bookingUrl,
        detail: { ...api, code: card.code, sailings: [sailing] },
      };
    });
  }
  throw new Error('[NCL] No sailings returned for ' + card.code);
}

function extractCruiseCardsFromArticles(articles) {
  return articles.map(article => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const getText = selector => clean(article.querySelector(selector)?.textContent);
    const bookingUrl = article.querySelector('a.btn.btn-secondary[href*="itineraryCode="]')?.href || '';
    const code = (() => {
      try {
        return new URL(bookingUrl).searchParams.get('itineraryCode') || '';
      } catch {
        return '';
      }
    })();
    const shipLabel = getText('.c66_label');
    const duration = shipLabel.replace(/\s+on\s+.+$/i, '');
    const shipName = shipLabel.replace(/^\d+-day Cruise\s+on\s+/i, '');
    const itinerary = getText('.c66_title');
    const departurePort = getText('.c66_subtitle').replace(/^from\s+/i, '');
    const departureDate = getText('.c160_date_item.-departure .c160_date_item_dateFull');
    const returnDate = getText('.c160_date_item.-return .c160_date_item_dateFull');
    const priceText = getText('.c495_aside .e55_price_value') || getText('.c495_aside .headline-1');
    const currencyMatch = getText('.c495_aside').match(/PP\s*\/\s*([A-Z]{3})/i);
    const priceMatch = priceText.match(/([\d,]+(?:\.\d+)?)/);

    return {
      code,
      bookingUrl,
      shipName,
      itinerary,
      departurePort,
      departureDate,
      returnDate,
      duration,
      destination: itinerary,
      priceFrom: priceMatch ? priceMatch[1].replace(/,/g, '') : '',
      currency: currencyMatch ? currencyMatch[1].toUpperCase() : 'GBP',
    };
  });
}

async function waitForAnyCruiseCard(page, attempt) {
  try {
    await page.waitForSelector('article.c495', { timeout: 15_000 });
  } catch {
    if (attempt >= NCL_EMPTY_LOAD_RETRIES) return;
    console.warn(`  [NCL] no cruise cards after load attempt ${attempt + 1}; reloading.`);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(NCL_PAGE_WAIT_MS * 2);
    await waitForAnyCruiseCard(page, attempt + 1);
  }
}

async function collectCruiseCards(browserType = chromium, options = {}) {
  const browser = await browserType.launch({ headless: true, args: ['--disable-http2'] });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
  });
  const itineraryDetails = new Map();
  const itineraryPromises = [];
  const cards = new Map();
  const started = Date.now();
  let deniedStatus = 0;

  page.on('response', response => {
    if (response.url().includes('/api/vacations/') && [403, 429].includes(response.status?.())) {
      deniedStatus = response.status();
    }
    const match = response.url().match(/\/api\/vacations\/v2\/search-result-itinerary\/([^?/#]+)/i);
    if (!match) return;

    const code = cleanText(decodeURIComponent(match[1]));
    if (!code || itineraryDetails.has(code)) return;

    const pending = response.json()
      .then(data => {
        itineraryDetails.set(code, data);
      })
      .catch(() => {});
    itineraryPromises.push(pending);
  });

  try {
    const response = await page.goto(NCL_CRUISES_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if ([403, 429].includes(response?.status())) {
      throw Object.assign(new Error('NCL discovery denied'), { status: response.status() });
    }
    await page.waitForTimeout(NCL_PAGE_WAIT_MS);
    await waitForAnyCruiseCard(page, 0);

    for (let step = 0; step < NCL_MAX_PAGINATION_STEPS; step++) {
      if (deniedStatus) throw Object.assign(new Error('NCL discovery denied'), { status: deniedStatus });
      if (Date.now() - started > 120000) throw new Error('NCL discovery time limit reached');
      const pageCards = await page.$$eval('article.c495', extractCruiseCardsFromArticles);

      pageCards.forEach(card => {
        if (card.code && !cards.has(card.code)) {
          cards.set(card.code, card);
        }
      });
      if (options.onProgress) {
        await Promise.allSettled(itineraryPromises);
        await options.onProgress(Array.from(cards.values()), itineraryDetails);
      }

      const visibleCount = await page.locator('article.c495').count();
      const moreButton = page.getByRole('button', { name: /view more results/i }).last();
      const hasMore = await moreButton.isVisible().catch(() => false);

      if (!hasMore) break;
      if (step === NCL_MAX_PAGINATION_STEPS - 1) {
        throw new Error(`[NCL] Pagination limit reached after ${cards.size} itineraries`);
      }

      await moreButton.evaluate(button => button.click());
      try {
        await page.waitForFunction(
          previousCount => document.querySelectorAll('article.c495').length > previousCount,
          visibleCount,
          { timeout: 15000 }
        );
      } catch {
        throw Object.assign(new Error(`[NCL] Incomplete pagination after ${cards.size} itineraries: result count did not increase`), { status: deniedStatus });
      }
    }

    if (!cards.size) throw new Error('[NCL] No itinerary cards loaded');
    await Promise.allSettled(itineraryPromises);
    if (options.discoveryOnly) return [];

    // Responses can arrive late or fail during pagination. Recover missing
    // details explicitly so those cards do not collapse to one departure.
    for (const card of cards.values()) {
      if (itineraryDetails.get(card.code)?.sailings?.length) continue;
      const response = await page.request.get(
        NCL_BASE_URL + '/uk/en/api/vacations/v2/search-result-itinerary/' + encodeURIComponent(card.code),
        { timeout: 30000 }
      );
      if (!response.ok()) throw new Error('[NCL] Could not load sailings for ' + card.code);
      const detail = await response.json();
      if (!Array.isArray(detail?.sailings) || !detail.sailings.length) {
        throw new Error('[NCL] No sailings returned for ' + card.code);
      }
      itineraryDetails.set(card.code, detail);
    }
    const cruises = Array.from(cards.values()).flatMap(card =>
      expandItineraryCard(card, itineraryDetails.get(card.code))
    );

    return cruises;
  } finally {
    try {
      await Promise.allSettled(itineraryPromises);
      if (options.onProgress) await options.onProgress(Array.from(cards.values()), itineraryDetails);
    } finally { await browser.close(); }
  }
}

class NclCruisesProvider {
  constructor() {
    this.name = 'Norwegian Cruise Line';
    this.id = 'ncl-cruises';
  }

  normalizeCruise(detail, bookingUrl) {
    return normalizeCruise(detail, bookingUrl);
  }

  async fetchCruises(options = {}) {
    const { cruises, state } = await refreshNcl({
      priorState: options.priorScrapeState,
      priorCruises: options.priorEnrichmentById,
      priorArchive: options.priorArchiveById,
      save: options.onScrapeState,
      normalize: (card, api) => {
        if (api?.code !== card.code || !Array.isArray(api.sailings)) throw new Error('Invalid NCL itinerary response');
        if (!api.sailings.length) return []; // A valid retired itinerary, not a failed request.
        return expandItineraryCard(card, api).map(({ detail, bookingUrl }) => normalizeCruise(detail, bookingUrl));
      },
      loadItinerary: async code => {
        const response = await fetchWithTimeout(`${NCL_BASE_URL}/uk/en/api/vacations/v2/search-result-itinerary/${encodeURIComponent(code)}`);
        if (!response.ok) {
          const retryAfter = response.headers.get('retry-after');
          const retryAfterMs = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) * 1000
            : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
          throw Object.assign(new Error(`NCL HTTP ${response.status}`), { status: response.status, retryAfterMs });
        }
        return response.json();
      },
      discover: onProgress => collectCruiseCards(chromium, { onProgress, discoveryOnly: true }),
    });
    console.log(`  [NCL] ${state.status.freshItineraries}/${state.status.knownItineraries} known itineraries checked within 48 hours; ${cruises.length} retained sailings`);
    if (!cruises.length) throw new Error('[NCL] No saved sailings yet; import progress retained');
    return cruises;
  }
}

module.exports = new NclCruisesProvider();
// Launches a headless Chromium; the scrape scheduler serialises browser
// providers so no two Chromium instances contend for a small CI runner.
module.exports.usesBrowser = true;
module.exports.normalizeCruise = normalizeCruise;
module.exports.collectCruiseCards = collectCruiseCards;
module.exports.extractFirstDateText = extractFirstDateText;
module.exports.formatEpochDate = formatEpochDate;
module.exports.extractPriceFromText = extractPriceFromText;
module.exports.extractDateFromText = extractDateFromText;
module.exports.extractPortsFromSlug = extractPortsFromSlug;
module.exports.isRoundTripBookingUrl = isRoundTripBookingUrl;
module.exports.buildDetailedNclItinerary = buildDetailedNclItinerary;
module.exports.classifyRoomType = classifyRoomType;
module.exports.extractRoomTypePrices = extractRoomTypePrices;
module.exports.extractCruiseCardsFromArticles = extractCruiseCardsFromArticles;

module.exports.expandItineraryCard = expandItineraryCard;

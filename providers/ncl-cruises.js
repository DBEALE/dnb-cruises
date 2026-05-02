'use strict';

const { chromium } = require('@playwright/test');

const { getDepartureRegion } = require('./shared');

const NCL_BASE_URL = 'https://www.ncl.com';
const NCL_CRUISES_URL = 'https://www.ncl.com/uk/en/vacations';
const NCL_PAGE_WAIT_MS = 1200;
const NCL_MAX_PAGINATION_STEPS = 60;

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

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

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

    // Remove "to-{destination}" prefix left over from "from X to Y" URL patterns.
    // Handles destination names up to four hyphenated words (e.g. "to-new-york-",
    // "to-auckland", "to-fort-lauderdale-"). Matches with or without a trailing "-"
    // so that slugs ending in the destination (no further ports) are also stripped.
    slug = slug.replace(/^to-[a-z]+(?:-[a-z]+){0,3}(?:-|$)/i, '');

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

async function extractPriceFromBookingPage(browser, bookingUrl) {
  if (!bookingUrl) return '';

  const page = await browser.newPage({ viewport: { width: 1440, height: 1800 } });
  try {
    await page.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(NCL_PAGE_WAIT_MS);
    const text = await page.evaluate(() => document.body?.innerText || '');
    return extractPriceFromText(text);
  } catch {
    return '';
  } finally {
    await page.close();
  }
}

async function extractDateFromBookingPage(browser, bookingUrl) {
  if (!bookingUrl) return '';

  const page = await browser.newPage({ viewport: { width: 1440, height: 1800 } });
  try {
    await page.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(NCL_PAGE_WAIT_MS);
    const text = await page.evaluate(() => document.body?.innerText || '');
    const dateText = extractDateFromText(text);
    return dateText || '';
  } catch {
    return '';
  } finally {
    await page.close();
  }
}

function normalizeCruise(detail, bookingUrl) {
  const shipName = cleanText(detail?.ship?.title);
  const departurePort = cleanText(detail?.embarkationPort?.title);
  const sailing = Array.isArray(detail?.sailings) ? detail.sailings[0] : null;
  const itineraryCode = cleanText(detail?.code || sailing?.itineraryCode);
  const baseItinerary = cleanText(detail?.shortTitle || detail?.title);
  const ports = extractPortsFromSlug(bookingUrl, departurePort);

  return {
    provider: 'Norwegian Cruise Line',
    id: `ncl_${itineraryCode || extractItineraryCode(bookingUrl) || ''}`,
    shipName,
    shipClass: SHIP_CLASS[shipName] || '',
    shipLaunchYear: SHIP_LAUNCH_YEAR[shipName] || null,
    itinerary: buildDetailedNclItinerary(baseItinerary, ports),
    departureDate: buildDepartureDate(sailing?.departureDate || sailing?.sailStartDate, sailing?.returnDate || detail?.returnDate),
    duration: cleanText(detail?.duration?.text || ''),
    departurePort,
    departureRegion: getDepartureRegion(departurePort),
    destination: cleanText(detail?.destination?.title || detail?.shortTitle || detail?.title),
    priceFrom: getLowestPrice(detail)?.toString() || '',
    currency: cleanText(detail?.currency) || 'GBP',
    bookingUrl: resolveUrl(bookingUrl),
    prices: { inside: null, oceanView: null, balcony: null, suite: null },
  };
}

async function collectCruiseCards() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1800 } });

  try {
    await page.goto(NCL_CRUISES_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(NCL_PAGE_WAIT_MS);

    const cards = new Map();
    let lastVisible = 0;

    for (let step = 0; step < NCL_MAX_PAGINATION_STEPS; step++) {
      const pageCards = await page.$$eval('article.c495', articles => articles.map(article => {
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
        const currencyMatch = clean(getText('.c495_aside')).match(/PP\s*\/\s*([A-Z]{3})/i);
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
      }));

      pageCards.forEach(card => {
        if (card.code && !cards.has(card.code)) {
          cards.set(card.code, card);
        }
      });

      const visibleCount = await page.locator('li.listing_item article.c495').count();
      const hasMore = await page.evaluate(() => Array.from(document.querySelectorAll('button, a, [role="button"]')).some(el => /view more results/i.test((el.textContent || '').trim())));

      if (!hasMore) break;

      await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(el => /view more results/i.test((el.textContent || '').trim()));
        if (button) button.click();
      });

      await page.waitForTimeout(NCL_PAGE_WAIT_MS);
      if (visibleCount === lastVisible) {
        await page.waitForTimeout(NCL_PAGE_WAIT_MS);
      }
      lastVisible = visibleCount;
    }

    const cruises = Array.from(cards.values()).map(card => ({
      code: card.code,
      bookingUrl: card.bookingUrl,
      detail: {
        code: card.code,
        title: card.itinerary,
        shortTitle: card.itinerary,
        duration: { text: card.duration },
        currency: card.currency,
        ship: { title: card.shipName },
        destination: { title: card.destination },
        embarkationPort: { title: card.departurePort },
        sailings: [{
          departureDate: buildDepartureDate(card.departureDate, card.returnDate),
          sailStartDate: buildDepartureDate(card.departureDate, card.returnDate),
          returnDate: extractFirstDateText(card.returnDate),
          staterooms: [{ combinedPrice: card.priceFrom }],
        }],
      },
    }));

    for (const cruise of cruises) {
      const sailing = Array.isArray(cruise.detail?.sailings) ? cruise.detail.sailings[0] : null;
      const hasPrice = Boolean(sailing?.staterooms?.some(room => cleanText(room?.combinedPrice)));
      const hasDepartureDate = Boolean(cleanText(sailing?.departureDate));

      if (!hasDepartureDate) {
        const bookingDate = await extractDateFromBookingPage(browser, cruise.bookingUrl);
        if (bookingDate) {
          sailing.departureDate = bookingDate;
          sailing.sailStartDate = bookingDate;
        }
      }

      if (!hasPrice) {
        const bookingPrice = await extractPriceFromBookingPage(browser, cruise.bookingUrl);
        if (bookingPrice) {
          sailing.staterooms = [{ combinedPrice: bookingPrice }];
        }
      }
    }

    return cruises;
  } finally {
    await browser.close();
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

  async fetchCruises() {
    const itineraryLinks = await collectCruiseCards();
    const cruises = [];

    for (const { detail, bookingUrl } of itineraryLinks) {
      const cruise = this.normalizeCruise(detail, bookingUrl);
      if (cruise?.id && cruise.shipName) {
        cruises.push(cruise);
      }
    }

    console.log(`  [NCL] ${cruises.length} / ${itineraryLinks.length}`);
    return cruises;
  }
}

module.exports = new NclCruisesProvider();
module.exports.normalizeCruise = normalizeCruise;
module.exports.collectCruiseCards = collectCruiseCards;
module.exports.extractFirstDateText = extractFirstDateText;
module.exports.extractPriceFromText = extractPriceFromText;
module.exports.extractDateFromText = extractDateFromText;
module.exports.extractPortsFromSlug = extractPortsFromSlug;
module.exports.buildDetailedNclItinerary = buildDetailedNclItinerary;
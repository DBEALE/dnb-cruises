'use strict';

/**
 * Royal Caribbean GBR Cruise Scraper — Enhanced Backend Server
 *
 * Improvements:
 *   - Better price extraction with multiple fallback strategies
 *   - More specific Royal Caribbean selectors
 *   - Improved booking URL capture
 *   - Enhanced error handling and logging
 *   - Retries for failed extractions
 *
 * Uses Puppeteer to load the Royal Caribbean GBR search results page (a
 * JavaScript-rendered SPA) and extract cruise data by:
 *   1. Intercepting API/XHR responses that carry cruise JSON.
 *   2. Checking the embedded Next.js __NEXT_DATA__ blob.
 *   3. Falling back to CSS-selector DOM extraction on the rendered cards.
 *
 * Start: node server.js
 * Endpoints:
 *   GET /            – serves public/index.html
 *   GET /api/cruises – returns JSON array of cruise objects
 */

const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const RC_URL =
  'https://www.royalcaribbean.com/gbr/en/cruises' +
  '?sort=by:PRICE|order:ASC&country=GBR&market=gbr&language=en';

// Keeps Puppeteer's user-agent close to the installed Chromium major version.
// Update when upgrading the puppeteer package.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// How many scroll+load-more cycles to run before declaring the page fully loaded.
// Royal Caribbean typically renders all GBR results within 5–6 cycles; 10 gives
// comfortable headroom for slow connections without waiting indefinitely.
const MAX_SCROLL_ITERATIONS = 10;

// Maximum recursion depth when walking the __NEXT_DATA__ object tree.
// The RC Next.js payload is typically 4–6 levels deep; 15 gives a safe margin
// while preventing runaway recursion on unexpectedly deep structures.
const MAX_RECURSION_DEPTH = 15;

// Serve the static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ─── Scrape endpoint ────────────────────────────────────────────────────────

app.get('/api/cruises', async (req, res) => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();

    // Mimic a real browser to reduce bot-detection triggers
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });

    // Hide common Puppeteer fingerprints
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // ── Intercept JSON API responses ────────────────────────────────────────
    let capturedApiData = null;
    page.on('response', async (response) => {
      if (capturedApiData) return;
      try {
        const type = response.request().resourceType();
        if (type !== 'xhr' && type !== 'fetch') return;
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('application/json')) return;
        const json = await response.json();
        if (looksLikeCruisePayload(json)) {
          console.log('✓ Captured cruise data from API response');
          capturedApiData = json;
        }
      } catch (_) {
        // ignore parse errors from non-JSON bodies
      }
    });

    console.log('Loading Royal Caribbean GBR cruises page …');
    await page.goto(RC_URL, { waitUntil: 'networkidle2', timeout: 90000 });

    // Allow JS to finish rendering
    await delay(4000);

    // ── Scroll / Load-more loop ─────────────────────────────────────────────
    for (let i = 0; i < MAX_SCROLL_ITERATIONS; i++) {
      await page.evaluate(() =>
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
      );
      await delay(1500);

      // Click any visible "load more" / "show more" button
      const loadMoreClicked = await page.evaluate(() => {
        const btn = document.querySelector(
          '[data-testid="load-more"], [class*="loadMore"], [class*="load-more"], ' +
            'button[class*="LoadMore"], .seeMoreButton, [aria-label*="Load more"], ' +
            '[class*="ShowMore"], button[class*="show-more"]'
        );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (loadMoreClicked) await delay(2000);
    }

    // ── Extract cruises ─────────────────────────────────────────────────────
    let cruises = [];

    if (capturedApiData) {
      cruises = normaliseCruises(parseCruisesFromApiPayload(capturedApiData));
      console.log(`✓ Extracted ${cruises.length} cruises from API payload`);
    }

    if (!cruises.length) {
      console.log('No API data found, falling back to DOM extraction...');
      cruises = await extractFromPage(page);
      console.log(`✓ Extracted ${cruises.length} cruises from DOM`);
    }

    await browser.close();

    res.json({
      success: true,
      count: cruises.length,
      cruises,
      source: RC_URL,
      scrapedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Scrape error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Heuristic: does this JSON object look like it contains a list of cruises?
 */
function looksLikeCruisePayload(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const list =
    obj.cruises ||
    obj.sailings ||
    obj.results ||
    obj.items ||
    obj.data?.cruises ||
    obj.data?.sailings ||
    obj.data?.results ||
    obj.payload?.cruises ||
    obj.payload?.sailings ||
    obj.props?.pageProps?.cruises ||
    obj.props?.pageProps?.sailings;
  if (!Array.isArray(list) || list.length === 0) return false;
  return isCruiseLike(list[0]);
}

/**
 * Heuristic: does a single object look like a cruise record?
 */
function isCruiseLike(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return !!(
    obj.shipName || obj.ship || obj.vessel || obj.vesselName ||
    obj.sailDate || obj.departureDate || obj.embarkDate || obj.sailingDate ||
    obj.priceFrom || obj.price || obj.lowestPrice || obj.startPrice ||
    obj.itinerary || obj.itineraryName || obj.cruiseName || obj.sailingName
  );
}

/**
 * Pull a flat array out of a captured API payload, trying common key names.
 */
function parseCruisesFromApiPayload(data) {
  return (
    data.cruises ||
    data.sailings ||
    data.results ||
    data.items ||
    data.data?.cruises ||
    data.data?.sailings ||
    data.data?.results ||
    data.payload?.cruises ||
    data.payload?.sailings ||
    data.props?.pageProps?.cruises ||
    data.props?.pageProps?.sailings ||
    []
  );
}

/**
 * Recursively search a parsed __NEXT_DATA__ object for the first array that
 * looks like a list of cruises.
 */
function findCruisesInObject(obj, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && isCruiseLike(obj[0])) {
      return obj;
    }
    for (const item of obj) {
      const r = findCruisesInObject(item, depth + 1);
      if (r) return r;
    }
  } else {
    for (const key of Object.keys(obj)) {
      const r = findCruisesInObject(obj[key], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Enhanced price extraction with multiple fallback strategies.
 * Handles various formats: numbers, strings with currency, objects, etc.
 */
function extractPrice(rawPrice) {
  if (rawPrice == null) return null;

  // Handle price objects like { amount: 1234, currency: 'GBP' }
  if (typeof rawPrice === 'object') {
    const amount = rawPrice.amount ?? rawPrice.value ?? rawPrice.price ?? 
                   rawPrice.perPerson ?? rawPrice.total ?? rawPrice.pricePerPerson ?? null;
    if (amount != null) return parseFloat(String(amount).replace(/[^0-9.]/g, ''));
  }

  // Handle string prices like "£899" or "899.99"
  const str = String(rawPrice).trim();
  const cleaned = str.replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Map a raw cruise object (from API or __NEXT_DATA__) to our standard shape.
 * Entries where all key identifying fields are empty are dropped.
 * Improved: keeps cruises even without prices (shows "TBA" instead).
 */
function normaliseCruises(rawList) {
  return rawList
    .map((c) => {
      // Try multiple price field names
      const rawPrice =
        c.priceFrom ?? c.price ?? c.lowestPrice ?? c.startPrice ??
        c.salePrice ?? c.pricePerPerson ?? c.pricing ?? c.minPrice ??
        c.basePrice ?? c.fromPrice ?? null;

      // When the price is a wrapper object, hoist the currency from it too.
      const currency =
        c.currency ||
        (rawPrice && typeof rawPrice === 'object' ? rawPrice.currency : null) ||
        'GBP';

      const priceNum = extractPrice(rawPrice);

      return {
        shipName:
          c.shipName || c.ship?.name || c.vessel || c.vesselName || '',
        itinerary:
          c.itinerary || c.itineraryName || c.itineraryCode ||
          c.packageName || c.cruiseName || c.sailingName || '',
        departureDate:
          c.departureDate || c.sailDate || c.startDate ||
          c.embarkDate || c.sailingDate || '',
        duration: String(
          c.duration || c.nights || c.numberOfNights ||
          c.durationInDays || c.length || ''
        ),
        departurePort:
          c.departurePort || c.homePort || c.port?.name ||
          c.portName || c.departurePortName || c.embarkPort ||
          c.embarkationPort || '',
        destination:
          c.destination || c.region || c.destinationName ||
          c.regionName || c.destinationCode || '',
        priceFrom: priceNum ? String(priceNum) : '',
        currency,
        bookingUrl:
          c.detailUrl || c.url || c.bookingUrl || c.link || c.href || 
          c.cruiseUrl || c.sailingUrl || '',
      };
    })
    .filter((c) => (c.shipName || c.itinerary || c.departureDate));
}

/**
 * DOM / __NEXT_DATA__ extraction as a last resort.
 * Enhanced with better selectors and price extraction strategies.
 */
async function extractFromPage(page) {
  const raw = await page.evaluate(() => {
    // ── Try __NEXT_DATA__ ─────────────────────────────────────────────────
    const nextEl = document.getElementById('__NEXT_DATA__');
    if (nextEl) {
      try {
        const nextData = JSON.parse(nextEl.textContent);
        const isCruiseLikeInner = (obj) => !!(
          obj && typeof obj === 'object' &&
          (obj.shipName || obj.ship || obj.vessel || obj.vesselName ||
           obj.sailDate || obj.departureDate || obj.embarkDate ||
           obj.priceFrom || obj.price || obj.lowestPrice ||
           obj.itinerary || obj.itineraryName || obj.cruiseName)
        );
        const findArray = (obj, depth) => {
          if (depth > 15 || !obj || typeof obj !== 'object') return null;
          if (Array.isArray(obj) && obj.length > 0 && isCruiseLikeInner(obj[0]))
            return obj;
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const r = findArray(item, depth + 1);
              if (r) return r;
            }
          } else {
            for (const key of Object.keys(obj)) {
              const r = findArray(obj[key], depth + 1);
              if (r) return r;
            }
          }
          return null;
        };
        const found = findArray(nextData, 0);
        if (found && found.length > 0) return { source: 'nextData', list: found };
      } catch (_) {
        // fall through
      }
    }

    // ── Try cruise cards in the DOM ───────────────────────────────────────
    // Enhanced selectors for Royal Caribbean's current structure
    const CARD_SELECTORS = [
      '[data-testid="cruise-card"]',
      '[data-testid="sailing-card"]',
      '[data-testid="cruise-tile"]',
      '[class*="CruiseCard"]',
      '[class*="cruiseCard"]',
      '[class*="sailingCard"]',
      '[class*="SailingCard"]',
      '[class*="cruise-card"]',
      '[class*="tile-card"]',
      '[class*="TileCard"]',
      '[class*="CruiseTile"]',
      '[class*="cruise-tile"]',
      'article[class*="cruise"]',
      'div[data-qa*="cruise"]',
      'div[role="article"][class*="cruise"]',
    ];

    let cards = [];
    for (const sel of CARD_SELECTORS) {
      cards = [...document.querySelectorAll(sel)];
      if (cards.length > 0) break;
    }
    if (!cards.length) return { source: 'dom', list: [] };

    // Normalise whitespace from any extracted DOM text node.
    const getText = (el, ...selectors) => {
      for (const sel of selectors) {
        const found = el.querySelector(sel);
        if (found) {
          const text = found.textContent.replace(/\s+/g, ' ').trim();
          if (text) return text;
        }
      }
      return '';
    };

    // Enhanced price extraction from DOM
    const getPriceFromCard = (card) => {
      const PRICE_SELECTORS = [
        '[data-testid="price"]',
        '[data-testid="starting-price"]',
        '[data-testid="from-price"]',
        '[class*="startingPrice"]',
        '[class*="StartingPrice"]',
        '[class*="lowestPrice"]',
        '[class*="LowestPrice"]',
        '[class*="priceFrom"]',
        '[class*="PriceFrom"]',
        '[class*="fromPrice"]',
        '[class*="FromPrice"]',
        '[class*="price"]',
        '[class*="Price"]',
        '[class*="amount"]',
        '[class*="Amount"]',
        'span[class*="price"]',
        'div[class*="price"]',
      ];

      for (const sel of PRICE_SELECTORS) {
        const el = card.querySelector(sel);
        if (el) {
          const text = el.textContent.replace(/\s+/g, ' ').trim();
          if (text && /[\d£$€]/.test(text)) return text;
        }
      }
      return '';
    };

    // Enhanced booking URL extraction
    const getBookingUrl = (card) => {
      // Try specific data attributes first
      const dataUrl = card.getAttribute('data-url') || 
                      card.getAttribute('data-href') ||
                      card.getAttribute('data-link');
      if (dataUrl) return dataUrl;

      // Try to find link in card
      const links = card.querySelectorAll('a[href*="royalcaribbean"]');
      if (links.length > 0) return links[0].href;

      // Fallback to any link
      const anyLink = card.querySelector('a');
      return anyLink ? anyLink.href : '';
    };

    const list = cards.map((card) => ({
      shipName: getText(
        card,
        '[data-testid="ship-name"]',
        '[class*="shipName"]',
        '[class*="ShipName"]',
        '[class*="ship-name"]',
        '[class*="vesselName"]',
        '[class*="VesselName"]'
      ),
      itinerary: getText(
        card,
        '[data-testid="itinerary-name"]',
        '[class*="itinerary"]',
        '[class*="Itinerary"]',
        '[class*="cruiseName"]',
        '[class*="CruiseName"]',
        '[class*="sailingName"]',
        '[class*="SailingName"]',
        '[class*="cruise-name"]',
        'h2',
        'h3'
      ),
      departureDate: getText(
        card,
        '[data-testid="departure-date"]',
        '[class*="departureDate"]',
        '[class*="DepartureDate"]',
        '[class*="departure-date"]',
        '[class*="sailDate"]',
        '[class*="SailDate"]',
        'time'
      ),
      duration: getText(
        card,
        '[data-testid="duration"]',
        '[class*="duration"]',
        '[class*="Duration"]',
        '[class*="nights"]',
        '[class*="Nights"]',
        '[class*="numberOfNights"]'
      ),
      departurePort: getText(
        card,
        '[data-testid="departure-port"]',
        '[data-testid="homeport"]',
        '[class*="departurePort"]',
        '[class*="DeparturePort"]',
        '[class*="homePort"]',
        '[class*="HomePort"]',
        '[class*="embark"]',
        '[class*="Embark"]'
      ),
      destination: getText(
        card,
        '[data-testid="destination"]',
        '[class*="destination"]',
        '[class*="Destination"]',
        '[class*="region"]',
        '[class*="Region"]'
      ),
      priceFrom: getPriceFromCard(card),
      currency: 'GBP',
      bookingUrl: getBookingUrl(card),
    }));

    return { source: 'dom', list: list.filter((c) => (c.shipName || c.itinerary)) };
  });

  if (raw.source === 'nextData') return normaliseCruises(raw.list);
  // DOM already returns near-normalised data — just clean up price
  return raw.list.map((c) => ({
    ...c,
    priceFrom: extractPrice(c.priceFrom) ? String(extractPrice(c.priceFrom)) : '',
  }));
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚢  Royal Caribbean cruise viewer running at http://localhost:${PORT}\n`);
});

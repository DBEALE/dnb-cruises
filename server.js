'use strict';

/**
 * Royal Caribbean GBR Cruise Scraper — Backend Server
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
// Royal Caribbean typically renders all GBR results within 5–6 cycles; 8 gives
// comfortable headroom for slow connections without waiting indefinitely.
const MAX_SCROLL_ITERATIONS = 8;

// Maximum recursion depth when walking the __NEXT_DATA__ object tree.
// The RC Next.js payload is typically 4–6 levels deep; 12 gives a safe margin
// while preventing runaway recursion on unexpectedly deep structures.
const MAX_RECURSION_DEPTH = 12;

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
        if (looksLikeCruisePayload(json)) capturedApiData = json;
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
            'button[class*="LoadMore"], .seeMoreButton, [aria-label*="Load more"]'
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
    }

    if (!cruises.length) {
      cruises = await extractFromPage(page);
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
    obj.data?.sailings;
  if (!Array.isArray(list) || list.length === 0) return false;
  const first = list[0];
  return !!(
    first.shipName ||
    first.ship ||
    first.sailDate ||
    first.departureDate ||
    first.priceFrom ||
    first.price
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
    if (obj.length > 0 && (obj[0].shipName || obj[0].sailDate || obj[0].priceFrom)) {
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
 * Map a raw cruise object (from API or __NEXT_DATA__) to our standard shape.
 */
function normaliseCruises(rawList) {
  return rawList.map((c) => ({
    shipName: c.shipName || c.ship?.name || c.vessel || '',
    itinerary: c.itinerary || c.itineraryName || c.name || c.title || '',
    departureDate: c.departureDate || c.sailDate || c.startDate || '',
    duration: String(c.duration || c.nights || c.length || ''),
    departurePort: c.departurePort || c.homePort || c.port?.name || '',
    destination: c.destination || c.region || c.destinationName || '',
    priceFrom: formatPrice(c.priceFrom ?? c.price ?? c.lowestPrice ?? null),
    currency: c.currency || 'GBP',
    bookingUrl:
      c.detailUrl ||
      c.url ||
      c.bookingUrl ||
      '',
  }));
}

function formatPrice(val) {
  if (val == null) return '';
  const n = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? '' : String(n);
}

/**
 * DOM / __NEXT_DATA__ extraction as a last resort.
 */
async function extractFromPage(page) {
  const raw = await page.evaluate(() => {
    // ── Try __NEXT_DATA__ ─────────────────────────────────────────────────
    const nextEl = document.getElementById('__NEXT_DATA__');
    if (nextEl) {
      try {
        const nextData = JSON.parse(nextEl.textContent);
        const findArray = (obj, depth) => {
          if (depth > 12 || !obj || typeof obj !== 'object') return null;
          if (
            Array.isArray(obj) &&
            obj.length > 0 &&
            (obj[0].shipName || obj[0].sailDate || obj[0].priceFrom)
          )
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
    const CARD_SELECTORS = [
      '[data-testid="cruise-card"]',
      '[data-testid="sailing-card"]',
      '[class*="CruiseCard"]',
      '[class*="cruiseCard"]',
      '[class*="sailingCard"]',
      '[class*="SailingCard"]',
      '[class*="cruise-card"]',
      '[class*="tile-card"]',
      '[class*="TileCard"]',
      'article[class*="cruise"]',
    ];

    let cards = [];
    for (const sel of CARD_SELECTORS) {
      cards = [...document.querySelectorAll(sel)];
      if (cards.length > 0) break;
    }
    if (!cards.length) return { source: 'dom', list: [] };

    const getText = (el, ...selectors) => {
      for (const sel of selectors) {
        const found = el.querySelector(sel);
        if (found && found.textContent.trim()) return found.textContent.trim();
      }
      return '';
    };

    const list = cards.map((card) => ({
      shipName: getText(
        card,
        '[data-testid="ship-name"]',
        '[class*="shipName"]',
        '[class*="ShipName"]',
        '[class*="ship-name"]'
      ),
      itinerary: getText(
        card,
        '[data-testid="itinerary-name"]',
        '[class*="itinerary"]',
        '[class*="Itinerary"]',
        '[class*="cruise-name"]',
        '[class*="CruiseName"]',
        'h2',
        'h3'
      ),
      departureDate: getText(
        card,
        '[data-testid="departure-date"]',
        '[class*="departureDate"]',
        '[class*="DepartureDate"]',
        '[class*="departure-date"]',
        'time'
      ),
      duration: getText(
        card,
        '[data-testid="duration"]',
        '[class*="duration"]',
        '[class*="Duration"]',
        '[class*="nights"]',
        '[class*="Nights"]'
      ),
      departurePort: getText(
        card,
        '[data-testid="departure-port"]',
        '[class*="departurePort"]',
        '[class*="port"]',
        '[class*="Port"]'
      ),
      destination: getText(
        card,
        '[data-testid="destination"]',
        '[class*="destination"]',
        '[class*="Destination"]',
        '[class*="region"]',
        '[class*="Region"]'
      ),
      priceFrom: getText(
        card,
        '[data-testid="price"]',
        '[class*="price"]',
        '[class*="Price"]',
        '[class*="amount"]',
        '[class*="Amount"]'
      ),
      currency: 'GBP',
      bookingUrl: (() => {
        const a = card.querySelector('a[href*="royalcaribbean"]') || card.querySelector('a');
        return a ? a.href : '';
      })(),
    }));

    return { source: 'dom', list: list.filter((c) => c.shipName || c.itinerary) };
  });

  if (raw.source === 'nextData') return normaliseCruises(raw.list);
  // DOM already returns near-normalised data — just clean up price
  return raw.list.map((c) => ({
    ...c,
    priceFrom: formatPrice(c.priceFrom),
  }));
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚢  Royal Caribbean cruise viewer running at http://localhost:${PORT}\n`);
});

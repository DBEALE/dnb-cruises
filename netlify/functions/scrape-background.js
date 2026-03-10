'use strict';

/**
 * Netlify Background Function — Royal Caribbean GBR Cruise Scraper
 *
 * Naming a function file with the `-background` suffix tells Netlify to run it
 * as a background function (up to 15-minute timeout). Netlify returns HTTP 202
 * to the caller immediately, then executes this handler asynchronously.
 *
 * Workflow:
 *   1. Mark status as "running" in Netlify Blobs so the frontend can poll.
 *   2. Launch a headless Chromium via @sparticuz/chromium + puppeteer-core.
 *   3. Load the Royal Caribbean GBR page, extract cruise data.
 *   4. Store results (or error) back in Blobs under the key "status".
 *
 * The companion function `cruises.js` reads those Blobs and returns them to
 * the frontend.
 */

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { connectLambda, getStore } = require('@netlify/blobs');

const RC_URL =
  'https://www.royalcaribbean.com/gbr/en/cruises' +
  '?sort=by:PRICE|order:ASC&country=GBR&market=gbr&language=en';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_SCROLL_ITERATIONS = 8;
const MAX_RECURSION_DEPTH = 12;

// ─── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // In a deployed Netlify Lambda, the Blobs context (siteID + token) arrives
  // in event.blobs, not as a pre-set environment variable.
  // connectLambda() extracts it and sets process.env.NETLIFY_BLOBS_CONTEXT so
  // that subsequent getStore() calls work correctly.
  if (event && event.blobs) {
    connectLambda(event);
  }

  let store;
  let browser;
  try {
    store = getStore('cruises');

    // Immediately mark as running so the polling endpoint can respond correctly
    await store.setJSON('status', {
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const page = await browser.newPage();

    // Mimic a real browser to reduce bot-detection triggers
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });

    // Hide common Puppeteer fingerprints
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // ── Intercept JSON API responses ──────────────────────────────────────────
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

    console.log('Background: loading Royal Caribbean GBR cruises page …');
    await page.goto(RC_URL, { waitUntil: 'networkidle2', timeout: 90000 });

    // Allow JS to finish rendering
    await delay(4000);

    // ── Scroll / Load-more loop ───────────────────────────────────────────────
    for (let i = 0; i < MAX_SCROLL_ITERATIONS; i++) {
      await page.evaluate(() =>
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
      );
      await delay(1500);

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

    // ── Extract cruises ───────────────────────────────────────────────────────
    let cruises = [];

    if (capturedApiData) {
      cruises = normaliseCruises(parseCruisesFromApiPayload(capturedApiData));
    }

    if (!cruises.length) {
      cruises = await extractFromPage(page);
    }

    await browser.close();
    browser = null;

    await store.setJSON('status', {
      status: 'ready',
      success: true,
      count: cruises.length,
      cruises,
      source: RC_URL,
      scrapedAt: new Date().toISOString(),
    });

    console.log(`Background: stored ${cruises.length} cruises.`);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Background scrape error:', err.message);

    if (store) {
      await store.setJSON('status', {
        status: 'error',
        success: false,
        error: err.message,
      }).catch(() => {});
    }
  }
};

// ─── Helpers (mirrored from server.js) ────────────────────────────────────────

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
    obj.payload?.sailings;
  if (!Array.isArray(list) || list.length === 0) return false;
  return isCruiseLike(list[0]);
}

function isCruiseLike(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return !!(
    obj.shipName || obj.ship || obj.vessel || obj.vesselName ||
    obj.sailDate || obj.departureDate || obj.embarkDate || obj.sailingDate ||
    obj.priceFrom || obj.price || obj.lowestPrice || obj.startPrice ||
    obj.itinerary || obj.itineraryName || obj.cruiseName || obj.sailingName
  );
}

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
    []
  );
}

function normaliseCruises(rawList) {
  return rawList
    .map((c) => {
      // Price may arrive as a plain number, a formatted string ("£899"), or an
      // object like { amount: 899, currency: 'GBP' }.  Try every known field
      // name before falling back to null so formatPrice can do its job.
      const rawPrice =
        c.priceFrom ?? c.price ?? c.lowestPrice ?? c.startPrice ??
        c.salePrice ?? c.pricePerPerson ?? c.pricing ?? null;

      // When the price is a wrapper object, hoist the currency from it too.
      const currency =
        c.currency ||
        (rawPrice && typeof rawPrice === 'object' ? rawPrice.currency : null) ||
        'GBP';

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
        priceFrom: formatPrice(rawPrice),
        currency,
        bookingUrl:
          c.detailUrl || c.url || c.bookingUrl || c.link || c.href || '',
      };
    })
    .filter((c) => c.shipName || c.itinerary || c.departureDate);
}

function formatPrice(val) {
  if (val == null) return '';
  // Handle price objects like { amount: 1234, currency: 'GBP' } or
  // { value: 1234 } or { perPerson: 1234 }
  if (typeof val === 'object') {
    val = val.amount ?? val.value ?? val.price ?? val.perPerson ?? val.total ?? null;
    if (val == null) return '';
  }
  const n = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? '' : String(n);
}

async function extractFromPage(page) {
  const raw = await page.evaluate((maxRecursionDepth) => {
    // ── Try __NEXT_DATA__ ───────────────────────────────────────────────────
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
          if (depth > maxRecursionDepth || !obj || typeof obj !== 'object') return null;
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
    // ── Try cruise cards in the DOM ─────────────────────────────────────────
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

    const list = cards.map((card) => ({
      shipName: getText(
        card,
        '[data-testid="ship-name"]',
        '[class*="shipName"]',
        '[class*="ShipName"]',
        '[class*="ship-name"]',
        '[class*="vesselName"]'
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
      priceFrom: getText(
        card,
        '[data-testid="price"]',
        '[data-testid="starting-price"]',
        '[class*="startingPrice"]',
        '[class*="StartingPrice"]',
        '[class*="lowestPrice"]',
        '[class*="LowestPrice"]',
        '[class*="priceFrom"]',
        '[class*="PriceFrom"]',
        '[class*="price"]',
        '[class*="Price"]',
        '[class*="amount"]',
        '[class*="Amount"]'
      ),
      currency: 'GBP',
      bookingUrl: (() => {
        const a =
          card.querySelector('a[href*="royalcaribbean"]') || card.querySelector('a');
        return a ? a.href : '';
      })(),
    }));

    return { source: 'dom', list: list.filter((c) => c.shipName || c.itinerary) };
  }, MAX_RECURSION_DEPTH);

  if (raw.source === 'nextData') return normaliseCruises(raw.list);
  return raw.list.map((c) => ({
    ...c,
    priceFrom: formatPrice(c.priceFrom),
  }));
}

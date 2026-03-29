'use strict';

/**
 * Netlify Background Function — Royal Caribbean GBR Cruise Scraper
 *
 * Naming a function file with the `-background` suffix tells Netlify to run it
 * as a background function (up to 15-minute timeout). Netlify returns HTTP 202
 * to the caller immediately, then executes this handler asynchronously.
 *
 * Uses Firecrawl for reliable, JavaScript-rendered scraping with AI-powered
 * structured data extraction. Requires the FIRECRAWL_API_KEY environment
 * variable to be set in Netlify.
 *
 * Workflow:
 *   1. Mark status as "running" in Netlify Blobs so the frontend can poll.
 *   2. Call the Firecrawl API to scrape and extract cruise data.
 *   3. Store results (or error) back in Blobs under the key "status".
 *
 * The companion function `cruises.js` reads those Blobs and returns them to
 * the frontend.
 */

const { FirecrawlAppV1: FirecrawlApp } = require('@mendable/firecrawl-js');
const { connectLambda, getStore } = require('@netlify/blobs');

const RC_URL =
  'https://www.royalcaribbean.com/gbr/en/cruises' +
  '?search=departurePort:ATH,BCN,BLQ,IST,ROM,STH,TRS|nights:6~8,9~11,gte12' +
  '&sort=by:PRICE|order:ASC&conflict_banner=false&country=GBR&market=gbr&language=en';

const DEFAULT_LIMIT = 100;

// JSON schema for structured cruise extraction
const CRUISE_SCHEMA = {
  type: 'object',
  properties: {
    cruises: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          shipName:      { type: 'string', description: 'Name of the cruise ship' },
          itinerary:     { type: 'string', description: 'Name of the cruise itinerary or route' },
          duration:      { type: 'string', description: 'Duration of the cruise, e.g. "7 Nights"' },
          departurePort: { type: 'string', description: 'Port of embarkation / departure' },
          destination:   { type: 'string', description: 'Destination region or ports visited' },
          priceFrom:     { type: 'string', description: 'Lowest price per person in GBP (digits only, no currency symbol)' },
          bookingUrl:    { type: 'string', description: 'Full URL to view dates or book this cruise' },
        },
        required: ['shipName', 'itinerary'],
      },
    },
  },
  required: ['cruises'],
};

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
  try {
    store = getStore('cruises');

    // Immediately mark as running so the polling endpoint can respond correctly
    await store.setJSON('status', {
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    const limit = parseInt(
      event.queryStringParameters && event.queryStringParameters.limit, 10,
    ) || DEFAULT_LIMIT;

    const cruises = await scrapeCruises(
      (event.headers && event.headers['x-firecrawl-api-key']) ||
      process.env.FIRECRAWL_API_KEY,
      limit,
    );

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Scrape the Royal Caribbean GBR cruise listings using Firecrawl and return
 * a normalised array of cruise objects.
 * @param {string} apiKey  Firecrawl API key.
 * @param {number} [limit] Maximum number of cruise listings to extract (default: DEFAULT_LIMIT).
 */
async function scrapeCruises(apiKey, limit = DEFAULT_LIMIT) {
  if (!apiKey) {
    throw new Error('Firecrawl API key is required. Please provide it via the prompt or set FIRECRAWL_API_KEY.');
  }
  const firecrawl = new FirecrawlApp({ apiKey });

  console.log('Background: loading Royal Caribbean GBR cruises page via Firecrawl …');

  // Scroll down the page multiple times so lazy-loaded results are rendered
  // before the content is extracted. Each pair scrolls one viewport-height
  // and then waits for the network/JS to settle.
  const scrollActions = [];
  for (let i = 0; i < 25; i++) {
    scrollActions.push({ type: 'scroll', direction: 'down', amount: 800 });
    scrollActions.push({ type: 'wait', milliseconds: 1500 });
  }

  const result = await firecrawl.scrapeUrl(RC_URL, {
    formats: ['json'],
    actions: scrollActions,
    timeout: 120000,
    jsonOptions: {
      prompt:
        `Extract up to ${limit} cruise listings shown on this Royal Caribbean page. ` +
        'Do not stop early; include every listing visible up to that limit. ' +
        'For each cruise record the ship name, itinerary/route name, ' +
        'duration in nights (e.g. "7 Nights"), departure / embarkation port, ' +
        'destination region or ports visited, the lowest price per person in ' +
        'GBP (digits only, no £ symbol), and the full booking or "view dates" URL.',
      schema: CRUISE_SCHEMA,
    },
  });

  if (!result.success) {
    throw new Error(result.error || 'Firecrawl scrape failed');
  }

  const raw = result.json?.cruises || [];
  return raw.map((c) => ({
    shipName:      c.shipName      || '',
    itinerary:     c.itinerary     || '',
    departureDate: '',
    duration:      c.duration      || '',
    departurePort: c.departurePort || '',
    destination:   c.destination   || '',
    priceFrom:     c.priceFrom     || '',
    currency:      'GBP',
    bookingUrl:    c.bookingUrl    || '',
  }));
}

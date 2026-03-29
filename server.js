'use strict';

/**
 * Royal Caribbean GBR Cruise Scraper — Firecrawl Edition
 *
 * Uses the Firecrawl API for reliable, JavaScript-rendered scraping with
 * AI-powered structured data extraction. Requires the FIRECRAWL_API_KEY
 * environment variable to be set.
 *
 * Start: node server.js
 * Endpoints:
 *   GET /            – serves public/index.html
 *   GET /api/cruises – returns JSON array of cruise objects
 */

const express = require('express');
const { FirecrawlAppV1: FirecrawlApp } = require('@mendable/firecrawl-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Serve the static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ─── Scrape endpoint ────────────────────────────────────────────────────────

app.get('/api/cruises', async (req, res) => {
  try {
    const apiKey = req.headers['x-firecrawl-api-key'] || process.env.FIRECRAWL_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: 'Firecrawl API key is required. Provide it via the X-Firecrawl-API-Key header or set FIRECRAWL_API_KEY in the environment.',
        hint: 'For local testing: export FIRECRAWL_API_KEY=your_key and restart the server, or include X-Firecrawl-API-Key in the request headers.',
      });
    }

    const limit = parseInt(req.query.limit, 10) || DEFAULT_LIMIT;
    const cruises = await scrapeCruises(apiKey, limit);

    console.log(`✓ Successfully extracted ${cruises.length} cruises`);

    res.json({
      success: true,
      count: cruises.length,
      cruises,
      source: RC_URL,
      scrapedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

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

  console.log('Loading Royal Caribbean GBR cruises page via Firecrawl …');

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

// ─── Start ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚢  Royal Caribbean cruise viewer running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;

# Copilot Instructions

## Project overview

`dnb-cruises` is a Node.js web application that scrapes cruise listings from the Royal Caribbean GBR (UK) market and presents them in a clean, sortable HTML table.

- **Backend** (`server.js`) — Express server with a single `/api/cruises` endpoint that uses the [Firecrawl](https://www.firecrawl.dev/) API (`@mendable/firecrawl-js`) to scrape and extract structured cruise data from the Royal Caribbean GBR search page.
- **Frontend** (`public/index.html`) — Single-page UI that calls the API and renders results in a sortable, filterable table with booking links.
- **Netlify deployment** (`netlify/functions/`) — Two Netlify Functions mirror the backend logic for serverless deployment:
  - `scrape-background.js` — Netlify Background Function (≤15 min timeout) that scrapes and stores results in [Netlify Blobs](https://docs.netlify.com/blobs/overview/).
  - `cruises.js` — Synchronous function that reads the stored blob and returns results to the frontend.

## Tech stack

- **Runtime:** Node.js ≥ 18 (`node:test` built-in test runner, no Jest/Mocha)
- **Web framework:** Express 4
- **Scraping:** Firecrawl (`@mendable/firecrawl-js`) — requires `FIRECRAWL_API_KEY` environment variable
- **Blob storage (Netlify):** `@netlify/blobs`
- **Deployment:** Netlify (config in `netlify.toml`)
- **Tests:** Node.js built-in `node:test` + `node:assert/strict`

## Project structure

```
server.js                          # Express app entry point
public/
  index.html                       # Frontend SPA
netlify/
  functions/
    scrape-background.js           # Netlify Background Function (scrapes + stores)
    cruises.js                     # Netlify Function (reads + returns stored results)
netlify.toml                       # Netlify config (publish dir, functions dir, redirects)
test/
  api-key.test.js                  # Tests Firecrawl API key presence and validity
  cruises-route.test.js            # Tests /api/cruises route error handling
package.json
```

## Running, testing, and building

```bash
# Install dependencies
npm install

# Start the local server (http://localhost:3000)
npm start

# Start with file watching (auto-restart on changes)
npm run dev

# Run tests
npm test
```

There is no separate build step — the app runs directly with Node.js.

## Coding conventions

- `'use strict';` at the top of every `.js` file.
- CommonJS modules (`require` / `module.exports`), not ES modules.
- `async`/`await` for all asynchronous code.
- JSDoc comments on exported and key helper functions.
- Align object property values vertically when defining object literals with many keys (see `CRUISE_SCHEMA` and the cruise mapping in `scrapeCruises`).
- Section separators use the pattern: `// ─── Section name ──────────`.

## Key patterns and architecture

### Firecrawl scraping
Both `server.js` and `netlify/functions/scrape-background.js` contain a `scrapeCruises(apiKey)` helper that:
1. Instantiates `FirecrawlApp` with the provided API key.
2. Calls `firecrawl.scrapeUrl(RC_URL, { formats: ['json'], jsonOptions: { prompt, schema } })`.
3. Maps the raw JSON response to a normalised cruise object with fixed fields: `shipName`, `itinerary`, `departureDate`, `duration`, `departurePort`, `destination`, `priceFrom`, `currency`, `bookingUrl`.

**Important:** This logic is intentionally duplicated in both files. When changing scraping behaviour, update **both** `server.js` and `netlify/functions/scrape-background.js`.

### API key handling
The Firecrawl API key can be supplied via:
- The `X-Firecrawl-API-Key` request header (takes precedence), or
- The `FIRECRAWL_API_KEY` environment variable.

The `/api/cruises` endpoint returns HTTP 400 with `{ success: false, error, hint }` when neither is present. This short-circuit fires before any scraping occurs.

### Server export pattern
`server.js` exports the Express `app` and only calls `app.listen()` when `require.main === module`. This allows the app to be imported in tests without starting a server.

### Tests
Tests use the Node.js built-in `node:test` runner and `node:assert/strict`. Run with `npm test` (currently runs `test/api-key.test.js` only; `test/cruises-route.test.js` can be run directly with `node --test test/cruises-route.test.js`).

Tests must not depend on external network access to pass in sandboxed environments — any live API check should use `t.skip()` when the network is unavailable.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `FIRECRAWL_API_KEY` | Yes | Firecrawl API key (format: `fc-<hex>`) |
| `PORT` | No | Port for local Express server (default: `3000`) |

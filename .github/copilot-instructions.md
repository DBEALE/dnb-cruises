# Copilot Instructions

## Project overview

`dnb-cruises` is a Node.js web application that scrapes cruise listings from Royal Caribbean GBR and presents them in a clean, sortable HTML table.

- **Local server** (`server.js`) — Express app that serves `public/` and exposes `/api/cruises` for local development.
- **Frontend** (`public/index.html`) — Single-page UI that loads provider-specific static data from `public/providers/` and renders a sortable, filterable table with booking links.
- **Static deployment** (`.github/workflows/deploy-pages.yml`) — GitHub Actions refreshes cruise data with `scripts/fetch-cruises.js` and deploys `public/` to GitHub Pages on an hourly schedule and on pushes to `main`.

## Tech stack

- **Runtime:** Node.js ≥ 18 (`node:test` built-in test runner, no Jest/Mocha)
- **Web framework:** Express 4
- **Deployment:** GitHub Pages via GitHub Actions
- **Tests:** Node.js built-in `node:test` + `node:assert/strict`, plus Playwright for browser checks

## Project structure

```
server.js                          # Express app entry point
public/
  index.html                       # Frontend SPA
  providers/
    index.json                     # Provider manifest for static hosting
    royal-caribbean/
      cruises.json                 # Provider-specific cruise snapshot
scripts/
  fetch-cruises.js                # Generates provider snapshots and the manifest
.github/workflows/deploy-pages.yml # Hourly GitHub Pages deployment workflow
test/
  ui-provider-load.test.js        # Sandboxed frontend loading tests
  ui-provider-load.e2e.js         # Playwright browser test
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

There is no separate build step for the local app. The GitHub Pages workflow handles data refresh and deployment.

## Coding conventions

- `'use strict';` at the top of every `.js` file.
- CommonJS modules (`require` / `module.exports`), not ES modules.
- `async`/`await` for all asynchronous code.
- JSDoc comments on exported and key helper functions.
- Section separators use the pattern: `// ─── Section name ──────────`.

## Key patterns and architecture

### Static cruise data
`scripts/fetch-cruises.js` writes provider-specific cruise snapshots to `public/providers/<provider-id>/cruises.json` and updates `public/providers/index.json`. The frontend uses the manifest to discover available providers and loads their snapshot files directly.

### Server export pattern
`server.js` exports the Express `app` and only calls `app.listen()` when `require.main === module`. This allows the app to be imported in tests without starting a server.

### Tests
Tests use the Node.js built-in `node:test` runner and `node:assert/strict`. Browser checks use Playwright. Tests should not depend on external network access unless they explicitly guard for it.

# dnb-cruises

A Node.js web app that scrapes cruise listings from the configured providers in the UK market and presents them in a clean, sortable HTML table.

## Screenshot

![Cruise explorer viewer](https://github.com/user-attachments/assets/2183351b-32fc-4ce9-bcf9-ec439ac1390c)

## How it works

1. **Backend** (`server.js`) — Express server for local development. It serves `public/` and exposes `/api/cruises` so the app can still be exercised locally without static hosting.

2. **Frontend** (`public/index.html`) — A single-page UI that loads provider-specific static files and renders results in a table with:
   - **Click-to-sort** on every column (ascending / descending toggle)
   - **Live text filter** across ship name, destination, itinerary and port
   - A **Book →** link for each cruise that opens on royalcaribbean.com
   - Static hosting loads provider-specific files from `public/providers/<provider-id>/cruises.json` via `public/providers/index.json`

## Setup

### Local development

**Requirements:** Node.js >= 18

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser and click **Fetch Cruises**.

To manually refresh all provider cruise data locally, run:

```bash
node scripts/fetch-cruises.js
```

> The first fetch can take up to 90 seconds because Puppeteer launches a full headless Chrome instance to render the dynamic page.

### Deploy to GitHub Pages

The site is built for GitHub Pages. A GitHub Actions workflow in [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) refreshes the cruise data and deploys the static site every hour and on pushes to `main`.

## Columns

| Column | Description |
|---|---|
| # | Row number |
| Ship | Ship name |
| Itinerary / Name | Cruise itinerary or sailing name |
| Destination | Region or destination area |
| Departure Date | Sail date |
| Duration | Number of nights |
| Departure Port | Embarkation port |
| Price From | Lowest advertised price per person (GBP) |
| Book | Direct link to the provider booking page |

## Source

Data is scraped live from:
https://www.royalcaribbean.com/gbr/en/cruises?sort=by:PRICE|order:ASC&country=GBR&market=gbr&language=en

Generated static data now lives under `public/providers/` instead of a single shared `public/cruises.json` file. To add another provider, add a module under `providers/`, include it in `providers/index.js`, and the build script will generate its own `cruises.json` plus update the provider manifest.

Prices and availability are subject to change. Always verify on the provider website before booking.


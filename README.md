# dnb-cruises

A Node.js web app that scrapes cruise listings from major UK-market cruise lines
and presents them in a fast, filterable, sortable single-page viewer — with
per-cabin price history, saved searches, connecting-journey planning, and a
multi-cruise route finder.

## Screenshot

![Cruise explorer viewer](https://github.com/user-attachments/assets/2183351b-32fc-4ce9-bcf9-ec439ac1390c)

## Providers

Data is aggregated from six cruise lines (see `providers/index.js`):

- **Royal Caribbean**
- **Celebrity Cruises**
- **Norwegian Cruise Line (NCL)**
- **Princess Cruises**
- **P&O Cruises**
- **Virgin Voyages**

Each provider is a self-contained scraper that normalises its source into one
shared cruise contract (ship, itinerary, ports, dates, region, per-cabin
prices, and price history). Most use the lines' JSON search APIs; a couple mint
a token or read prices via a short headless-Chromium step.

## Features

### Browsing, sorting & filtering
- **Sortable table** — click any column header to sort ascending/descending.
- **Per-column filters** — ship, cruise line, ship class (dropdowns), min launch
  year, departure **date range**, departure port, itinerary (multi-word), destination
  port, min nights, max sea days, region (with grouped areas), and max price.
- **Toolbar filters** — price reduced (past 24h / week), newly added (past 24h /
  week), and endpoint ports (round-trip "same port" vs. one-way "different ports").
- **Port matching** is proximity-aware — an optional search radius also matches
  nearby ports, not just an exact name.

### Prices & history
- **Per-cabin prices** — Inside, Sea view, Balcony, and Suite, normalised to GBP
  (USD fares converted at the current rate).
- **Price-history sparklines** under each cabin price, plus a full
  **price-history dialog** with a chart and per-bucket table.
- **Price signals** — price-change %, a "24-hour price reduction" sort, "recently
  found" sort, **price stars** (≥15% below the recorded peak) and a
  **lowest-price highlight**.
- **£/night** — an optional sortable price-per-night column.

### Journey planning
- **Onward journey explorer** — from any cruise's destination port, chain
  connecting cruises within your configured window. Each port leg expands to its
  individual sailings (ship · nights · fare, linking back into the table), and
  each sailing expands onward from its own arrival — with a running **cumulative
  total price and nights** for the whole journey.
- **Route finder** — enter a **from** port, **to** port, optional ordered
  **waypoints**, and a **maximum total budget**; it traverses the cruise graph
  to list chains of connecting cruises that reach the destination within budget,
  cheapest first.
- **Connecting-cruise buttons** on each row — find a "cruise after" (departing
  the destination port) or a "cruise before" (arriving into the departure port).

### Saved searches, favourites & sharing
- **Saved views** — store a filter+sort combination with an auto-suggested name,
  re-apply or delete it later.
- **Favourites** — star cruises and switch to a favourites-only view.
- **Share** the current search or an individual cruise via URL (state is encoded
  in the address hash, so links and the back button round-trip).
- **WhatsApp alerts** — subscribe a saved view to be notified when new matching
  cruises appear.

### Personalisation (Settings)
Dark mode · price-history sparklines · £/night column · price stars · lowest-price
highlight · link targets for ship/line/class names (Wikipedia / cruise company /
none) · connecting-cruise window · port search radius · onward-journey depth ·
class quality dots · ship launch year · ship icons · **home port** highlighting.

### Mobile
Below tablet width the table becomes a **card layout** with a dedicated
**sort & filter sheet**, and compact route/share actions. All preferences persist
in `localStorage`.

## Columns (wide screen)

| Column | Description |
|---|---|
| # | Row number |
| Ship | Ship name (with line/class/launch details) |
| Cruise line | Provider |
| Class | Ship class (with quality dots) |
| Launch | Ship launch year |
| Departure | Sail date |
| Departure port | Embarkation port |
| Itinerary | Port sequence for the sailing |
| Destination port | Final (disembarkation) port |
| Nights | Duration |
| Sea days | Days at sea |
| Region | Departure region |
| Price | Lowest cabin fare (GBP) |
| £/night | Price per night (optional) |

("First seen" is tracked and shown in the mobile card view.)

## How it works

- **Frontend** (`public/`) — a static single-page app (`index.html`, `app.js`,
  `styles.css`). It loads each provider's snapshot from
  `public/providers/<provider-id>/cruises.json` via the `public/providers/index.json`
  manifest, then does all filtering, sorting, and rendering client-side. Data
  loads automatically on open.
- **Scraper** (`scripts/fetch-cruises.js`) — runs every provider, merges per-cabin
  prices, accumulates price history into a sibling `price-history.json`, and writes
  each provider's `cruises.json` plus the manifest. Providers **fail closed**: an
  empty or degraded scrape (e.g. a missing port map) is dropped rather than
  overwriting the last good snapshot.
- **Backend** (`server.js`) — a small Express server for local development. It
  serves `public/` and exposes `GET /api/cruises` to fetch live data from all
  providers without static hosting.
- **Deploy** — the site is hosted on GitHub Pages; a GitHub Actions workflow
  refreshes the cruise data and redeploys on a schedule and on pushes to `main`.

## Setup

**Requirements:** Node.js >= 18

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

Refresh all provider data locally:

```bash
npm run cruises:pull      # node scripts/fetch-cruises.js
```

> Providers that render a page in headless Chromium can take a little longer on
> the first run.

## Testing

```bash
npm test          # unit tests (node --test) + Playwright e2e
npm run test:unit # unit tests only
npm run test:e2e  # Playwright end-to-end only
```

## Adding a provider

1. Create `providers/<name>.js` exporting `{ id, name, fetchCruises() }` that
   returns cruises in the shared contract (see an existing provider and
   `providers/shared.js`).
2. Add it to the array in `providers/index.js`.
3. Run `npm run cruises:pull` — the build generates its `cruises.json` and updates
   `public/providers/index.json`.

---

Prices shown are per person and subject to change. Always verify on the cruise
line's website before booking.

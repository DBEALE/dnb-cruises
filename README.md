# dnb-cruises

A Node.js web app that scrapes all cruises from the Royal Caribbean GBR (UK) market and presents them in a clean, sortable HTML table.

## Screenshot

![Royal Caribbean GBR Cruises viewer](https://github.com/user-attachments/assets/2183351b-32fc-4ce9-bcf9-ec439ac1390c)

## How it works

1. **Backend** (`server.js`) — Express server that uses [Puppeteer](https://pptr.dev/) to load the Royal Caribbean GBR cruise search page (a JavaScript-rendered SPA) in a headless Chrome browser. It tries three extraction strategies in order of preference:
   - Intercept XHR/fetch API responses that carry cruise JSON directly
   - Parse the embedded `__NEXT_DATA__` blob that Next.js injects into the HTML
   - Fall back to CSS-selector DOM scraping of the rendered cruise cards

2. **Frontend** (`public/index.html`) — A single-page UI that calls the `/api/cruises` endpoint and renders results in a table with:
   - **Click-to-sort** on every column (ascending / descending toggle)
   - **Live text filter** across ship name, destination, itinerary and port
   - A **Book →** link for each cruise that opens on royalcaribbean.com

## Setup

**Requirements:** Node.js >= 18

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser and click **Fetch Cruises**.

> The first fetch can take up to 90 seconds because Puppeteer launches a full headless Chrome instance to render the dynamic page.

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
| Book | Direct link to the Royal Caribbean booking page |

## Source

Data is scraped live from:
https://www.royalcaribbean.com/gbr/en/cruises?sort=by:PRICE|order:ASC&country=GBR&market=gbr&language=en

Prices and availability are subject to change. Always verify on the Royal Caribbean website before booking.

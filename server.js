'use strict';

/**
 * Royal Caribbean GBR Cruise Scraper — Completely Rewritten
 *
 * The RC website uses React with styled-components, making class-based selectors
 * unreliable. This version uses the stable `div[id^="cruise-card_"]` selector
 * and extracts data by parsing text content directly.
 *
 * Key insights from page inspection:
 *   - Cards have IDs like: cruise-card_SR01ONX-1808727148
 *   - Text content is structured and predictable
 *   - Prices appear as separate elements: "£" and "111"
 *   - Booking buttons have IDs: card-view-dates-button-{SHIPCODE}-{UNIQUEID}
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

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });

    // Hide Puppeteer fingerprints
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    console.log('Loading Royal Caribbean GBR cruises page …');
    await page.goto(RC_URL, { waitUntil: 'networkidle2', timeout: 90000 });

    // Allow JS to finish rendering
    await delay(3000);

    // ── Scroll and load more ────────────────────────────────────────────────
    console.log('Scrolling and loading more cruises...');
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      });
      await delay(1500);

      // Look for "Load more" button
      const loadMoreClicked = await page.evaluate(() => {
        const btn = document.querySelector('button:contains("Load more")') ||
                    Array.from(document.querySelectorAll('button')).find(b => 
                      b.textContent.includes('Load more')
                    );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (loadMoreClicked) await delay(2000);
    }

    // ── Extract cruises using the stable card ID selector ──────────────────
    const cruises = await extractCruisesFromPage(page);
    
    await browser.close();

    console.log(`✓ Successfully extracted ${cruises.length} cruises`);

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
 * Extract cruises from the page using the stable card ID selector.
 * The RC website uses styled-components with unpredictable class names,
 * so we rely on the stable `div[id^="cruise-card_"]` selector and parse
 * the text content directly.
 */
async function extractCruisesFromPage(page) {
  const cruises = await page.evaluate(() => {
    const cards = document.querySelectorAll('div[id^="cruise-card_"]');
    const results = [];

    for (const card of cards) {
      try {
        const cardId = card.id; // e.g., "cruise-card_SR01ONX-1808727148"
        const text = card.innerText || card.textContent;
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);

        // Parse the structured text content
        // Example structure:
        // [0] "1 Nights"
        // [1] "Southern Caribbean Cruise"
        // [2] "Serenade of the Seas"
        // [3] "4.6"
        // [4] "4.6 out of 5 stars. 44021 reviews"
        // [5] "ONE-WAY FROM:Colón, Panama to Cartagena, Colombia"
        // [6] "CRUISE PORTS:Colón, PanamaCartagena, Colombia"
        // [7] "+ View Ports & Map"
        // [8] "AVG PER PERSON*"
        // [9] "£"
        // [10] "111"
        // [11] "View 1 date"
        // [12] "View itinerary"

        let duration = '';
        let itinerary = '';
        let shipName = '';
        let departureInfo = '';
        let priceStr = '';
        let bookingUrl = '';

        // Extract duration (first line usually)
        if (lines[0] && lines[0].includes('Nights')) {
          duration = lines[0];
        }

        // Extract itinerary (usually second non-duration line)
        let itineraryIdx = 1;
        if (lines[itineraryIdx] && !lines[itineraryIdx].includes('Nights')) {
          itinerary = lines[itineraryIdx];
        }

        // Extract ship name (usually after itinerary, before ratings)
        let shipIdx = 2;
        if (lines[shipIdx] && !lines[shipIdx].includes('out of 5') && !lines[shipIdx].includes('Nights')) {
          shipName = lines[shipIdx];
        }

        // Extract departure info (contains "FROM:" or "ROUNDTRIP")
        const departureLineIdx = lines.findIndex(l => l.includes('FROM:'));
        if (departureLineIdx >= 0) {
          departureInfo = lines[departureLineIdx];
        }

        // Extract price: look for "£" followed by a number
        const priceLineIdx = lines.findIndex(l => l === '£');
        if (priceLineIdx >= 0 && priceLineIdx + 1 < lines.length) {
          const nextLine = lines[priceLineIdx + 1];
          // Check if next line is a number
          if (/^\d+$/.test(nextLine)) {
            priceStr = nextLine;
          }
        }

        // Extract booking URL from button ID
        // Button ID format: card-view-dates-button-{SHIPCODE}-{UNIQUEID}
        const dateButton = card.querySelector('button[id^="card-view-dates-button-"]');
        if (dateButton && dateButton.id) {
          const buttonId = dateButton.id;
          // Extract the ship code and unique ID from the button ID
          const match = buttonId.match(/card-view-dates-button-(.+)/);
          if (match) {
            const cruiseCode = match[1];
            // Construct the booking URL
            bookingUrl = `https://www.royalcaribbean.com/gbr/en/cruises/${cruiseCode}`;
          }
        }

        // Parse departure port from "FROM:" line
        let departurePort = '';
        if (departureInfo) {
          const fromMatch = departureInfo.match(/FROM:(.+?)(?:to|$)/);
          if (fromMatch) {
            departurePort = fromMatch[1].trim();
          }
        }

        // Extract destination from ports list
        let destination = '';
        const portsLineIdx = lines.findIndex(l => l.includes('CRUISE PORTS:'));
        if (portsLineIdx >= 0) {
          const portsLine = lines[portsLineIdx];
          // Extract ports from "CRUISE PORTS:Port1Port2Port3" format
          const portsMatch = portsLine.match(/CRUISE PORTS:(.+)/);
          if (portsMatch) {
            destination = portsMatch[1];
          }
        }

        // Only include if we have essential data
        if (shipName || itinerary) {
          results.push({
            shipName: shipName || '',
            itinerary: itinerary || '',
            departureDate: '', // Not visible in current page structure
            duration: duration || '',
            departurePort: departurePort || '',
            destination: destination || '',
            priceFrom: priceStr || '',
            currency: 'GBP',
            bookingUrl: bookingUrl || '',
          });
        }
      } catch (e) {
        console.error('Error parsing card:', e.message);
      }
    }

    return results;
  });

  return cruises;
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚢  Royal Caribbean cruise viewer running at http://localhost:${PORT}\n`);
});

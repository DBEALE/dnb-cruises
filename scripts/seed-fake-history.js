'use strict';

/**
 * seed-fake-history.js
 *
 * LOCAL PREVIEW ONLY. Overwrites public/providers/<id>/cruises.json with
 * synthetic priceHistory so the sparkline + dialog UI can be demoed before
 * real scrape cycles have accumulated data.
 *
 * The last entry in each generated history matches the cruise's current
 * priceFrom, so the table's "Price" column stays consistent with the dialog.
 *
 * Do NOT commit the result. Revert with:
 *   git checkout public/providers/*\/cruises.json
 */

const fs   = require('node:fs');
const path = require('node:path');

const PROVIDERS_DIR = path.join(__dirname, '..', 'public', 'providers');
const DAY_MS        = 24 * 60 * 60 * 1000;

function seedHistory(cruise, scrapedAt) {
  const currentPrice = parseFloat(cruise.priceFrom);
  if (!Number.isFinite(currentPrice)) return cruise;

  const endMs    = Date.parse(scrapedAt) || Date.now();
  const numPoints = 3 + Math.floor(Math.random() * 5);   // 3..7 entries
  const spanDays  = 14 + Math.floor(Math.random() * 30); // 14..44 days back

  // Build oldest → newest. Oldest price wobbles up/down from current by up to
  // ±15%; intermediate points are linearly interpolated with light noise so
  // the line isn't perfectly straight.
  const startPrice = currentPrice * (1 + (Math.random() - 0.5) * 0.3);
  const points = [];
  for (let i = 0; i < numPoints; i++) {
    const t        = i / (numPoints - 1);                 // 0..1
    const daysBack = (1 - t) * spanDays;
    const at       = new Date(endMs - daysBack * DAY_MS).toISOString();
    const noise    = 1 + (Math.random() - 0.5) * 0.04;    // ±2%
    const price    = i === numPoints - 1
      ? Math.round(currentPrice)
      : Math.round((startPrice + (currentPrice - startPrice) * t) * noise);
    points.push({ at, price });
  }
  return { ...cruise, priceHistory: points };
}

function main() {
  if (!fs.existsSync(PROVIDERS_DIR)) {
    console.error('No public/providers directory found.');
    process.exit(1);
  }

  console.log('LOCAL PREVIEW — overwriting cruises.json with fake price history.');
  console.log('Revert with: git checkout public/providers/*/cruises.json\n');

  let totalSeeded = 0;
  for (const entry of fs.readdirSync(PROVIDERS_DIR)) {
    const file = path.join(PROVIDERS_DIR, entry, 'cruises.json');
    if (!fs.existsSync(file)) continue;

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const scrapedAt = data.scrapedAt || new Date().toISOString();
    data.cruises = (data.cruises || []).map(c => seedHistory(c, scrapedAt));
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

    console.log(`  ✓ ${entry}: seeded ${data.cruises.length} cruises`);
    totalSeeded += data.cruises.length;
  }
  console.log(`\nDone. ${totalSeeded} cruises now carry synthetic priceHistory.`);
  console.log('Refresh http://localhost:3000/ to see sparklines.');
}

main();

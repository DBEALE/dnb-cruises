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

const BUCKETS = ['inside', 'oceanView', 'balcony', 'suite'];

function seedHistory(cruise, scrapedAt) {
  const currentFrom = parseFloat(cruise.priceFrom);
  if (!Number.isFinite(currentFrom)) return cruise;

  const endMs     = Date.parse(scrapedAt) || Date.now();
  const numPoints = 3 + Math.floor(Math.random() * 5);   // 3..7 entries
  const spanDays  = 14 + Math.floor(Math.random() * 30); // 14..44 days back

  // Which cabins this cruise actually publishes. If none (e.g. providers
  // not yet running the per-cabin scrape), synthesize all four around
  // priceFrom so the multi-line preview UI has data to show.
  let presentBuckets = BUCKETS.filter(b => {
    const v = parseFloat(cruise.prices?.[b]);
    return Number.isFinite(v) && v > 0;
  });
  const hasMulti = true;
  if (!presentBuckets.length) {
    cruise = {
      ...cruise,
      prices: {
        inside:    Math.round(currentFrom),
        oceanView: Math.round(currentFrom * 1.18),
        balcony:   Math.round(currentFrom * 1.42),
        suite:     Math.round(currentFrom * 2.60),
      },
    };
    presentBuckets = [...BUCKETS];
  }

  // For each present cabin, pick a starting price that wobbles ±15% from
  // current; intermediate points interpolate with ±2% noise. The final
  // entry equals the current price so the table's price column matches.
  const cabinStart = {};
  if (hasMulti) {
    for (const b of presentBuckets) {
      const cur = parseFloat(cruise.prices[b]);
      cabinStart[b] = cur * (1 + (Math.random() - 0.5) * 0.3);
    }
  }
  const startFrom = currentFrom * (1 + (Math.random() - 0.5) * 0.3);

  const points = [];
  for (let i = 0; i < numPoints; i++) {
    const t        = i / (numPoints - 1);
    const daysBack = (1 - t) * spanDays;
    const at       = new Date(endMs - daysBack * DAY_MS).toISOString();
    const noise    = 1 + (Math.random() - 0.5) * 0.04;

    if (hasMulti) {
      const prices = {};
      for (const b of presentBuckets) {
        const cur = parseFloat(cruise.prices[b]);
        prices[b] = i === numPoints - 1
          ? Math.round(cur)
          : Math.round((cabinStart[b] + (cur - cabinStart[b]) * t) * noise);
      }
      points.push({ at, prices });
    } else {
      const price = i === numPoints - 1
        ? Math.round(currentFrom)
        : Math.round((startFrom + (currentFrom - startFrom) * t) * noise);
      points.push({ at, price });
    }
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

'use strict';

/**
 * One-off migration: split the inline `priceHistory` arrays out of each
 * provider's cruises.json into a sibling price-history.json, rewriting
 * cruises.json in the slim shape the app now expects.
 *
 * Idempotent — a cruises.json that already carries no inline history simply
 * produces an empty history map. The scraper (scripts/fetch-cruises.js) writes
 * the same split shape on every run, so this only matters for pre-existing
 * local data files; the deployed copy is re-split by the next scrape.
 *
 *   node scripts/split-price-history.js
 */

const fs   = require('node:fs');
const path = require('node:path');

const PROVIDERS_DIR = path.join(__dirname, '..', 'public', 'providers');

function splitProvider(dir) {
  const cruisesPath = path.join(dir, 'cruises.json');
  if (!fs.existsSync(cruisesPath)) return null;

  let data;
  try { data = JSON.parse(fs.readFileSync(cruisesPath, 'utf8')); }
  catch { return null; }

  const cruises = Array.isArray(data.cruises) ? data.cruises : [];
  const history = {};
  const slim = cruises.map(cruise => {
    const { priceHistory, ...rest } = cruise;
    if (cruise.id && Array.isArray(priceHistory) && priceHistory.length) {
      history[cruise.id] = priceHistory;
    }
    return rest;
  });

  data.cruises = slim;
  data.count = slim.length;
  fs.writeFileSync(cruisesPath, JSON.stringify(data, null, 2) + '\n');

  const provider = data.provider || { id: path.basename(dir) };
  fs.writeFileSync(path.join(dir, 'price-history.json'), JSON.stringify({
    provider,
    count: Object.keys(history).length,
    history,
    scrapedAt: data.scrapedAt || null,
  }, null, 2) + '\n');

  return { id: provider.id || path.basename(dir), moved: Object.keys(history).length };
}

function main() {
  if (!fs.existsSync(PROVIDERS_DIR)) {
    console.log('No public/providers directory — nothing to split.');
    return;
  }
  for (const entry of fs.readdirSync(PROVIDERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const res = splitProvider(path.join(PROVIDERS_DIR, entry.name));
    if (res) console.log(`  ✓ ${res.id}: moved price history for ${res.moved} cruise(s)`);
  }
}

main();

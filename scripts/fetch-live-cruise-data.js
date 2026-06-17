'use strict';

/**
 * fetch-live-cruise-data.js
 *
 * Downloads the currently-deployed cruises.json + oldCruises.json for every
 * provider in the live providers/index.json, writing them into
 * public/providers/<id>/ so subsequent build steps see the live state.
 *
 * The deployed copy on GitHub Pages is the source of truth; the repo no
 * longer tracks these files. Missing files (404) are tolerated silently —
 * happens on the very first deploy before anything has been published.
 *
 * Deliberately uses only Node built-ins so workflows that skip `npm ci`
 * (e.g. the push-only deploy) can still run this without installing the
 * provider modules' scrape-side deps (cheerio, playwright, etc.).
 *
 * Set LIVE_BASE_URL to override the default. Example:
 *   LIVE_BASE_URL=https://dbeale.github.io/dnb-cruises/ node scripts/fetch-live-cruise-data.js
 */

const fs   = require('node:fs');
const path = require('node:path');
const { sanitizePriceHistoryForProvider } = require('./price-history-cleanup');

const DEFAULT_BASE = 'https://dbeale.github.io/dnb-cruises/';
const BASE_URL     = (process.env.LIVE_BASE_URL || DEFAULT_BASE).replace(/\/?$/, '/');
const PUBLIC_DIR   = path.join(__dirname, '..', 'public');

// Inline copy of the shared `fetchWithTimeout` helper from
// providers/shared.js. We deliberately do not import it — this script
// runs in workflows that skip `npm ci` (push-only deploy) and must
// depend on Node built-ins only.
const FETCH_TIMEOUT_MS = 15_000;
function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

async function fetchJson(url) {
  const res = await fetchWithTimeout(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function fetchToFile(url, outPath) {
  const res = await fetchWithTimeout(url, { cache: 'no-store' });
  if (res.status === 404) {
    console.log(`  − ${url} (404 — first deploy?)`);
    return false;
  }
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  const body = await res.text();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body);
  const kb = (body.length / 1024).toFixed(0);
  console.log(`  ✓ ${url} → ${path.relative(process.cwd(), outPath)} (${kb} KB)`);
  return true;
}

function sanitizeProviderFile(providerId, filePath) {
  if (providerId !== 'ncl-cruises') return 0;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    let removed = 0;
    data.cruises = (data.cruises || []).map(cruise => {
      const before = Array.isArray(cruise.priceHistory) ? cruise.priceHistory.length : 0;
      const priceHistory = sanitizePriceHistoryForProvider(providerId, cruise.priceHistory);
      removed += before - priceHistory.length;
      return { ...cruise, priceHistory };
    });
    if (removed > 0) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    }
    return removed;
  } catch {
    return 0;
  }
}

// Provider IDs come from the live providers/index.json on Pages. Falls back
// to the local tracked copy in this repo if Pages isn't reachable (first
// deploy, network blip).
async function getProviderIds() {
  try {
    const index = await fetchJson(`${BASE_URL}providers/index.json`);
    return (index.providers || []).map(p => p.id).filter(Boolean);
  } catch (err) {
    console.log(`  − live providers/index.json unavailable (${err.message}); falling back to local file`);
    try {
      const localPath = path.join(PUBLIC_DIR, 'providers', 'index.json');
      const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      return (local.providers || []).map(p => p.id).filter(Boolean);
    } catch {
      return [];
    }
  }
}

async function main() {
  console.log(`→ Fetching live cruise data from ${BASE_URL}`);
  const providerIds = await getProviderIds();
  if (!providerIds.length) {
    console.log('  (no providers discovered — first deploy?)');
    return;
  }

  let okCount = 0;
  for (const id of providerIds) {
    const dir = path.join(PUBLIC_DIR, 'providers', id);
    for (const file of ['cruises.json', 'oldCruises.json']) {
      const url = `${BASE_URL}providers/${id}/${file}`;
      const outPath = path.join(dir, file);
      try {
        if (await fetchToFile(url, outPath)) {
          const removed = sanitizeProviderFile(id, outPath);
          if (removed) console.log(`    cleaned ${removed} NCL seeded history entr${removed === 1 ? 'y' : 'ies'}`);
          okCount++;
        }
      } catch (err) {
        console.warn(`  ! ${url} failed: ${err.message}`);
      }
    }
  }
  console.log(`✓ Fetched ${okCount} live file(s).`);
}

main().catch(err => {
  console.error('✗ fetch-live-cruise-data failed:', err.message);
  process.exit(1);
});

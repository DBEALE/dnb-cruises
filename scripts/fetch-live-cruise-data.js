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

const DEFAULT_BASE = 'https://dbeale.github.io/dnb-cruises/';
const BASE_URL     = (process.env.LIVE_BASE_URL || DEFAULT_BASE).replace(/\/?$/, '/');
const PUBLIC_DIR   = path.join(__dirname, '..', 'public');

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function fetchToFile(url, outPath) {
  const res = await fetch(url, { cache: 'no-store' });
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
      try {
        if (await fetchToFile(url, path.join(dir, file))) okCount++;
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

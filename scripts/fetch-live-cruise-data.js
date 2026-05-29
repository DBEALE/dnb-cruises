'use strict';

/**
 * fetch-live-cruise-data.js
 *
 * Downloads the currently-deployed cruises.json + oldCruises.json for every
 * provider in providers/index.js, writing them into public/providers/<id>/
 * so subsequent build steps (fetch-cruises.js merge logic, the Pages upload)
 * see the live state instead of a fresh checkout's empty workspace.
 *
 * The deployed copy on GitHub Pages is the source of truth; the repo no
 * longer tracks these files. Missing files (404) are tolerated silently —
 * happens on the very first deploy before anything has been published.
 *
 * Set LIVE_BASE_URL to override the auto-derived URL. Example:
 *   LIVE_BASE_URL=https://dbeale.github.io/dnb-cruises/ node scripts/fetch-live-cruise-data.js
 */

const fs        = require('node:fs');
const path      = require('node:path');
const providers = require('../providers');

const DEFAULT_BASE = 'https://dbeale.github.io/dnb-cruises/';
const BASE_URL     = (process.env.LIVE_BASE_URL || DEFAULT_BASE).replace(/\/?$/, '/');
const PUBLIC_DIR   = path.join(__dirname, '..', 'public');

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

async function main() {
  console.log(`→ Fetching live cruise data from ${BASE_URL}`);
  let okCount = 0;
  for (const provider of providers) {
    const dir = path.join(PUBLIC_DIR, 'providers', provider.id);
    for (const file of ['cruises.json', 'oldCruises.json']) {
      const url = `${BASE_URL}providers/${provider.id}/${file}`;
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

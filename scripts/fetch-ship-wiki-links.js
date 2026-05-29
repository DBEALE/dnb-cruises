'use strict';

/**
 * fetch-ship-wiki-links.js
 *
 * Scrapes https://en.wikipedia.org/wiki/List_of_cruise_ships and writes
 * public/ship-wiki-links.json with a normalized {shipName: wikipediaUrl} map,
 * plus verified {provider: url} and {shipClass: url} maps built by querying
 * the Wikipedia API for known cruise-line and ship-class article titles.
 */

const fs      = require('node:fs');
const path    = require('node:path');
const cheerio = require('cheerio');

const SOURCE_URL   = 'https://en.wikipedia.org/wiki/List_of_cruise_ships';
const OUT_PATH     = path.join(__dirname, '..', 'public', 'ship-wiki-links.json');
const PROVIDER_DIR = path.join(__dirname, '..', 'public', 'providers');

const SHIP_PREFIXES = ['MS', 'MV', 'SS', 'RMS', 'PS', 'TS', 'TSS', 'RV', 'MY', 'HMS', 'USS'];
const PREFIX_RE     = new RegExp('^(?:' + SHIP_PREFIXES.join('|') + ')\\s+', 'i');
const PAREN_RE      = /\s*\([^)]*\)\s*$/;

// Provider display name → Wikipedia article title.
// These rarely change; new providers should be added here as they're onboarded.
const PROVIDER_WIKI_TITLES = {
  'Royal Caribbean':       'Royal Caribbean International',
  'Celebrity Cruises':     'Celebrity Cruises',
  'Norwegian Cruise Line': 'Norwegian Cruise Line',
  'Princess Cruises':      'Princess Cruises',
};

function normalizeShipName(name) {
  if (!name) return '';
  return name
    .replace(PREFIX_RE, '')
    .replace(PAREN_RE, '')
    .trim()
    .toLowerCase();
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'dnb-cruises/1.0 (build script)' },
  });
  if (!res.ok) throw new Error(`Wikipedia fetch failed: ${res.status} ${res.statusText}`);
  return res.text();
}

function extractShipLinks(html) {
  const $ = cheerio.load(html);
  const links = {};

  $('table.wikitable tbody tr').each((_, tr) => {
    // Ship name lives in the row header (<th>), not the first <td>
    const nameCell = $(tr).find('th').first();
    if (!nameCell.length) return;

    const anchor = nameCell.find('a[href^="/wiki/"]').first();
    if (!anchor.length) return;

    const href = anchor.attr('href');
    if (!href || href.includes(':')) return; // skip File:, Category: etc.

    const displayName = anchor.text().trim();
    if (!displayName) return;

    const key = normalizeShipName(displayName);
    if (!key) return;

    // Skip rows where the linked article is for a renamed/historical ship.
    // (E.g. an old "Sun Princess" row whose href is now /wiki/Pacific_World.)
    const articleSlug = decodeURIComponent(href.replace(/^\/wiki\//, '')).replace(/_/g, ' ');
    if (normalizeShipName(articleSlug) !== key) return;

    if (!links[key]) {
      links[key] = 'https://en.wikipedia.org' + href;
    }
  });

  return links;
}

function collectAppProvidersAndClasses() {
  const providers = new Set();
  const classes   = new Set();
  if (!fs.existsSync(PROVIDER_DIR)) return { providers, classes };

  for (const entry of fs.readdirSync(PROVIDER_DIR)) {
    const cruisesPath = path.join(PROVIDER_DIR, entry, 'cruises.json');
    if (!fs.existsSync(cruisesPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(cruisesPath, 'utf8'));
      for (const c of data.cruises || []) {
        if (c.provider)  providers.add(c.provider);
        if (c.shipClass) classes.add(c.shipClass);
      }
    } catch {}
  }
  return { providers, classes };
}

function titleToWikiUrl(title) {
  return 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/');
}

async function queryExistingTitles(titles) {
  if (!titles.length) return new Set();
  const url = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({
    action:    'query',
    format:    'json',
    titles:    titles.join('|'),
    redirects: '1',
  });
  const res = await fetch(url, { headers: { 'User-Agent': 'dnb-cruises/1.0 (build script)' } });
  if (!res.ok) throw new Error(`Wikipedia API failed: ${res.status} ${res.statusText}`);
  const data = await res.json();

  const existing = new Set();
  for (const page of Object.values(data.query?.pages || {})) {
    if (page.missing === undefined) existing.add(page.title);
  }
  // Walk normalization + redirect chains so we know which *requested* titles resolved.
  const chainBack = new Map();
  for (const n of data.query?.normalized || []) chainBack.set(n.to, n.from);
  for (const r of data.query?.redirects  || []) chainBack.set(r.to, r.from);

  const resolved = new Set();
  for (const finalTitle of existing) {
    let t = finalTitle;
    while (chainBack.has(t)) t = chainBack.get(t);
    resolved.add(t);
  }
  return resolved;
}

async function buildProviderLinks(providers) {
  const links = {};
  const candidates = [];
  const titleToProvider = new Map();
  for (const provider of providers) {
    const title = PROVIDER_WIKI_TITLES[provider];
    if (!title) continue;
    candidates.push(title);
    titleToProvider.set(title, provider);
  }
  if (!candidates.length) return links;

  const existing = await queryExistingTitles(candidates);
  for (const title of candidates) {
    if (existing.has(title)) {
      links[titleToProvider.get(title).toLowerCase()] = titleToWikiUrl(title);
    }
  }
  return links;
}

async function buildClassLinks(classes) {
  const links = {};
  const candidates = [];
  const titleToClass = new Map();
  for (const cls of classes) {
    const title = `${cls}-class cruise ship`;
    candidates.push(title);
    titleToClass.set(title, cls);
  }
  if (!candidates.length) return links;

  const existing = await queryExistingTitles(candidates);
  for (const title of candidates) {
    if (existing.has(title)) {
      links[titleToClass.get(title).toLowerCase()] = titleToWikiUrl(title);
    }
  }
  return links;
}

async function main() {
  console.log(`→ Fetching ${SOURCE_URL}`);
  const html  = await fetchHtml(SOURCE_URL);
  const ships = extractShipLinks(html);

  if (Object.keys(ships).length < 100) {
    throw new Error(`Suspiciously low entry count (${Object.keys(ships).length}); Wikipedia layout may have changed.`);
  }

  console.log('→ Building provider + class maps from cruises.json');
  const { providers, classes } = collectAppProvidersAndClasses();
  const [providerLinks, classLinks] = await Promise.all([
    buildProviderLinks(providers),
    buildClassLinks(classes),
  ]);

  fs.writeFileSync(OUT_PATH, JSON.stringify({
    source:    SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    ships,
    providers: providerLinks,
    classes:   classLinks,
  }, null, 2) + '\n');

  console.log(`✓ Wrote ${Object.keys(ships).length} ships, ${Object.keys(providerLinks).length}/${providers.size} providers, ${Object.keys(classLinks).length}/${classes.size} classes → ${OUT_PATH}`);
}

main().catch(err => {
  console.error('✗ fetch-ship-wiki-links failed:', err.message);
  process.exit(1);
});

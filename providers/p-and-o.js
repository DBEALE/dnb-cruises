'use strict';

const { load } = require('cheerio');
const https = require('node:https');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const {
  cleanText,
  estimateSeaDays,
  fetchWithTimeout,
  getDepartureRegion,
  getDestinationPort,
  DEFAULT_USER_AGENT,
} = require('./shared');

// Sentinel used to detect rendered cruise tiles in raw HTML.
const CRUISE_TILE_SENTINEL = 'po-cuk-cruise-tile-wrapper';

const PANDO_SEARCH_URL = 'https://www.pocruises.com/find-a-cruise';
const PANDO_READER_PREFIX = 'https://r.jina.ai/';
const CABIN_FILTERS = ['I', 'O', 'B', 'S'];
const CABIN_BUCKETS = {
  I: 'inside',
  O: 'oceanView',
  B: 'balcony',
  S: 'suite',
};
const execFileAsync = promisify(execFile);

const SHIPS = {
  Arcadia:   { shipClass: 'Vista',      shipLaunchYear: 2005 },
  Arvia:     { shipClass: 'Excellence', shipLaunchYear: 2022 },
  Aurora:    { shipClass: 'R',          shipLaunchYear: 2000 },
  Azura:     { shipClass: 'Grand',      shipLaunchYear: 2010 },
  Britannia: { shipClass: 'Royal',      shipLaunchYear: 2015 },
  Iona:      { shipClass: 'Excellence', shipLaunchYear: 2020 },
  Ventura:   { shipClass: 'Grand',      shipLaunchYear: 2008 },
};

function emptyPrices() {
  return { inside: null, oceanView: null, balcony: null, suite: null };
}

function classifyCabinType(value) {
  const text = cleanText(value).toLowerCase();
  if (text === 'i' || /\binside\b/.test(text)) return 'inside';
  if (text === 'o' || /sea\s*view|ocean\s*view|outside/.test(text)) return 'oceanView';
  if (text === 'b' || /\bbalcony\b/.test(text)) return 'balcony';
  if (text === 's' || /suite/.test(text)) return 'suite';
  return null;
}

function parsePrice(value) {
  const n = Number.parseFloat(cleanText(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : null;
}

function toIsoDate(value) {
  const text = cleanText(value);
  if (!text) return '';
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const match = text.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (!match) return '';
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = months.indexOf(match[2].slice(0, 3).toLowerCase());
  if (month < 0) return '';
  return `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

function parseSearchHtml(html, forcedCabinCode = '') {
  const $ = load(html);
  const cruises = [];

  $('[data-testid="po-cuk-cruise-tile-wrapper"]').each((_, element) => {
    const tile = $(element);
    const cruiseId = cleanText(tile.find('input[type="checkbox"][id]').first().attr('id'));
    if (!cruiseId || !/^[A-Z0-9]+$/i.test(cruiseId)) return;

    const values = new Map();
    tile.find('label').each((__, label) => {
      const key = cleanText($(label).text()).toLowerCase();
      const spans = $(label).parent().find('p span').map((___, span) => cleanText($(span).text())).get();
      if (key && spans.length) values.set(key, spans);
    });

    const title = cleanText(tile.find('h5').first().text());
    const ship = values.get('ship') || [];
    const departs = values.get('departs') || [];
    const arrives = values.get('arrives') || [];
    const shipName = ship[0] || '';
    const durationText = ship[1] || title.match(/(\d+)\s+Nights?/i)?.[0] || '';
    const itineraryPorts = cleanText(tile.find('[data-testid="itinerary-port"]').first().text())
      .split(/\s*,\s*/)
      .filter(Boolean);
    const priceLabel = cleanText(tile.find('[data-testid="c-price-block"] span').first().text());
    const cabin = classifyCabinType(forcedCabinCode || priceLabel);
    const price = parsePrice(tile.find('[data-testid="c-curreny-content"]').first().text());
    const prices = emptyPrices();
    if (cabin && price) prices[cabin] = price;
    const shipMeta = SHIPS[shipName] || {};
    const nights = Number.parseInt(durationText, 10);
    const destination = cleanText(title.replace(/,?\s*\d+\s+Nights?.*$/i, '')) || 'Cruise';

    cruises.push({
      id: `pando-${cruiseId}`,
      provider: 'P&O Cruises',
      shipName,
      shipClass: shipMeta.shipClass || '',
      shipLaunchYear: shipMeta.shipLaunchYear || null,
      itinerary: itineraryPorts.length ? itineraryPorts.join(' → ') : title,
      departureDate: toIsoDate(departs[1]),
      duration: Number.isFinite(nights) ? `${nights} Nights` : durationText,
      departurePort: departs[0] || '',
      departureRegion: getDepartureRegion(departs[0] || ''),
      destination,
      destinationPort: getDestinationPort(itineraryPorts),
      seaDays: estimateSeaDays({ labels: itineraryPorts, duration: durationText }),
      priceFrom: price || '',
      currency: 'GBP',
      prices,
      bookingUrl: `${PANDO_SEARCH_URL}/${encodeURIComponent(cruiseId)}/${encodeURIComponent(cruiseId)}`,
      arrivalDate: toIsoDate(arrives[1]),
    });
  });

  return cruises;
}

function mergeCruises(groups) {
  const byId = new Map();
  for (const cruises of groups) {
    for (const cruise of cruises) {
      const existing = byId.get(cruise.id);
      if (!existing) {
        byId.set(cruise.id, cruise);
        continue;
      }
      for (const bucket of Object.values(CABIN_BUCKETS)) {
        if (cruise.prices[bucket] != null) existing.prices[bucket] = cruise.prices[bucket];
      }
      const allPrices = Object.values(existing.prices)
        .filter(value => value != null && value !== '')
        .map(Number)
        .filter(Number.isFinite);
      existing.priceFrom = allPrices.length ? String(Math.min(...allPrices)) : existing.priceFrom;
    }
  }
  return [...byId.values()].sort((a, b) => a.departureDate.localeCompare(b.departureDate) || a.id.localeCompare(b.id));
}

async function fetchSearchPage(cabinCode, fetchImpl = fetchWithTimeout, options = {}) {
  const target = `${PANDO_SEARCH_URL}?roomTypes=${encodeURIComponent(cabinCode)}&web2=true`;
  const headers = { 'user-agent': DEFAULT_USER_AGENT, accept: 'text/html,application/xhtml+xml' };
  const readerUrl = `${PANDO_READER_PREFIX}${target}`;
  const platform = options.platform || process.platform;
  const requestTextImpl = options.requestText || requestText;
  const requestTextViaPowerShellImpl = options.requestTextViaPowerShell || requestTextViaPowerShell;
  const fetchWithPlaywrightImpl = options.fetchWithPlaywright || fetchSearchPageWithPlaywright;

  // Try a direct HTTP fetch first.  The P&O website is a JavaScript SPA so a
  // plain request returns only the app shell – no rendered cruise tiles.  Only
  // use the response if the rendered tile sentinel is present; otherwise fall
  // through to the Jina reader which executes JavaScript before returning HTML.
  try {
    const response = await fetchImpl(target, { headers });
    if (response.ok) {
      const text = await response.text();
      if (text.includes(CRUISE_TILE_SENTINEL)) return text;
    }
  } catch {}

  // Jina AI reader renders the page with JavaScript before returning HTML.
  try {
    const text = platform === 'win32'
      ? await requestTextViaPowerShellImpl(readerUrl, 60_000)
      : await requestTextImpl(readerUrl, { ...headers, 'x-return-format': 'html' }, 60_000);
    if (text.includes(CRUISE_TILE_SENTINEL)) return text;
  } catch {}

  // Last resort: use a real Playwright browser to render the page.
  return fetchWithPlaywrightImpl(cabinCode);
}

async function fetchSearchPageWithPlaywright(cabinCode) {
  const { chromium } = require('@playwright/test');
  const target = `${PANDO_SEARCH_URL}?roomTypes=${encodeURIComponent(cabinCode)}&web2=true`;
  const browser = await chromium.launch({ headless: true, args: ['--disable-http2'] });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      userAgent: DEFAULT_USER_AGENT,
      locale: 'en-GB',
      timezoneId: 'Europe/London',
    });
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(target, { waitUntil: 'commit', timeout: 60_000 });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < 2) await page.waitForTimeout(1_000);
      }
    }
    if (lastError) throw lastError;
    await page.waitForSelector(`[data-testid="${CRUISE_TILE_SENTINEL}"]`, { timeout: 30_000 });
    return page.content();
  } finally {
    await browser.close();
  }
}

async function requestTextViaPowerShell(url, timeoutMs) {
  const escapedUrl = url.replace(/'/g, "''");
  const command = [
    `$response = Invoke-WebRequest -Uri '${escapedUrl}' -UseBasicParsing -Headers @{'X-Return-Format'='html'} -TimeoutSec 60`,
    '[Console]::Out.Write($response.Content)',
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { timeout: timeoutMs + 5_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
  );
  return stdout;
}

function requestText(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = callback => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const succeed = finish(resolve);
    const fail = finish(reject);
    const request = https.get(url, { headers, family: 4 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          fail(new Error(`P&O reader failed: HTTP ${response.statusCode}`));
          return;
        }
        succeed(body);
      });
    });
    const timer = setTimeout(() => request.destroy(new Error(`P&O reader timed out after ${timeoutMs}ms`)), timeoutMs);
    request.on('error', fail);
  });
}

async function fetchCruises() {
  const pages = [];
  for (const cabinCode of CABIN_FILTERS) {
    const html = await fetchSearchPage(cabinCode);
    pages.push(parseSearchHtml(html, cabinCode));
  }
  const cruises = mergeCruises(pages);
  if (!cruises.length) throw new Error('P&O returned no parseable cruise results');
  return cruises;
}

const provider = {
  id: 'p-and-o',
  name: 'P&O Cruises',
  fetchCruises,
  normalizeCruise(cruise) {
    if (cruise?.id && cruise?.provider === provider.name) return cruise;
    const prices = emptyPrices();
    for (const [key, value] of Object.entries(cruise?.prices || {})) {
      const bucket = classifyCabinType(key);
      if (bucket) prices[bucket] = parsePrice(value);
    }
    const cruiseId = cleanText(cruise?.id || cruise?.cruiseId);
    const shipName = cleanText(cruise?.shipName || cruise?.ship?.name);
    const meta = SHIPS[shipName] || {};
    return {
      ...cruise,
      id: cruiseId.startsWith('pando-') ? cruiseId : `pando-${cruiseId}`,
      provider: provider.name,
      shipName,
      shipClass: meta.shipClass || cleanText(cruise?.shipClass),
      shipLaunchYear: meta.shipLaunchYear || cruise?.shipLaunchYear || null,
      departureDate: toIsoDate(cruise?.departureDate || cruise?.departDate),
      duration: cleanText(cruise?.duration),
      departurePort: cleanText(cruise?.departurePort),
      bookingUrl: cruise?.bookingUrl || `${PANDO_SEARCH_URL}/${cruiseId}/${cruiseId}`,
      prices,
    };
  },
};

module.exports = provider;
module.exports.classifyCabinType = classifyCabinType;
module.exports.parseSearchHtml = parseSearchHtml;
module.exports.mergeCruises = mergeCruises;
module.exports.toIsoDate = toIsoDate;
module.exports.emptyPrices = emptyPrices;
module.exports.fetchSearchPage = fetchSearchPage;

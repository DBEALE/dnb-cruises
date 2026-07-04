'use strict';

const fs        = require('fs');
const path      = require('path');
const providers = require('../providers');
const { fetchWithTimeout } = require('../providers/shared');
const {
  hasUniformCabinPrices,
  isInvalidLeadingHistoryEntry,
  sanitizePriceHistoryForProvider,
  withSanitizedPriceHistory,
} = require('./price-history-cleanup');

const PUBLIC_DIR          = path.join(__dirname, '..', 'public');
const PROVIDERS_DIR       = path.join(PUBLIC_DIR, 'providers');
const PROVIDER_INDEX_PATH = path.join(PROVIDERS_DIR, 'index.json');

function getProvidersToProcess(providerId) {
  if (!providerId || providerId === 'all') return providers;
  const provider = providers.find(entry => entry.id === providerId);
  if (!provider) {
    const known = providers.map(entry => entry.id).join(', ');
    throw new Error(`Unknown provider "${providerId}". Known providers: ${known}`);
  }
  return [provider];
}

function parseCommandLineArgs(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter(arg => arg.startsWith('--')));
  const providerId = args.find(arg => !arg.startsWith('--')) || 'all';

  return {
    providerId,
    providerOnly: flags.has('--provider-only') || flags.has('--isolated'),
    writeManifest: providerId === 'all' || flags.has('--write-manifest'),
  };
}

function getProviderOutputPath(providerId) {
  return path.join(PROVIDERS_DIR, providerId, 'cruises.json');
}

function getProviderArchivePath(providerId) {
  return path.join(PROVIDERS_DIR, providerId, 'oldCruises.json');
}

// Price history is split out of cruises.json into this sibling file so the
// frontend's initial load only downloads table-visible fields (~⅓ smaller)
// and hydrates history lazily. See docs/IMPROVEMENTS.md.
function getProviderHistoryPath(providerId) {
  return path.join(PROVIDERS_DIR, providerId, 'price-history.json');
}

// Reads price-history.json into a plain { [cruiseId]: entries[] } map.
// Missing/legacy files (history still inline in cruises.json) yield {}.
function readProviderHistoryMap(providerId) {
  try {
    const data = JSON.parse(fs.readFileSync(getProviderHistoryPath(providerId), 'utf8'));
    return data && data.history && typeof data.history === 'object' ? data.history : {};
  } catch {
    return {};
  }
}

function readCruiseMap(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const byId = new Map();
    for (const cruise of data.cruises || []) {
      if (cruise.id) byId.set(cruise.id, cruise);
    }
    return byId;
  } catch {
    return new Map();
  }
}

function readPreviousProviderSnapshot(providerId) {
  const byId = readCruiseMap(getProviderOutputPath(providerId));
  // Reattach history from the sidecar so mergePriceHistory keeps accumulating.
  // Legacy files that still inline priceHistory keep theirs where the sidecar
  // has no entry, so this stays backward-compatible with un-split data.
  const history = readProviderHistoryMap(providerId);
  for (const [id, cruise] of byId) {
    if (Array.isArray(history[id])) cruise.priceHistory = history[id];
  }
  return byId;
}

function readPreviousArchive(providerId) {
  return readCruiseMap(getProviderArchivePath(providerId));
}

// Archive pruning threshold: drop cruises whose departureDate is more than
// 2 years in the past. Kept generous so retrospective analysis stays useful.
const DAYS_PER_YEAR          = 365.25;
const ARCHIVE_RETENTION_DAYS = 2 * DAYS_PER_YEAR;
const MS_PER_DAY             = 24 * 60 * 60 * 1000;
const ARCHIVE_RETENTION_MS   = ARCHIVE_RETENTION_DAYS * MS_PER_DAY;
const ARCHIVE_AFTER_DEPARTURE_MS = MS_PER_DAY;

function shouldArchiveAfterDeparture(cruise, nowMs) {
  const departed = Date.parse(cruise.departureDate);
  if (!Number.isFinite(departed)) return false; // keep active if unparseable
  return (nowMs - departed) > ARCHIVE_AFTER_DEPARTURE_MS;
}

function shouldPruneFromArchive(cruise, nowMs) {
  const departed = Date.parse(cruise.departureDate);
  if (!Number.isFinite(departed)) return false; // keep if unparseable
  return (nowMs - departed) > ARCHIVE_RETENTION_MS;
}

// Each priceHistory entry is { at, prices: { inside, oceanView, balcony, suite } }
// — one number per cabin bucket the provider published. Cruises without a
// per-cabin breakdown do not produce price-history entries.
//
// A new entry is appended when *any* bucket's price differs from the last
// recorded entry. Trimmed to MAX_PRICE_HISTORY so payload stays bounded.
const MAX_PRICE_HISTORY = 60;
const PRICE_BUCKETS     = ['inside', 'oceanView', 'balcony', 'suite'];
const EMPTY_RESULT_RETRIES = 1;
const EMPTY_RESULT_RETRY_DELAY_MS = 5_000;

function buildHistoryEntry(cruise, scrapedAt) {
  const filteredPrices = {};
  let hasAnyBucket = false;
  for (const bucket of PRICE_BUCKETS) {
    const n = parseFloat(cruise.prices?.[bucket]);
    if (Number.isFinite(n)) {
      filteredPrices[bucket] = n;
      hasAnyBucket = true;
    }
  }
  if (hasAnyBucket) return { at: scrapedAt, prices: filteredPrices };

  return null;
}

function entrySignature(entry) {
  if (!entry) return '';
  if (!entry.prices) return '';
  return PRICE_BUCKETS
    .map(b => entry.prices[b] != null ? String(entry.prices[b]) : '-')
    .join('|');
}

function mergePriceHistory(providerId, prevCruise, newCruise, scrapedAt) {
  const history = sanitizePriceHistoryForProvider(providerId, prevCruise?.priceHistory);
  const newEntry = buildHistoryEntry(newCruise, scrapedAt);
  if (!newEntry) return history.slice(-MAX_PRICE_HISTORY);
  if (history.length === 0 && isInvalidLeadingHistoryEntry(providerId, newEntry)) {
    return history;
  }

  const last = history[history.length - 1];
  if (entrySignature(last) !== entrySignature(newEntry)) {
    history.push(newEntry);
  }
  return history.slice(-MAX_PRICE_HISTORY);
}

function firstSeenAt(prevCruise, priceHistory, scrapedAt) {
  if (prevCruise?.firstSeenAt) return prevCruise.firstSeenAt;
  const firstHistoryAt = Array.isArray(priceHistory)
    ? priceHistory.map(entry => entry?.at).filter(Boolean).sort()[0]
    : '';
  return firstHistoryAt || scrapedAt;
}

function countCurrentPrices(cruises) {
  return (Array.isArray(cruises) ? cruises : []).reduce((total, cruise) => {
    return total + PRICE_BUCKETS.filter(bucket => {
      const value = parseFloat(cruise?.prices?.[bucket]);
      return Number.isFinite(value) && value > 0;
    }).length;
  }, 0);
}

function writeProviderSnapshot(provider, cruises, scrapedAt) {
  // Safety net: never overwrite a good snapshot with an empty one. The fetch
  // path already excludes empty/failed providers, but this guarantees it
  // structurally — a zero-cruise write is always a scrape failure, never a
  // real state, so we keep the last-known-good file untouched.
  if (!Array.isArray(cruises) || cruises.length === 0) {
    console.warn(`  ⚠ ${provider.name}: refusing to write an empty snapshot; keeping previous ${getProviderOutputPath(provider.id)}`);
    return false;
  }

  const outPath = getProviderOutputPath(provider.id);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Split the heavy priceHistory arrays into a sibling price-history.json so
  // cruises.json carries only the fields the table renders from. The frontend
  // fetches the history file separately and hydrates on top.
  const history = {};
  const slimCruises = cruises.map(cruise => {
    const { priceHistory, ...rest } = cruise;
    if (cruise.id && Array.isArray(priceHistory) && priceHistory.length) {
      history[cruise.id] = priceHistory;
    }
    return rest;
  });

  fs.writeFileSync(outPath, JSON.stringify({
    success:   true,
    count:     slimCruises.length,
    priceCount: countCurrentPrices(cruises),
    provider:  { id: provider.id, name: provider.name },
    cruises:   slimCruises,
    scrapedAt,
  }, null, 2) + '\n');
  console.log(`  ✓ Wrote ${slimCruises.length} cruises to ${outPath}`);

  writeProviderHistory(provider, history, scrapedAt);
  return true;
}

function writeProviderHistory(provider, history, scrapedAt) {
  const outPath = getProviderHistoryPath(provider.id);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const count = Object.keys(history).length;
  fs.writeFileSync(outPath, JSON.stringify({
    provider: { id: provider.id, name: provider.name },
    count,
    history,
    scrapedAt,
  }, null, 2) + '\n');
  console.log(`  ✓ Wrote price history for ${count} cruises to ${outPath}`);
}

function writeProviderArchive(provider, archived) {
  const outPath = getProviderArchivePath(provider.id);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    provider: { id: provider.id, name: provider.name },
    count:    archived.length,
    cruises:  archived,
  }, null, 2) + '\n');
  console.log(`  ✓ Wrote ${archived.length} archived cruises to ${outPath}`);
}

function writeProviderIndex(scrapedAt) {
  fs.mkdirSync(PROVIDERS_DIR, { recursive: true });
  fs.writeFileSync(PROVIDER_INDEX_PATH, JSON.stringify({
    defaultProviderId: providers[0]?.id || null,
    providers: providers.map(provider => ({
      id:         provider.id,
      name:       provider.name,
      cruisesUrl: `./providers/${provider.id}/cruises.json`,
    })),
    scrapedAt,
  }, null, 2) + '\n');
  console.log(`  ✓ Wrote provider index to ${PROVIDER_INDEX_PATH}`);
}

async function fetchProviderSnapshot(provider, options = {}) {
  const retries = options.emptyResultRetries ?? EMPTY_RESULT_RETRIES;
  const retryDelayMs = options.emptyResultRetryDelayMs ?? EMPTY_RESULT_RETRY_DELAY_MS;
  for (let attempt = 0; attempt <= retries; attempt++) {
    console.log(`Fetching from ${provider.name}${attempt ? ` (retry ${attempt})` : ''}…`);
    // Providers that support incremental itinerary enrichment (Royal Caribbean)
    // read the previous snapshot from here; others ignore the extra field.
    const cruises = await provider.fetchCruises({ priorEnrichmentById: options.priorEnrichmentById });
    if (Array.isArray(cruises) && cruises.length > 0) {
      console.log(`  ✓ ${cruises.length} cruises from ${provider.name}`);
      return { provider, cruises };
    }
    if (attempt < retries) {
      console.warn(`  ${provider.name} returned no cruise results; retrying in ${retryDelayMs / 1000}s.`);
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error(`${provider.name} returned no cruise results`);
}

// Runs every provider, returning a settled[] of { status, value|reason } in the
// same shape the sequential loop produced. A provider that throws or returns an
// empty result becomes a `rejected` entry and is therefore filtered out before
// the write step — so an empty scrape can never overwrite good data.
//
// Concurrency is deliberately shaped to avoid the one failure mode that used to
// force this fully sequential: two headless Chromium instances contending on a
// small CI runner and starving each other into timeouts / empty results.
//   • Network-only providers (pure HTTP/GraphQL, e.g. Royal Caribbean,
//     Celebrity) run all at once — cheap and independent.
//   • Browser providers (`usesBrowser`, each launches Chromium) run in a single
//     serialised lane, so at most one Chromium is ever live. That lane overlaps
//     the network lane freely (one browser + some HTTP is fine).
// Set SCRAPE_SEQUENTIAL=1 (or pass { sequential: true }) to force the original
// one-at-a-time behaviour as an escape hatch.
async function fetchAllSnapshots(activeProviders, options = {}) {
  const settled = [];
  // Per-provider previous snapshot (id → cruise) for incremental enrichment.
  const priorByProvider = options.priorByProvider instanceof Map ? options.priorByProvider : new Map();
  const runOne = async (provider) => {
    const providerOptions = { ...options, priorEnrichmentById: priorByProvider.get(provider.id) };
    try {
      settled.push({ status: 'fulfilled', value: await fetchProviderSnapshot(provider, providerOptions) });
    } catch (err) {
      console.error(`  ✗ ${provider.name} failed: ${err.message}`);
      settled.push({ status: 'rejected', reason: err });
    }
  };
  const runSerial = async (list) => { for (const provider of list) await runOne(provider); };

  const sequential = options.sequential || process.env.SCRAPE_SEQUENTIAL === '1';
  if (sequential) {
    await runSerial(activeProviders);
    return settled;
  }

  const networkProviders = activeProviders.filter(provider => !provider.usesBrowser);
  const browserProviders = activeProviders.filter(provider => provider.usesBrowser);
  console.log(`Fetching ${networkProviders.length} network provider(s) in parallel; ${browserProviders.length} browser provider(s) one at a time.`);

  await Promise.all([
    ...networkProviders.map(runOne),
    runSerial(browserProviders),
  ]);
  return settled;
}

// ── Alert matching ─────────────────────────────────────────────────────────────

function matchesAlert(cruise, alert) {
  if (alert.departureRegion && cruise.departureRegion !== alert.departureRegion) return false;
  if (alert.shipClass       && cruise.shipClass       !== alert.shipClass)       return false;
  if (alert.provider        && cruise.provider        !== alert.provider)        return false;
  if (alert.departurePort   && !cruise.departurePort?.toLowerCase().includes(alert.departurePort.toLowerCase())) return false;
  if (alert.shipName        && !cruise.shipName?.toLowerCase().includes(alert.shipName.toLowerCase()))           return false;
  if (alert.minNights) {
    const nights = parseInt(cruise.duration, 10) || 0;
    if (nights < alert.minNights) return false;
  }
  if (alert.maxPriceUSD) {
    const price = parseFloat(cruise.priceFrom) || Infinity;
    if (price > alert.maxPriceUSD) return false;
  }
  return true;
}

function formatPrice(cruise, usdToGbp) {
  const n = parseFloat(cruise.priceFrom);
  if (isNaN(n)) return 'N/A';
  if (cruise.currency === 'USD' && usdToGbp) return `£${Math.round(n * usdToGbp).toLocaleString()} (~$${Math.round(n).toLocaleString()})`;
  return `$${Math.round(n).toLocaleString()}`;
}

function buildEmailHtml(alertMatches, usdToGbp) {
  const sections = alertMatches.map(({ alert, cruises }) => {
    const rows = cruises.map(c => {
      const bookLink = c.bookingUrl
        ? (c.bookingUrl.startsWith('http') ? c.bookingUrl : 'https://www.royalcaribbean.com' + c.bookingUrl)
        : 'https://www.royalcaribbean.com/gbr/en/cruises';
      return `
        <tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:10px 12px;font-weight:600;color:#0d1b2e;">${c.shipName}</td>
          <td style="padding:10px 12px;color:#64748b;font-size:13px;">${c.provider}</td>
          <td style="padding:10px 12px;color:#475569;">${c.itinerary || '—'}</td>
          <td style="padding:10px 12px;color:#475569;">${c.departureDate || '—'}</td>
          <td style="padding:10px 12px;color:#475569;">${c.duration || '—'}</td>
          <td style="padding:10px 12px;color:#475569;">${c.departurePort || '—'}</td>
          <td style="padding:10px 12px;font-weight:700;color:#1d4ed8;">${formatPrice(c, usdToGbp)}</td>
          <td style="padding:10px 12px;">
            <a href="${bookLink}" style="background:#1d4ed8;color:#fff;padding:5px 12px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">Book →</a>
          </td>
        </tr>`;
    }).join('');
    return `
      <h3 style="margin:24px 0 10px;color:#0d1b2e;font-size:16px;">🔔 ${alert.name} — ${cruises.length} new sailing${cruises.length > 1 ? 's' : ''}</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">
        <thead>
          <tr style="background:#0d1b2e;color:#fff;">
            <th style="padding:10px 12px;text-align:left;">Ship</th>
            <th style="padding:10px 12px;text-align:left;">Provider</th>
            <th style="padding:10px 12px;text-align:left;">Itinerary</th>
            <th style="padding:10px 12px;text-align:left;">Departure</th>
            <th style="padding:10px 12px;text-align:left;">Duration</th>
            <th style="padding:10px 12px;text-align:left;">Port</th>
            <th style="padding:10px 12px;text-align:left;">Price</th>
            <th style="padding:10px 12px;"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }).join('');

  return `
    <div style="font-family:'Segoe UI',system-ui,sans-serif;max-width:800px;margin:0 auto;background:#f8fafc;padding:24px;">
      <div style="background:linear-gradient(135deg,#0d1b2e,#1a3461);color:#fff;padding:32px;border-radius:12px;margin-bottom:24px;">
        <h1 style="margin:0 0 8px;font-size:24px;">🚢 New Cruise Alert</h1>
        <p style="margin:0;opacity:.7;font-size:14px;">New sailings have been found matching your alert criteria.</p>
      </div>
      ${sections}
      <p style="margin-top:24px;font-size:12px;color:#94a3b8;text-align:center;">
        Edit alert criteria in <code>alerts.json</code> in the GitHub repository.<br>
        Prices subject to change. Always verify on the provider's website.
      </p>
    </div>`;
}

async function sendAlertEmail(subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.ALERT_EMAIL;
  if (!apiKey || !to) {
    console.log('  (no RESEND_API_KEY or ALERT_EMAIL — skipping email)');
    return;
  }
  const res = await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'RC Cruises <onboarding@resend.dev>', to: [to], subject, html }),
  });
  if (res.ok) console.log(`  ✓ Alert email sent to ${to}`);
  else        console.warn(`  ✗ Email failed: ${await res.text()}`);
}

async function checkAlerts(newCruises, previousIds, usdToGbp) {
  const alertsPath = path.join(__dirname, '../alerts.json');
  if (!fs.existsSync(alertsPath)) return;
  let alerts;
  try { alerts = JSON.parse(fs.readFileSync(alertsPath, 'utf8')); }
  catch { console.warn('  Could not parse alerts.json'); return; }

  const brandNew = newCruises.filter(c => c.id && !previousIds.has(c.id));
  console.log(`  ${brandNew.length} new cruise IDs found across all providers.`);
  if (brandNew.length === 0) return;

  const alertMatches = alerts
    .map(alert => ({ alert, cruises: brandNew.filter(c => matchesAlert(c, alert)) }))
    .filter(({ cruises }) => cruises.length > 0);

  if (alertMatches.length === 0) { console.log('  No new cruises matched any alert.'); return; }

  const total = alertMatches.reduce((n, { cruises }) => n + cruises.length, 0);
  console.log(`  ${total} new cruise(s) matched — sending email…`);
  await sendAlertEmail(
    `🚢 ${total} new cruise${total > 1 ? 's' : ''} match your alerts`,
    buildEmailHtml(alertMatches, usdToGbp),
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { providerId, providerOnly, writeManifest } = parseCommandLineArgs(process.argv);
  const activeProviders = getProvidersToProcess(providerId);

  // Load previous active + archive snapshots so price history follows cruises
  // when they expire (move to archive) or get re-listed (come back to active).
  const previousActiveByProvider  = new Map();
  const previousArchiveByProvider = new Map();
  let previousIds = new Set();
  for (const provider of activeProviders) {
    const prevActive  = readPreviousProviderSnapshot(provider.id);
    const prevArchive = readPreviousArchive(provider.id);
    previousActiveByProvider.set(provider.id, prevActive);
    previousArchiveByProvider.set(provider.id, prevArchive);
    for (const id of prevActive.keys()) previousIds.add(id);
  }
  console.log(`Previous scan: ${previousIds.size} active cruise IDs across ${providerId === 'all' ? 'all providers' : providerId}.`);

  // Live exchange rate
  let usdToGbp = 0.79;
  try {
    const r = await (await fetchWithTimeout('https://open.er-api.com/v6/latest/USD')).json();
    if (r?.rates?.GBP) usdToGbp = r.rates.GBP;
  } catch {}
  console.log(`Exchange rate: 1 USD = £${usdToGbp.toFixed(4)}`);

  const scrapedAt = new Date().toISOString();
  const settled = await fetchAllSnapshots(activeProviders, { priorByProvider: previousActiveByProvider });

  const providerSnapshots = settled
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  // Carry price history forward and partition into active / archive based on
  // whether each known cruise still appears in the fresh scrape and whether
  // the departure date is more than 1 day in the past.
  const scrapedNowMs = Date.parse(scrapedAt);
  for (const snapshot of providerSnapshots) {
    const prevActive  = previousActiveByProvider.get(snapshot.provider.id)  || new Map();
    const prevArchive = previousArchiveByProvider.get(snapshot.provider.id) || new Map();
    // Union: active wins on duplicate ids so re-listed cruises pull the freshest record.
    const knownById = new Map([...prevArchive, ...prevActive]);

    const freshCruises = snapshot.cruises.map(cruise => {
      const prevCruise = knownById.get(cruise.id);
      const priceHistory = mergePriceHistory(snapshot.provider.id, prevCruise, cruise, scrapedAt);
      return {
        ...cruise,
        firstSeenAt: firstSeenAt(prevCruise, priceHistory, scrapedAt),
        priceHistory,
        lastSeenAt:  scrapedAt,
      };
    });

    // Active list: freshly scraped cruises that have not aged out after sailing.
    const expiredFreshById = new Map();
    snapshot.cruises = [];
    for (const cruise of freshCruises) {
      if (cruise.id && shouldArchiveAfterDeparture(cruise, scrapedNowMs)) {
        expiredFreshById.set(cruise.id, cruise);
      } else {
        snapshot.cruises.push(cruise);
      }
    }
    const activeFreshIds = new Set(snapshot.cruises.map(c => c.id).filter(Boolean));

    // Archive list: everything we've known about that is no longer active,
    // including freshly scraped cruises whose departureDate is more than
    // 1 day past, minus entries whose departureDate is more than 2 years past.
    const archiveCandidates = new Map([...knownById, ...expiredFreshById]);
    const archive = [];
    let pruned = 0;
    for (const [id, prevCruise] of archiveCandidates) {
      if (activeFreshIds.has(id)) continue;
      if (shouldPruneFromArchive(prevCruise, scrapedNowMs)) { pruned++; continue; }
      // First-time transition from active → archive may lack lastSeenAt on
      // pre-existing data; fall back to the current scrapedAt in that case.
      archive.push({ ...withSanitizedPriceHistory(snapshot.provider.id, prevCruise), lastSeenAt: prevCruise.lastSeenAt || scrapedAt });
    }
    snapshot.archive = archive;
    if (expiredFreshById.size) console.log(`  ${snapshot.provider.name}: archived ${expiredFreshById.size} cruise(s) more than 1 day past departure.`);
    if (pruned) console.log(`  ${snapshot.provider.name}: pruned ${pruned} cruise(s) past the 2-year retention.`);
  }

  const allCruises = providerSnapshots.flatMap(s => s.cruises);

  // Write provider-specific outputs plus a manifest for the frontend
  for (const { provider, cruises, archive } of providerSnapshots) {
    writeProviderSnapshot(provider, cruises, scrapedAt);
    writeProviderArchive(provider, archive);
  }

  if (writeManifest && !providerOnly) {
    writeProviderIndex(scrapedAt);
  } else if (providerOnly) {
    console.log('  ✓ Skipped provider index refresh (--provider-only)');
  }
  console.log(`\n✓ Wrote ${allCruises.length} total cruises across ${providerSnapshots.length} provider(s).`);

  // Check alerts
  await checkAlerts(allCruises, previousIds, usdToGbp);
}

if (require.main === module) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = {
  countCurrentPrices,
  fetchProviderSnapshot,
  fetchAllSnapshots,
  hasUniformCabinPrices,
  mergePriceHistory,
  sanitizePriceHistoryForProvider,
  withSanitizedPriceHistory,
  getProviderOutputPath,
  getProviderHistoryPath,
  writeProviderSnapshot,
  readPreviousProviderSnapshot,
};

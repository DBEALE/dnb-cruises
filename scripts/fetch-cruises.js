'use strict';

const fs        = require('fs');
const path      = require('path');
const providers = require('../providers');

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

function readPreviousCruiseIds(providerId) {
  try {
    const prev = JSON.parse(fs.readFileSync(getProviderOutputPath(providerId), 'utf8'));
    return new Set((prev.cruises || []).map(c => c.id).filter(Boolean));
  } catch {
    return new Set();
  }
}

function writeProviderSnapshot(provider, cruises, scrapedAt) {
  const outPath = getProviderOutputPath(provider.id);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    success:   true,
    count:     cruises.length,
    provider:  { id: provider.id, name: provider.name },
    cruises,
    scrapedAt,
  }, null, 2) + '\n');
  console.log(`  ✓ Wrote ${cruises.length} cruises to ${outPath}`);
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
  const res = await fetch('https://api.resend.com/emails', {
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

  // Load previous IDs for new-cruise detection
  let previousIds = new Set();
  for (const provider of activeProviders) {
    const providerIds = readPreviousCruiseIds(provider.id);
    for (const id of providerIds) previousIds.add(id);
  }
  console.log(`Previous scan: ${previousIds.size} cruise IDs across ${providerId === 'all' ? 'all providers' : providerId}.`);

  // Live exchange rate
  let usdToGbp = 0.79;
  try {
    const r = await (await fetch('https://open.er-api.com/v6/latest/USD')).json();
    if (r?.rates?.GBP) usdToGbp = r.rates.GBP;
  } catch {}
  console.log(`Exchange rate: 1 USD = £${usdToGbp.toFixed(4)}`);

  // Fetch from all active providers in parallel
  const scrapedAt = new Date().toISOString();
  const settled = await Promise.allSettled(
    activeProviders.map(async provider => {
      console.log(`Fetching from ${provider.name}…`);
      try {
        const cruises = await provider.fetchCruises();
        console.log(`  ✓ ${cruises.length} cruises from ${provider.name}`);
        return { provider, cruises };
      } catch (err) {
        console.error(`  ✗ ${provider.name} failed: ${err.message}`);
        throw err;
      }
    })
  );

  const providerSnapshots = settled
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
  const allCruises = providerSnapshots.flatMap(s => s.cruises);

  // Write provider-specific outputs plus a manifest for the frontend
  for (const { provider, cruises } of providerSnapshots) {
    writeProviderSnapshot(provider, cruises, scrapedAt);
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

main().catch(err => { console.error(err.message); process.exit(1); });

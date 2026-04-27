'use strict';

const fs   = require('fs');
const path = require('path');

const CRUISE_GRAPH_URL      = 'https://www.royalcaribbean.com/cruises/graph';
const CRUISE_SEARCH_FILTERS = '';
const CRUISE_SEARCH_SORT    = { by: 'PRICE', order: 'ASC' };
const CRUISE_SEARCH_PAGE_SIZE = 100;
const CRUISE_SEARCH_QUERY = `query cruiseSearch_Cruises($filters: String, $qualifiers: String, $sort: CruiseSearchSort, $pagination: CruiseSearchPagination, $nlSearch: String) {
  cruiseSearch(filters: $filters, qualifiers: $qualifiers, sort: $sort, pagination: $pagination, nlSearch: $nlSearch) {
    results {
      cruises {
        id
        productViewLink
        lowestPriceSailing {
          bookingLink
          sailDate
          lowestStateroomClassPrice {
            price {
              value
              currency {
                code
              }
            }
          }
        }
        masterSailing {
          itinerary {
            name
            totalNights
            departurePort {
              name
            }
            destination {
              name
            }
            ship {
              name
              code
            }
          }
        }
      }
      total
    }
  }
}`;

const SHIP_LAUNCH_YEAR = {
  'Adventure of the Seas':    2001,
  'Allure of the Seas':       2010,
  'Anthem of the Seas':       2015,
  'Brilliance of the Seas':   2002,
  'Enchantment of the Seas':  1997,
  'Explorer of the Seas':     2000,
  'Freedom of the Seas':      2006,
  'Grandeur of the Seas':     1996,
  'Harmony of the Seas':      2016,
  'Icon of the Seas':         2024,
  'Independence of the Seas': 2008,
  'Jewel of the Seas':        2004,
  'Liberty of the Seas':      2007,
  'Mariner of the Seas':      2003,
  'Navigator of the Seas':    2002,
  'Oasis of the Seas':        2009,
  'Odyssey of the Seas':      2021,
  'Ovation of the Seas':      2016,
  'Quantum of the Seas':      2014,
  'Radiance of the Seas':     2001,
  'Rhapsody of the Seas':     1997,
  'Serenade of the Seas':     2003,
  'Spectrum of the Seas':     2019,
  'Symphony of the Seas':     2018,
  'Utopia of the Seas':       2024,
  'Vision of the Seas':       1998,
  'Voyager of the Seas':      1999,
  'Wonder of the Seas':       2022,
};

const SHIP_CLASS = {
  'Icon of the Seas':         'Icon',
  'Utopia of the Seas':       'Oasis',
  'Wonder of the Seas':       'Oasis',
  'Symphony of the Seas':     'Oasis',
  'Harmony of the Seas':      'Oasis',
  'Allure of the Seas':       'Oasis',
  'Oasis of the Seas':        'Oasis',
  'Odyssey of the Seas':      'Quantum',
  'Spectrum of the Seas':     'Quantum',
  'Ovation of the Seas':      'Quantum',
  'Anthem of the Seas':       'Quantum',
  'Quantum of the Seas':      'Quantum',
  'Independence of the Seas': 'Freedom',
  'Liberty of the Seas':      'Freedom',
  'Freedom of the Seas':      'Freedom',
  'Mariner of the Seas':      'Voyager',
  'Navigator of the Seas':    'Voyager',
  'Adventure of the Seas':    'Voyager',
  'Explorer of the Seas':     'Voyager',
  'Voyager of the Seas':      'Voyager',
  'Jewel of the Seas':        'Radiance',
  'Serenade of the Seas':     'Radiance',
  'Brilliance of the Seas':   'Radiance',
  'Radiance of the Seas':     'Radiance',
  'Rhapsody of the Seas':     'Vision',
  'Grandeur of the Seas':     'Vision',
  'Enchantment of the Seas':  'Vision',
  'Vision of the Seas':       'Vision',
};

function getDepartureRegion(portName) {
  if (!portName) return '';
  const p = portName.toLowerCase();
  if (/england|scotland|wales|southampton|dover|harwich|tilbury|portsmouth|newcastle|liverpool|belfast|dublin|cork|ireland/.test(p)) return 'UK & Ireland';
  if (/norway|sweden|denmark|finland|iceland|amsterdam|netherlands|hamburg|germany|copenhagen|stockholm|oslo|reykjavik|rotterdam|antwerp|belgium/.test(p)) return 'Northern Europe';
  if (/spain|france|italy|greece|turkey|portugal|croatia|malta|cyprus|montenegro|albania|gibraltar|monaco|barcelona|rome|civitavecchia|naples|genoa|venice|ravenna|trieste|piraeus|athens|istanbul|lisbon|marseille|valletta|palma|dubrovnik|kotor|split|zadar/.test(p)) return 'Mediterranean';
  if (/bahamas|barbados|antigua|jamaica|puerto rico|st\. lucia|aruba|curacao|trinidad|martinique|guadeloupe|dominica|grenada|nassau|bridgetown|castries|kingston|willemstad|oranjestad|virgin island|cayman|cozumel|belize|haiti|dominican|caribbean/.test(p)) return 'Caribbean';
  if (/florida|miami|fort lauderdale|port canaveral|tampa|galveston|texas|new york|new orleans|louisiana|baltimore|maryland|boston|seattle|washington|vancouver|canada|alaska|los angeles|california|san diego|honolulu|hawaii/.test(p)) return 'Americas';
  if (/singapore|china|japan|tokyo|yokohama|shanghai|hong kong|thailand|vietnam|korea|taiwan|philippines|indonesia|malaysia|bali|tianjin|keelung|hakodate|osaka/.test(p)) return 'Asia & Far East';
  if (/dubai|abu dhabi|uae|oman|muscat|qatar|doha|bahrain|israel|jordan|aqaba|haifa|egypt|alexandria/.test(p)) return 'Middle East';
  if (/australia|new zealand|sydney|melbourne|brisbane|auckland|fiji|tahiti|pacific/.test(p)) return 'Australia & Pacific';
  if (/brazil|argentina|chile|peru|colombia|uruguay|buenos aires|rio de janeiro|santiago|lima|cartagena|montevideo/.test(p)) return 'South America';
  return 'Other';
}

function normalizeCruise(cruise) {
  const itinerary = cruise?.masterSailing?.itinerary || {};
  const sailing   = cruise?.lowestPriceSailing || cruise?.displaySailing || {};
  const price     = sailing?.lowestStateroomClassPrice?.price || {};
  const shipName  = itinerary?.ship?.name || '';
  const departurePort = itinerary?.departurePort?.name || '';
  return {
    id:              cruise.id || '',
    shipName,
    shipClass:       SHIP_CLASS[shipName] || '',
    shipLaunchYear:  SHIP_LAUNCH_YEAR[shipName] || null,
    itinerary:       itinerary?.name || '',
    departureDate:   sailing?.sailDate || '',
    duration:        itinerary?.totalNights ? `${itinerary.totalNights} Nights` : '',
    departurePort,
    departureRegion: getDepartureRegion(departurePort),
    destination:     itinerary?.destination?.name || '',
    priceFrom:       price?.value != null ? String(price.value) : '',
    currency:        price?.currency?.code || 'USD',
    bookingUrl:      sailing?.bookingLink || cruise?.productViewLink || '',
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchCruiseSearchPage({ filters, pagination }, attempt = 1) {
  const body = JSON.stringify({
    operationName: 'cruiseSearch_Cruises',
    variables: { filters, qualifiers: '', nlSearch: '', sort: CRUISE_SEARCH_SORT, pagination },
    query: CRUISE_SEARCH_QUERY,
  });
  const res = await fetch(CRUISE_GRAPH_URL, {
    method: 'POST',
    headers: {
      'content-type':   'application/json',
      'accept':         'application/json',
      'accept-language':'en-GB,en;q=0.9',
      'user-agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'origin':         'https://www.royalcaribbean.com',
      'referer':        'https://www.royalcaribbean.com/gbr/en/cruises',
    },
    body,
  });
  if (!res.ok) {
    if (attempt < 4) {
      const delay = attempt * 3000;
      console.log(`  HTTP ${res.status} — retrying in ${delay / 1000}s (attempt ${attempt}/3)…`);
      await sleep(delay);
      return fetchCruiseSearchPage({ filters, pagination }, attempt + 1);
    }
    throw new Error(`RC API returned HTTP ${res.status} after 3 retries`);
  }
  const payload = await res.json();
  const results = payload?.data?.cruiseSearch?.results;
  if (!results) throw new Error(payload?.errors?.[0]?.message || 'No results in RC API response');
  return results;
}

async function fetchAllCruises() {
  const cruises      = [];
  const seenIds      = new Set();
  let total          = Number.POSITIVE_INFINITY;
  let skip           = 0;

  while (skip < total) {
    const count   = Math.min(CRUISE_SEARCH_PAGE_SIZE, total - skip);
    const results = await fetchCruiseSearchPage({ filters: CRUISE_SEARCH_FILTERS, pagination: { count, skip } });
    total = Number.isFinite(results.total) ? results.total : total;

    const page = Array.isArray(results.cruises) ? results.cruises : [];
    if (page.length === 0) break;

    for (const c of page) {
      if (!c?.id || seenIds.has(c.id)) continue;
      seenIds.add(c.id);
      cruises.push(normalizeCruise(c));
    }

    skip += page.length;
    console.log(`  fetched ${cruises.length} / ${total}`);
    await sleep(500);
  }
  return cruises;
}

// ── Alert matching ────────────────────────────────────────────────────────────

function matchesAlert(cruise, alert, usdToGbp) {
  if (alert.departureRegion && cruise.departureRegion !== alert.departureRegion) return false;
  if (alert.shipClass       && cruise.shipClass       !== alert.shipClass)       return false;
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
  if (cruise.currency === 'USD' && usdToGbp) return `£${Math.round(n * usdToGbp).toLocaleString()} (≈$${Math.round(n).toLocaleString()})`;
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
            <th style="padding:10px 12px;text-align:left;font-weight:600;">Ship</th>
            <th style="padding:10px 12px;text-align:left;font-weight:600;">Itinerary</th>
            <th style="padding:10px 12px;text-align:left;font-weight:600;">Departure</th>
            <th style="padding:10px 12px;text-align:left;font-weight:600;">Duration</th>
            <th style="padding:10px 12px;text-align:left;font-weight:600;">Port</th>
            <th style="padding:10px 12px;text-align:left;font-weight:600;">Price</th>
            <th style="padding:10px 12px;text-align:left;font-weight:600;"></th>
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
        Edit your alert criteria in <code>alerts.json</code> in the GitHub repository.<br>
        Data sourced from <a href="https://www.royalcaribbean.com/gbr/en/cruises" style="color:#1d4ed8;">royalcaribbean.com</a>. Prices subject to change.
      </p>
    </div>`;
}

async function sendAlertEmail(subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.ALERT_EMAIL;
  if (!apiKey || !to) {
    console.log('  (no RESEND_API_KEY or ALERT_EMAIL set — skipping email)');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'RC Cruises <onboarding@resend.dev>', to: [to], subject, html }),
  });
  if (res.ok) {
    console.log(`  ✓ Alert email sent to ${to}`);
  } else {
    const err = await res.text();
    console.warn(`  ✗ Email failed: ${err}`);
  }
}

async function checkAlerts(newCruises, previousIds, usdToGbp) {
  const alertsPath = path.join(__dirname, '../alerts.json');
  if (!fs.existsSync(alertsPath)) return;

  let alerts;
  try { alerts = JSON.parse(fs.readFileSync(alertsPath, 'utf8')); }
  catch { console.warn('  Could not parse alerts.json'); return; }

  // Only check cruises that are genuinely new this scan
  const brandNew = newCruises.filter(c => c.id && !previousIds.has(c.id));
  if (brandNew.length === 0) { console.log('  No new cruises found this scan.'); return; }
  console.log(`  ${brandNew.length} new cruises found this scan — checking alerts…`);

  const alertMatches = alerts
    .map(alert => ({
      alert,
      cruises: brandNew.filter(c => matchesAlert(c, alert, usdToGbp)),
    }))
    .filter(({ cruises }) => cruises.length > 0);

  if (alertMatches.length === 0) {
    console.log('  No new cruises matched any alert criteria.');
    return;
  }

  const totalMatches = alertMatches.reduce((n, { cruises }) => n + cruises.length, 0);
  console.log(`  ${totalMatches} new cruise(s) matched alert criteria — sending email…`);

  const subject = `🚢 ${totalMatches} new cruise${totalMatches > 1 ? 's' : ''} match your alerts`;
  const html    = buildEmailHtml(alertMatches, usdToGbp);
  await sendAlertEmail(subject, html);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching Royal Caribbean cruise data…');

  // Load previous cruise IDs for new-cruise detection
  const outPath = path.join(__dirname, '../public/cruises.json');
  let previousIds = new Set();
  try {
    const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    previousIds = new Set((prev.cruises || []).map(c => c.id).filter(Boolean));
    console.log(`  Previous scan had ${previousIds.size} cruise IDs.`);
  } catch { /* first run — no previous data */ }

  // Fetch live exchange rate for price comparisons
  let usdToGbp = 0.79;
  try {
    const rateRes = await fetch('https://open.er-api.com/v6/latest/USD');
    const rateData = await rateRes.json();
    if (rateData?.rates?.GBP) usdToGbp = rateData.rates.GBP;
  } catch { /* use fallback */ }
  console.log(`  Exchange rate: 1 USD = £${usdToGbp.toFixed(4)}`);

  const cruises = await fetchAllCruises();

  // Write new data
  fs.writeFileSync(outPath, JSON.stringify({
    success: true, count: cruises.length, cruises, scrapedAt: new Date().toISOString(),
  }));
  console.log(`✓ Wrote ${cruises.length} cruises to ${outPath}`);

  // Check and send alerts
  await checkAlerts(cruises, previousIds, usdToGbp);
}

main().catch(err => { console.error(err.message); process.exit(1); });

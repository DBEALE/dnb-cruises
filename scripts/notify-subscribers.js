'use strict';

const fs   = require('fs');
const path = require('path');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWILIO_ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM          = process.env.TWILIO_WHATSAPP_FROM || '+14155238886';

// ── Supabase REST helpers ─────────────────────────────────────────────────────

async function sbFetch(method, resource, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${resource}`, {
    method,
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'apikey':        SUPABASE_SERVICE_KEY,
      'Content-Type':  'application/json',
      'Prefer':        method === 'POST' ? 'return=minimal' : 'return=minimal',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${resource}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Twilio WhatsApp send ──────────────────────────────────────────────────────

async function sendWhatsApp(to, message) {
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        From: `whatsapp:${TWILIO_FROM}`,
        To:   `whatsapp:${to}`,
        Body: message,
      }).toString(),
    },
  );
  if (!res.ok) throw new Error(`Twilio error: ${await res.text()}`);
}

// ── Load cruises from static JSON files ──────────────────────────────────────

function loadAllCruises() {
  const indexPath = path.join(__dirname, '../public/providers/index.json');
  if (!fs.existsSync(indexPath)) return [];
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const cruises = [];
  for (const provider of index.providers) {
    const rel = provider.cruisesUrl.replace('./', '');
    const p = path.join(__dirname, '../public', rel);
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      cruises.push(...(data.cruises || []));
    }
  }
  return cruises;
}

// ── Criteria matching (mirrors frontend filter logic) ────────────────────────

function matchesCriteria(cruise, criteria, usdToGbp) {
  const c = criteria;
  if (c.shipName        && !cruise.shipName?.toLowerCase().includes(c.shipName.toLowerCase()))               return false;
  if (c.provider        && cruise.provider !== c.provider)                                                    return false;
  if (c.shipClass       && cruise.shipClass !== c.shipClass)                                                  return false;
  if (c.minLaunch       && (cruise.shipLaunchYear ?? 0) < Number(c.minLaunch))                               return false;
  if (c.itinerary       && !cruise.itinerary?.toLowerCase().includes(c.itinerary.toLowerCase()))             return false;
  if (c.destination     && !cruise.destination?.toLowerCase().includes(c.destination.toLowerCase()))         return false;
  if (c.departureDate   && !cruise.departureDate?.toLowerCase().includes(c.departureDate.toLowerCase()))     return false;
  if (c.departurePort   && !cruise.departurePort?.toLowerCase().includes(c.departurePort.toLowerCase()))     return false;
  if (c.departureRegion && cruise.departureRegion !== c.departureRegion)                                      return false;
  if (c.duration) {
    const nights = parseInt(cruise.duration, 10) || 0;
    if (nights < Number(c.duration)) return false;
  }
  if (c.maxPrice) {
    let price = parseFloat(cruise.priceFrom);
    if (isNaN(price)) return false;
    if (cruise.currency === 'USD' && usdToGbp) price *= usdToGbp;
    if (price > Number(c.maxPrice)) return false;
  }
  return true;
}

// ── WhatsApp message formatter ────────────────────────────────────────────────

function buildMessage(cruises, usdToGbp) {
  const lines = cruises.slice(0, 10).map((c, i) => {
    const rawPrice = parseFloat(c.priceFrom);
    const price = isNaN(rawPrice)
      ? 'N/A'
      : (c.currency === 'USD' && usdToGbp)
        ? `£${Math.round(rawPrice * usdToGbp).toLocaleString('en-GB')}`
        : `£${Math.round(rawPrice).toLocaleString('en-GB')}`;
    const nights = (c.duration ?? '').toString().replace(/\D/g, '') || '?';
    const date = c.departureDate
      ? new Date(c.departureDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : '?';
    const book = c.bookingUrl
      ? (c.bookingUrl.startsWith('http') ? c.bookingUrl : `https://www.royalcaribbean.com${c.bookingUrl}`)
      : 'https://www.royalcaribbean.com/gbr/en/cruises';
    return `${i + 1}. *${c.shipName}* (${c.provider})\n   ${nights}N · ${date} · ${c.departurePort || '?'}\n   From ${price} pp\n   ${book}`;
  });

  const overflow = cruises.length > 10 ? `\n\n_...and ${cruises.length - 10} more sailings._` : '';
  return (
    `🚢 *New Cruise Alert!*\n\n` +
    `${cruises.length} new sailing${cruises.length !== 1 ? 's' : ''} match your saved search:\n\n` +
    lines.join('\n\n') +
    overflow +
    `\n\n_Reply *CONTINUE* to keep receiving alerts — otherwise this is your final notification._`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.log('  Skipping subscriber notifications — required env vars not set.');
    return;
  }

  const usdToGbp = await (async () => {
    try {
      const r = await (await fetch('https://open.er-api.com/v6/latest/USD')).json();
      return r?.rates?.GBP ?? 0.79;
    } catch { return 0.79; }
  })();

  const allCruises = loadAllCruises();
  console.log(`  Loaded ${allCruises.length} cruises for subscriber matching.`);

  const subscriptions = await sbFetch('GET', 'subscriptions?active=eq.true&select=id,whatsapp_number,criteria');
  if (!subscriptions?.length) {
    console.log('  No active subscriptions.');
    return;
  }
  console.log(`  Found ${subscriptions.length} active subscription(s).`);

  for (const sub of subscriptions) {
    const seenRows = await sbFetch('GET', `seen_cruises?subscription_id=eq.${sub.id}&select=cruise_id`);
    const seenIds  = new Set((seenRows ?? []).map(r => r.cruise_id));

    const newMatches = allCruises.filter(c =>
      c.id && !seenIds.has(c.id) && matchesCriteria(c, sub.criteria, usdToGbp),
    );

    if (newMatches.length === 0) {
      console.log(`  Sub ${sub.id}: no new matches.`);
      continue;
    }

    console.log(`  Sub ${sub.id}: ${newMatches.length} new match(es) — sending WhatsApp to ${sub.whatsapp_number}…`);

    try {
      await sendWhatsApp(sub.whatsapp_number, buildMessage(newMatches, usdToGbp));
      console.log(`  ✓ Sent to ${sub.whatsapp_number}`);

      // Record these cruises as seen
      await sbFetch('POST', 'seen_cruises', newMatches.map(c => ({ subscription_id: sub.id, cruise_id: c.id })));

      // Deactivate until user replies CONTINUE
      await sbFetch('PATCH', `subscriptions?id=eq.${sub.id}`, {
        active: false,
        last_notified_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`  ✗ Failed for ${sub.whatsapp_number}: ${err.message}`);
    }
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });

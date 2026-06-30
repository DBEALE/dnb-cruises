'use strict';

const fs   = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('../providers/shared');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TWILIO_ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM          = process.env.TWILIO_WHATSAPP_FROM || '+14155238886';
const TWILIO_BODY_LIMIT    = 1600;
const WHATSAPP_SAFE_LIMIT  = 1400;
const MAX_LISTED_MATCHES   = 20;

// Supabase REST helpers

async function sbFetch(method, resource, body) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${resource}`, {
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

// Twilio WhatsApp send

async function sendWhatsApp(to, message) {
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetchWithTimeout(
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

// Load cruises from static JSON files

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

// Criteria matching (mirrors frontend filter logic)

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

// WhatsApp message formatter

function clip(value, max) {
  const text = String(value || '?').replace(/\s+/g, ' ').trim() || '?';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatShortDate(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '?';
}

function formatPrice(c, usdToGbp) {
  const rawPrice = parseFloat(c.priceFrom);
  if (Number.isNaN(rawPrice)) return 'N/A';
  const price = c.currency === 'USD' && usdToGbp ? rawPrice * usdToGbp : rawPrice;
  return `GBP ${Math.round(price).toLocaleString('en-GB')}`;
}

function compactCruiseLine(c, index, usdToGbp) {
  const nights = (c.duration ?? '').toString().replace(/\D/g, '') || '?';
  return [
    `${index + 1}. ${clip(c.shipName, 42)} (${clip(c.provider, 24)})`,
    `${nights}N | ${formatShortDate(c.departureDate)} | ${clip(c.departurePort, 28)} | ${formatPrice(c, usdToGbp)} pp`,
  ].join('\n');
}

function pushChunk(chunks, lines) {
  if (lines.length) chunks.push(lines.join('\n\n'));
}

function buildMessages(cruises, usdToGbp, options = {}) {
  const safeLimit = options.safeLimit || WHATSAPP_SAFE_LIMIT;
  const maxListed = options.maxListed || MAX_LISTED_MATCHES;
  const listed = cruises.slice(0, maxListed);
  const chunks = [];
  let current = [
    `Cruise alert: ${cruises.length} new match${cruises.length === 1 ? '' : 'es'}.`,
  ];

  for (let i = 0; i < listed.length; i++) {
    const line = compactCruiseLine(listed[i], i, usdToGbp);
    const next = [...current, line].join('\n\n');
    if (next.length > safeLimit && current.length > 1) {
      pushChunk(chunks, current);
      current = [line];
    } else {
      current.push(line);
    }
  }

  const footerLines = [];
  if (cruises.length > listed.length) {
    footerLines.push(`+${cruises.length - listed.length} more matches in the site.`);
  }
  footerLines.push('Open your saved view for booking links.');
  footerLines.push('Reply CONTINUE to keep alerts.');

  for (const footerLine of footerLines) {
    const next = [...current, footerLine].join('\n\n');
    if (next.length > safeLimit && current.length) {
      pushChunk(chunks, current);
      current = [footerLine];
    } else {
      current.push(footerLine);
    }
  }
  pushChunk(chunks, current);

  const labelled = chunks.length > 1
    ? chunks.map((chunk, index) => `Part ${index + 1}/${chunks.length}\n\n${chunk}`)
    : chunks;

  for (const message of labelled) {
    if (message.length > TWILIO_BODY_LIMIT) {
      throw new Error(`WhatsApp message body is ${message.length} characters; Twilio limit is ${TWILIO_BODY_LIMIT}.`);
    }
  }

  return labelled;
}

// Main

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.log('  Skipping subscriber notifications - required env vars not set.');
    return;
  }

  const usdToGbp = await (async () => {
    try {
      const r = await (await fetchWithTimeout('https://open.er-api.com/v6/latest/USD')).json();
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

    console.log(`  Sub ${sub.id}: ${newMatches.length} new match(es) - sending WhatsApp to ${sub.whatsapp_number}...`);

    try {
      const messages = buildMessages(newMatches, usdToGbp);
      for (let i = 0; i < messages.length; i++) {
        await sendWhatsApp(sub.whatsapp_number, messages[i]);
        console.log(`  Sent WhatsApp part ${i + 1}/${messages.length} to ${sub.whatsapp_number}`);
      }

      // Record these cruises as seen only after every message part succeeds.
      await sbFetch('POST', 'seen_cruises', newMatches.map(c => ({ subscription_id: sub.id, cruise_id: c.id })));

      // Deactivate until user replies CONTINUE.
      await sbFetch('PATCH', `subscriptions?id=eq.${sub.id}`, {
        active: false,
        last_notified_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`  Failed for ${sub.whatsapp_number}: ${err.message}`);
    }
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = {
  buildMessages,
  compactCruiseLine,
  matchesCriteria,
};

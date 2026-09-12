'use strict';

const DAY = 86400000;
const FRESH_MS = 2 * DAY;

function itineraryCode(cruise) {
  try {
    const code = new URL(cruise.bookingUrl).searchParams.get('itineraryCode');
    return /^[A-Z0-9]+$/.test(code || '') ? code : '';
  } catch { return ''; }
}

function statusFor(state, now) {
  const entries = Object.values(state.itineraries);
  const checked = entries.filter(e => e.fetchedAt);
  const fresh = checked.filter(e => now - Date.parse(e.fetchedAt) < FRESH_MS);
  const dates = checked.map(e => e.fetchedAt).sort();
  return {
    knownItineraries: entries.length,
    freshItineraries: fresh.length,
    pendingItineraries: entries.length - fresh.length,
    lastPriceCheckAt: dates.at(-1) || null,
    oldestPriceCheckAt: dates[0] || null,
    lastDiscoveryAt: state.lastDiscoveryAt || null,
    discoveryComplete: Boolean(state.lastDiscoveryAt && now - Date.parse(state.lastDiscoveryAt) < 7 * DAY),
    nextAttemptAt: state.nextAttemptAt || null,
    lastError: state.lastError || '',
    checkedAt: new Date(now).toISOString(),
  };
}

// Store normalized sailings, not NCL's large marketing payloads. This state is
// persisted after every successful itinerary and restored on the next CI run.
async function refreshNcl({ priorState, priorCruises = new Map(), priorArchive = new Map(),
  loadItinerary, discover, normalize, save = () => {}, now = Date.now(),
  batchSize = 25, delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  requestDelayMs = 1500, timeBudgetMs = 180000, clock = Date.now }) {
  const state = priorState?.version === 1
    ? JSON.parse(JSON.stringify(priorState))
    : { version: 1, itineraries: {} };
  state.itineraries ||= {};
  const stamp = new Date(now).toISOString();
  const started = clock();
  function ensure(code, bookingUrl) {
    if (!/^[A-Z0-9]+$/.test(code || '')) return null;
    return state.itineraries[code] ||= { code, bookingUrl, cruises: [] };
  }
  for (const c of priorArchive.values()) ensure(itineraryCode(c), c.bookingUrl);
  for (const c of priorCruises.values()) {
    const entry = ensure(itineraryCode(c), c.bookingUrl);
    if (entry && !entry.fetchedAt && !entry.cruises.some(old => old.id === c.id)) {
      const { priceHistory, ...slim } = c;
      entry.cruises.push({ ...slim, priceCheckedAt: c.priceCheckedAt || c.lastSeenAt || null });
    }
  }
  const checkpoint = async () => {
    state.status = statusFor(state, now);
    await save(state);
  };
  function accept(card, detail) {
    const entry = ensure(card.code, card.bookingUrl);
    if (!entry) return;
    if (entry.fetchedAt === stamp) return;
    const cruises = normalize(card, detail);
    if (!Array.isArray(cruises) || cruises.some(c => !c.shipName || !c.departureDate)) {
      throw new Error('Invalid itinerary response');
    }
    entry.cruises = cruises.map(c => ({ ...c, priceCheckedAt: stamp }));
    entry.fetchedAt = stamp;
    entry.lastAttemptAt = stamp;
  }
  function fail(error) {
    const blocked = [403, 429].includes(error.status);
    state.failures = (state.failures || 0) + 1;
    const wait = blocked ? Math.min(DAY, 6 * 3600000 * 2 ** Math.min(state.failures - 1, 2)) : 2 * 3600000;
    state.nextAttemptAt = new Date(now + Math.max(wait, error.retryAfterMs || 0)).toISOString();
    state.lastError = error.status === 403 ? 'NCL denied access'
      : error.status === 429 ? 'NCL rate limit' : 'NCL refresh interrupted';
  }
  if (!(Date.parse(state.nextAttemptAt) > now)) {
    state.nextAttemptAt = null;
    state.lastError = '';
    const queue = Object.values(state.itineraries)
      .filter(e => !e.fetchedAt || now - Date.parse(e.fetchedAt) >= FRESH_MS)
      .sort((a, b) => (Date.parse(a.lastAttemptAt) || 0) - (Date.parse(b.lastAttemptAt) || 0)
        || a.code.localeCompare(b.code));
    let requests = 0;
    for (const entry of queue.slice(0, batchSize)) {
      if (clock() - started >= timeBudgetMs) break;
      if (requests++) await delay(requestDelayMs);
      entry.lastAttemptAt = stamp;
      try {
        accept(entry, await loadItinerary(entry.code));
        state.failures = 0;
      } catch (error) {
        fail(error);
        await checkpoint();
        break;
      }
      await checkpoint();
    }
    // Discovery is less frequent than price updates. Partial discoveries add
    // routes to the queue without deleting routes absent from a failed page.
    if (!state.nextAttemptAt && discover && clock() - started < timeBudgetMs
      && (!state.lastDiscoveryAttemptAt || now - Date.parse(state.lastDiscoveryAttemptAt) >= DAY)) {
      state.lastDiscoveryAttemptAt = stamp;
      await checkpoint();
      try {
        await discover(async (cards, details) => {
          for (const card of cards) {
            ensure(card.code, card.bookingUrl);
            const detail = details.get(card.code);
            if (detail?.sailings?.length) accept(card, detail);
          }
          await checkpoint();
        });
        state.lastDiscoveryAt = stamp;
        state.failures = 0;
      } catch (error) { fail(error); }
    }
  }
  await checkpoint();
  // Keep stale known sailings until their itinerary is successfully refreshed.
  // The caller handles expired dates and preserves each sailing's history.
  return { cruises: Object.values(state.itineraries).flatMap(e => e.cruises || []), state };
}

module.exports = { refreshNcl, statusFor, itineraryCode, FRESH_MS };

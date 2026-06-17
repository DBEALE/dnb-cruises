'use strict';

const PRICE_BUCKETS = ['inside', 'oceanView', 'balcony', 'suite'];

function hasUniformCabinPrices(entry) {
  if (entry?.price != null && !entry.prices) {
    return Number.isFinite(parseFloat(entry.price));
  }
  if (!entry?.prices) return false;
  const values = PRICE_BUCKETS.map(bucket => parseFloat(entry.prices[bucket]));
  return values.every(Number.isFinite) && values.every(value => value === values[0]);
}

function sanitizePriceHistoryForProvider(providerId, history) {
  let entries = Array.isArray(history) ? [...history] : [];
  if (providerId !== 'ncl-cruises' || entries.length === 0) return entries;
  while (entries.length) {
    let earliestIndex = 0;
    let earliestTime = Date.parse(entries[0]?.at || '');
    for (let i = 1; i < entries.length; i++) {
      const time = Date.parse(entries[i]?.at || '');
      if (Number.isFinite(time) && (!Number.isFinite(earliestTime) || time < earliestTime)) {
        earliestTime = time;
        earliestIndex = i;
      }
    }
    if (!hasUniformCabinPrices(entries[earliestIndex])) return entries;
    entries = entries.filter((_, index) => index !== earliestIndex);
  }
  return entries;
}

function withSanitizedPriceHistory(providerId, cruise) {
  if (!cruise) return cruise;
  return {
    ...cruise,
    priceHistory: sanitizePriceHistoryForProvider(providerId, cruise.priceHistory),
  };
}

module.exports = {
  hasUniformCabinPrices,
  sanitizePriceHistoryForProvider,
  withSanitizedPriceHistory,
};

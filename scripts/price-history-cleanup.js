'use strict';

const PRICE_BUCKETS = ['inside', 'oceanView', 'balcony', 'suite'];

function hasUniformCabinPrices(entry) {
  if (!entry?.prices) return false;
  const values = PRICE_BUCKETS.map(bucket => parseFloat(entry.prices[bucket]));
  return values.every(Number.isFinite) && values.every(value => value === values[0]);
}

function hasAnyCabinPrice(entry) {
  return Boolean(entry?.prices) && PRICE_BUCKETS.some(bucket => Number.isFinite(parseFloat(entry.prices[bucket])));
}

function hasUniformPopulatedCabinPrices(entry) {
  if (!entry?.prices) return false;
  const values = PRICE_BUCKETS
    .map(bucket => parseFloat(entry.prices[bucket]))
    .filter(Number.isFinite);
  return values.length >= 2 && values.every(value => value === values[0]);
}

function isInvalidLeadingHistoryEntry(providerId, entry) {
  if (providerId === 'ncl-cruises') return hasUniformCabinPrices(entry);
  if (providerId === 'princess-cruises') return hasUniformPopulatedCabinPrices(entry);
  return false;
}

function sanitizePriceHistoryForProvider(providerId, history) {
  let entries = Array.isArray(history) ? history.filter(hasAnyCabinPrice) : [];
  if (!['ncl-cruises', 'princess-cruises'].includes(providerId) || entries.length === 0) return entries;
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
    if (!isInvalidLeadingHistoryEntry(providerId, entries[earliestIndex])) return entries;
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
  hasAnyCabinPrice,
  hasUniformPopulatedCabinPrices,
  isInvalidLeadingHistoryEntry,
  sanitizePriceHistoryForProvider,
  withSanitizedPriceHistory,
};

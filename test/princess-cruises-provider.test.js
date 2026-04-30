'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../providers/princess-cruises');

// ─── normalizeCruise ───────────────────────────────────────────────────────────

test('normalizes a Princess Cruises product + sailing into a standard cruise object', () => {
  const cruise = provider.normalizeCruise(
    {
      id:            'ECI12A',
      trades:        [{ id: 'E' }],
      embkDbkPortIds: ['SOU', 'SOU'],
      cruiseDuration: 12,
    },
    '20261014',          // sailDate
    'YP',               // shipId
    'Sky Princess',     // shipName
    'Southampton (for London), England', // portName
  );

  assert.deepEqual(cruise, {
    provider:        'Princess Cruises',
    id:              'princess_ECI12A_YP_20261014',
    shipName:        'Sky Princess',
    shipClass:       'Royal',
    shipLaunchYear:  2019,
    itinerary:       '12-Night Europe',
    departureDate:   '2026-10-14',
    duration:        '12 Nights',
    departurePort:   'Southampton (for London), England',
    departureRegion: 'UK & Ireland',
    destination:     'Europe',
    priceFrom:       '',
    currency:        'GBP',
    bookingUrl:      'https://www.princess.com/en-us/itinerary/ECI12A/YP/2026/',
  });
});

test('uses port names as itinerary when portNames are provided', () => {
  const portNames = ['Southampton', 'Lisbon', 'Gibraltar', 'Barcelona', 'Rome (Civitavecchia)', 'Southampton'];
  const cruise = provider.normalizeCruise(
    {
      id:            'ECI12A',
      trades:        [{ id: 'E' }],
      embkDbkPortIds: ['SOU', 'SOU'],
      portIds:       ['SOU', 'LIS', 'GIB', 'BCN', 'CIV', 'SOU'],
      cruiseDuration: 12,
    },
    '20261014',
    'YP',
    'Sky Princess',
    'Southampton (for London), England',
    portNames,
  );

  assert.equal(cruise.itinerary, 'Southampton → Lisbon → Gibraltar → Barcelona → Rome (Civitavecchia) → Southampton');
  assert.equal(cruise.destination, 'Europe');
  assert.equal(cruise.duration, '12 Nights');
});

test('falls back to N-Night Destination when portNames is empty', () => {
  const cruise = provider.normalizeCruise(
    {
      id:            'CAR07B',
      trades:        [{ id: 'C' }],
      embkDbkPortIds: ['FLL', 'FLL'],
      cruiseDuration: 7,
    },
    '20270115',
    'MJ',
    'Majestic Princess',
    'Ft. Lauderdale, Florida',
    [],
  );

  assert.equal(cruise.itinerary, '7-Night Caribbean');
});

test('normalizes a Caribbean cruise from Fort Lauderdale', () => {
  const cruise = provider.normalizeCruise(
    {
      id:            'CAR07B',
      trades:        [{ id: 'C' }],
      embkDbkPortIds: ['FLL', 'FLL'],
      cruiseDuration: 7,
    },
    '20270115',
    'MJ',
    'Majestic Princess',
    'Ft. Lauderdale, Florida',
  );

  assert.equal(cruise.destination,    'Caribbean');
  assert.equal(cruise.itinerary,      '7-Night Caribbean');
  assert.equal(cruise.departurePort,  'Ft. Lauderdale, Florida');
  assert.equal(cruise.duration,       '7 Nights');
  assert.equal(cruise.shipName,       'Majestic Princess');
  assert.equal(cruise.shipClass,      'Royal');
  assert.equal(cruise.shipLaunchYear, 2017);
  assert.equal(cruise.priceFrom,      '');
  assert.equal(cruise.currency,       'GBP');
});

test('falls back gracefully when optional fields are missing', () => {
  const cruise = provider.normalizeCruise(
    { id: 'TEST01', trades: [], embkDbkPortIds: [], cruiseDuration: null },
    '20270601',
    'CB',
    'Caribbean Princess',
    '',
  );

  assert.equal(cruise.id,          'princess_TEST01_CB_20270601');
  assert.equal(cruise.itinerary,   'Cruise');
  assert.equal(cruise.duration,    '');
  assert.equal(cruise.destination, 'Cruise');
  assert.equal(cruise.departurePort, '');
});

test('falls back to the search URL when booking-URL inputs are missing', () => {
  const url = provider.buildBookingUrl('', '', '');
  assert.equal(url, 'https://www.princess.com/cruise-search/results/?resType=C');
});

// ─── formatSailDate ────────────────────────────────────────────────────────────

test('converts a Princess API date string to ISO-8601 format', () => {
  assert.equal(provider.formatSailDate('20260330'), '2026-03-30');
  assert.equal(provider.formatSailDate('20251225'), '2025-12-25');
});

test('returns an empty string for invalid date strings', () => {
  assert.equal(provider.formatSailDate(''),        '');
  assert.equal(provider.formatSailDate('2026'),    '');
  assert.equal(provider.formatSailDate(null),      '');
  assert.equal(provider.formatSailDate(undefined), '');
});

// ─── getDestination ────────────────────────────────────────────────────────────

test('maps Princess trade codes to destination names', () => {
  assert.equal(provider.getDestination([{ id: 'C' }]), 'Caribbean');
  assert.equal(provider.getDestination([{ id: 'E' }]), 'Europe');
  assert.equal(provider.getDestination([{ id: 'A' }]), 'Alaska');
  assert.equal(provider.getDestination([{ id: 'Z' }]), 'Australia & New Zealand');
  assert.equal(provider.getDestination([{ id: 'H' }]), 'Hawaii');
});

test('returns "Cruise" for unknown trade codes', () => {
  assert.equal(provider.getDestination([{ id: 'X99' }]), 'Cruise');
  assert.equal(provider.getDestination([]),               'Cruise');
  assert.equal(provider.getDestination(null),             'Cruise');
});

// ─── buildBookingUrl ───────────────────────────────────────────────────────────

test('builds a valid Princess Cruises booking URL', () => {
  assert.equal(
    provider.buildBookingUrl('ECI12A', 'YP', '20261014'),
    'https://www.princess.com/en-us/itinerary/ECI12A/YP/2026/',
  );
});

test('falls back to the search page URL when productId is missing', () => {
  assert.equal(
    provider.buildBookingUrl('', 'YP', '20261014'),
    'https://www.princess.com/cruise-search/results/?resType=C',
  );
});

// ─── buildItinerary ────────────────────────────────────────────────────────────

test('joins port names with → when portNames is provided', () => {
  assert.equal(
    provider.buildItinerary(['Fort Lauderdale', 'Nassau', 'Half Moon Cay', 'Fort Lauderdale'], '7', 'Caribbean'),
    'Fort Lauderdale → Nassau → Half Moon Cay → Fort Lauderdale',
  );
});

test('falls back to N-Night Destination when portNames is empty', () => {
  assert.equal(provider.buildItinerary([], '7', 'Caribbean'), '7-Night Caribbean');
  assert.equal(provider.buildItinerary(null, '7', 'Caribbean'), '7-Night Caribbean');
});

test('returns destination only when portNames is empty and nights is absent', () => {
  assert.equal(provider.buildItinerary([], '', 'Europe'), 'Europe');
  assert.equal(provider.buildItinerary(null, '', 'Cruise'), 'Cruise');
});

// ─── getLowestFare ─────────────────────────────────────────────────────────────

test('extracts price from lowestPrice object with amount and currencyCode', () => {
  const result = provider.getLowestFare({ lowestPrice: { amount: 799, currencyCode: 'GBP' } });
  assert.deepEqual(result, { amount: '799', currency: 'GBP' });
});

test('extracts price from startingFrom object', () => {
  const result = provider.getLowestFare({ startingFrom: { amount: 1299.50, currencyCode: 'GBP' } });
  assert.deepEqual(result, { amount: '1300', currency: 'GBP' });
});

test('extracts price from lowestFare object', () => {
  const result = provider.getLowestFare({ lowestFare: { fare: 849, currency: 'GBP' } });
  assert.deepEqual(result, { amount: '849', currency: 'GBP' });
});

test('extracts price from a scalar number field', () => {
  const result = provider.getLowestFare({ lowestPrice: 599 });
  assert.deepEqual(result, { amount: '599', currency: 'GBP' });
});

test('extracts price from a numeric string field', () => {
  const result = provider.getLowestFare({ fare: '1100' });
  assert.deepEqual(result, { amount: '1100', currency: 'GBP' });
});

test('returns null when no price fields are present', () => {
  assert.equal(provider.getLowestFare({}), null);
  assert.equal(provider.getLowestFare(null), null);
  assert.equal(provider.getLowestFare(undefined), null);
});

test('returns null when price fields are zero or negative', () => {
  assert.equal(provider.getLowestFare({ lowestPrice: 0 }), null);
  assert.equal(provider.getLowestFare({ lowestPrice: { amount: -5, currencyCode: 'GBP' } }), null);
});

test('falls back to GBP when currency is absent from price object', () => {
  const result = provider.getLowestFare({ lowestPrice: { amount: 999 } });
  assert.deepEqual(result, { amount: '999', currency: 'GBP' });
});

// ─── normalizeCruise with price ────────────────────────────────────────────────

test('includes price when ship object has lowestPrice data', () => {
  const cruise = provider.normalizeCruise(
    {
      id:            'ECI12A',
      trades:        [{ id: 'E' }],
      embkDbkPortIds: ['SOU', 'SOU'],
      cruiseDuration: 12,
    },
    '20261014',
    'YP',
    'Sky Princess',
    'Southampton (for London), England',
    [],
    { id: 'YP', sailDates: ['20261014'], lowestPrice: { amount: 1199, currencyCode: 'GBP' } },
  );

  assert.equal(cruise.priceFrom, '1199');
  assert.equal(cruise.currency, 'GBP');
});

test('priceFrom is empty string when ship has no price data', () => {
  const cruise = provider.normalizeCruise(
    { id: 'CAR07B', trades: [{ id: 'C' }], embkDbkPortIds: ['FLL'], cruiseDuration: 7 },
    '20270115',
    'MJ',
    'Majestic Princess',
    'Ft. Lauderdale, Florida',
    [],
    { id: 'MJ', sailDates: ['20270115'] },
  );

  assert.equal(cruise.priceFrom, '');
  assert.equal(cruise.currency, 'GBP');
});

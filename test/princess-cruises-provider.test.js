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

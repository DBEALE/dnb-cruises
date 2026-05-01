'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../providers/ncl-cruises');

test('normalizes Norwegian Cruise Line itinerary details', () => {
  const cruise = provider.normalizeCruise({
    code: 'SKY10SOUSOQIVGLVPBFSDUNWATIPOSOU',
    title: 'British Isles: England, Ireland & Scotland',
    shortTitle: 'British Isles: England, Ireland & Scotland',
    duration: { text: '10-day Cruise' },
    currency: 'GBP',
    ship: { title: 'Norwegian Sky' },
    destination: { title: 'Northern Europe Cruises' },
    embarkationPort: { title: 'Southampton, England' },
    sailings: [
      {
        departureDate: '2026-07-18',
        sailStartDate: '2026-07-18',
        staterooms: [
          { combinedPrice: '999.00' },
          { combinedPrice: '1099.00' },
        ],
      },
    ],
  }, '/uk/en/cruises/british-isles-test-SKY10SOUSOQIVGLVPBFSDUNWATIPOSOU?itineraryCode=SKY10SOUSOQIVGLVPBFSDUNWATIPOSOU');

  assert.deepEqual(cruise, {
    provider: 'Norwegian Cruise Line',
    id: 'ncl_SKY10SOUSOQIVGLVPBFSDUNWATIPOSOU',
    shipName: 'Norwegian Sky',
    shipClass: 'Sun',
    shipLaunchYear: 1999,
    itinerary: 'British Isles: England, Ireland & Scotland',
    departureDate: '2026-07-18',
    duration: '10-day Cruise',
    departurePort: 'Southampton, England',
    departureRegion: 'UK & Ireland',
    destination: 'Northern Europe Cruises',
    priceFrom: '999',
    currency: 'GBP',
    bookingUrl: 'https://www.ncl.com/uk/en/cruises/british-isles-test-SKY10SOUSOQIVGLVPBFSDUNWATIPOSOU?itineraryCode=SKY10SOUSOQIVGLVPBFSDUNWATIPOSOU',
    prices: { inside: null, oceanView: null, balcony: null, suite: null },
  });
});

test('uses the first visible sailing date when NCL concatenates multiple departures', () => {
  const cruise = provider.normalizeCruise({
    code: 'STAR10SOUIPOCOBDUNBFSPTRKWLABZSOQSOU',
    title: 'British Isles: England, Ireland & Scotland',
    shortTitle: 'British Isles: England, Ireland & Scotland',
    duration: { text: '10-day Cruise' },
    currency: 'GBP',
    ship: { title: 'Norwegian Star' },
    destination: { title: 'British Isles' },
    embarkationPort: { title: 'London (Southampton), United Kingdom' },
    sailings: [
      {
        departureDate: 'June,2026July,2026',
        returnDate: 'Thu 16 Sept 2027',
        staterooms: [{ combinedPrice: '1935.00' }],
      },
    ],
  }, '/uk/en/cruises/british-isles-test-STAR10SOUIPOCOBDUNBFSPTRKWLABZSOQSOU?itineraryCode=STAR10SOUIPOCOBDUNBFSPTRKWLABZSOQSOU');

  assert.equal(cruise.departureDate, 'June,2026');
});

test('extracts the cruise offer price from NCL detail-page text', () => {
  const price = provider.extractPriceFromText('Cruise Offers From £2,290 PP / GBP\nFree at Sea™ Upgrade');

  assert.equal(price, '2290');
});

test('extracts the first sailing date from NCL date-range text', () => {
  const date = provider.extractDateFromText('Sun 31 May — Thu 11 Jun 2026\nCruise Offers From £2,290 PP / GBP');

  assert.equal(date, 'Sun 31 May 2026');
});

test('extracts port names from NCL booking URL slug', () => {
  assert.deepEqual(
    provider.extractPortsFromSlug(
      'https://www.ncl.com/uk/en/cruises/7-day-caribbean-round-trip-new-orleans-cozumel-and-costa-maya-BREAKAWAY7MSYCZMRTBBZECMAMSY?itineraryCode=BREAKAWAY7MSYCZMRTBBZECMAMSY',
      'New Orleans, Louisiana'
    ),
    ['Cozumel', 'Costa Maya']
  );
});

test('extracts multiple single-word ports from NCL booking URL slug', () => {
  assert.deepEqual(
    provider.extractPortsFromSlug(
      'https://www.ncl.com/uk/en/cruises/14-day-iceland-round-trip-london-reykjavik-edinburgh-and-bergen-STAR14SOUNWHIVGR?itineraryCode=STAR14SOUNWHIVGR',
      'London (Southampton), United Kingdom'
    ),
    ['Reykjavik', 'Edinburgh', 'Bergen']
  );
});

test('returns empty array when no port names are in the booking URL slug', () => {
  assert.deepEqual(
    provider.extractPortsFromSlug(
      'https://www.ncl.com/uk/en/cruises/7-day-bermuda-round-trip-boston-BREAKAWAY7BOSWRFBOS?itineraryCode=BREAKAWAY7BOSWRFBOS',
      'Boston, Massachusetts'
    ),
    []
  );
});

test('returns empty array for "from X to Y" URL with no intermediate port stops', () => {
  assert.deepEqual(
    provider.extractPortsFromSlug(
      'https://www.ncl.com/uk/en/cruises/11-day-australia-and-new-zealand-from-sydney-to-auckland-SPIRIT11SYDQDNBWTMELORRTMUTAUAKL?itineraryCode=SPIRIT11SYDQDNBWTMELORRTMUTAUAKL',
      'Sydney, Australia'
    ),
    []
  );
});

test('builds detailed NCL itinerary from base title and port names', () => {
  assert.equal(
    provider.buildDetailedNclItinerary('Western Caribbean', ['Cozumel', 'Costa Maya']),
    'Western Caribbean: Cozumel, Costa Maya'
  );
});

test('leaves itinerary unchanged when it already contains port detail', () => {
  assert.equal(
    provider.buildDetailedNclItinerary('Iceland: Reykjavik, Edinburgh & Bergen', ['Reykjavik', 'Edinburgh', 'Bergen']),
    'Iceland: Reykjavik, Edinburgh & Bergen'
  );
});

test('returns base itinerary unchanged when no port names are available', () => {
  assert.equal(
    provider.buildDetailedNclItinerary('Bermuda', []),
    'Bermuda'
  );
});

test('normalizeCruise enriches itinerary with port names from URL slug', () => {
  const cruise = provider.normalizeCruise({
    code: 'BREAKAWAY7MSYCZMRTBBZECMAMSY',
    title: 'Western Caribbean',
    shortTitle: 'Western Caribbean',
    duration: { text: '7-day Cruise' },
    currency: 'USD',
    ship: { title: 'Norwegian Breakaway' },
    destination: { title: 'Western Caribbean' },
    embarkationPort: { title: 'New Orleans, Louisiana' },
    sailings: [{ departureDate: '2026-01-07', staterooms: [{ combinedPrice: '599.00' }] }],
  }, 'https://www.ncl.com/uk/en/cruises/7-day-caribbean-round-trip-new-orleans-cozumel-and-costa-maya-BREAKAWAY7MSYCZMRTBBZECMAMSY?itineraryCode=BREAKAWAY7MSYCZMRTBBZECMAMSY');

  assert.equal(cruise.itinerary, 'Western Caribbean: Cozumel, Costa Maya');
});

test('normalizeCruise leaves simple itinerary unchanged when URL has no intermediate ports', () => {
  const cruise = provider.normalizeCruise({
    code: 'BREAKAWAY7BOSWRFBOS',
    title: 'Bermuda',
    shortTitle: 'Bermuda',
    duration: { text: '7-day Cruise' },
    currency: 'GBP',
    ship: { title: 'Norwegian Breakaway' },
    destination: { title: 'Bermuda' },
    embarkationPort: { title: 'Boston, Massachusetts' },
    sailings: [{ departureDate: '2026-06-01', staterooms: [{ combinedPrice: '799.00' }] }],
  }, 'https://www.ncl.com/uk/en/cruises/7-day-bermuda-round-trip-boston-BREAKAWAY7BOSWRFBOS?itineraryCode=BREAKAWAY7BOSWRFBOS');

  assert.equal(cruise.itinerary, 'Bermuda');
});
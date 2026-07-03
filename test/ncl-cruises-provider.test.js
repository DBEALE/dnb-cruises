'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../providers/ncl-cruises');

test('extracts NCL cards without relying on Node-scope helpers', () => {
  const bookingUrl = 'https://www.ncl.com/uk/en/cruises/test?itineraryCode=EPIC7BCNTEST';
  const values = new Map([
    ['.c66_label', { textContent: ' 7-day Cruise  on  Norwegian Epic ' }],
    ['.c66_title', { textContent: ' Mediterranean: Nice & Florence ' }],
    ['.c66_subtitle', { textContent: ' from Barcelona, Spain ' }],
    ['.c160_date_item.-departure .c160_date_item_dateFull', { textContent: ' Sun 21 Jun 2026 ' }],
    ['.c160_date_item.-return .c160_date_item_dateFull', { textContent: ' Sun 28 Jun 2026 ' }],
    ['.c495_aside .e55_price_value', { textContent: ' £1,234 ' }],
    ['.c495_aside', { textContent: 'Cruise fare PP / GBP' }],
    ['a.btn.btn-secondary[href*="itineraryCode="]', { href: bookingUrl }],
  ]);
  const article = { querySelector: selector => values.get(selector) || null };

  assert.deepEqual(provider.extractCruiseCardsFromArticles([article]), [{
    code: 'EPIC7BCNTEST',
    bookingUrl,
    shipName: 'Norwegian Epic',
    itinerary: 'Mediterranean: Nice & Florence',
    departurePort: 'Barcelona, Spain',
    departureDate: 'Sun 21 Jun 2026',
    returnDate: 'Sun 28 Jun 2026',
    duration: '7-day Cruise',
    destination: 'Mediterranean: Nice & Florence',
    priceFrom: '1234',
    currency: 'GBP',
  }]);
});

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
          { code: 'INSIDE', title: 'Inside', combinedPrice: '999.00' },
          { code: 'OCEANVIEW', title: 'Oceanview', combinedPrice: '1099.00' },
          { code: 'BALCONY', title: 'Balcony', combinedPrice: '1299.00' },
          { code: 'MINISUITE', title: 'Club Balcony Suite', combinedPrice: '1799.00' },
          { code: 'SUITE', title: 'Suite', combinedPrice: '2299.00' },
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
    prices: { inside: '999', oceanView: '1099', balcony: '1299', suite: '1799' },
    seaDays: null,
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

test('detects round-trip NCL booking URLs', () => {
  assert.equal(
    provider.isRoundTripBookingUrl('https://www.ncl.com/uk/en/cruises/7-day-caribbean-round-trip-new-orleans-cozumel-and-costa-maya-BREAKAWAY7MSYCZMRTBBZECMAMSY'),
    true,
  );
  assert.equal(
    provider.isRoundTripBookingUrl('https://www.ncl.com/uk/en/cruises/7-day-northern-europe-from-london-to-reykjavik-akureyri-and-stavanger-STAR7SOUKWLBGOAKUISAREY'),
    false,
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

test('keeps "from X to Y" style URLs with intermediate ports intact', () => {
  assert.deepEqual(
    provider.extractPortsFromSlug(
      'https://www.ncl.com/uk/en/cruises/7-day-northern-europe-from-london-to-reykjavik-akureyri-and-stavanger-STAR7SOUKWLBGOAKUISAREY?numberOfGuests=4294949461&sortBy=closer_to_me&autoPopulate=f&from=resultpage&itineraryCode=STAR7SOUKWLBGOAKUISAREY',
      'London (Southampton), United Kingdom'
    ),
    ['Reykjavik', 'Akureyri', 'Stavanger']
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

  assert.equal(cruise.itinerary, 'Western Caribbean: Cozumel, Costa Maya, New Orleans, Louisiana');
  assert.equal(cruise.destinationPort, 'New Orleans, Louisiana');
});

test('normalizeCruise estimates sea days from the NCL slug when ports are present', () => {
  const cruise = provider.normalizeCruise({
    code: 'STAR7SOUKWLBGOAKUISAREY',
    title: 'Northern Europe: Akureyri & Stavanger',
    shortTitle: 'Northern Europe: Akureyri & Stavanger',
    duration: { text: '7-day Cruise' },
    currency: 'GBP',
    ship: { title: 'Norwegian Star' },
    destination: { title: 'Northern Europe: Akureyri & Stavanger' },
    embarkationPort: { title: 'London (Southampton), United Kingdom' },
    sailings: [{ departureDate: '2026-08-02', staterooms: [{ combinedPrice: '676.00' }] }],
  }, 'https://www.ncl.com/uk/en/cruises/7-day-northern-europe-from-london-to-reykjavik-akureyri-and-stavanger-STAR7SOUKWLBGOAKUISAREY?numberOfGuests=4294949461&sortBy=closer_to_me&autoPopulate=f&from=resultpage&itineraryCode=STAR7SOUKWLBGOAKUISAREY');

  assert.equal(cruise.seaDays, 3);
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

test('extractRoomTypePrices maps NCL stateroom labels to cabin buckets', () => {
  const prices = provider.extractRoomTypePrices({
    sailings: [{
      staterooms: [
        { code: 'INSIDE', title: 'Inside', combinedPrice: '902' },
        { code: 'OCEANVIEW', title: 'Oceanview', combinedPrice: '1126' },
        { code: 'BALCONY', title: 'Balcony', combinedPrice: '2178' },
        { code: 'MINISUITE', title: 'Club Balcony Suite', combinedPrice: '2775' },
        { code: 'SUITE', title: 'Suite', combinedPrice: '3175' },
      ],
    }],
  });

  assert.deepEqual(prices, {
    inside: '902',
    oceanView: '1126',
    balcony: '2178',
    suite: '2775',
  });
});

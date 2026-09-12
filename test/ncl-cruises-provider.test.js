'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../providers/ncl-cruises');
// Public NCL /uk/en/api/vacations/v2/search-result-itinerary/LUNA7MIAPOPSTTTOVNPIMIA
// response captured 12 Sep 2026, with images/marketing offers removed.
const lunaItinerary = require('./fixtures/ncl-luna-sailings.json');

function fakeNclBrowser({ more = false, captured = true, recoveryOk = true } = {}) {
  const state = { closed: false, requests: 0 };
  const card = { code: lunaItinerary.code, bookingUrl: 'https://www.ncl.com/uk/en/cruises/luna' };
  const page = {
    on(event, handler) {
      if (captured && event === 'response') handler({
        url: () => 'https://www.ncl.com/uk/en/api/vacations/v2/search-result-itinerary/' + card.code,
        json: async () => lunaItinerary,
      });
    },
    goto: async () => {}, waitForTimeout: async () => {}, waitForSelector: async () => {},
    $$eval: async () => [card],
    locator: () => ({ count: async () => 1 }),
    getByRole: () => ({ last: () => ({ isVisible: async () => more, evaluate: async () => {} }) }),
    waitForFunction: async () => { throw new Error('Timed out'); },
    request: { get: async () => {
      state.requests++;
      return { ok: () => recoveryOk, json: async () => lunaItinerary };
    } },
  };
  return { state, browser: { launch: async () => ({ newPage: async () => page, close: async () => { state.closed = true; } }) } };
}

test('collector expands every captured departure instead of only the first card date', async () => {
  const { state, browser } = fakeNclBrowser();
  const result = await provider.collectCruiseCards(browser);
  assert.equal(result.length, 32);
  assert.ok(result.some(c => c.bookingUrl.includes('voyageId=25337848')));
  assert.equal(state.requests, 0);
  assert.equal(state.closed, true);
});

test('collector recovers missing API details and rejects failed recovery', async () => {
  const { state, browser } = fakeNclBrowser({ captured: false });
  assert.equal((await provider.collectCruiseCards(browser)).length, 32);
  assert.equal(state.requests, 1);
  const failed = fakeNclBrowser({ captured: false, recoveryOk: false });
  await assert.rejects(provider.collectCruiseCards(failed.browser), /Could not load sailings/);
  assert.equal(failed.state.closed, true);
});

test('collector rejects incomplete pagination so a partial list cannot overwrite good data', async () => {
  const { state, browser } = fakeNclBrowser({ more: true });
  await assert.rejects(provider.collectCruiseCards(browser), /Incomplete pagination/);
  assert.equal(state.closed, true);
});

test('imports all 32 Luna departures, including 7 November 2027, with sailing-specific fares and links', () => {
  const card = { code: lunaItinerary.code, bookingUrl: 'https://www.ncl.com/uk/en/cruises/luna?itineraryCode=' + lunaItinerary.code };
  const cruises = provider.expandItineraryCard(card, lunaItinerary).map(({ detail, bookingUrl }) => provider.normalizeCruise(detail, bookingUrl));
  assert.equal(cruises.length, 32);
  assert.equal(new Set(cruises.map(c => c.id)).size, 32);
  const cruise = cruises.find(c => c.departureDate === '2027-11-07');
  assert.ok(cruise);
  assert.equal(cruise.id, 'ncl_LUNA7MIAPOPSTTTOVNPIMIA_2027-11-07');
  assert.equal(cruise.shipName, 'Norwegian Luna');
  assert.equal(cruise.arrivalDate, '2027-11-14');
  assert.equal(cruise.currency, 'GBP');
  assert.equal(cruise.priceFrom, '780');
  assert.deepEqual(cruise.prices, { inside: '780', oceanView: '935', balcony: '1165', suite: '1790' });
  const url = new URL(cruise.bookingUrl);
  assert.equal(url.pathname, '/uk/en/booking/stateroom-offers/stateroom');
  assert.equal(url.searchParams.get('voyageId'), '25337848');
  assert.equal(url.searchParams.get('itineraryCode'), lunaItinerary.code);
  assert.equal(url.searchParams.get('sailDate'), '2027-11-07');
  assert.equal(url.searchParams.get('shipCode'), 'LUNA');
  const reversed = provider.expandItineraryCard(card, { ...lunaItinerary, sailings: [...lunaItinerary.sailings].reverse() })
    .map(({ detail, bookingUrl }) => provider.normalizeCruise(detail, bookingUrl).id).sort();
  assert.deepEqual(reversed, cruises.map(c => c.id).sort(), 'IDs are independent of itinerary ordering');
});

test('does not reuse another departure or the summary card price for an unpriced sailing', () => {
  const api = { ...lunaItinerary, sailings: [
    { ...lunaItinerary.sailings[0], staterooms: [] },
    lunaItinerary.sailings[1],
  ] };
  const [empty, priced] = provider.expandItineraryCard({ code: api.code, priceFrom: '999' }, api)
    .map(({ detail, bookingUrl }) => provider.normalizeCruise(detail, bookingUrl));
  assert.equal(empty.priceFrom, '');
  assert.deepEqual(empty.prices, { inside: null, oceanView: null, balcony: null, suite: null });
  assert.notEqual(priced.priceFrom, '');
  assert.notEqual(empty.id, priced.id);
});

test('rejects invalid API dates instead of attributing other sailings to the card date', () => {
  assert.throws(() => provider.expandItineraryCard({ code: 'LUNA' }, {
    sailings: [{ departureDate: 'unknown' }],
  }), /Invalid sailing date/);
});

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
    id: 'ncl_SKY10SOUSOQIVGLVPBFSDUNWATIPOSOU_2026-07-18',
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

  assert.equal(cruise.itinerary, 'Western Caribbean: New Orleans, Louisiana, Cozumel, Costa Maya, New Orleans, Louisiana');
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

test('formatEpochDate converts NCL epoch-ms sail dates to ISO dates', () => {
  // 1787457600000 = the real STAR11 departure (midnight US-Eastern → UTC 04:00).
  assert.equal(provider.formatEpochDate(1787457600000), '2026-08-23');
  assert.equal(provider.formatEpochDate('1788408000000'), '2026-09-03');
  assert.equal(provider.formatEpochDate(0), '');
  assert.equal(provider.formatEpochDate(null), '');
  assert.equal(provider.formatEpochDate('not-a-date'), '');
});

// Regression for the reported bug: the booking-URL slug ends in "…-and-norway",
// which the slug parser turned into a "Norway" destination and, when the card
// date selector broke, left the departure date blank. The itinerary API's
// portsOfCall + epoch dates fix both at the root.
test('normalizeCruise uses the API port sequence and epoch dates over the slug', () => {
  const cruise = provider.normalizeCruise({
    code: 'STAR11SOUNWHKWLBGOAESAKUISAREY',
    title: 'Northern Europe: Iceland, Scotland & Norway',
    shortTitle: 'Northern Europe: Iceland, Scotland & Norway',
    duration: { text: '11-day Cruise' },
    currency: 'GBP',
    ship: { title: 'Norwegian Star' },
    destination: { title: 'Northern Europe Cruises' },
    embarkationPort: { title: 'London (Southampton), United Kingdom' },
    portsOfCall: [
      { code: 'SOU', title: 'London (Southampton), United Kingdom' },
      { code: 'NWH', title: 'Edinburgh (Newhaven), Scotland' },
      { code: 'KWL', title: 'Kirkwall, Orkney Isles, Scotland' },
      { code: 'BGO', title: 'Bergen, Norway' },
      { code: 'AES', title: 'Alesund, Norway' },
      { code: 'AKU', title: 'Akureyri, Iceland' },
      { code: 'ISA', title: 'Isafjordur, Iceland' },
      { code: 'REY', title: 'Reykjavik, Iceland' },
    ],
    sailings: [{
      departureDate: '2026-08-23',
      sailStartDate: '2026-08-23',
      returnDate: '2026-09-03',
      staterooms: [{ code: 'INSIDE', title: 'Inside', combinedPrice: '810' }],
    }],
  }, '/uk/en/cruises/11-day-northern-europe-from-london-to-reykjavik-iceland-scotland-and-norway-STAR11SOUNWHKWLBGOAESAKUISAREY?itineraryCode=STAR11SOUNWHKWLBGOAESAKUISAREY');

  assert.equal(cruise.departureDate, '2026-08-23', 'departure date populated from the API');
  assert.equal(cruise.arrivalDate, '2026-09-03', 'arrival date populated from the API return date');
  assert.equal(cruise.destinationPort, 'Reykjavik, Iceland', 'final port, not the trailing "Norway" slug word');
  assert.equal(cruise.seaDays, 4, '11 nights minus 8 endpoint-inclusive port calls, floored at 0');
});

test('normalizeCruise treats an API round trip as returning to the departure port', () => {
  const cruise = provider.normalizeCruise({
    code: 'RT',
    title: 'Caribbean',
    shortTitle: 'Caribbean',
    duration: { text: '7-day Cruise' },
    ship: { title: 'Norwegian Star' },
    embarkationPort: { title: 'Miami, Florida' },
    portsOfCall: [
      { code: 'MIA', title: 'Miami, Florida' },
      { code: 'CZM', title: 'Cozumel, Mexico' },
      { code: 'MIA', title: 'Miami, Florida' },
    ],
    sailings: [{ departureDate: '2026-05-02', staterooms: [{ combinedPrice: '599' }] }],
  }, '/uk/en/cruises/round-trip-RT?itineraryCode=RT');

  assert.equal(cruise.destinationPort, 'Miami, Florida');
});

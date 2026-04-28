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
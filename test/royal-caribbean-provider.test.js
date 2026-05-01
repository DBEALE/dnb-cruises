'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../providers/royal-caribbean');

const SAMPLE_CHAPTERS = [
  { days: [1], port: { name: 'Tampa', region: 'Florida' } },
  { days: [2], port: { name: 'Cruising', region: '' } },
  { days: [3], port: { name: 'George Town', region: 'Grand Cayman' } },
  { days: [4], port: { name: 'Oranjestad', region: 'Aruba' } },
  { days: [5], port: { name: 'Colón', region: 'Panama' } },
];

test('extractPortSequenceFromChapters reads ports from chapter objects', () => {
  assert.deepEqual(provider.extractPortSequenceFromChapters(SAMPLE_CHAPTERS), [
    'Tampa, Florida',
    'Cruising',
    'George Town, Grand Cayman',
    'Oranjestad, Aruba',
    'Colón, Panama',
  ]);
});

test('buildDetailedItinerary appends non-cruising stops after the summary name', () => {
  assert.equal(
    provider.buildDetailedItinerary('7 Night Southern Caribbean Cruise', [
      'Tampa, Florida',
      'Cruising',
      'George Town, Grand Cayman',
      'Oranjestad, Aruba',
      'Willemstad, Curacao',
      'Colón, Panama',
    ]),
    '7 Night Southern Caribbean Cruise: George Town, Grand Cayman, Oranjestad, Aruba, Willemstad, Curacao, Colón, Panama',
  );
});

test('parseBookingContext extracts room-selection filter fields from booking URL', () => {
  assert.deepEqual(
    provider.parseBookingContext('https://www.royalcaribbean.com/booking/landing?groupId=GR07TPA-670505416&sailDate=2026-05-02&shipCode=GR&packageCode=GR07D501&destinationCode=ISLAN&selectedCurrencyCode=USD&country=USA'),
    {
      packageCode: 'GR07D501',
      sailDate: '2026-05-02',
      selectedCurrencyCode: 'USD',
      country: 'USA',
    },
  );
});
// ─── Room-type price extraction ────────────────────────────────────────────────

test('classifyRoomType identifies inside / ocean view / balcony / suite entries', () => {
  assert.equal(provider.classifyRoomType({ id: 'X', name: 'Interior' }), 'inside');
  assert.equal(provider.classifyRoomType({ id: 'I', name: 'Inside' }), 'inside');
  assert.equal(provider.classifyRoomType({ id: 'N', name: 'Ocean View' }), 'oceanView');
  assert.equal(provider.classifyRoomType({ id: 'OV', name: 'Oceanview' }), 'oceanView');
  assert.equal(provider.classifyRoomType({ id: 'B', name: 'Balcony' }), 'balcony');
  assert.equal(provider.classifyRoomType({ id: 'S', name: 'Suite' }), 'suite');
  assert.equal(provider.classifyRoomType({ id: 'JS', name: 'Junior Suite' }), 'suite');
  assert.equal(provider.classifyRoomType({ id: 'ZZ', name: 'Unknown' }), null);
});

test('extractRoomTypePricesFromPayload reads per-class prices from sailing.stateroomClasses', () => {
  const payload = {
    sailing: {
      itinerary: { chapters: [] },
      stateroomClasses: [
        { id: 'X', name: 'Interior',   lowestPrice: { amount: 299 } },
        { id: 'N', name: 'Ocean View', lowestPrice: { amount: 449 } },
        { id: 'B', name: 'Balcony',    lowestPrice: { amount: 649 } },
        { id: 'S', name: 'Suite',      lowestPrice: { amount: 1299 } },
      ],
    },
  };
  assert.deepEqual(provider.extractRoomTypePricesFromPayload(payload), {
    inside:    '299',
    oceanView: '449',
    balcony:   '649',
    suite:     '1299',
  });
});

test('extractRoomTypePricesFromPayload returns all nulls when payload has no stateroom data', () => {
  assert.deepEqual(provider.extractRoomTypePricesFromPayload({}), {
    inside: null, oceanView: null, balcony: null, suite: null,
  });
});

test('extractRoomTypePricesFromPayload reads prices from top-level categories fallback', () => {
  const payload = {
    categories: [
      { id: 'B', name: 'Balcony', lowestPrice: { amount: 799 } },
      { id: 'S', name: 'Suite',   price:       { value:  2499 } },
    ],
  };
  const result = provider.extractRoomTypePricesFromPayload(payload);
  assert.equal(result.balcony, '799');
  assert.equal(result.suite,   '2499');
  assert.equal(result.inside,  null);
});

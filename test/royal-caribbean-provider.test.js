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
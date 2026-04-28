'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getDepartureRegion } = require('../providers/shared');

test('maps remaining Other-region ports to their proper regions', () => {
  assert.equal(getDepartureRegion('Cape Liberty'), 'Americas');
  assert.equal(getDepartureRegion('Philadelphia, Pennsylvania'), 'Americas');
  assert.equal(getDepartureRegion('Seoul (Incheon)'), 'Asia & Far East');
  assert.equal(getDepartureRegion('Baltra Island'), 'South America');
  assert.equal(getDepartureRegion('Cape Town, South Africa'), 'Africa');
  assert.equal(getDepartureRegion('Port Louis, Mauritius'), 'Africa');
});
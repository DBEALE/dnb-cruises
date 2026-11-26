'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDate, seasonStatus, filterFixtures, isValidEmail } = require('../public/rickmansworth-bowls/app.js');

const season = { year: 2027, opens: '2027-04-24', closes: '2027-09-25' };

test('formatDate renders UK-style dates with optional weekday', () => {
  assert.equal(formatDate('2027-04-24'), '24 April 2027');
  assert.equal(formatDate('2027-04-24', { weekday: true }), 'Saturday 24 April 2027');
  assert.equal(formatDate('2027-04-24', { weekday: true, year: false }), 'Saturday 24 April');
});

test('seasonStatus reports before, during and after the season', () => {
  assert.equal(seasonStatus(season, new Date(2026, 10, 26)).state, 'before');
  assert.match(seasonStatus(season, new Date(2026, 10, 26)).text, /opens on Saturday 24 April 2027/);
  assert.equal(seasonStatus(season, new Date(2027, 3, 24, 9)).state, 'open');
  assert.equal(seasonStatus(season, new Date(2027, 8, 25, 18)).state, 'open');
  assert.equal(seasonStatus(season, new Date(2027, 8, 26)).state, 'after');
});

test('filterFixtures sorts by date and filters by type', () => {
  const fixtures = [
    { date: '2027-06-01', type: 'League' },
    { date: '2027-05-01', type: 'Club' },
    { date: '2027-05-15', type: 'League' },
  ];
  assert.deepEqual(filterFixtures(fixtures, 'all').map(f => f.date), ['2027-05-01', '2027-05-15', '2027-06-01']);
  assert.deepEqual(filterFixtures(fixtures, 'League').map(f => f.date), ['2027-05-15', '2027-06-01']);
  assert.equal(fixtures[0].date, '2027-06-01', 'input is not mutated');
});

test('isValidEmail accepts normal addresses only', () => {
  assert.ok(isValidEmail('bowler@example.org'));
  assert.ok(!isValidEmail('not-an-email'));
  assert.ok(!isValidEmail(''));
});

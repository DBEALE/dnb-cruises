'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildMessages, compactCruiseLine } = require('../scripts/notify-subscribers');

function cruise(overrides = {}) {
  return {
    id: `cruise-${Math.random()}`,
    shipName: 'Celebrity Apex With A Very Long Marketing Name',
    provider: 'Celebrity Cruises',
    departureDate: '2026-07-04',
    departurePort: 'Southampton, England, United Kingdom',
    duration: '7 nights',
    priceFrom: '1299',
    currency: 'GBP',
    bookingUrl: 'https://example.test/book/this/url/should/not/be/in/whatsapp',
    ...overrides,
  };
}

test('buildMessages splits large alert batches into short Twilio-safe parts', () => {
  const cruises = Array.from({ length: 146 }, (_, index) => cruise({
    id: `match-${index}`,
    shipName: `Very Long Ship Name For Alert Splitting Regression ${index}`,
    departurePort: `Long Departure Port Name ${index}, England`,
  }));

  const messages = buildMessages(cruises, 0.7573, { safeLimit: 500, maxListed: 20 });

  assert.ok(messages.length > 1);
  assert.ok(messages.every(message => message.length <= 1600));
  assert.ok(messages[0].startsWith('Part 1/'));
  assert.ok(messages.at(-1).includes('+126 more matches in the site.'));
  assert.ok(messages.every(message => !message.includes('http')));
});

test('buildMessages keeps small alert batches compact and actionable', () => {
  const messages = buildMessages([
    cruise({ shipName: 'Arvia', provider: 'P&O Cruises' }),
    cruise({ shipName: 'Iona', provider: 'P&O Cruises', priceFrom: '899' }),
  ], 0.7573);

  assert.equal(messages.length, 1);
  assert.match(messages[0], /^Cruise alert: 2 new matches\./);
  assert.match(messages[0], /Open your saved view for booking links\./);
  assert.match(messages[0], /Reply CONTINUE to keep alerts\./);
  assert.ok(messages[0].length < 500);
});

test('compactCruiseLine converts USD prices and clips noisy fields', () => {
  const line = compactCruiseLine(cruise({
    shipName: 'A'.repeat(80),
    provider: 'Royal Caribbean International',
    departurePort: 'B'.repeat(80),
    priceFrom: '1000',
    currency: 'USD',
  }), 0, 0.75);

  assert.match(line, /^1\. A{39}\.\.\. \(Royal Caribbean Inter\.\.\.\)/);
  assert.match(line, /7N \| 4 Jul 2026 \| B{25}\.\.\. \| GBP 750 pp$/);
});

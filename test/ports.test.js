'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PORTS, resolvePort, canonicalPortName, distanceMiles, isDrivable } = require('../providers/ports');

test('resolves provider name variants to one canonical port', () => {
  for (const variant of ['Southampton, UK', 'Southampton (for London), England', 'London (Southampton), United Kingdom', 'Southampton']) {
    assert.equal(canonicalPortName(variant), 'Southampton', variant);
  }
  for (const variant of ['Fort Lauderdale, Florida', 'Ft. Lauderdale, Florida', 'Fort Lauderdale']) {
    assert.equal(canonicalPortName(variant), 'Fort Lauderdale', variant);
  }
  assert.equal(canonicalPortName('Rome (Civitavecchia), Italy'), 'Rome (Civitavecchia)');
  assert.equal(canonicalPortName('Civitavecchia (for Rome), Italy'), 'Rome (Civitavecchia)');
  assert.equal(canonicalPortName('Orlando (Port Canaveral), Florida'), 'Port Canaveral');
});

test('leaves unknown ports as their trimmed original', () => {
  assert.equal(canonicalPortName('  Nowhereville, Atlantis  '), 'Nowhereville, Atlantis');
  assert.equal(canonicalPortName(''), '');
});

test('every registry entry has coordinates and a landmass group', () => {
  assert.ok(PORTS.length >= 40);
  for (const p of PORTS) {
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), `${p.name} coords`);
    assert.ok(p.land, `${p.name} land`);
    assert.ok(Array.isArray(p.aliases) && p.aliases.length, `${p.name} aliases`);
  }
});

test('straight-line distance is roughly right', () => {
  const miami = resolvePort('Miami');
  const ftl = resolvePort('Fort Lauderdale');
  const d = distanceMiles(miami, ftl);
  assert.ok(d > 18 && d < 30, `Miami→Fort Lauderdale ~22mi, got ${d?.toFixed(1)}`);
  // Southampton to Barcelona is a long haul.
  assert.ok(distanceMiles(resolvePort('Southampton'), resolvePort('Barcelona')) > 600);
  assert.equal(distanceMiles(null, miami), null);
});

test('drivable = same landmass; different landmass needs a sea crossing', () => {
  assert.equal(isDrivable(resolvePort('Miami'), resolvePort('Fort Lauderdale')), true);
  assert.equal(isDrivable(resolvePort('Seattle'), resolvePort('Vancouver')), true);
  assert.equal(isDrivable(resolvePort('Miami'), resolvePort('Nassau')), false); // Bahamas
  assert.equal(isDrivable(resolvePort('Southampton'), resolvePort('Amsterdam')), false); // GB vs continent
  assert.equal(isDrivable(resolvePort('Valletta'), resolvePort('Rome (Civitavecchia)')), false); // Malta is an island
});

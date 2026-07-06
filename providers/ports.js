'use strict';

/**
 * Canonical port registry + geo helpers.
 *
 * Providers name the same embark/disembark port many different ways
 * ("Southampton, UK", "Southampton (for London), England", "Southampton").
 * This resolves those variants to one canonical port with coordinates and a
 * drivable-landmass group, so departure/arrival ports can be standardised and
 * compared by straight-line distance (see docs — proximity search).
 *
 * Data lives in public/ports.json so the frontend can load the same registry.
 */

const registry = require('../public/ports.json');

const PORTS = Array.isArray(registry.ports) ? registry.ports : [];

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents (Colón → colon)
    .replace(/\s+/g, ' ')
    .trim();
}

// Match a raw port string to a canonical entry via its alias substrings.
function resolvePort(raw) {
  const n = norm(raw);
  if (!n) return null;
  for (const port of PORTS) {
    if (Array.isArray(port.aliases) && port.aliases.some(alias => n.includes(alias))) return port;
  }
  return null;
}

// Standardise a raw port string to its canonical name, leaving unknown ports
// as their (trimmed) original so nothing is dropped while the registry grows.
function canonicalPortName(raw) {
  const port = resolvePort(raw);
  return port ? port.name : String(raw || '').trim();
}

const EARTH_RADIUS_MILES = 3958.8;
const toRad = deg => (deg * Math.PI) / 180;

// Straight-line (great-circle) miles between two port entries (or null).
function distanceMiles(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return null;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Two ports are drivable when they share a landmass group; otherwise the trip
// between them needs a sea crossing.
function isDrivable(a, b) {
  return Boolean(a && b && a.land && a.land === b.land);
}

module.exports = { PORTS, resolvePort, canonicalPortName, distanceMiles, isDrivable };

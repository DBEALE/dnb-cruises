'use strict';

// Same size groups as the site's SHIP_TIER_BY_CLASS filter (not ship-icon defaults).
const SIZE_CLASSES = {
  mega: ['Icon', 'Oasis'],
  large: ['Quantum', 'Voyager', 'Freedom', 'Edge', 'Breakaway', 'Breakaway Plus', 'Prima', 'Royal', 'Grand'],
  medium: ['Radiance', 'Vision', 'Lady', 'Millennium', 'Solstice', 'Jewel', 'Dawn', 'Sun', 'Epic', 'Coral'],
  small: ['Spirit', 'America', 'Galapagos'],
};

function matchesShipClasses(shipClass, value) {
  if (!value) return true;
  let choices = [String(value)];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) choices = parsed.filter(v => typeof v === 'string' && v.trim());
  } catch { /* Existing single-class saved views remain valid. */ }
  return !choices.length || choices.some(choice => {
    const normalized = choice.trim().toLowerCase();
    return normalized.startsWith('tier:')
      ? Boolean(SIZE_CLASSES[normalized.slice(5)]?.includes(shipClass))
      : String(shipClass || '').toLowerCase().includes(normalized);
  });
}

module.exports = { matchesShipClasses };

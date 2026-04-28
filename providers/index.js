'use strict';

/**
 * List of active cruise data providers.
 * To add a new provider:
 *   1. Create providers/<name>.js exporting { name, id, fetchCruises() }
 *   2. Add it to this array.
 */
const providers = [
  require('./royal-caribbean'),
  require('./celebrity-cruises'),
  // require('./msc-cruises'),
  // require('./p-and-o'),
];

module.exports = providers;

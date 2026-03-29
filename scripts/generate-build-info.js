'use strict';

/**
 * generate-build-info.js
 *
 * Writes public/build-info.json with the current UTC timestamp.
 * Run as part of the Netlify build step so that the deployed static
 * site can display when it was last built.
 */

const fs   = require('node:fs');
const path = require('node:path');

const outPath = path.join(__dirname, '..', 'public', 'build-info.json');

const info = {
  builtAt: new Date().toISOString(),
};

fs.writeFileSync(outPath, JSON.stringify(info, null, 2) + '\n');

console.log(`✓ Build info written to ${outPath} (builtAt: ${info.builtAt})`);

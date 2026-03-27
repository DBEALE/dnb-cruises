'use strict';

/**
 * Firecrawl API key integration test
 *
 * Reads the FIRECRAWL_API_KEY from netlify.toml (or the environment) and
 * verifies that:
 *   1. The key is present and has the expected format.
 *   2. The key is accepted by the Firecrawl API (live request).
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const { FirecrawlAppV1 } = require('@mendable/firecrawl-js');

/** Parse FIRECRAWL_API_KEY out of netlify.toml. */
function readKeyFromToml() {
  const tomlPath = path.join(__dirname, '..', 'netlify.toml');
  const content  = fs.readFileSync(tomlPath, 'utf8');
  const match    = content.match(/FIRECRAWL_API_KEY\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error('FIRECRAWL_API_KEY not found in netlify.toml');
  }
  return match[1];
}

// ── Test 1: key is present in netlify.toml ────────────────────────────────────

test('FIRECRAWL_API_KEY is defined in netlify.toml', () => {
  const key = readKeyFromToml();
  assert.ok(key.length > 0, 'API key must be non-empty');
  assert.match(key, /^fc-[a-f0-9]+$/, 'API key must match the fc-<hex> format');
});

// ── Test 2: key is accepted by the Firecrawl API ──────────────────────────────

test('Firecrawl API key is valid and functional', { timeout: 60_000 }, async (t) => {
  const apiKey    = process.env.FIRECRAWL_API_KEY || readKeyFromToml();
  const firecrawl = new FirecrawlAppV1({ apiKey });

  let result;
  try {
    // Scrape a lightweight, stable page to verify the key is accepted.
    result = await firecrawl.scrapeUrl('https://example.com', {
      formats: ['markdown'],
    });
  } catch (err) {
    // statusCode 0 means no response was received (network unavailable).
    // Skip the live check rather than fail so the test suite still passes in
    // offline / sandboxed environments.
    if (err.statusCode === 0) {
      t.skip('Network unavailable — skipping live Firecrawl API check');
      return;
    }
    // Any other error (e.g. 401 Unauthorized) means the key is invalid.
    throw new Error(`Firecrawl API rejected the key: ${err.message}`);
  }

  assert.ok(
    result.success,
    `Firecrawl scrape failed — the API key may be invalid or expired (error: ${result.error || 'unknown'})`,
  );
  assert.ok(
    typeof result.markdown === 'string' && result.markdown.length > 0,
    'Expected non-empty markdown content from Firecrawl',
  );
});

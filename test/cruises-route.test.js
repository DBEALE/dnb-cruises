'use strict';

/**
 * /api/cruises route tests — API key validation
 *
 * Verifies that the route handler returns HTTP 400 with a descriptive JSON
 * body when no Firecrawl API key is present.  The 400 short-circuit fires
 * before scrapeCruises is ever called, so no network access is required.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Ensure the key is absent before the app module is loaded so the
// environment-variable path in the handler is also exercised cleanly.
delete process.env.FIRECRAWL_API_KEY;

const app = require('../server.js');

let server;
let baseUrl;

before(
  () =>
    new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    }),
);

after(
  () =>
    new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
);

/** Performs a GET and resolves with { status, body }. */
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('GET /api/cruises returns 400 when no API key is provided', async () => {
  delete process.env.FIRECRAWL_API_KEY;
  const { status, body } = await get(`${baseUrl}/api/cruises`);

  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.ok(
    typeof body.error === 'string' && body.error.length > 0,
    'Response must include an error message',
  );
  assert.ok(
    typeof body.hint === 'string' && body.hint.length > 0,
    'Response must include a hint',
  );
});

test('GET /api/cruises returns 400 when X-Firecrawl-API-Key header is empty string', async () => {
  delete process.env.FIRECRAWL_API_KEY;
  const { status, body } = await get(`${baseUrl}/api/cruises`, {
    'x-firecrawl-api-key': '',
  });

  assert.equal(status, 400);
  assert.equal(body.success, false);
});

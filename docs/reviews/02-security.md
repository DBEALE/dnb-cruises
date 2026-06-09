# Security review — `dnb-cruises`

**Reviewed:** 2026-06-09
**Scope:** server.js, supabase/functions/, scripts/, public/app.js, providers/, .github/workflows/, .gitignore, alerts.json, package.json/lock, supabase/migrations
**Methodology:** Manual source review + dependency-CVE lookup. No project files were modified.

---

## Summary

The dnb-cruises project is a small, mostly static site. The frontend is the bulk of the code (2.7k lines of `app.js`) and is, on the whole, **defensively written**: an `escHtml()` helper is used consistently for scraped text, the table render path is HTML-escaped, and secrets are kept out of the repo and out of workflow logs. The high-risk code (Supabase edge functions) is small and generally safe **except** for a missing Twilio signature check that allows unauthenticated POSTs to the webhook.

The biggest problems are:

1. **No Twilio signature verification** on the WhatsApp webhook — anyone can POST to it and flip subscriptions back to `active`. (High)
2. **The frontend trusts the absolute URL computed from a scraped `bookingUrl`** and emits it into an `href` without restricting the scheme — combined with the missing rate limiting on the dev server this would matter more if the static site ever moved off GitHub Pages. (Medium)
3. **No request timeouts on the GraphQL providers** — a slow upstream can hang the scrape job indefinitely, and the providers spoof a desktop Chrome `User-Agent` to defeat provider bot detection. (Medium)

No CVEs were found in the installed versions of `cheerio@1.2.0` or `express@4.22.1` (caret-pinned to `^4.18.2`). The resolved express version is post the 2024 open-redirect / XSS-redirect fixes.

---

## Findings

Severity scale (per task spec):

- **Critical** — data loss, RCE, account takeover
- **High** — XSS, auth bypass, secret leak
- **Medium** — info disclosure, missing validation
- **Low** — best practice

### H-1 — `twilio-webhook` does not verify `X-Twilio-Signature` (auth bypass)

- **File:** `supabase/functions/twilio-webhook/index.ts:21-44`
- **Severity:** High (auth bypass on WhatsApp subscription state)
- **Evidence:**
  ```ts
  Deno.serve(async (req) => {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    // ... no signature check
    if (msgBody.includes('CONTINUE') && number) {
      await dbFetch('PATCH',
        `subscriptions?whatsapp_number=eq.${encodeURIComponent(number)}&active=eq.false`,
        { active: true });
    }
  ```
  The function accepts any POST and flips matching rows from `active=false` back to `active=true`. Twilio's `X-Twilio-Signature` header is never read, and the `Twilio` Node helper / a manual HMAC-SHA1 of `url + sorted body params` against `TWILIO_AUTH_TOKEN` is never computed.
- **Impact:** Anyone who knows or guesses a subscriber's WhatsApp number (or who replays the request with `Body=CONTINUE` and a chosen `From`) can reactivate any subscription in the `subscriptions` table. The `notify-subscribers.js` job then sends real WhatsApp messages on the next scrape cycle to any attacker-chosen number, and the user's "STOP" intent is bypassed.
- **Fix:** Verify `X-Twilio-Signature` before processing:
  1. Read the `X-Twilio-Signature` header.
  2. Concatenate `requestUrl + sorted(body params)`, HMAC-SHA1 with `TWILIO_AUTH_TOKEN` (base64-encoded), compare in constant time. Reject on mismatch (`403`).
  3. Make sure the `requestUrl` you sign is the **public** Twilio-reachable URL (the value Twilio signed), not a synthesized one.
  4. Add the `TWILIO_AUTH_TOKEN` env var to the function's secret store; the workflow at `.github/workflows/deploy-pages.yml:107` already has it.

### H-2 — `twilio-webhook` PATCH uses URL-encoded filter (not parameterized RPC) but is safe; still — PII in logs

- **File:** `supabase/functions/twilio-webhook/index.ts:37`
- **Severity:** Low (no SQLi — PostgREST is parameterized by design; but `console.log` writes the phone number in plaintext to function logs)
- **Evidence:**
  ```ts
  await dbFetch('PATCH',
    `subscriptions?whatsapp_number=eq.${encodeURIComponent(number)}&active=eq.false`,
    { active: true });
  console.log(`Reactivated subscriptions for ${number}`);
  ```
  PostgREST path filters (`?col=eq.value`) are server-side parameter binding — no SQLi risk even though the value is interpolated into the URL string. However, `console.log` and the `Error` thrown by `dbFetch` on non-2xx (`subscriptions?… → 500: {...}`) both include the raw `whatsapp_number`, which is PII.
- **Impact:** WhatsApp numbers leak into Supabase function logs, and any unhandled 5xx from PostgREST echoes them back in the thrown error. Log retention policies then become a GDPR/privacy concern.
- **Fix:**
  - Log a short hash of the number (e.g. last 4 digits) instead of the full E.164.
  - Wrap the PATCH in a typed RPC (`reactivate_subscription(phone text)`) so the value is passed as a JSON body parameter rather than a query string, and the body is masked in the error path.

### H-3 — `subscribe` function returns raw error messages to the client (info disclosure)

- **File:** `supabase/functions/subscribe/index.ts:55-62`
- **Severity:** Medium (info disclosure)
- **Evidence:**
  ```ts
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('subscribe error:', message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, ... },
    );
  }
  ```
  The function uses the service-role key and constructs DB requests against `${SUPABASE_URL}/rest/v1/subscriptions`. If PostgREST is unreachable, returns a non-2xx, or the JSON body is malformed, the entire upstream response text is included in the returned `error` field. That response text typically contains the `subscriptions` table schema (`column "x" does not exist`) and the request URL with the service key implied.
- **Impact:** A misconfigured / failing Supabase project reveals schema details (column names, table names) to anyone who can call the function. There is no auth on the function — only the `whatsappNumber` regex is checked.
- **Fix:** Return a generic `{"error":"Could not save subscription"}` to the client. Log the detailed `err.message` server-side only. Also: this function is unauthenticated and uses the service-role key (correct for write access, but there is no abuse mitigation — see M-3 below).

### M-1 — `server.js /api/cruises` re-fetches from every provider on every request and leaks the upstream error message

- **File:** `server.js:21-45`
- **Severity:** Medium (DoS + info disclosure on the dev server)
- **Evidence:**
  ```js
  app.get('/api/cruises', async (req, res) => {
    try {
      const allCruises = [];
      for (const provider of providers) {
        try {
          const cruises = await provider.fetchCruises();
          ...
        } catch (err) {
          console.error(`  ✗ ${provider.name} failed: ${err.message}`);
        }
      }
      ...
    } catch (err) {
      console.error('Error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
  ```
  Two issues in 50 lines:
  1. **No caching** — every request runs 4 providers (RC + Celebrity GraphQL, NCL Playwright headless browser, Princess Playwright). Two of them spawn Chromium, scroll 60 steps, and wait for timeouts. A few concurrent browser hits and the laptop fans up. This is a dev-only endpoint but `server.js` is the example, and `process.env.PORT || 3000` means a stray `node server.js` on a public host would be an easy DoS target.
  2. **No validation/error sanitization** — the 500 branch forwards `err.message` to the client. A provider that throws (e.g. `cheerio` with a `Cannot read property 'children' of undefined`) leaks the full stack context.
- **Impact:** Trivial DoS on a publicly reachable instance; leaking provider-internal error text.
- **Fix:** Cache the snapshot to disk (e.g. 5-minute TTL), and replace the 500 body with `{ success:false, error:"Internal error" }`. (Production already uses the static `public/providers/*/cruises.json` written by `scripts/fetch-cruises.js`, so `/api/cruises` should just stream that.)

### M-2 — No rate limiting, CORS, helmet, or request-size limits on `server.js`

- **File:** `server.js:12-45`
- **Severity:** Medium (best practice / hardening gap)
- **Evidence:** The file consists of `app.use(express.static(...))` plus one GET handler. There is no `helmet()`, no `cors()`, no `express-rate-limit`, no body-parser, no JSON size limit. A `POST /api/cruises` (or any other) would 404 silently, but a malicious client can still pound the static-file endpoint to exhaust disk I/O.
- **Impact:** Brute-force-friendly surface if the dev server is ever bound to a non-loopback interface. No `X-Content-Type-Options`, no `Referrer-Policy`, no CSP.
- **Fix:** Add `helmet()` for default security headers, `express-rate-limit` on `/api/cruises` (e.g. 30 req/min/IP), and document in a comment that the dev server should not be exposed publicly.

### M-3 — All three Supabase functions are unauthenticated; `subscribe` and `twilio-webhook` accept writes from anyone

- **Files:** `supabase/functions/subscribe/index.ts`, `supabase/functions/visitor-count/index.ts`, `supabase/functions/twilio-webhook/index.ts` (all deployed with `--no-verify-jwt` per `.github/workflows/deploy-edge-functions.yml:21-23`).
- **Severity:** Medium (the Twilio one is H-1 above; here we focus on the others)
- **Evidence:**
  - `subscribe` accepts any `+E164` number and any `criteria` JSON. There is no proof-of-control of the phone (e.g. sending a one-time code via Twilio Verify before persisting).
  - `visitor-count` rate-limits itself with the client-supplied `visitorId` UUID regex but does no challenge — an attacker can `POST` 10,000 fresh UUIDs in a loop to inflate the public counter.
  - All three functions set `Access-Control-Allow-Origin: *`, so any origin (including attacker pages) can call them.
- **Impact:** A motivated visitor can sign victims up for WhatsApp alerts (the response says `{"success": true, "id": "<uuid>"}`); a casual troll can inflate the visitor counter shown in the footer.
- **Fix:**
  - Add a CAPTCHA / Twilio Verify round-trip before persisting a subscription.
  - Add per-IP rate-limiting at the function gateway level (Supabase supports this via the dashboard).
  - For `visitor-count`, scope the counter to a salted hash of (UA + IP) server-side rather than trusting the client UUID.

### M-4 — `visitor-count` trusts a client-supplied UUID for de-duplication

- **File:** `supabase/functions/visitor-count/index.ts:33-42`
- **Severity:** Low (privacy + integrity; mild)
- **Evidence:**
  ```ts
  const { visitorId } = await req.json();
  if (!visitorId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(visitorId)) { ... }
  const rows = await dbRpc('record_site_visit', { p_visitor_id: visitorId });
  ```
  The UUID is generated client-side and stored in `localStorage`; nothing ties it to a real browser. Clearing `localStorage` (or running curl with a fresh UUID) counts as a new unique visitor. Total-visit counter only increments once per UUID per call, but with UUIDs being free, an attacker can submit 10⁵ requests with distinct UUIDs to inflate the unique-visitor count shown in the public footer.
- **Impact:** Public counter is forgeable.
- **Fix:** Issue a signed cookie from the function (e.g. HMAC the (IP, UA, day-bucket)) and verify it on subsequent calls. Or accept a UA-fingerprint hash but tie increments to a signed nonce.

### M-5 — `absoluteUrl()` in `app.js` only allows `http(s)` via `startsWith('http')` check; the rendered `href` is then put through `escHtml()` — but if the scraped `bookingUrl` is `javascript:...` or `data:...` the existing `escHtml` does NOT block those schemes

- **File:** `public/app.js:1357-1360` and `public/app.js:2736-2740`
- **Severity:** Low (the data flow is upstream-controlled by scrapers, not user-controlled; an attacker would need to compromise a provider scrape or a GitHub Action to inject the URL)
- **Evidence:**
  ```js
  const url = c.bookingUrl ? escHtml(absoluteUrl(c.bookingUrl)) : '';
  ...
  function absoluteUrl(url) {
    if (!url) return '#';
    if (url.startsWith('http')) return url;
    return 'https://www.royalcaribbean.com' + (url.startsWith('/') ? url : '/' + url);
  }
  ```
  The providers (`providers/royal-caribbean.js`, `celebrity-cruises.js`, etc.) all return URLs that start with `http`/`https` or are prefixed with `https://www.<vendor>.com` in `resolveBookingUrl()`. The frontend then escapes the URL — but a `javascript:` URL escaped into an `href` is **still executable** in older browsers / contexts. `escHtml` only encodes `& < > " '`.
- **Impact:** A scraped value (or an Action-compromised provider output) starting with `javascript:` would become a stored XSS in the `Book` link column. The trigger surface is a click on `Book` — so it requires user action — but the URL bar will show `javascript:…` only after the click.
- **Fix:** In `absoluteUrl()`, reject anything that doesn't match `^https?://`. Return `'#'` otherwise. Add a unit test that asserts `absoluteUrl('javascript:alert(1)')` returns `'#'`.

### M-6 — Scrapers send a desktop-Chrome `User-Agent` to bypass bot detection, and respect neither `robots.txt` nor per-request timeouts

- **Files:** `providers/graphql-cruise-provider.js:53`, `providers/royal-caribbean.js:292`, `providers/celebrity-cruises.js:500/527`, `providers/princess-cruises.js:392`, `providers/ncl-cruises.js` (Playwright), `scripts/fetch-ship-wiki-links.js:44`
- **Severity:** Medium (legal/ToS exposure, not a direct technical vulnerability)
- **Evidence:** All HTTP providers set `user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36` and Princess/NCL additionally use `--disable-blink-features=AutomationControlled`. The GraphQL providers have **no `AbortController` / no `signal`** on the `fetch` call, so a slow upstream hangs the scrape for the full `requestDelayMs × pages` budget. There is no `robots.txt` check.
- **Impact:**
  - Misrepresentation of the scraper to the providers (ToS risk: RC, Celebrity, Princess, NCL all have anti-scraping clauses).
  - A slow / hung upstream blocks the entire workflow run (the GitHub Action is on a 2-hour cron, so a 30-minute hang in one provider blocks notify-subscribers step).
  - No retry budget means a transient 5xx causes the whole provider to be skipped silently.
- **Fix:**
  - Use a unique, honest `User-Agent` (`dnb-cruises/1.0 (+contact)`) and add `Accept` and `Accept-Language` headers — most CDNs allow identified bots.
  - Wrap each `fetch` with `AbortSignal.timeout(20_000)`.
  - Honor `robots.txt` for the Wikipedia fetcher at minimum.
  - Move the provider HTTP layer into a shared helper so the timeouts are uniform.

### M-7 — `notify-subscribers.js` writes the subscriber's WhatsApp number to the workflow log on failure

- **File:** `scripts/notify-subscribers.js:179`
- **Severity:** Low
- **Evidence:**
  ```js
  console.error(`  ✗ Failed for ${sub.whatsapp_number}: ${err.message}`);
  ```
  Plus the same for every successful send: `console.log(\`  ✓ Sent to ${sub.whatsapp_number}\`)`. Twilio's API returns 4xx error bodies that can include the number too.
- **Impact:** PII in GitHub Actions logs (visible to anyone with repo read, retained 90 days by default).
- **Fix:** Print only the masked last-4 of the number in CI logs. The successful-send log can be dropped entirely.

### L-1 — `.gitignore` does not cover Supabase env files

- **File:** `.gitignore` (10 lines)
- **Severity:** Low
- **Evidence:** Only `.env` is ignored. The Supabase CLI writes `supabase/.branches/`, `supabase/.temp/`, and `supabase/.env.local` for local function development. None are ignored.
- **Impact:** Risk of accidentally committing a developer's local Supabase credentials if they ever copy `.env` next to the project.
- **Fix:** Append:
  ```
  supabase/.branches/
  supabase/.temp/
  supabase/.env*
  ```

### L-2 — `package.json` uses caret ranges for `cheerio` and `express`

- **File:** `package.json:14-17`
- **Severity:** Low
- **Evidence:** `"cheerio": "^1.2.0"`, `"express": "^4.18.2"`. Currently `package-lock.json` resolves to `cheerio@1.2.0` and `express@4.22.1`, both clean. A fresh `npm install` (no lockfile) could float to a future major with a breaking change or a CVE that hasn't been patched in 4.x yet.
- **Impact:** Reproducibility and supply-chain drift.
- **Fix:** Pin to exact versions, or add Renovate / Dependabot to keep the lockfile fresh and the caret range tight.

### L-3 — `deploy-pages.yml` reuses the same `GITHUB_TOKEN` to push to a `data` branch from a Pages workflow

- **File:** `.github/workflows/deploy-pages.yml:63-99`
- **Severity:** Low
- **Evidence:** The `Persisit data snapshot to 'data' branch` step uses `secrets.GITHUB_TOKEN` to push the snapshot. The workflow has `contents: write`, which is broader than needed for a single-branch commit.
- **Impact:** A compromised step (e.g. via a malicious provider scrape that lands a file named something the workflow `git add`s) could push arbitrary content to `data` (or `main`, since `contents: write` is global). A tighter scope would be a dedicated fine-grained PAT limited to the `data` branch, or use `pull-requests: write` to open a PR to `data` instead of pushing.
- **Fix:** Generate a fine-grained PAT with `contents: write` scoped to the `data` branch only, and store it as `SECURITY_REVIEW_DATA_BRANCH_TOKEN`. Use that token in this single step and drop the workflow-level `contents: write`.

### L-4 — `app.js` `SITE_CHANGES` and `sub-options` arrays are static; no `eval` / `new Function` / `document.write` is used. XSS surface is well-controlled

- **File:** `public/app.js:54-352` (constant), `public/app.js:440-484` (DOM injection)
- **Severity:** None (positive finding)
- **Evidence:** The 13 `innerHTML` write sites in `app.js` are all either:
  - Built from a static template + `escHtml()`'d scraped values (e.g. line 1369-1386 table render, line 1849-1856 saved-view list), or
  - Constants rendered with `escHtml()` (line 1622-1629 site changes, line 1802 mobile saved-views dropdown).
  No `document.write`, no `eval`, no `new Function`, no `insertAdjacentHTML` with untrusted data. The `summary` line at 2481 is the only un-escaped `innerHTML` write — its content is built from `capped.length.toLocaleString()` (numeric), `filterSummary` (a derived string of filter values, all numeric or already-escaped via `escHtml(label)`), and a literal button — so the injection surface is also closed.
- **Action:** None. Keep the `escHtml` discipline in future contributions.

---

## Dependency CVE check

Resolved versions per `package-lock.json`:

- `cheerio@1.2.0` — no direct vulnerabilities reported in Snyk / GitHub Advisory as of 2026-06-09.
- `express@4.22.1` — post-fix for **CVE-2024-29041** (open redirect) and **CVE-2024-43796** (XSS via `response.redirect()`). Both fixed in 4.19.2 / 4.20.0. The caret-pinned `^4.18.2` could in theory float down on a `rm package-lock.json && npm install`, but with the lockfile intact the resolved version is clean.
- `@playwright/test@1.59.1` — no direct CVEs at the time of writing.
- `jimp@1.6.1` — no direct CVEs.

---

## What the project does **right**

- `escHtml` is applied to every scraped string before it reaches `innerHTML` (lines 440, 441, 466, 469, 954, 995, 1013, 1031, 1219, 1232, 1235, 1236, 1376-1385, 1451, 1455, 1459, 1477, 1498, 1504, 1520, 1625-1627, 1798, 1839-1856, etc.). No `document.write`, no `eval`, no `new Function`.
- All outbound anchors are emitted with `rel="noopener noreferrer" target="_blank"` (line 831, 997, 1014, 1359).
- Workflows declare `permissions:` blocks with the minimum they need (deploy-on-push is `contents: read` + `pages: write` + `id-token: write`). The `deploy-pages.yml` is the only one with `contents: write` and that's the legitimate exception for the data-branch push.
- The `data-branch` push is wrapped in `set -euo pipefail` and uses `git diff --cached --quiet` to avoid empty commits.
- `package-lock.json` is committed, which pins resolved versions.
- `.gitignore` ignores `.env`, `public/build-info.json`, the cruise JSON snapshots, and `test-results/`.
- The price-history dialog (lines 1409-1411) and site-changes dialog (line 1622) both use `escHtml` on every interpolated value.
- `twilio-webhook` uses the service-role key for the PATCH and uses `encodeURIComponent` on the phone number (line 36) — no SQLi, even though the filter is in the URL.

---

## Recommended priority

1. **H-1** — Add Twilio signature verification (one afternoon of work, fixes the only critical-class issue).
2. **M-1, M-2** — Harden the dev server (rate limit, helmet, no upstream-error leak). Even if the server is dev-only, the same Express pattern is likely to be copy-pasted later.
3. **M-3** — Add basic per-IP rate limiting + (ideally) a Twilio Verify round-trip to the `subscribe` function.
4. **M-5, M-6** — `absoluteUrl` scheme allowlist + per-request timeouts in the providers.
5. Everything else (L-*, H-2) is small-but-good-hygiene work.

No project files were modified. This report is the only deliverable.

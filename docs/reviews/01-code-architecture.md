# Code Quality & Architecture Review — dnb-cruises

**Reviewed:** 2026-06-09
**Scope:** `server.js`, `providers/**`, `scripts/**`, `supabase/functions/**`, `test/**`, `playwright.config.cjs`, `package.json`
**Method:** Read-only inspection. No project files were modified.

---

## Summary

The codebase is well-tested (unit + e2e + VM-sandboxed frontend tests) and
the per-provider `normalizeCruise` outputs are consistent enough that the
frontend can treat them as one schema. However, there is substantial
duplication between `royal-caribbean.js` and `celebrity-cruises.js` (the
two providers built on the shared RCI room-selection/GraphQL APIs), a
misnamed `package.json` script that does **not** invoke the real scraper,
no documented provider contract, and several instances of silently
swallowed errors in production HTTP paths.

This review proposes targeted, minimal fixes — no architectural rewrites.

---

## Findings

### F-1 — `package.json` `cruises:pull` runs the *wrong* script [High]

- **File:** `package.json:10`
- **Evidence:**

```json
"cruises:pull": "node scripts/fetch-live-cruise-data.js",
```

- **Description:** The script `cruises:pull` resolves to
  `scripts/fetch-live-cruise-data.js`, which only re-downloads the
  already-deployed `cruises.json` files from GitHub Pages. It does **not**
  call any provider or trigger a real scrape. The actual scraper entry
  point is `scripts/fetch-cruises.js` — used by `.github/workflows/deploy-pages.yml:55`
  but missing from `package.json`. A developer running `npm run cruises:pull`
  to do a local pull will be confused when no providers are called.
- **Fix:**
  1. Add a real "scrape locally" npm script:
     ```json
     "cruises:pull": "node scripts/fetch-cruises.js",
     ```
  2. If the intent is to expose both operations, rename:
     ```json
     "scrape:local":   "node scripts/fetch-cruises.js",
     "scrape:hydrate": "node scripts/fetch-live-cruise-data.js"
     ```
  Pick the option that matches the developer's mental model; do not ship a
  misnamed alias.

---

### F-2 — `cleanText` re-defined in 4 of 5 providers [High]

- **Files:**
  - `providers/shared.js:23` (canonical)
  - `providers/royal-caribbean.js:118`
  - `providers/celebrity-cruises.js:127`
  - `providers/princess-cruises.js:93`
  - `providers/ncl-cruises.js:60`
- **Description:** All four provider files declare an identical
  `cleanText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }`.
  Only the canonical version in `shared.js` is exported; the others are
  duplicates that drift independently. `cleanText` is also re-implemented
  inside NCL's `$$eval` callback at `ncl-cruises.js:420`.
- **Fix:** Import from `shared.js` in every provider, then delete the
  local copies. Add `cleanText` to `module.exports` in `shared.js`
  alongside `getDepartureRegion` / `estimateSeaDays`.

---

### F-3 — Royal Caribbean and Celebrity Cruises share a huge
  duplicated module (~250 LOC) [Critical]

- **Files:**
  - `providers/royal-caribbean.js:118–334` vs
  - `providers/celebrity-cruises.js:127–391`
- **Duplicated symbols** (line ranges in RC first, Celebrity second):
  | Symbol | RC | Celebrity |
  |---|---|---|
  | `cleanText` | 118–120 | 127–129 |
  | `parseBookingContext` | 150–171 | 231–248 |
  | `formatChapterPort` | 173–180 | 250–257 |
  | `extractPortSequenceFromChapters` | 182–188 | 260–263 |
  | `buildRoomSelectionFilter` | 190–201 | 283–294 |
  | `classifyRoomType` | 211–220 | 329–338 |
  | `extractPriceFromEntry` | 229–235 | 346–351 |
  | `extractRoomTypePricesFromPayload` | 244–265 | 359–379 |
  | `extractPricesFromClassPricing` | 267–277 | 381–391 |
  | `fetchRoomSelectionData` | 279–303 | 487–511 |
  | `fetchRoomSelectionPorts` (deprecated) | 305–309 | 550–554 |
  | `enrichCruiseItinerary` worker loop | 399–436 | 650–687 |
- **Description:** Both providers target the same backend (RCI's
  `cruiseSearch` GraphQL endpoint + the `/room-selection/api/v1/rooms`
  REST endpoint). The only real differences are:
  1. URL host (`www.royalcaribbean.com` vs `www.celebritycruises.com`).
  2. Booking-URL query-param names (`packageCode` vs `pID`).
  3. RC provider fetches one GraphQL path; Celebrity fetches the same
     path but injects extra Apollo headers.

  This means the room-selection enrichment pipeline is essentially
  copy-pasted, and any fix has to be applied twice.
- **Fix:** Extract a `providers/rci-room-selection.js` module exporting
  the 9 duplicated helpers (parameterized only on the two hosts /
  query-param aliases). The two provider files then import and pass a
  small `hostConfig` object. Concretely:
  ```js
  // providers/rci-room-selection.js
  module.exports = function createRciRoomSelection({ host, bookingParamAliases, roomApiBrand }) {
    return {
      parseBookingContext(url) { /* uses bookingParamAliases */ },
      fetchRoomSelectionData(ctx) { /* uses host, roomApiBrand */ },
      enrichCruiseItinerary(cruise, fetcher) { /* shared worker */ },
      // ...
    };
  };
  ```
  Keep the existing per-provider test files (they will still exercise
  the per-provider `parseBookingContext`); they will now hit the shared
  module via a thin re-export.

---

### F-4 — `parseBookingContext` differs only in query-param names
  [Medium]

- **Files:** `royal-caribbean.js:150–171` vs `celebrity-cruises.js:231–248`
- **Description:** Both extract `packageCode`, `sailDate`, `country`, and
  a currency. RC reads `packageCode` / `sailDate`; Celebrity reads
  `packageCode | pID` and `sailDate | sDT` (with fallbacks). The rest of
  the shape is identical. See F-3 for the recommended consolidation.
- **Fix:** Same as F-3 — fold into the shared module with a
  `paramAliases` config:
  ```js
  { packageCode: ['packageCode', 'pID'], sailDate: ['sailDate', 'sDT'] }
  ```

---

### F-5 — `cleanText`, `buildDetailedItinerary`,
  `extractPortSequenceFromChapters`, `formatChapterPort` duplicated
  verbatim in RC and Celebrity [High]

- **Files:**
  - `royal-caribbean.js:118, 139–148, 173–188`
  - `celebrity-cruises.js:127, 272–281, 250–263`
- **Description:** These four helpers are byte-identical (or trivially
  identical apart from whitespace) in the two files. `buildDetailedItinerary`
  is also re-implemented in `ncl-cruises.js:205–212` under the name
  `buildDetailedNclItinerary` with a slightly different signature.
- **Fix:** Move `cleanText`, `buildDetailedItinerary`,
  `formatChapterPort`, and `extractPortSequenceFromChapters` into
  `shared.js`. In NCL, replace the bespoke
  `buildDetailedNclItinerary` with a thin wrapper that calls
  `buildDetailedItinerary(baseItinerary, ports, { alreadyHasPorts: baseItinerary.includes(':') })`,
  or accept the NCL test expectations as a contract by adding a flag.

---

### F-6 — Mozilla user-agent string hard-coded in 5 places
  (and 2 Chrome versions) [Low]

- **Files:**
  - `providers/graphql-cruise-provider.js:53` (Chrome/124.0.0.0)
  - `providers/royal-caribbean.js:292` (Chrome/124.0.0.0)
  - `providers/celebrity-cruises.js:500` (Chrome/124.0.0.0)
  - `providers/celebrity-cruises.js:527` (Chrome/124.0.0.0)
  - `providers/princess-cruises.js:392` (Chrome/131.0.0.0)
- **Description:** The same User-Agent string is duplicated and two
  different Chrome versions are in use. When the user-agent must be
  rotated after a provider change, every site must be hunted down.
- **Fix:** Export a single `DEFAULT_USER_AGENT` constant from
  `shared.js` (or a new `providers/http.js`) and import it in all five
  locations. Pick one Chrome version (the newer one, 131.0.0.0, is what
  Princess uses — that should be the canonical one).

---

### F-7 — `randomUUID` imported but unused in
  `graphql-cruise-provider.js` AND in `celebrity-cruises.js` [Low]

- **Files:**
  - `providers/graphql-cruise-provider.js:3` — imported and used at
    line 56 in the base class's `buildRequestHeaders()`. **This import
    IS used.**
  - `providers/celebrity-cruises.js:4` — imported but **never used** in
    this file (Celebrity extends `GraphQLCruiseProvider` and inherits the
    usage; it does not call `randomUUID` itself).
- **Fix:** Remove the dead import in `celebrity-cruises.js:4`.
  (No change needed in `graphql-cruise-provider.js`.)

---

### F-8 — No timeouts on any outbound `fetch()` [High]

- **Files (excerpt):**
  - `providers/royal-caribbean.js:286–294` — `fetchRoomSelectionData`
  - `providers/celebrity-cruises.js:494–502` — `fetchRoomSelectionData`
  - `providers/celebrity-cruises.js:523–529` — `fetchRoomSelectionPagePrice`
  - `scripts/notify-subscribers.js:34–48` — Twilio
  - `scripts/notify-subscribers.js:15–24` — Supabase REST
  - `scripts/fetch-cruises.js:256` — Resend email
  - `scripts/fetch-cruises.js:312–314` — open.er-api.com
  - `scripts/fetch-live-cruise-data.js:30, 36` — `fetchJson`,
    `fetchToFile`
  - `scripts/fetch-ship-wiki-links.js:43, 122` — Wikipedia
  - `supabase/functions/subscribe/index.ts:11`
  - `supabase/functions/visitor-count/index.ts:11`
  - `supabase/functions/twilio-webhook/index.ts:5`
- **Description:** None of the outbound `fetch` calls set an `AbortSignal`
  with a timeout. When an upstream provider is slow or hangs, the
  `enrichCruiseItinerary` worker pool (`royal-caribbean.js:399–436` and
  `celebrity-cruises.js:650–687`) will block indefinitely on the slowest
  cruise, defeating its concurrency=6 design. In CI, a hung
  `https://www.royalcaribbean.com` request will fail the whole
  deploy-pages workflow.
- **Fix:** Add a single helper, e.g. in `providers/shared.js`:
  ```js
  function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  }
  ```
  Replace the `fetch(...)` calls listed above with `fetchWithTimeout(...)`.
  Apply the same pattern to scripts. (`AbortSignal.timeout` is available
  on Node ≥ 17.3, which is satisfied by `engines.node: ">=18.0.0"` in
  `package.json:18–20`.)

---

### F-9 — Errors silently swallowed in `enrichCruiseItinerary`
  [High]

- **Files:**
  - `providers/royal-caribbean.js:336–357` — `enrichCruiseItinerary`
    wraps the call in `try { … } catch { return cruise; }` (line 354) —
    the error is discarded.
  - `providers/celebrity-cruises.js:556–594` — same pattern at line 591.
  - `providers/ncl-cruises.js:323–338` — `extractPriceFromBookingPage`
    catches and returns `''` (line 333). `extractDateFromBookingPage`
    does the same at line 350.
  - `scripts/fetch-cruises.js:312–315` — exchange-rate `fetch` is wrapped
    in a bare `catch {}` (line 315), and the default `0.79` is silently
    used on failure.
  - `scripts/notify-subscribers.js:135–139` — same `0.79` fallback.
- **Description:** Silent failures make the scraper's behaviour opaque:
  when a provider returns empty data because every enrichment request
  failed, the operator has no way to know why. There is no log message
  at all in the `catch` blocks.
- **Fix:** For each `catch {}` that is intentionally defensive, at minimum
  log a single line at `console.warn`/`console.error` level:
  ```js
  } catch (err) {
    console.warn(`  [Royal Caribbean] room-selection fetch failed for ${context.packageCode}: ${err.message}`);
    return cruise;
  }
  ```
  When the *expected* behaviour is "carry on with a default", keep the
  fallback but log a one-liner. This is a documentation/diagnosability
  fix, not a logic change.

---

### F-10 — The two providers' `enrichCruiseItinerary` cache+worker
  loop is a near-perfect copy [High]

- **Files:**
  - `providers/royal-caribbean.js:399–436` (38 lines)
  - `providers/celebrity-cruises.js:650–687` (38 lines)
- **Description:** Both define a `concurrency = 6` constant, a `worker`
  closure using a shared `cursor`, a `Map<cacheKey, Promise>` cache, and
  await `Promise.all(Array.from({ length: concurrency }, () => worker()))`.
  The only differences are:
  1. The `progressPrefix` interpolation in the success log.
  2. The exact `enrichCruiseItinerary` function it calls.
- **Fix:** Add a generic helper to `shared.js`:
  ```js
  async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await mapper(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
  }
  ```
  Combined with the per-`bookingUrl` cache, this collapses each
  provider's `fetchCruises()` enrichment block to ~10 lines.

---

### F-11 — Provider API contract is undocumented; the registry
  comment is misleading [High]

- **File:** `providers/index.js:3–8`
- **Evidence:**

```js
/**
 * List of active cruise data providers.
 * To add a new provider:
 *   1. Create providers/<name>.js exporting { name, id, fetchCruises() }
 *   2. Add it to this array.
 */
```

- **Description:** The comment documents the *registration contract* but
  not the *output contract*. The 4 actual providers do not all export
  the same shape:

  | Field | RC | Princess | Celebrity | NCL |
  |---|---|---|---|---|
  | `module.exports` | provider instance | provider instance | provider instance | provider instance |
  | `provider.id` | `'royal-caribbean'` | `'princess-cruises'` | `'celebrity-cruises'` | `'ncl-cruises'` |
  | `provider.name` | `'Royal Caribbean'` | `'Princess Cruises'` | `'Celebrity Cruises'` | `'Norwegian Cruise Line'` |
  | `provider.fetchCruises()` | ✅ | ✅ | ✅ | ✅ |

  All four set `name` and `id` in the constructor / initializer (good).
  However:
  - `celebrity-cruises.js:604–704` extends `GraphQLCruiseProvider` but
    re-attaches 10 helper functions to the instance via
    `provider.foo = foo` (lines 692–702). This pattern only works for
    tests, not for normal usage.
  - `royal-caribbean.js:441–447` does the same (re-attaches 6 helpers).
  - `ncl-cruises.js:562–570` re-attaches 9 helpers, **but also**
    re-exports `collectCruiseCards` and others as module-level
    properties.

  There is no JSDoc on the `fetchCruises()` return value, no documented
  minimum required keys, and no documented optional fields.
- **Fix:** Replace the comment in `providers/index.js` with a contract
  block:

  ```js
  /**
   * List of active cruise data providers.
   *
   * A provider module (`providers/<name>.js`) must export an instance
   * that satisfies the following duck-typed contract:
   *
   *   { id: string, name: string, fetchCruises(): Promise<NormalizedCruise[]> }
   *
   * `NormalizedCruise` keys (all strings unless noted):
   *   provider, id, shipName, shipClass, shipLaunchYear (number|null),
   *   itinerary, departureDate, duration, departurePort,
   *   departureRegion, destination, priceFrom, currency,
   *   bookingUrl, prices: { inside, oceanView, balcony, suite } (each
   *   string|null), and optionally `seaDays` (number|null).
   *
   * To add a new provider:
   *   1. Create providers/<name>.js exporting the instance above.
   *   2. Add it to the `providers` array below.
   */
  ```

  This is documentation, not refactor. It also gives the next provider
  author a checklist to validate against.

---

### F-12 — `parseBookingContext` is re-attached to the provider
  instance on every require [Medium]

- **Files:**
  - `providers/royal-caribbean.js:441–447`
  - `providers/celebrity-cruises.js:692–702`
  - `providers/ncl-cruises.js:562–570`
  - `providers/princess-cruises.js:655–666`
- **Description:** Each provider does
  `module.exports = new XProvider();` then `module.exports.fn = fn;` to
  expose helpers for testing. The test files use these as
  `provider.normalizeCruise(...)` and
  `provider.extractPortSequenceFromChapters(...)`. The pattern is brittle
  (re-assignment after `module.exports = ...` works but is non-obvious)
  and not type-checked.
- **Fix:** Either (a) leave the helpers as module-level exports and
  have the test files import them directly (e.g.
  `const { normalizeCruise } = require('../providers/royal-caribbean');`),
  or (b) consolidate per F-3 and have the tests target the consolidated
  module. Option (a) is the smaller change.

---

### F-13 — `buildGraphRequestBody` in `celebrity-cruises.js` is
  dead code [Medium]

- **File:** `providers/celebrity-cruises.js:75–85`
- **Description:** The function is defined but never called. The
  Celebrity provider extends `GraphQLCruiseProvider` and uses the
  base-class `buildRequestBody` (which calls `buildRequestVariables`,
  which Celebrity overrides) — the local `buildGraphRequestBody` is
  superseded.
- **Fix:** Delete `providers/celebrity-cruises.js:75–85`. Tests in
  `test/celebrity-cruises-provider.test.js` do not reference it.

---

### F-14 — `randomUUID` is imported in `celebrity-cruises.js` but
  never used locally [Low]

- **File:** `providers/celebrity-cruises.js:4`
- **Description:** `const { randomUUID } = require('node:crypto');` is
  imported but never referenced in this file. The `x-session-id` header
  is generated by the inherited `GraphQLCruiseProvider` (line 56 of
  `graphql-cruise-provider.js`).
- **Fix:** Delete line 4 of `celebrity-cruises.js`.

---

### F-15 — The `RclCruisesProvider` and `CelebrityCruisesProvider`
  cacheKey tuple is identical and the worker code is too [High]

- **Files:** `providers/royal-caribbean.js:413–415` and
  `providers/celebrity-cruises.js:663–665`
- **Description:**
  ```js
  // Both files
  const cacheKey = context
    ? `${context.packageCode}|${context.sailDate}|${context.selectedCurrencyCode}|${context.country}`
    : null;
  ```
- **Fix:** Folds into F-3 / F-10: when the room-selection helpers are
  shared, the cache key derivation lives next to the cache, in
  `rci-room-selection.js`.

---

### F-16 — `server.js` re-implements the same scrape orchestrator
  pattern as `scripts/fetch-cruises.js` [Medium]

- **Files:**
  - `server.js:21–45` — `/api/cruises` endpoint
  - `scripts/fetch-cruises.js:292–391` — `main()`
- **Description:** Both iterate over `providers`, call
  `provider.fetchCruises()`, accumulate results, and log per-provider
  progress. The two have slightly different error semantics
  (`server.js` swallows errors and returns a 200 with the partial list;
  `scripts/fetch-cruises.js` uses `Promise.allSettled` and continues).
  The duplication is small (~10 LOC each) but the inconsistency is what
  matters: the live API and the static JSON can disagree on which
  providers are working at a given moment.
- **Fix:** Extract a `runAllProviders(providers, { onProgress })` helper
  in a new `lib/scrape-orchestrator.js` (or add it to `providers/index.js`).
  Both `server.js` and `scripts/fetch-cruises.js` consume it.
  Behaviour for both call sites should converge on the `Promise.allSettled`
  semantics (i.e. partial success).

---

### F-17 — Hard-coded `https://www.royalcaribbean.com` fallback URLs
  in scripts [Medium]

- **Files:**
  - `scripts/fetch-cruises.js:200–201` — builds an alert email booking
    link:
    ```js
    const bookLink = c.bookingUrl
      ? (c.bookingUrl.startsWith('http') ? c.bookingUrl : 'https://www.royalcaribbean.com' + c.bookingUrl)
      : 'https://www.royalcaribbean.com/gbr/en/cruises';
    ```
  - `scripts/notify-subscribers.js:111–112` — same pattern for the
    WhatsApp message:
    ```js
    const book = c.bookingUrl
      ? (c.bookingUrl.startsWith('http') ? c.bookingUrl : `https://www.royalcaribbean.com${c.bookingUrl}`)
      : 'https://www.royalcaribbean.com/gbr/en/cruises';
    ```
- **Description:** These fallback URLs assume the cruise is a Royal
  Caribbean sailing. Other providers (NCL, Celebrity, Princess) also
  write `bookingUrl` values to `cruises.json`; if any of them ever
  returns a relative path, the alerts will silently link to a wrong
  site. The NCL and Celebrity providers always return absolute URLs
  (`ncl-cruises.js:380` `resolveUrl`, `celebrity-cruises.js:138` and
  `218`), so the bug is latent today but the code is brittle.
- **Fix:** Replace with a single `resolveBookingUrl(cruise, { providerDefaultHost })`
  helper, ideally one that already exists in the provider modules (RC
  and Celebrity already export `resolveBookingUrl`; see F-12). Or
  delete the relative-path branch entirely since the providers already
  return absolute URLs.

---

### F-18 — `graphql-cruise-provider.js` `origin` / `referer`
  getters are dead code [Low]

- **File:** `providers/graphql-cruise-provider.js:62–69`
- **Description:**
  ```js
  get origin()  { return ''; }
  get referer() { return ''; }
  ```
  The base class never sets `this.origin` / `this.referer`, so the
  getters always return `''`. The base `buildRequestHeaders()` reads
  `this.origin` and `this.referer` (lines 54–55) and emits empty
  strings into the request. Royal Caribbean sets
  `requestHeaders: { origin, referer }` directly via spread, and
  Celebrity does the same. The getters are never invoked.
- **Fix:** Delete the two getters and the corresponding `this.origin` /
  `this.referer` reads in `buildRequestHeaders`. Use
  `requestHeaders.origin` / `requestHeaders.referer` only.

---

### F-19 — `GraphQLCruiseProvider` is the right abstraction but is
  only used by 2 of 4 providers [Medium]

- **File:** `providers/graphql-cruise-provider.js` (whole file)
- **Description:** The class provides paginated GraphQL fetching with
  retry, dedupe, and rate limiting. Royal Caribbean and Celebrity use
  it; Princess and NCL do not (Princess uses Playwright interception,
  NCL uses Playwright DOM scraping). The abstraction is **earned for
  RC+Celebrity** — the two implementations would otherwise duplicate
  the pagination + retry + dedupe logic — but Princess and NCL are
  different shapes of provider and shouldn't be forced to inherit it.
- **Fix:** None required for the abstraction itself, but rename to make
  the scope clearer: `RciGraphQLCruiseProvider` (since the only two
  consumers are Royal Caribbean International properties). Or add a
  JSDoc at the top of the class file documenting the two consumers.

---

### F-20 — `assertion` `country` default in `parseBookingContext`
  differs between providers [Low]

- **Files:**
  - `providers/royal-caribbean.js:158` — `|| 'USA'`
  - `providers/celebrity-cruises.js:240` — `|| 'GBR'`
- **Description:** The `country` default fallback differs by provider
  (RC defaults to `'USA'`, Celebrity to `'GBR'`). This is intentional
  (the two sites' default geographies differ), but the difference is
  undocumented and easy to misread as a bug.
- **Fix:** Add a one-line JSDoc on each `parseBookingContext` explaining
  the default, or — once F-3 is applied — pass the default via the
  `hostConfig` object.

---

### F-21 — `ARCHIVE_RETENTION_MS` uses a magic constant for
  retention policy [Low]

- **File:** `scripts/fetch-cruises.js:64`
- **Description:**
  ```js
  const ARCHIVE_RETENTION_MS = 2 * 365.25 * 24 * 60 * 60 * 1000;
  ```
  The constant is well-named and has a clarifying comment, but the
  `2 * 365.25 * …` form is hard to scan. Consider:
  ```js
  const DAYS_PER_YEAR = 365.25;
  const ARCHIVE_RETENTION_DAYS = 2 * DAYS_PER_YEAR;
  const ARCHIVE_RETENTION_MS   = ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  ```
  (Minor, optional.)

---

### F-22 — `Alert` matching logic is duplicated between
  `scripts/fetch-cruises.js` and `scripts/notify-subscribers.js`
  [Medium]

- **Files:**
  - `scripts/fetch-cruises.js:172–187` — `matchesAlert`
  - `scripts/notify-subscribers.js:72–94` — `matchesCriteria`
- **Description:** Both implement essentially the same filter set
  (`shipName`, `provider`, `shipClass`, `minLaunch`, `itinerary`,
  `destination`, `departureDate`, `departurePort`, `departureRegion`,
  `duration`/`minNights`, `maxPrice`/`maxPriceUSD`). They diverge on
  field naming (`minNights` vs `duration`, `maxPriceUSD` vs `maxPrice`)
  and on the price-currency conversion (only the WhatsApp path
  converts USD→GBP). The two functions are the same conceptual filter
  applied at two stages of the pipeline.
- **Fix:** Move `matchesCriteria` to a new `lib/cruise-filters.js` (or
  `scripts/lib/cruise-filters.js`) and have both scripts import it.
  The two filter "shapes" should converge to a single
  `criteria` object, normalised at the script boundary.

---

### F-23 — `notify-subscribers.js` USD→GBP conversion and the
  frontend's conversion can disagree [Medium]

- **Files:**
  - `scripts/notify-subscribers.js:90` — `if (cruise.currency === 'USD' && usdToGbp) price *= usdToGbp;`
  - `scripts/notify-subscribers.js:103–105` — only converts in the
    `formatPrice` branch
  - The frontend (`public/app.js`, not in scope) presumably also
    converts; the rate used is fetched at runtime by both the script
    and the frontend.
- **Description:** The live rate is fetched at scrape time
  (`scripts/fetch-cruises.js:312–316` and
  `scripts/notify-subscribers.js:135–139`) and cached in memory only.
  Two consecutive scrapes can produce alerts that disagree about
  "this is a £X sailing" if the rate moved between them. There is no
  fallback documentation explaining what `0.79` should be.
- **Fix:** Document the 0.79 default and consider writing the rate
  used to `cruises.json`'s top level so consumers (and the WhatsApp
  script) can reference a consistent value across runs. Or, simpler:
  rate-limit re-fetches to once per scrape run, log the rate used,
  and persist it inside the JSON payload.

---

### F-24 — `twilio-webhook` swallows the upstream error [Low]

- **File:** `supabase/functions/twilio-webhook/index.ts:39–41`
- **Description:**
  ```ts
  } catch (err) {
    console.error('twilio-webhook error:', err instanceof Error ? err.message : String(err));
  }
  ```
  This logs the error and returns 200 (the TwiML `<Response>`) regardless
  of whether the DB update succeeded. Twilio will mark the webhook
  delivery as successful and never retry. If the CONTINUE flow silently
  fails, the user will not be re-subscribed.
- **Fix:** Return a 5xx response when `dbFetch` throws so Twilio retries.
  ```ts
  } catch (err) {
    console.error(...);
    return new Response('internal error', { status: 500 });
  }
  ```

---

### F-25 — Missing JSDoc on public APIs of `providers/index.js`
  contract [High]

- **File:** `providers/index.js:1–18`
- **Description:** The `// To add a new provider` comment block exists
  but does not document the **return value of `fetchCruises()`** or
  the **error model** (does it return `[]` on failure, throw, or
  reject?). Server and script behaviour around partial failure is
  inconsistent (see F-16).
- **Fix:** See F-11. A JSDoc block at the top of `providers/index.js`
  is the right place to spell out the contract.

---

## Recommended Fixes (ordered)

Concrete, scoped — not architectural rewrites:

| # | Severity | Effort | Change |
|---|---|---|---|
| **F-1** | High | XS | Fix `package.json` `cruises:pull` to point to `scripts/fetch-cruises.js` (or rename to disambiguate). |
| **F-2** | High | XS | Delete 4 duplicate `cleanText` declarations; import from `shared.js`. |
| **F-3** | Critical | M | Extract `providers/rci-room-selection.js` containing the 9 duplicated helpers; thin out `royal-caribbean.js` and `celebrity-cruises.js`. |
| **F-4** | Medium | S | Folded into F-3 via `paramAliases` config. |
| **F-5** | High | S | Move `buildDetailedItinerary` / `formatChapterPort` / `extractPortSequenceFromChapters` into `shared.js`. |
| **F-6** | Low | XS | Single `DEFAULT_USER_AGENT` constant in `shared.js` (use the Princess 131 version). |
| **F-7** | Low | XS | Delete the unused `randomUUID` import in `celebrity-cruises.js:4`. |
| **F-8** | High | S | Add a `fetchWithTimeout` helper and apply to every outbound `fetch`. |
| **F-9** | High | S | Add one-line `console.warn` to every empty `catch` block listed. |
| **F-10** | High | S | Add a `mapWithConcurrency` helper to `shared.js`; collapse both `enrichCruiseItinerary` worker loops. |
| **F-11** | High | XS | Expand the JSDoc in `providers/index.js` to document the output contract. |
| **F-12** | Medium | S | Stop re-attaching helpers to `module.exports`; have tests import them as named exports instead. |
| **F-13** | Medium | XS | Delete dead `buildGraphRequestBody` in `celebrity-cruises.js:75–85`. |
| **F-14** | Low | XS | Delete dead `randomUUID` import in `celebrity-cruises.js:4` (overlaps with F-7). |
| **F-15** | High | S | Folded into F-3 — cache key lives next to the cache. |
| **F-16** | Medium | S | Extract a `runAllProviders` helper; converge on `Promise.allSettled` semantics. |
| **F-17** | Medium | S | Replace hard-coded RC fallbacks in scripts with a generic resolver or delete the relative-path branch. |
| **F-18** | Low | XS | Delete dead `origin` / `referer` getters in `graphql-cruise-provider.js`. |
| **F-19** | Medium | XS | Rename to `RciGraphQLCruiseProvider` (or add JSDoc) to clarify scope. |
| **F-20** | Low | XS | Add a one-line JSDoc on each `parseBookingContext` explaining the country default. |
| **F-21** | Low | XS | Optional: split `ARCHIVE_RETENTION_MS` into `DAYS_PER_YEAR * 2` for readability. |
| **F-22** | Medium | M | Extract `matchesCriteria` to a shared module; have both scripts use it. |
| **F-23** | Medium | S | Document the 0.79 fallback and log the rate used on each run. |
| **F-24** | Low | XS | Return 5xx from `twilio-webhook` on DB failure. |
| **F-25** | High | XS | Folded into F-11. |

### Suggested PR sequencing

1. **PR 1 (Quick wins, ~30 min):** F-1, F-2, F-6, F-7, F-13, F-14, F-18, F-21, F-24.
2. **PR 2 (Consolidation, ~2 hr):** F-3, F-4, F-5, F-8, F-9, F-10, F-15, F-19, F-20.
3. **PR 3 (Contracts and helpers, ~1 hr):** F-11, F-12, F-16, F-17, F-22, F-23, F-25.

### Test plan

After each PR, run:
- `npm test` (Node `node:test` unit suite: `test/ui-provider-load.test.js`, `test/princess-cruises-provider.test.js`)
- `npx playwright test` (e2e suite)
- The two `test/royal-caribbean-provider.test.js`,
  `test/celebrity-cruises-provider.test.js`, `test/ncl-cruises-provider.test.js`,
  and `test/shared-region.test.js` cover the duplicated helpers; if
  they break after PR 2, the consolidation was wrong.

### What I did NOT propose (and why)

- **No rewrite of the shared region matcher.** The chain of `if`/regex
  literals in `providers/shared.js:7–21` is hard to read but functional
  and covered by `test/shared-region.test.js`. Refactoring it to a
  table-driven structure is out of scope for a "minimal targeted
  changes" review.
- **No provider abstraction for NCL / Princess.** They use Playwright
  in a way that's hard to abstract over the GraphQL pair. The
  `GraphQLCruiseProvider` is the right boundary; adding a
  `PlaywrightCruiseProvider` base class would be premature.
- **No TypeScript migration.** Out of scope.

---

## Top 3 Findings

1. **F-3 (Critical)** — RC and Celebrity share ~250 lines of
   duplicated room-selection code (`parseBookingContext`,
   `formatChapterPort`, `extractPortSequenceFromChapters`,
   `classifyRoomType`, `extractPriceFromEntry`,
   `extractRoomTypePricesFromPayload`, `extractPricesFromClassPricing`,
   `fetchRoomSelectionData`, `buildRoomSelectionFilter`,
   `enrichCruiseItinerary`). Extract into `providers/rci-room-selection.js`.
2. **F-1 (High)** — `package.json:10` `cruises:pull` runs the wrong
   script (`fetch-live-cruise-data.js` — the GitHub Pages hydrator)
   instead of the real scraper `fetch-cruises.js`. Misleading alias.
3. **F-8 (High)** — Zero outbound `fetch()` calls set a timeout
   (`AbortSignal.timeout`). When a provider is slow, the
   `enrichCruiseItinerary` worker pool hangs indefinitely and the
   Pages deploy workflow can time out.

# Improvement Plan — `dnb-cruises`

**Compiled:** 2026-06-09
**Sources synthesized (read-only):**
- `docs/reviews/01-code-architecture.md` — 25 findings (F-1 … F-25)
- `docs/reviews/02-security.md` — 11 findings (H-1, H-2, M-1 … M-7, L-1 … L-4)
- `docs/reviews/03-frontend-ux.md` — 22 findings (F1.1 … F8.6)
- `docs/reviews/04-ops-ci.md` — 11 findings (F-01 … F-11)

This plan is a synthesis, not a new review. Every item traces to a numbered
finding in one of the four upstream reports. Source files were not modified.

---

## TL;DR

`dnb-cruises` is a small, mostly-static site with a Playwright-driven scraper
and three Supabase edge functions. The codebase is generally defensively
written — `escHtml` is applied consistently, the frontend has no
`document.write` / `eval` / `new Function`, and dependency CVEs are clean.
The highest-leverage changes are all in CI and operations, not application
code: **`npm test` silently skips 4 of 6 unit tests and CI never runs the
test suite at all** (so a broken provider can ship), **`.claude/settings.local.json`
with broad Bash allows is committed to the public repo**, and **GitHub
Actions are pinned to mutable `@vN` tags rather than commit SHAs**. On the
application side, the two real blockers are **Twilio webhook signature
verification missing (auth bypass on WhatsApp subscription state)** and
**the desktop sort `<th>` is unreachable to keyboard and screen-reader
users**. The 6.75 MB of cruise JSON fetched eagerly on every page load
should be lazy-loaded or cache-friendly before mobile users notice.
Most of the rest is cleanup.

---

## Prioritized Action List

### P0 — Must-fix (security, data loss, broken deploy)

1. **Verify Twilio webhook signature on `twilio-webhook`.**
   Anyone can POST `Body=CONTINUE` with a chosen `From` and reactivate any
   subscription. HMAC-SHA1 the public URL + sorted body params with
   `TWILIO_AUTH_TOKEN` and reject on mismatch.
   *Source:* security H-1. *Effort:* S.

2. **Run unit tests in CI and stop `npm test` from silently skipping files.**
   `package.json:11` chains `node --test <two file names> && playwright test`,
   so the other four `*.test.js` files are never run; no workflow invokes
   `npm test` at all. Expand the file list (`node --test test/*.test.js`) and
   add a `test.yml` workflow that runs on PR with artifact upload.
   *Source:* ops F-01. *Effort:* S.

3. **Pin GitHub Actions to commit SHAs (with Dependabot) and stop
   committing `.claude/settings.local.json`.** Action tags can be rewritten
   by a compromised publisher; the current `actions/*@vN` references run
   unverified code with access to `GITHUB_TOKEN`, `RESEND_API_KEY`,
   `TWILIO_*`, and `SUPABASE_*` secrets. `.claude/settings.local.json`
   publishes one developer's per-machine `Bash(git commit *)` /
   `Bash(npm install *)` allow list to the public repo — `git rm --cached`
   it and add to `.gitignore`. Narrow the surviving shared allow list to
   read-only commands.
   *Source:* ops F-02, F-03. *Effort:* S.

4. **Make the desktop sort `<th>` cells keyboard-operable and expose
   `aria-sort`.** The headers are clickable via inline `onclick` but have
   no `tabindex`, no `role="button"`, no `keydown` handler, and never set
   `aria-sort`. Keyboard and screen-reader users cannot reach the most
   important control on the page. Add `tabindex="0"`, `aria-sort`, an
   `Enter`/`Space` keydown, and a `:focus-visible` outline. Also set
   `aria-pressed` and a state-aware label on the sort-direction button.
   *Source:* frontend F1.1, F2.2. *Effort:* S.

5. **Add outbound `fetch` timeouts and an honest `User-Agent` for all
   providers.** Zero `fetch` calls set an `AbortSignal`; a slow upstream
   hangs the `enrichCruiseItinerary` worker pool and the
   `deploy-pages.yml` workflow. Add a `fetchWithTimeout(url, opts, 15000)`
   helper in `providers/shared.js` and apply it to every outbound
   `fetch` in providers, scripts, and Supabase functions (≈15 call sites).
   *Source:* code-arch F-8, security M-6. *Effort:* S.

### P1 — Should-fix (significant UX or maintainability gain)

6. **Address the ~6.75 MB of cruise JSON fetched eagerly in parallel on
   every page load with `cache: 'no-store'`.** Switch to a
   `Cache-Control: max-age=600` static-host header and drop the client
   `no-store`; lazy-load one provider at a time on demand; or stream-parse
   the JSON. Confirm `providers/*/oldCruises.json` (~924 KB combined) is
   not referenced and stop deploying them.
   *Source:* frontend F4.1. *Effort:* M.

7. **Add `aria-live` regions to the result-count, loading state, and
   error state.** `#summary` (count), `#statusText` (loading/error), and
   the empty `<tr>` are all visual-only — screen-reader users get no
   feedback when filters or loads change. Use `aria-live="polite"` for
   count and loading, `role="alert"` for errors, and a visually-hidden
   `<caption>` on `<table id="cruiseTable">` so empty rows are anchored.
   *Source:* frontend F1.2, F1.3, F3.2. *Effort:* S.

8. **Extract a `providers/rci-room-selection.js` module to collapse the
   ~250 lines of duplicated code between `royal-caribbean.js` and
   `celebrity-cruises.js`.** Both share `parseBookingContext`,
   `formatChapterPort`, `extractPortSequenceFromChapters`,
   `classifyRoomType`, `extractPriceFromEntry`,
   `extractRoomTypePricesFromPayload`, `extractPricesFromClassPricing`,
   `fetchRoomSelectionData`, `buildRoomSelectionFilter`, the cache key
   tuple, and the `enrichCruiseItinerary` worker loop — they differ only
   in host, booking-param aliases, and a few Apollo headers. Pass a small
   `hostConfig` object.
   *Source:* code-arch F-3, F-4, F-5, F-10, F-15. *Effort:* M.

9. **Add `Retry` button and per-provider failure detail to the error
   state.** `showStatus('Could not load cruise data: …', true)` is a
   one-liner with no way for the user to recover. Add a `Retry` button
   that re-runs `loadData()`, surface which providers' JSON failed
   (currently the first throw aborts the whole `Promise.all`), and add
   `role="alert"` to the status bar in the error state.
   *Source:* frontend F3.2. *Effort:* S.

10. **Add a CSP `<meta>` tag to the frontend.** 80+ inline event handlers
    require `unsafe-inline`; tightening `script-src` to `'self'` is
    possible today but a future compromise would currently have free
    rein. Add a `connect-src` allowlist for the Supabase / FX / Wikipedia
    origins, `frame-ancestors 'none'`, and `base-uri 'self'`. Also add
    `<link rel="preconnect">` to `yttgqscwgmsnewdjqbcc.supabase.co` and
    `open.er-api.com`.
    *Source:* frontend F8.1, F8.4. *Effort:* S.

11. **Harden `server.js` for the dev/express path.** No `helmet()`, no
    `cors()` policy, no `express-rate-limit`, no JSON size limit. Add
    `helmet()` for default security headers, `express-rate-limit` on
    `/api/cruises` (≈30 req/min/IP), cache the snapshot to disk with a
    5-minute TTL, and replace the 500 body that forwards `err.message`
    with `{ success: false, error: "Internal error" }`.
    *Source:* security M-1, M-2. *Effort:* S.

12. **Add per-IP rate-limiting + a Twilio Verify round-trip before
    persisting subscriptions.** All three Supabase functions are deployed
    `--no-verify-jwt`. `subscribe` accepts any `+E164` number with no
    proof of control; `visitor-count` rate-limits only on a client-supplied
    UUID that an attacker can rotate freely. Add CAPTCHA / Twilio Verify
    for `subscribe`, switch the visitor counter to a salted `(UA, IP)`
    hash, and enable gateway-level per-IP limits.
    *Source:* security M-3, M-4. *Effort:* M.

13. **Fix the `package.json:10` `cruises:pull` misnaming.** It currently
    points to `scripts/fetch-live-cruise-data.js` (the GitHub Pages
    hydrator), not the real scraper `scripts/fetch-cruises.js`. Either
    point it at the real scraper, or rename to disambiguate
    (`scrape:local` vs `scrape:hydrate`).
    *Source:* code-arch F-1. *Effort:* S.

14. **Make `absoluteUrl()` reject non-`http(s)` schemes.** Today
    `absoluteUrl('javascript:alert(1)')` slips through the
    `startsWith('http')` check (the providers return only `http`/`https`
    today, but the data flow is upstream-controlled). Restrict to
    `^https?://` and return `'#'` otherwise; add a unit test.
    *Source:* security M-5. *Effort:* S.

15. **Return 5xx from `twilio-webhook` when the DB PATCH throws.** The
    function currently logs and returns 200 with the TwiML regardless of
    whether `dbFetch` succeeded, so Twilio marks the delivery successful
    and never retries. A 5xx makes Twilio retry; only return 200 after
    the state change is durable. (Same edge function as P0 #1; ship
    together.)
    *Source:* code-arch F-24. *Effort:* S.

16. **Stop silently swallowing errors in `enrichCruiseItinerary`,
    `extractPriceFromBookingPage`, the exchange-rate `fetch`, and the
    `notify-subscribers` matchers.** Bare `catch {}` blocks return
    defaults (empty string, `0.79` rate) with no log line, so the
    operator has no way to know enrichment is failing. Add a
    `console.warn` one-liner per site. Also log the FX rate used on
    every scrape run so the WhatsApp alerts and the static `cruises.json`
    agree.
    *Source:* code-arch F-9, F-23. *Effort:* S.

### P2 — Nice-to-fix (cleanup, polish, hardening)

17. **Add `accessibility`/live-region sweep across the rest of the
    dialogs and inputs.** `:focus-visible` outline on `.sort-row th`,
    `.sort-dir-btn`, and the back-to-top FAB; `scope="col"` on the
    `<th>` cells; extend `prefers-reduced-motion` to the skeleton
    shimmer, `#backToTopFab`, and the mobile dialog slide-up; add a
    `<noscript>` block explaining the page requires JS.
    *Source:* frontend F1.5, F1.8, F6.2, F2.3. *Effort:* S.

18. **Move `<table>` wrapper to `overflow-x: auto` between 480–860px.**
    At intermediate widths the table shrinks to ~70–80px columns with
    no horizontal scroll; long ship names wrap awkwardly.
    *Source:* frontend F5.2. *Effort:* S.

19. **Refine the empty state.** Single "No cruises match your filters"
    row has no CTA. Add a "Clear all filters" button next to the message
    and reference the active filter summary string.
    *Source:* frontend F3.3. *Effort:* S.

20. **Mask PII in workflow and function logs.** `notify-subscribers.js`
    writes the full `whatsapp_number` to the GitHub Actions log on every
    success and failure; `twilio-webhook`'s `console.log` does the same
    in the Supabase function log. Print only the last 4 digits. Drop the
    successful-send log line entirely.
    *Source:* security H-2, M-7. *Effort:* S.

21. **Stop deploying `providers/*/oldCruises.json` (~924 KB total).**
    The frontend never references them. They are committed and uploaded
    on every scrape cycle.
    *Source:* frontend F4.1 (orphan assets). *Effort:* S.

22. **Consolidate duplicate helpers in `providers/shared.js`.** Delete
    the four `cleanText` re-declarations in `royal-caribbean.js`,
    `celebrity-cruises.js`, `princess-cruises.js`, `ncl-cruises.js`, and
    the inline one inside NCL's `$$eval` callback. Move
    `buildDetailedItinerary`, `formatChapterPort`, and
    `extractPortSequenceFromChapters` to `shared.js`. Import from
    `shared.js` in every provider.
    *Source:* code-arch F-2, F-5. *Effort:* S.

23. **Add a single `DEFAULT_USER_AGENT` constant in `providers/shared.js`.**
    Currently the desktop-Chrome UA is duplicated in 5 places and
    Princess uses 131.0.0.0 while the others use 124.0.0.0. Pick 131.0.0.0
    as canonical.
    *Source:* code-arch F-6. *Effort:* S.

24. **Document the provider output contract and the error model in
    `providers/index.js`.** Replace the 6-line "to add a provider"
    comment with a JSDoc block spelling out the `fetchCruises()` return
    shape (`NormalizedCruise` keys, all required and optional), the
    `id`/`name`/`fetchCruises` duck-type, and whether a failing provider
    should return `[]`, throw, or reject. Pin down whether `server.js`
    and `scripts/fetch-cruises.js` should converge on
    `Promise.allSettled` semantics.
    *Source:* code-arch F-11, F-16, F-25. *Effort:* S.

25. **Stop re-attaching helpers to the provider instance after
    `module.exports`.** Today each provider does
    `module.exports = new XProvider(); module.exports.fn = fn;` so tests
    can call `provider.normalizeCruise(...)`. Either have the tests
    import the helpers directly as named exports, or fold them into the
    shared `rci-room-selection.js` module (see P1 #8).
    *Source:* code-arch F-12. *Effort:* S.

26. **Delete dead code.** `randomUUID` import in `celebrity-cruises.js:4`
    (F-7 / F-14 — same import), `buildGraphRequestBody` in
    `celebrity-cruises.js:75–85`, the `origin`/`referer` getters in
    `graphql-cruise-provider.js:62–69`, and the stale
    `// toggleGBP was the UI handler for…` comment at
    `app.js:2575-2577`.
    *Source:* code-arch F-7, F-13, F-14, F-18; frontend F7.5. *Effort:* S.

27. **Move the `SITE_CHANGES` array (~300 lines) out of `app.js` into a
    lazy `site-changes.json`** and render inside `openSiteChanges()`.
    *Source:* frontend F4.3, F7.7. *Effort:* S.

28. **Add `<meta name="description">` and `<meta name="theme-color">` to
    the page head.** Both are absent; search engines and the mobile URL
    bar fall back to defaults.
    *Source:* frontend F8.2, F8.3. *Effort:* S.

29. **Tidy the repository root.** `git rm --cached
    test-results/.last-run.json` (F-04); delete the empty `netlify/`
    directory (F-05); move or delete `.venv/` (F-07); rewrite the
    README paragraph that incorrectly claims Puppeteer is the scraper
    (F-06); add `supabase/.env*`, `supabase/.branches/`, `supabase/.temp/`,
    and `.venv/` to `.gitignore` (L-1, F-07).
    *Source:* ops F-04, F-05, F-06, F-07; security L-1. *Effort:* S.

30. **Add a `permissions: { contents: read }` block to
    `deploy-edge-functions.yml`.** It's the only workflow without one;
    defense in depth.
    *Source:* ops F-08. *Effort:* S.

31. **Dependency hygiene follow-up.** Add a `dependabot.yml` for GitHub
    Actions and `npm`; pin `cheerio` and `express` to exact versions (or
    keep caret + lockfile + Dependabot — security L-2); schedule an
    `express 4 → 5` upgrade as a separate PR (ops F-10); decide whether
    to keep `jimp` (used only by the one-shot
    `process-ship-silhouettes.js`); either bump `engines.node` to
    `>= 20.18.1` (matches CI) or pin `cheerio` to `^1.0.0` if Node 18
    support must be preserved.
    *Source:* security L-2; ops F-10. *Effort:* M (express upgrade),
    otherwise S.

32. **Tighten the `data` branch push scope in `deploy-pages.yml`.**
    Today the workflow has `contents: write` and uses `GITHUB_TOKEN` to
    push to `data`. Generate a fine-grained PAT scoped to the `data`
    branch only, store it as `SECURITY_REVIEW_DATA_BRANCH_TOKEN`, and
    drop the workflow-level `contents: write`.
    *Source:* security L-3. *Effort:* S.

33. **Replace the hard-coded `royalcaribbean.com` fallback URLs in
    `fetch-cruises.js:200-201` and `notify-subscribers.js:111-112`** with
    a generic `resolveBookingUrl(cruise, { providerDefaultHost })` helper
    (or delete the relative-path branch since providers already return
    absolute URLs).
    *Source:* code-arch F-17. *Effort:* S.

34. **Extract a shared `matchesCriteria` filter** to a new
    `lib/cruise-filters.js` so `scripts/fetch-cruises.js` and
    `scripts/notify-subscribers.js` stop duplicating the same predicate
    with divergent field names (`minNights` vs `duration`, `maxPriceUSD`
    vs `maxPrice`).
    *Source:* code-arch F-22. *Effort:* M.

35. **Documentation-only JSDoc touches.** Add a one-line note to each
    `parseBookingContext` explaining the country default
    (`'USA'` for RC, `'GBR'` for Celebrity — F-20). Rename
    `GraphQLCruiseProvider` to `RciGraphQLCruiseProvider` or add a JSDoc
    clarifying the scope (F-19). Optional: split
    `ARCHIVE_RETENTION_MS` into `DAYS_PER_YEAR * 2` for readability
    (F-21 — skip per the finding's own "optional" note).
    *Source:* code-arch F-19, F-20, F-21. *Effort:* S.

---

## Cross-Cutting Themes

**1. CI / test coverage gap is the single biggest operational risk.**
The four upstream reviews do not look like they would agree on this, but
they do. The code-arch review's "minimal" provider contract change
(F-11/F-25), the ops review's test-script finding (F-01), and the
frontend review's "error state has no provider detail" finding (F3.2)
all point at the same underlying issue: **the pipeline catches failures
at the wrong layer**. `npm test` silently skips 4 of 6 unit tests
because the file list is hard-coded; no workflow runs `npm test` at all;
the frontend aborts on the first provider failure so partial success is
invisible; the Playwright e2e is run only on demand. A broken provider
ships today and the team finds out from users. Fixing the test runner
and adding a CI job is the cheapest, highest-leverage change in the
plan.

**2. Outbound HTTP has no timeouts, consistent error handling, or
honest identification.** This shows up in *three* reviews pointing at
the same files. The code-arch review counted 12+ outbound `fetch` calls
with no `AbortSignal` (F-8); the security review noted the same and
flagged the desktop-Chrome User-Agent spoofing as a ToS risk (M-6); the
ops review implicitly inherits both via the deploy workflow timing out.
The fix is mechanical: one `fetchWithTimeout(url, opts, 15000)` helper
in `providers/shared.js`, applied at every call site. A bonus from the
security review: a unique, honest `User-Agent` like
`dnb-cruises/1.0 (+contact)` and `Accept` / `Accept-Language` headers
let most CDNs whitelist the bot, removing the spoofing as a side
effect.

**3. Silent or leaky error handling is everywhere.** The code-arch
review found 5+ bare `catch {}` blocks in production HTTP paths (F-9);
the security review found two places that print subscriber phone
numbers in plaintext to GitHub Actions / Supabase function logs (H-2,
M-7); the ops review found that the only deploy-workflow error log line
that exists says "no RESEND_API_KEY or ALERT_EMAIL — skipping email"
which is fine but illustrates the *style*: present-absence, not values.
The pattern across all three is the same — the code is defensive but
the *logging* discipline is not. P1 #16 (log one-liners on each
swallowed catch) and P2 #20 (mask PII) are the two halves of the same
fix.

**4. Accessibility live-region discipline is inconsistent across
components.** The frontend review found three separate "this state
change is visual-only" instances that all need the same
`aria-live` / `role="status"` / `role="alert"` treatment: the
`Showing N sailings` count, the loading and error status bar, and the
empty-state row. The frontend already uses `aria-live` correctly in
three other places (visitor stats, phone-status, settings), so the
pattern is known; it's just not applied to the most important
user-visible states. P1 #7 fixes all three in one pass. P2 #17 then
extends the sweep to focus outlines, `prefers-reduced-motion`, and the
`<noscript>` fallback.

---

## Out of Scope

These were flagged in the upstream reviews but are not recommended for
this iteration. Each is a deliberate deferral, not an oversight.

- **Provider abstraction for NCL and Princess (code-arch F-19).** They
  use Playwright in a fundamentally different shape (DOM scraping vs
  GraphQL) and forcing them into a `PlaywrightCruiseProvider` base class
  would be premature. The `GraphQLCruiseProvider` boundary is correct;
  renaming to `RciGraphQLCruiseProvider` and adding a JSDoc is enough.
- **TypeScript migration (code-arch "What I did NOT propose").** The
  project ships as plain CommonJS. A migration is a separate
  architectural decision and out of scope for a "minimal targeted
  changes" review.
- **Rewrite of the shared region matcher in `providers/shared.js:7-21`
  (code-arch "What I did NOT propose").** The chain of `if`/regex
  literals is hard to read but functional and covered by
  `test/shared-region.test.js`. Refactoring to a table-driven structure
  is purely cosmetic.
- **Provider contract enforcement via TypeScript-style runtime checks
  (code-arch F-11/25, beyond the JSDoc).** Documenting the contract in
  JSDoc on `providers/index.js` is enough; adding `zod` / `valibot` /
  manual type guards would expand the dependency surface for marginal
  gain at the current provider count (4).
- **`ARCHIVE_RETENTION_MS` readability split (code-arch F-21).** Marked
  "Minor, optional" by the source finding itself.
- **`SITE_CHANGES` lazy render (frontend F7.7).** P2 #27 moves the data
  to a JSON file; actually rendering lazily inside `openSiteChanges()`
  saves nothing on first load because the JSON is still fetched on init.
  Ship the JSON move and stop there.
- **Per-IP rate-limiting at the function gateway level for *all* three
  Supabase functions (security M-3, broader scope).** P1 #12 covers
  `subscribe` and `visitor-count`; adding gateway-level limits is a
  Supabase dashboard setting that the operator should configure
  separately, not a code change.
- **A `PlaywrightCruiseProvider` base class** for NCL/Princess (see
  above; same rationale).
- **An SVG-favicon (frontend F8.6).** Marked "Optional" by the source;
  no branding is lost in practice with `data:,`.

---

## Suggested Sequencing

| Order | Items | Why this order |
|---|---|---|
| **Sprint 1 (P0, ≈ half a day)** | #1, #2, #3, #4, #5 | Security, CI, and a11y in one go; #5 unblocks several ops incidents at zero risk. |
| **Sprint 2 (P1, ≈ 2-3 days)** | #6, #7, #8, #9, #10, #11, #12, #13, #14, #15, #16 | UX and maintainability. #8 (rci-room-selection refactor) is the only M-effort item in the band; pair it with the smaller items so reviewers see the diff in context. |
| **Sprint 3 (P2, cleanup, ongoing)** | #17 – #35 | Polish. None block anything; many are one-line commits. Tackle opportunistically. |

No P0 item blocks a P1 or P2 item. P0 #1 and P1 #15 touch the same
edge function and should ship in the same PR. P1 #8 is the only
substantive refactor; everything else in the plan is local.

## Verification standard for the plan

- **Traceability:** every P0/P1/P2 item in this document cites the
  upstream finding number(s) it came from. No new findings were added
  during synthesis.
- **Defensibility:** P0 contains only items with real security,
  data-loss, or deploy-shipping impact. P1 contains significant UX
  wins and the large provider refactor. P2 is cleanup. P0 does **not**
  contain any "rename this variable" or "split this constant for
  readability" items.
- **Readability:** the document is structured so a maintainer can read
  TL;DR + the P0 list in under 5 minutes, then drill into any item via
  the source reference.

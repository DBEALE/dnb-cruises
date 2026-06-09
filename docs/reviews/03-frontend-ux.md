# Frontend & UX Review — `dnb-cruises`

**Scope:** `public/index.html`, `public/app.js`, `public/styles.css`,
`public/providers/index.json`, `public/ship-wiki-links.json`, `public/img/`
**Date:** 9 Jun 2026
**Reviewer:** `coder` (automated static review)
**Mode:** read-only — no project files were modified.

## Summary

The frontend is a single-page, framework-free vanilla-JS app. It is
substantially larger and more polished than its first impression suggests:
~2,750 LoC of JS, ~1,960 lines of CSS, five `<dialog>`s, dual desktop +
mobile filter surfaces, a 300-row render cap, a URL-hash state, an
IntersectionObserver-driven sparkline lazy-fill, a USD→GBP conversion, and
a saved-views feature backed by Supabase + WhatsApp notifications. Most of
the heavy lifting is done well.

The findings cluster around three weak spots:

1. **Accessibility** — the desktop sort `<th>` cells are clickable but not
   focusable, not keyboard-activatable, and never expose `aria-sort`. The
   live "Showing N sailings" count is written into the DOM with no
   `aria-live` region, so screen-reader users get no announcement of how a
   filter changed the result set. Empty state and error state are visually
   designed but not announced.
2. **Performance on first paint** — `app.js` is loaded `defer`red but
   `~6.6 MB` of cruise JSON is fetched eagerly and on the main thread on
   the init path. The skeleton table in `index.html` makes the wait
   tolerable, but the parse + render work is significant on mid-range
   devices, and the first-paint window is gated on the slowest provider.
3. **CSP / meta tags** — there is no `<meta http-equiv="Content-Security-Policy">`,
   no `theme-color`, no `description`, no `<link rel="preconnect">` to the
   Supabase / FX / Wikipedia origins the page talks to. There is no
   `<noscript>` fallback even though the page is a no-op without JS.

Everything else (responsive breakpoints, focus styles, code organisation,
IIFE-singleton init pattern, debouncing, contrast, semantic HTML
landmarks) is in good shape. The site is internally consistent in style
and naming, ships with `prefers-reduced-motion` handling for the
header wave, and runs the mobile filter sheet as a proper `<dialog>`.

---

## Findings

### Severity legend

- **HIGH** — meaningful barrier to users or a real production risk.
- **MED**  — degraded UX or accessibility; not blocking.
- **LOW**  — polish / consistency / nice-to-have.
- **INFO** — observation, not a defect.

### 1. Accessibility

#### F1.1 Sort `<th>` cells are not keyboard-operable or screen-reader-aware — **HIGH**
- **File:** `public/index.html:284-301`, `public/app.js:2170-2226`,
  `public/styles.css:437-457`
- **Evidence:** Each header cell renders as `<th class="col-..." data-sort="N" onclick="sortTable(N)">…</th>`.
  The `<th>` has no `tabindex`, no `role="button"`, no `aria-sort`, and
  the click handler is bound via inline `onclick`. Keyboard users have
  **no way** to reach these controls; VoiceOver/NVDA will read the
  column name but never announce "sorted ascending" or "clickable".
  The CSS at `styles.css:437` confirms `cursor: pointer` is the only
  interactive affordance — Tab key skips them entirely.
- **Fix:**
  - Add `tabindex="0"` and `role="button"` (or convert the cells to
    `<button>` children inside the `<th>`).
  - Add `aria-sort="ascending|descending|none"` and update it in
    `syncSortControls()` (`app.js:2204`).
  - Add a `keydown` listener for `Enter` and `Space` that calls
    `sortTable(colIndex)` from `app.js:2170`.
  - Add `:focus-visible` outline (currently only `:hover` is styled at
    `styles.css:454`).

#### F1.2 Result-count "Showing N sailings" is not announced to AT — **MED**
- **File:** `public/index.html:264`, `public/app.js:2481-2482`,
  `public/styles.css:213-216`
- **Evidence:** `#summary` is a plain `<span>`. Every filter change
  rewrites its `innerHTML` with the new count, but there is no
  `aria-live`, no `role="status"`, and no polite/assertive region. A
  screen-reader user filtering a list of 1,000+ cruises down to 3
  receives no audible confirmation. The `visitorStats` and
  `settingsPhoneStatus` regions in `index.html:492, 499, 598` do use
  `aria-live="polite"`, so the pattern exists — it just isn't applied
  to the most important result-count.
- **Fix:** Add `aria-live="polite"` and `aria-atomic="true"` to
  `<div class="summary-bar">` (or to `#summary` itself).

#### F1.3 Empty / error / loading states are visual only — **MED**
- **File:** `public/index.html:412-453`, `public/app.js:1351`,
  `public/app.js:849-858`, `public/styles.css:385-400`
- **Evidence:**
  - Loading: the 3 skeleton rows are decorative shimmer divs; the
    `<div id="statusBar">` announces visually with a spinner but its
    `<span id="statusText">` is not in an `aria-live` region, so a
    screen reader announces nothing until the data arrives.
  - Error: `showStatus('Could not load cruise data: …', true)` paints a
    red border (`styles.css:400`) but the same lack of `aria-live` means
    the error is invisible to AT. There is also no `role="alert"` or
    `role="status"`.
  - Empty results: `tbody.innerHTML = '<tr class="empty-row"><td colspan="16">No cruises match your filters.</td></tr>'`
    (`app.js:1351`) — the message exists but the table has no caption or
    summary, so the user hears "no cell content" or "table with 1 row
    and 1 column" depending on the reader.
- **Fix:**
  - Mark the status bar `role="status"` + `aria-live="polite"`; for
    `isError=true`, also `aria-live="assertive"` (or use `role="alert"`).
  - Give `<table id="cruiseTable">` a visually-hidden `<caption>` (e.g.
    "Cruise sailings" or a dynamic "X sailings matching your filters")
    so the empty state is anchored to something AT will read.
  - Add `scope="col"` to the `<th>` cells (they don't have it).

#### F1.4 Inline `onclick` on every filter & sort control — **MED**
- **File:** `public/index.html` (many lines: 13, 14, 64, 79, 81, 88, 91,
  98, 113, 119, 126, 141, 147, 150, 156, 159, 165, 168, 174, 175, 181,
  182, 188, 189, 195, 216, 224, 225, 231, 232, 238, 239, 245, 246, 252,
  253, 257, 258, 269, 276, 306, 309, 314, 317, 322, 325, 330, 331, 336,
  337, 342, 343, 350, 351, 356, 357, 362, 363, 368, 369, 374, 395, 400,
  401, 464, 470, 485, 525, 538, 555, 556, 557, 569, 584)
- **Evidence:** ~80+ inline `onclick="..."` handlers. Functionally fine
  (CSP is absent, so no `unsafe-inline` problem to solve), but it makes
  keyboard / non-mouse interaction harder to test, harder to keep
  consistent, and contributes to F1.1 because there is no single
  delegated keydown handler.
- **Fix:** Long term, migrate to a `data-action="..."` /
  event-delegation pattern. At minimum, add a `keydown` handler to the
  F1.1 sort headers (this is the user-visible case).

#### F1.5 Focus styles missing on `<th>`, sort-direction button, and some `.filter-clear-btn` — **LOW**
- **File:** `public/styles.css:454, 515, 1278, 1416, 1419, 1434, 1449`
- **Evidence:** `:focus-visible` is correctly defined for `.filter-clear-btn`,
  `.date-range-btn`, `.sort-wrap select`, `.price-spark`, the date-range
  inputs, the saved-view form input, and the settings phone input. The
  following are *not* covered:
  - The sort header `<th>` cells (`.sort-row th`, line 437) — only
    `:hover` is defined.
  - The sort direction button `.sort-dir-btn` (no `:focus-visible` rule).
  - The mobile filter inputs (`.mob-filter`) have a `:focus` rule (line
    1419) but the clear button next to them (`.mob-filter-group .filter-clear-btn`,
    line 1434) only re-uses the shared rule.
  - The empty placeholder rows after the dialog is dismissed have no
    visible focus state for the back-to-top FAB.
- **Fix:** Add `:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }`
  to `.sort-row th`, `.sort-dir-btn`, and any other interactive element
  lacking it. Keep `outline-offset` consistent (1–2px) so keyboard users
  get a uniform halo.

#### F1.6 `<th class="col-per-night">` has no `data-sort` (sortable only via dropdown) — **INFO**
- **File:** `public/index.html:298`
- **Evidence:** `<th class="col-per-night" onclick="sortTable(17)">£/night</th>`
  — note the missing `data-sort="17"` that every other sortable header
  has. The onclick still works (the column index 17 is hard-coded), so
  this is a code-hygiene gap, not a bug.
- **Fix:** Add `data-sort="17"` to match the rest.

#### F1.7 `<h1 tabindex="0">` is keyboard-focusable but exposes no role — **LOW**
- **File:** `public/index.html:16`
- **Evidence:** `<h1 tabindex="0">` is made focusable so the wave-press
  handler at `app.js:714-718` can fire on `Enter`/`Space`. Putting
  `tabindex` on a heading pulls it into the tab order purely for a
  cosmetic animation, which is questionable: a screen-reader user who
  Tabs through the page will hit the title once, and the announcement
  is the same as it would be un-focused.
- **Fix:** Either drop the animation entirely, or wire the press to
  the wave element directly (the SVGs are decorative; the actual
  trigger is just "user did something on the title"). At minimum,
  prefer `<button class="header-wave-trigger">` over tabindex on `<h1>`.

#### F1.8 Reduced-motion handling only covers the header wave — **LOW**
- **File:** `public/styles.css:191-194`
- **Evidence:** The `prefers-reduced-motion: reduce` block only disables
  `.header-wave .wave` animation. The skeleton-row shimmer at
  `styles.css:626` (`@keyframes skeleton-shimmer`) and the back-to-top
  FAB transform at `styles.css:273` are unaffected, and the dialog
  slide-up at `styles.css:1320` is also unaffected. Users who have
  motion sensitivity will see skeleton rows shimmer for ~1.6 s and
  the bottom sheet will slide in.
- **Fix:** Add `animation: none;` and `transition: none;` to the same
  `@media (prefers-reduced-motion: reduce)` block for
  `.skeleton`/`.skeleton-shimmer`, `#backToTopFab`, and
  `dialog#mobFilters`.

#### F1.9 Filter-clear buttons say `&times;` (×) with no text alternative — **LOW**
- **File:** `public/index.html:150, 159, 168, 175, 182, 189, 216, 225,
  232, 239, 246, 253, 309, 317, 325, 331, 337, 343, 351, 357, 363, 369,
  395, 401`
- **Evidence:** Each clear button relies on `aria-label="Clear ship filter"`
  etc. for its accessible name. The `&times;` glyph is announced as
  "Clear ship filter" so this is fine. Listed for completeness — the
  pattern is correct, just verify with a screen reader that the label
  is read on focus (it should be).
- **Fix:** None — informational. Pattern is correct.

### 2. Filter / Sort

#### F2.1 Live text filter *is* debounced — 320ms (and 650ms for launch year) — **INFO**
- **File:** `public/app.js:2233-2254`
- **Evidence:**
  ```js
  const FILTER_DEBOUNCE_MS = 320;
  const LAUNCH_YEAR_DEBOUNCE_MS = 650;
  ```
  Plus `scheduleApplyFilters()` uses a run-id guard so a stale
  `setTimeout` from a fast typer is dropped (`app.js:2238-2245`). The
  oninput handlers `debouncedApplyFilters` / `debouncedLaunchYearFilters`
  (`app.js:2248-2254`) are correctly wired to text and number inputs
  in `index.html` (e.g. `index.html:330, 336, 342, 356, 362, 368, 400`).
- **Assessment:** Done well. The 320ms threshold is below the
  perceptual "instant" boundary but coalesces typing bursts.

#### F2.2 Sort UI does not indicate current direction for screen readers — **HIGH** (see F1.1)
- **File:** `public/app.js:2222-2225`, `public/styles.css:456-457`
- **Evidence:** `syncSortControls()` writes `sort-asc` / `sort-desc` as
  a CSS class, which draws a `::after` arrow (▲/▼) on the active
  column. But the `aria-sort` attribute is never set on any `<th>`, so
  AT users get no directional cue. Also, the separate
  `sortDirBtn` (↑/↓, `index.html:79`) changes its glyph and `title` but
  its `aria-label` ("Toggle sort direction") is identical regardless of
  state.
- **Fix:** In `syncSortControls()`:
  - `th.setAttribute('aria-sort', sortAsc ? 'ascending' : 'descending')`
    on the active header, and `aria-sort="none"` on the others.
  - `btn.setAttribute('aria-pressed', String(sortAsc))` on the
    `sortDirBtn`, and a state-aware `aria-label`
    ("Sort ascending — click to switch to descending").

#### F2.3 Filter controls are correctly labelled — **INFO**
- **File:** `public/index.html:62-63, 87, 96, 124, 145, 154, 163, 172,
  179, 186, 194, 220, 229, 236, 243, 250`
- **Evidence:** Every `<select>` and `<input>` inside the mobile filter
  sheet has a `<label for="...">`. The desktop filter row uses
  `placeholder="…"` rather than visible labels — this is fine in
  context (the column header directly above already names the field),
  but a `<label class="visually-hidden">` would help screen-reader
  users who navigate to a filter input directly.
- **Fix:** Optional — add visually-hidden `<label>` for the desktop
  filter row.

### 3. Loading / Error / Empty States

#### F3.1 Loading state is well-designed — **INFO**
- **File:** `public/index.html:412-453`, `public/styles.css:600-635`
- **Evidence:** Three skeleton rows of realistic card shape, with
  shimmer animation, are baked into the initial HTML. The status bar
  above the table says "Loading cruise data…". When data arrives,
  `applyCruiseResults()` (`app.js:861`) replaces the skeletons with
  real rows. The visual design is intentional (mimics the card layout
  to avoid reflow).
- **Assessment:** Good. The only gap is F1.3 (no `aria-live`).

#### F3.2 Error state is a one-liner in the status bar — **MED**
- **File:** `public/app.js:640`, `public/styles.css:400`
- **Evidence:**
  ```js
  if (!cached) showStatus('Could not load cruise data: unable to load the static cruise files.', true);
  ```
  The red-bordered error pill appears, the table stays empty (or
  blank if no cache is available). There is no "Retry" button, no link
  back to a static fallback, no indication of which provider failed or
  whether the problem is network vs. CDN. On GitHub Pages, a 404 on
  `providers/royal-caribbean/cruises.json` produces this identical
  generic error.
- **Fix:**
  - At minimum, add a `Retry` button that re-runs `loadData()`.
  - Surface *which* providers failed (the catch in `loadData` at
    `app.js:613-642` throws on the first error, so partial success
    isn't reported at all).
  - Add `role="alert"` to the status bar in the error state.

#### F3.3 Empty state is a single row of "No cruises match your filters." — **MED**
- **File:** `public/app.js:1351`, `public/styles.css:943-945, 1188-1192`
- **Evidence:** `<tr class="empty-row"><td colspan="16">No cruises match your filters.</td></tr>`.
  No CTA, no suggestion to clear filters, no indication of *which*
  filter is the most restrictive, no visual differentiator from the
  loading state. On the mobile card layout the empty row collapses
  oddly because of the `display: block` + `grid` styling (line 1188).
- **Fix:**
  - Add a "Clear all filters" button next to the message.
  - Reference the active filter (the summary string already exists at
    `app.js:2471-2480`).
  - In mobile card layout, ensure the empty row spans both grid
    columns cleanly.

### 4. Performance

#### F4.1 All four provider JSONs are fetched eagerly in parallel — **HIGH**
- **File:** `public/app.js:614-621`
- **Evidence:**
  ```js
  const providerResults = await Promise.all(providers.map(async (provider) => {
    const res = await fetchStaticJson(provider.cruisesUrl);
    ...
  }));
  ```
  Provider JSON sizes (uncompressed on disk, see table below):
  | File                                | Size      |
  |-------------------------------------|-----------|
  | `providers/royal-caribbean/cruises.json`  | 2.64 MB   |
  | `providers/princess-cruises/cruises.json` | 1.92 MB   |
  | `providers/celebrity-cruises/cruises.json`| 1.52 MB   |
  | `providers/ncl-cruises/cruises.json`      | 670 KB    |
  | **Total**                                 | **~6.75 MB** |
  - `fetchStaticJson` uses `cache: 'no-store'` (`app.js:497`) — every
    page load re-downloads the full set, even when the user just wants
    to peek at saved views.
  - The `Promise.all` waits for the slowest. With 6.75 MB to pull and
    parse on the main thread, the first paint of the table is gated
    on the slowest provider, not the local cache.
  - `JSON.parse` of 6.75 MB synchronously blocks the main thread for
    ~600-1500 ms on mid-range devices (depending on engine).
- **Fix:**
  - `ship-wiki-links.json` (32 KB) and `build-info.json` (tiny) are
    already fetched in parallel with `loadData()` — good.
  - Switch the cruise fetches to one of:
    1. **Stream-JSON** (e.g. `oboe.js`, or fetch + manual chunked parse)
       so the table can render the first provider's rows while the
       others are still downloading.
    2. **Lazy-load per provider** on a tab / "Load Princess" button.
    3. **Switch from `cache: 'no-store'` to a stale-while-revalidate
       pattern** using `Cache-Control: max-age=600` on the responses
       (this is a server/CDN change, not a JS change) and remove the
       client-side `no-store` so repeat visits hit the browser cache.
  - Decompress with gzip/brotli at the static-host level — the JSON is
    highly compressible (URLs, repeated enums); a 2.64 MB file is
    usually ~400 KB gzipped.
  - The `oldCruises.json` files (~924 KB combined) are also being
    deployed but the `app.js` never references them — confirm they
    aren't being fetched by anything. (A quick grep shows no
    `oldCruises` reference in `app.js`; they're orphan deployments.)

#### F4.2 Image assets are tiny and reasonable — **INFO**
- **File:** `public/img/ship-mega.png` (40,813 B), `ship-large.png`
  (33,000 B), `ship-medium.png` (18,917 B), `ship-small.png` (10,916 B)
- **Total:** ~104 KB for all four ship silhouettes.
- **Evidence:** These are used as CSS `mask-image` references at
  `styles.css:1953-1959` to paint the ship-tier badge in the row's
  `--brand` colour. The largest is 40 KB; the smallest is 11 KB. No
  oversized assets. They are correctly referenced via `mask-image`
  so they can be re-tinted freely without multiple PNG variants.
- **Assessment:** Sensible. The files are not flagged as oversized.
  - **Optional improvement:** convert the four PNGs to inline-SVG
    silhouettes (each is a single-colour shape used only as a mask)
    — total payload would drop to a few hundred bytes and there'd be
    no per-request image cost at all. A trivial change to
    `styles.css:1952-1959`.

#### F4.3 `app.js` itself is 78 KB minified-equivalent — **LOW**
- **File:** `public/app.js` (size: see `wc -c`)
- **Evidence:** ~80 KB uncompressed JS. That's fine for an
  app of this scope, but a few mega-helpers (`inferSeaDays` at
  `app.js:1250-1341` is ~90 lines and is run for every cruise on
  every filter) could be split out for cache-friendliness. The
  `SITE_CHANGES` array alone (`app.js:54-352`) is ~300 lines of
  static data — a candidate for a separate `site-changes.json` fetched
  on demand by `openSiteChanges()`.
- **Fix:** Optional. Split `SITE_CHANGES` into a JSON fetch (it only
  matters when the user taps the "i" button), and consider splitting
  the URL-state / filter helpers into a separate `filters.js`.

#### F4.4 The `ship-wiki-links.json` (~32 KB) is fetched on init, not lazy — **LOW**
- **File:** `public/app.js:721-731`
- **Evidence:** `fetchShipWikiLinks()` is called from the `init` IIFE
  (`app.js:574`). The 32 KB JSON populates three lookup tables used
  only when `wikiLinks` setting is on (default) AND when rendering a
  row. Since the row render itself is the slow part, the
  wiki-link fetch could equally well be initiated after the first
  table paint, or in parallel with `Promise.all` of providers.
  Currently it races with the provider fetch in a fire-and-forget
  fashion, which is fine — but the `cache: 'no-store'` (`app.js:723`)
  means a second visit re-downloads it.
- **Fix:** Drop `cache: 'no-store'` on this fetch. The file is
  content-hashed at build time (or should be); the browser cache
  will be correct.

#### F4.5 Visitor-count POST happens on every page load — **LOW** (privacy note)
- **File:** `public/app.js:667-691`
- **Evidence:** `recordVisitorCount()` POSTs to a Supabase function
  on every load. The visitor ID is a UUID stored in localStorage
  (`app.js:645-665`). Functionally fine, but:
  - A privacy-focused user with no localStorage still gets a
    "Visitors unavailable" message — that's reasonable.
  - The fetch has no `keepalive: true`, so if the user navigates
    away during the POST, the count may be lost. Minor.
- **Fix:** Add `keepalive: true` to the fetch options so a tab close
  during the POST still records. Optional.

### 5. Mobile / Responsive

#### F5.1 Mobile card layout works well — **INFO**
- **File:** `public/styles.css:994-1230`
- **Evidence:** Below 480px the table becomes a 2-column grid of
  cards. Each card has its own left border in the brand colour via
  `tbody tr[data-provider]` (line 1039). Thead is hidden; data-labels
  are exposed via `::before` content. Ship / itinerary / price cells
  span both columns; the rest fit in 1. Test class is solid.
- **Assessment:** Looks correct on inspection. Could not be tested
  interactively (no device farm available).

#### F5.2 No `overflow-x: auto` fallback for the table between 480px and 860px — **MED**
- **File:** `public/styles.css:968-992, 430-432`
- **Evidence:** At 480px the table becomes a card layout. Between
  480px and 860px the table keeps its row layout but several columns
  are hidden (`.col-launch`, `.col-destination`, `.col-per-night`
  hidden at 1100px; `.col-region` hidden at 860px). The table is
  given `min-width: 0;` at 860px (line 970), so it will shrink. With
  ~10 columns still visible at 800px wide, real-world columns are
  ~70-80px each — readable but tight, and long ship names + the
  multi-cabin price grid will wrap awkwardly. There is no
  `overflow-x: auto` on `.table-wrapper` to allow horizontal scroll
  on these intermediate widths.
- **Fix:** Either add `overflow-x: auto;` to `.table-wrapper`
  between 480px and 860px (preserving the table layout), or hide
  more columns and accept narrower content.

#### F5.3 Mobile filter sheet is a proper `<dialog>` with backdrop + slide-up — **INFO**
- **File:** `public/index.html:116-261`, `public/styles.css:1304-1323`
- **Evidence:** The mobile filter sheet is a real `<dialog>` opened
  with `showModal()` (`app.js:2274`), with `::backdrop` blurred and
  a slide-up animation. Click on backdrop closes. `aria-expanded` on
  the toggle button is updated. iOS-style grabber at the top
  (`styles.css:1332-1336`). Looks polished.

#### F5.4 Sticky summary pill overlaps the sort header on very short viewports — **LOW**
- **File:** `public/styles.css:220-230`, `public/index.html:268-273`
- **Evidence:** `#stickySummary` is fixed at top:0 with z-index:50.
  The thead is also `position: sticky; top: 0; z-index: 2;`
  (`styles.css:435`). When the summary bar is scrolled out, the
  sticky pill appears; if the user then scrolls up, the thead and
  pill can briefly occupy the same screen area at the same `top:0`
  position. The z-index difference means the pill covers the thead —
  probably desirable (the pill says "Showing N sailings — ↑" which is
  a useful summary), but the thead suddenly vanishing under the pill
  is a visible jump.
- **Fix:** Either bump thead `top` to `40px` (the pill's height) so
  the thead never goes under the pill, or accept the current
  behaviour. The current behaviour is actually defensible: the pill
  is the new header.

### 6. Browser Compatibility

#### F6.1 All modern evergreen browsers supported — **INFO**
- **File:** `public/app.js` overall
- **Evidence:** The codebase uses:
  - `const` / `let` (ES2015) — universal.
  - Arrow functions, template literals, destructuring (ES2015).
  - `Map`, `Set`, `Array.from`, `Array.includes` (ES2015).
  - Optional chaining / nullish coalescing — **used** (`app.js:416,
    437, 490, 504, 651, 652, 653, 656, 670, 684, 685, 750, 815-825,
    1143, 1151, 1153, 1154, 1160, 1664, etc.`). This is ES2020.
  - `crypto.randomUUID()` (ES2021 / Web) — used at `app.js:656` with
    a fallback at `app.js:657-659`.
  - `<dialog>` element — used 5× (`index.html:116, 460, 481, 531,
    562, 577`). Supported in Chrome 37+, Edge 79+, Firefox 98+,
    Safari 15.4+. iOS Safari got it in 15.4 (March 2022). Should
    be fine for all "evergreen" browsers in 2026.
  - `IntersectionObserver` — used at `app.js:1140, 2508`, with
    feature-detect fallbacks at `app.js:1139, 2503`.
  - `CSS.supports('selector(:has(*))')`-style `:has()` — used at
    `styles.css:1226, 1228, 1418` for the price button. `:has()` is
    Baseline since Dec 2023 (Chrome 105, Safari 15.4, Firefox 121).
  - `mask-image` — used at `styles.css:1944-1958`. Universal in
    modern browsers with `-webkit-` prefix fallback.
  - `backdrop-filter: blur(2px)` (`styles.css:1322`) — supported
    everywhere modern; not supported in older Edge but Edge is
    dead.
- **Assessment:** No ES2017+ features in a way that would break old
  Edge / iOS 13. The only risk is `<dialog>` on iOS Safari < 15.4
  (~3% of mobile globally as of mid-2024) — but the code has a
  `setAttribute('open', '')` fallback (`app.js:1714, 1723, 1778,
  2275, 1638`) so the page still opens the dialog visually, just
  without the modal backdrop. The static `id="statusBar"` in HTML
  has `display: none` and is only toggled to `display: flex` by
  the JS — without JS, the status bar never appears.

#### F6.2 No `<noscript>` fallback — **LOW**
- **File:** `public/index.html` (no `<noscript>` anywhere)
- **Evidence:** The page is a no-op without JavaScript: the
  skeleton rows sit there forever, the toolbar is visible but its
  `<select>`s have no data, the table headers sort nothing. There
  is no `<noscript>` block to tell the user what happened.
- **Fix:** Add `<noscript><style>.skeleton-row, #statusBar { display: none; }</style><p style="padding:20px">This site needs JavaScript to load cruise data. Please enable scripts and reload.</p></noscript>`
  inside `<body>`.

#### F6.3 No console errors expected at runtime — **INFO**
- **Evidence:** Code paths audited:
  - All `getElementById` / `querySelector` calls either null-check
    before use (`app.js:669, 696, 706, 1300, 1698, 2056, 2147,
    2249, etc.`) or are inside optional chains (`?.`).
  - `JSON.parse` calls are wrapped in `try / catch` (`app.js:528,
    1534, 1763, 2119`).
  - `localStorage` access is wrapped in `try / catch` (`app.js:524,
    559, 565, 1539, 1769`).
  - `new Date(raw)` is `Number.isNaN`-checked before use
    (`app.js:885, 1453, 1455, 2380, 2417, 2730`).
  - `parseInt` / `parseFloat` results are `Number.isFinite` /
    `Number.isNaN` checked.
  - `webCrypto` access uses `globalThis.crypto?.…` with a
    `Math.random()` fallback (`app.js:651-659`).
  - The `Resolve Static URL` helper (`app.js:489-494`) handles
    `file:` protocol by re-routing through `localhost:3000` —
    which means the page is also configured to be developed against
    a local server. Slightly odd but not buggy.
- **Assessment:** Defensive coding throughout. No obvious console
  errors under normal operation. The `host/port fallback` at
  `app.js:493` is a development convenience and harmless in
  production (browser always runs at `http:` or `https:`).

### 7. Code Quality

#### F7.1 Single `app.js` (~2,750 lines) is internally well-organised — **INFO**
- **File:** `public/app.js`
- **Evidence:** Sections are clearly delimited by
  `// ── Section ──` comments at lines 1, 362, 569, 848, 860, 977,
  1391, 1527, 1757, 2168, 2393, 2526, 2712, 2748. Function names
  are consistent (`populateX`, `applyX`, `renderX`, `wireX`,
  `setX`, `formatX`). Helper utilities (escHtml, formatDateDisplay,
  formatDurationDisplay, formatPriceDisplay, absoluteUrl) are all
  near the top of the rendering section.
- **Assessment:** A single-file architecture is a defensible choice
  for a static site with no build step. The author has been
  disciplined about it.

#### F7.2 Module pattern / IIFE — **INFO**
- **File:** `public/app.js:570-599`
- **Evidence:** The `init` is an IIFE; all top-level `let` / `const`
  declarations are file-scoped and never assigned to `window`.
  Functions are also file-scoped. The only `window` references are
  `window.location` / `window.scrollTo` / `window.crypto` (read-only
  globals, fine). No `var` anywhere.
- **Assessment:** Clean. No global pollution. Comments at lines
  17-23, 1528-1530, 1758-1759, 2500-2501 explicitly note the
  ordering constraints imposed by `init()` calling functions before
  they are declared — a sign the author understands TDZ.

#### F7.3 Inline event handlers in HTML couple behaviour to markup — **LOW**
- **File:** `public/index.html` (every `onclick=`, `onchange=`,
  `oninput=` — see F1.4 for the full list)
- **Evidence:** ~80+ inline handlers. Functionally fine because
  CSP is absent and the functions are file-scoped so they are
  reachable from inline attributes. But the codebase *also* uses
  delegated event handlers (e.g. `app.js:2134-2142` for the saved
  views list, `app.js:2149-2155` for sparklines, `app.js:2162-2164`
  for dialog backdrops). The mixed style is inconsistent.
- **Fix:** Pick one. Migrating to `data-action="..."` +
  `addEventListener` delegation would be the modern choice; it
  also makes the F1.1 keyboard-handler story much easier (one
  delegated `keydown` listener, not 16).

#### F7.4 Magic numbers are commented where they matter — **INFO**
- **File:** `public/app.js:44` (ROW_CAP = 300), `:2233-2234` (debounce),
  `:702` (2900ms wave sweep), `:935-939` (age buckets for launch year)
- **Assessment:** Good. The comment at `app.js:42-44` is especially
  useful: it explains the trade-off (3000+ rows cost ~2s to render).
  The `FILTER_DEBOUNCE_MS` comment at `app.js:2229-2233` explains
  the perceptual threshold. The author comments *why*, not
  *what*.

#### F7.5 Stale comment at `app.js:2575` — **LOW**
- **File:** `public/app.js:2575-2577`
- **Evidence:**
  ```js
  // toggleGBP was the UI handler for the now-removed Prices-in-GBP switch.
  // showInGbp stays `true` permanently; client-side USD→GBP conversion still
  // happens for providers that return USD (Celebrity, NCL).
  ```
  Followed by `function getGBPPrice(c)` at line 2579. The
  explanatory comment is helpful, but it sits *above* the empty
  space where `toggleGBP` *used to be* — there's no function
  declaration following it, so the comment block is a header for
  a function that lives 4 lines later. Easy to lose track of when
  refactoring. Move the comment above `getGBPPrice()` itself.

#### F7.6 Some `setAttribute` / `removeAttribute` patterns could be `toggle` — **INFO**
- **File:** `public/app.js:2272, 2276, 2282, 2311, 2325`
- **Evidence:** Manually setting/removing `aria-expanded` and
  `aria-busy`. These could be `el.toggleAttribute('aria-busy',
  isBusy)`. Trivial.

#### F7.7 The `SITE_CHANGES` array is embedded in the JS bundle — **LOW** (also see F4.3)
- **File:** `public/app.js:54-352`
- **Evidence:** ~300 lines of human-readable changelog shipped on
  every page load. The `renderSiteChanges()` function
  (`app.js:1619-1631`) only runs when the user opens the dialog
  (line 579 calls it eagerly, but the DOM only shows it on
  click). The eager call at `init` is unnecessary — the content
  can be rendered on first open.
- **Fix:** Render lazily inside `openSiteChanges()`. Saves nothing
  on first load (the array is still parsed with the script) but
  makes the file easier to read by grouping all static data
  together.

### 8. CSP / Meta Tags

#### F8.1 No Content-Security-Policy meta tag — **HIGH**
- **File:** `public/index.html` (entire `<head>`, lines 3-9)
- **Evidence:** The `<head>` contains:
  - `<meta charset="UTF-8">`
  - `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
  - `<title>Cruise Explorer</title>`
  - `<link rel="icon" href="data:,">`
  - `<link rel="stylesheet" href="./styles.css">`
  - **No** `<meta http-equiv="Content-Security-Policy" …>`.
- **Implications:**
  - The page can load arbitrary scripts and styles (currently
    loads just `./app.js`, but if a future compromise injects
    something it would run unimpeded).
  - The page POSTs to `yttgqscwgmsnewdjqbcc.supabase.co` and
    reads from `open.er-api.com` and `en.wikipedia.org`. These
    domains are baked into the JS — a strict CSP would need
    explicit `connect-src` rules.
  - All inline event handlers (F1.4) require either `unsafe-inline`
    in `script-src` or hashes/nonces. A CSP migration would
    benefit from moving to delegated handlers (F7.3) first so the
    CSP can drop `unsafe-inline`.
- **Fix:** Add a meta CSP, e.g.:
  ```html
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self';
                 script-src 'self';
                 style-src 'self' 'unsafe-inline';
                 img-src 'self' data:;
                 connect-src 'self' https://yttgqscwgmsnewdjqbcc.supabase.co
                            https://open.er-api.com;
                 frame-ancestors 'none';
                 base-uri 'self';
                 form-action 'self';">
  ```
  Note `style-src 'unsafe-inline'` is needed because styles.css
  is currently ~1960 lines of inline-tagged CSS in a `<link>` (a
  static file) — the `'unsafe-inline'` is for the inline
  `style="..."` attributes (e.g. `app.js:1435` and
  `styles.css:1857`). If those were moved to CSS classes the
  CSP could be tightened.

#### F8.2 No `<meta name="description">` — **LOW**
- **File:** `public/index.html:3-9`
- **Evidence:** No description meta. Search engines and link
  previews fall back to whatever they can infer.
- **Fix:** Add `<meta name="description" content="Live aggregator of
  Royal Caribbean, Celebrity, NCL, and Princess cruise sailings with
  filterable prices, dates, and per-cabin price history.">`.

#### F8.3 No `<meta name="theme-color">` — **LOW**
- **File:** `public/index.html`
- **Evidence:** No `theme-color` meta. The header uses a navy
  gradient (`styles.css:31`) and the body background is
  `--gray-50` (`#f8fafc`). Mobile browsers (Chrome on Android,
  iOS Safari) pick the OS default. Setting
  `theme-color="#0d1b2e"` would tint the URL bar / status area to
  match the header.
- **Fix:** Add
  `<meta name="theme-color" content="#0d1b2e">`
  (and optionally
  `<meta name="theme-color" content="#f8fafc" media="(prefers-color-scheme: light)">`
  once dark mode is added).

#### F8.4 No `<link rel="preconnect">` to external origins — **MED**
- **File:** `public/index.html:3-9`
- **Evidence:** The app fires fetches to:
  - `https://yttgqscwgmsnewdjqbcc.supabase.co` (visitor count, subscribe).
  - `https://open.er-api.com` (FX rate).
  - `en.wikipedia.org` (link targets — not a same-origin fetch,
    but external link destinations).
  The DNS + TLS handshake to these hosts costs ~100-300ms each on
  first connection. No `preconnect` warms them up.
- **Fix:** Add:
  ```html
  <link rel="preconnect" href="https://yttgqscwgmsnewdjqbcc.supabase.co" crossorigin>
  <link rel="preconnect" href="https://open.er-api.com" crossorigin>
  ```
  (`crossorigin` is needed because the requests are POST or
  with custom headers.)

#### F8.5 No `<link rel="preload">` for `app.js` or `styles.css` — **LOW**
- **File:** `public/index.html:8, 602`
- **Evidence:** `app.js` is loaded with `defer` (good — does not
  block parsing). `styles.css` is a normal `<link rel="stylesheet">`
  (also does not block JS, but does block first paint). At 67 KB
  uncompressed, the CSS is significant. Preloading it would be
  defensive but is rarely necessary for a single stylesheet
  already in `<head>`.
- **Fix:** Skip — the current approach is correct. `<link rel="preload">`
  for `app.js` is unnecessary because it's `defer`red.

#### F8.6 Favicon is `data:,` (empty) — **INFO**
- **File:** `public/index.html:7`
- **Evidence:** `<link rel="icon" href="data:,">` — this is a
  common trick to suppress the default favicon request. It works,
  but every modern browser still shows a default icon in tabs
  that lack a real favicon. No branding is lost in practice.
- **Fix:** Optional — add a real SVG favicon, e.g.
  `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='28'>%E2%9B%B5</text></svg>">`.

---

## Aggregate Recommendations (priority order)

1. **Make the sort headers keyboard-operable and screen-reader-aware
   (F1.1, F2.2).** The single highest-impact accessibility fix in the
   review. The data is there; it's just not exposed to AT.
2. **Add `aria-live` to the result-count and status bar (F1.2, F1.3).**
   Trivial markup change. Screen-reader users will finally get
   feedback when they filter.
3. **Address the ~6.75 MB eager JSON fetch (F4.1).** Either lazy-load
   providers, stream-parse, or rely on `Cache-Control` + the browser
   cache. This is the only thing standing between the current
   "decent on broadband" experience and "usable on cellular".
4. **Add a CSP `<meta>` tag (F8.1).** Especially because there are
   80+ inline event handlers; a CSP migration is a forcing function
   for cleanup.
5. **Add a Retry button and provider-failure detail to the error
   state (F3.2).**
6. **Extend `prefers-reduced-motion` to the skeleton shimmer and
   the bottom-sheet slide (F1.8).**

## Files Audited (read-only, no modifications)

- `public/index.html` — 604 lines
- `public/app.js` — 2,752 lines
- `public/styles.css` — 1,959 lines
- `public/providers/index.json` — 26 lines, 676 B
- `public/ship-wiki-links.json` — 471 lines, 32 KB
- `public/providers/royal-caribbean/cruises.json` — 2.64 MB (size only)
- `public/providers/celebrity-cruises/cruises.json` — 1.52 MB (size only)
- `public/providers/princess-cruises/cruises.json` — 1.92 MB (size only)
- `public/providers/ncl-cruises/cruises.json` — 670 KB (size only)
- `public/img/ship-mega.png` — 40,813 B
- `public/img/ship-large.png` — 33,000 B
- `public/img/ship-medium.png` — 18,917 B
- `public/img/ship-small.png` — 10,916 B

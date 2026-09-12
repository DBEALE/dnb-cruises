# Scraper coverage review

Reviewed 12 September 2026. Scope: all six active providers and their shared pagination and persistence code. This is a code review with local reproductions, not certification of the current live inventory. No paid feed has been introduced.

## Confirmed issues, in priority order

### P1 — Princess fallback requests never reach the network

`providers/princess-cruises.js`, `collectCruiseData`: both functions passed to `page.evaluate` call `fetchWithTimeout`, a Node-module import that is not defined in the browser page. Their catch blocks suppress the resulting ReferenceError. This affects the fallback products/ships/ports fetch and the missing-voyage pricing batches.

Reproduced the actual pricing callback in a separate JavaScript context with a working `fetch` stub: it returned null with zero network calls. Consequently only automatically captured pricing and embedded fares remain available. The final `cruise.priceFrom !== ''` filter drops completely unpriced voyages. Fix the browser-scope fetches first, then verify batch completeness and preserve known fares on failures.

### P1 — Celebrity selects one departure per product

`providers/celebrity-cruises.js`, search query and `normalizeCruise`: the query requests `lowestPriceSailing` and `displaySailing`, and normalization selects only one. It does not enumerate a product's other sailings. A local input containing two sailings produces one record. The number of additional live dates requires a live API check; the code's inability to retain them is confirmed. Royal Caribbean already has the relevant one-record-per-departure pattern.

### P1 — P&O accepts missing pages as success

`providers/p-and-o.js`, `fetchRoomTypePages`: errors after the first page are caught and replaced with an empty array. The remaining pages and cabin-type passes are still published. A missing cabin pass page can remove a fare, and a cruise missing from every successful pass can disappear entirely. The page cap can also truncate without proving the reported total was reached. Persist/retry failed pages and distinguish incomplete cabin coverage from sold-out cabins.

### P1 — Royal Caribbean and Celebrity can accept truncated pagination

`providers/graphql-cruise-provider.js`, `fetchCruises`: an empty page ends pagination even when the API's reported product total has not been reached. Reproduced a total of two products with one populated page followed by an empty page: the method returns one product successfully. It should reject or resume this incomplete scan rather than publish it as complete.

### P2 — Virgin may retain stale or missing cabin fares after enrichment failure

`providers/virgin-voyages.js`, `enrichCabinPrices`: token acquisition failure or a failed per-voyage cabin request retains prior fares where available. A newly discovered voyage without prior fares remains without cabin prices. The provider still returns a successful listing. Retention is preferable to erasing prices, but freshness and failed-enrichment counts should be exposed. Discovery also trusts one embedded sailings array without an independent inventory count; there is no proof it always contains the full catalogue.

## NCL work in this change

NCL now enumerates all dates in each validated itinerary response. Its refresh queue checkpoints normalized sailings after each successful itinerary; up to 25 known itineraries are requested per scheduled run, with a 1.5-second gap. Prices less than 48 hours old are reused. The batch has a three-minute budget, and discovery is limited to once per day with a separate two-minute budget.

HTTP 403 and 429 stop further work and save a cooldown (initially six hours; repeated blocks increase it, and Retry-After is respected). Successful partial discoveries add routes without deleting previously known ones. The state and status sidecars are hydrated from Pages and included in the data-branch audit snapshots, so a fresh CI worker resumes existing progress.

The site displays known-itinerary refresh counts, last successful price-check time, cooldown and coverage uncertainty. Retained fares keep their original observation time. These measures improve continuity; they cannot discover unknown itineraries while access is denied, guarantee that NCL exposes its full inventory, or make a stale price current.

## Provider-by-provider result

| Provider | Sailing handling | Remaining coverage concern |
| --- | --- | --- |
| Royal Caribbean | Expands all returned sailings; stable sailing IDs | Shared early-empty-page issue; missing class prices have no per-sailing price recovery |
| Celebrity | One selected sailing per product | Other departure dates omitted; shared early-empty-page issue |
| NCL | All dates per validated itinerary; resumable known-route queue | Unknown routes, source access denials and ageing prices remain explicitly uncertain |
| Princess | Iterates voyages but drops those without a price | Broken browser fallback fetches; silent failed price batches |
| P&O | Merges four cabin-type passes by sailing ID | Failed pages are skipped, allowing incomplete fares or sailings to be published |
| Virgin Voyages | Expands embedded voyages; per-voyage cabin requests | Missing/stale fares after token or enrichment failure; unverified catalogue completeness |

## Recommended next repairs

1. Repair Princess browser fetch scope and verify requested-versus-returned voyage IDs.
2. Expand Celebrity's sailing query and keep separate stable departure IDs.
3. Add incomplete-page detection to shared GraphQL and P&O pagination.
4. Extend per-provider freshness and coverage reporting to cabin enrichment failures.

The review findings above are not repaired by the NCL changes. Full automated-suite success verifies existing and new expectations; it is not evidence that every provider's live inventory is complete.

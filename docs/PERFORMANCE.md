# Loaded-catalogue rendering benchmark

Measured locally in headless Chromium on 9 September 2026 with 4,127 cruises,
84,013 hydrated history entries and the cheapest 300 displayed rows. External
requests are blocked; both versions use the same local provider snapshots.

| Operation (median of five runs) | Before | After |
| --- | ---: | ---: |
| Generate HTML for 300 rows | 233.4 ms | 38.3 ms |
| Check onward availability for those rows | 8.9 ms | 0.1 ms |
| Filter catalogue and render first batch | 70.8 ms | 30.4 ms |

These measure JavaScript work after loading, with CPU profiling enabled. They
are not end-to-end interaction latency, network timings or a guarantee for
every device. HTML generation excludes DOM insertion and layout; the filter
measurement includes the synchronous first batch but not later rendering
frames. Showing all thousands of rows still costs more than the default cap.

The changes reuse Intl formatters, cache onward availability by arrival port
and date, and disconnect sparkline observers before replacing rows. Availability
is invalidated when the catalogue, port registry or connection settings change.

Run `node scripts/benchmark-ui.js` with locally populated provider files.
`node scripts/benchmark-ui.js --baseline` serves `public/app.js` from HEAD while
keeping the same local data, allowing comparison before committing changes.
After committing, HEAD will contain the optimized version too. The regular run
also captures `docs/screenshots/performance-loaded-desktop.png`.

## Mobile filter sheet

The row-generation benchmark above missed expensive background layout while
editing filters. `node scripts/benchmark-filters.js` now exercises the actual
sheet at 390 × 844 with the full local catalogue and Chromium's 4× CPU slowdown.
It opens the sheet, changes sorting four times, types an itinerary filter, then
closes the sheet and verifies that the results summary reflects the selection.
Use `--baseline` to serve the HTML, CSS and JavaScript from HEAD.

Before this fix, the interaction sequence caused four background table rebuilds
and repeated long tasks over one second (maximum observed: 2,625 ms). Deferring
filter application alone removed those rebuilds but left a 1,531 ms opening
task. Skipping layout and paint for offscreen mobile cards reduced the largest
observed opening task to 241 ms; the control sequence had one 75 ms long task
and zero background table rebuilds in that run.

These are individual local runs, not percentile latency guarantees. The script
reports main-thread tasks of at least 50 ms, and its opening phase includes
click preparation, opening and animation. It does not measure native dropdown
popup rendering on an actual phone. Results now update once the sheet closes;
filter values, active badges and sort direction update immediately while open.

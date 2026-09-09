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

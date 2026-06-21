# Project Delivery Requirements

These requirements apply to every change made in this repository.

## Verification

- Run the complete test suite with `npm test` after the final code change (`npm.cmd test` is the Windows PowerShell equivalent when script execution policy blocks `npm.ps1`).
- Do not substitute a focused, unit-only, or end-to-end-only test run for the complete suite.
- Do not report the work as complete if any test fails or is skipped because of an implementation or environment problem. Report the exact blocker instead.
- In the final response, state the command run and its pass/fail result.

## Screenshot Evidence

- Provide at least one screenshot artifact with every completed change.
- For a visible UI change, capture the affected flow at a viewport that clearly demonstrates the change. Include mobile and desktop screenshots when the behavior or layout differs between them.
- For non-visual work, capture the most relevant observable result, such as the application behavior or completed full-test output.
- Inspect each screenshot before delivery and confirm it shows the intended result without loading, error, or debug states.
- In the final response, link to every screenshot by its repository-relative artifact path.

## Product Changes

- For user-visible changes, update the in-app `SITE_CHANGES` / "What's changed" content before considering the work complete.

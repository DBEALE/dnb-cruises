# Review 04 — Operations, CI, and Dependencies

**Project:** `dnb-cruises` (Node.js + GitHub Pages + Supabase Edge Functions)
**Date:** 2026-06-09
**Scope:** package metadata, package-lock (declared deps), three GitHub workflows, `playwright.config.cjs`, `test/`, `netlify/`, `alerts.json`, `supabase/`, `.vscode/`, `.claude/`, `.venv/`, `test-results/`, README.

This is a review-only task; **no project files were modified.**

---

## Summary

The project has a working CI/CD chain on GitHub Pages with sensible secrets
handling and a *node-built-in*-based audit-snapshot pattern, but it ships
several minor ops problems: an empty untracked `netlify/` directory, a
README claim about Puppeteer that is not backed by the code, a committed
`test-results/.last-run.json` (despite `.gitignore`), a committed
`.claude/settings.local.json` (a per-developer local config), a stray
`.venv/` Python virtualenv in a Node project, the `test` script chains two
unrelated test runners with no coverage, and the CI workflows pin mutable
action tags rather than commit SHAs. Dependency hygiene is otherwise good —
declared major versions are current or near-current, and `cheerio`,
`jimp`, and `@playwright/test` are at latest. `express` is on the 4.x
line while upstream has shipped 5.x as stable; this is the only real
upgrade-debt item.

---

## Findings

### F-01 — `test` script chains two unrelated runners with no coverage  *(High)*

**Files:** `package.json:11`, `playwright.config.cjs`, `test/*.test.js`, `test/*.e2e.js`

**Evidence**

```json
"test": "node --test test/ui-provider-load.test.js test/princess-cruises-provider.test.js && playwright test"
```

The script runs two distinct runners in a single `npm test` invocation:

1. `node --test` — Node's built-in test runner, executing only the two
   files named explicitly. The other three provider unit tests
   (`celebrity-cruises-provider.test.js`, `ncl-cruises-provider.test.js`,
   `royal-caribbean-provider.test.js`, `shared-region.test.js`) are
   *never* run by `npm test`. They are exercised by neither the unit nor
   the e2e runner.
2. `playwright test` — Playwright, matching `testDir: ./test` and
   `testMatch: /.*\.e2e\.js$/` (`playwright.config.cjs:6-7`).

Issues:

- The two-runner chain silently skips 4 of 6 unit-test files because
  `node --test` defaults to `*.test.js` only when run with a directory —
  here it gets a file list and ignores everything else.
- `playwright.config.cjs:7` only matches `*.e2e.js`, so `ui-provider-load.test.js` (the
  one file the chain *does* call via `node --test`) is the same file
  that Playwright would otherwise skip. The two runners are
  disambiguated by file name, not by runner.
- No coverage is collected. `node --test --experimental-test-coverage`
  exists (Node 20+) and `playwright.config.cjs` has no `reporter: ['html']`
  or coverage hook. The repo has zero coverage signal.
- Tests are **not run in CI** at all — none of the three workflows
  (`deploy-pages.yml`, `deploy-on-push.yml`, `deploy-edge-functions.yml`)
  invoke `npm test`. CI is deploy-only.

**Fix**

- Either consolidate on a single runner (drop `node --test` and have
  Playwright run everything — Playwright can drive `node:test` via
  the `node:test` global), or expand the file list explicitly so all
  unit tests are picked up: `node --test test/*.test.js`.
- Add a CI job (a `test.yml` workflow on PR) that runs `npm test` and
  uploads artifacts. Without that, a broken provider will still deploy.
- Add coverage: `node --test --experimental-test-coverage` and
  `playwright test --coverage` (Playwright supports v8 coverage
  natively).

---

### F-02 — CI workflows pin mutable action tags, not SHAs  *(High)*

**Files:** `.github/workflows/deploy-pages.yml:25-43,111,114,119`, `.github/workflows/deploy-on-push.yml:25-29,43,46,51`, `.github/workflows/deploy-edge-functions.yml:13-15`

**Evidence**

```
uses: actions/checkout@v4
uses: actions/setup-node@v4
uses: actions/cache@v4
uses: actions/configure-pages@v4
uses: actions/upload-pages-artifact@v3
uses: actions/deploy-pages@v4
```

All third-party GitHub Actions are referenced by mutable major-version
tag rather than by commit SHA. A supply-chain compromise of any of
those actions (or a malicious tag rewrite by the publisher) would run
unverified code inside the deploy workflow, with access to
`GITHUB_TOKEN` (used at `deploy-pages.yml:66` to push to the `data`
branch), `RESEND_API_KEY`, `ALERT_EMAIL`, `SUPABASE_*`, and `TWILIO_*`
secrets.

**Permissions review** (this part is *good*):

- `deploy-pages.yml:8-11` declares a per-workflow `permissions:` block
  with the least-privilege set required (`contents: write`, `pages:
  write`, `id-token: write`).
- `deploy-on-push.yml:8-11` is tighter still — `contents: read` plus
  the Pages set. Correct.
- `deploy-edge-functions.yml:9-24` has **no** `permissions:` block —
  it falls back to the repository default. Currently it uses
  `SUPABASE_ACCESS_TOKEN` but the lack of an explicit block is a
  small hygiene issue (see F-08).

**Other**

- No secrets are echoed to the log; the only `console.log` referencing
  an env var (`scripts/fetch-cruises.js:253` — "no RESEND_API_KEY or
  ALERT_EMAIL — skipping email") only confirms presence/absence.
- `continue-on-error: true` on the data-branch snapshot step
  (`deploy-pages.yml:64`) is correct — audit log is best-effort.

**Fix**

- Pin each action to a full commit SHA and a version comment, e.g.:

  ```yaml
  uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1
  ```

  Use `dependabot.yml` to keep them current.
- Add an explicit (empty if not needed) `permissions:` block to
  `deploy-edge-functions.yml`.

---

### F-03 — `.claude/settings.local.json` is committed to the repo  *(High)*

**Files:** `.claude/settings.local.json` (tracked), `.claude/settings.json` (tracked)

**Evidence**

`git ls-files` shows both files committed:

```
.claude/settings.json
.claude/settings.local.json
```

`.claude/settings.local.json` contains per-developer `permissions.allow`
entries such as `Bash(node server.js)`, `Bash(npm test *)`,
`Bash(git commit *)`, `Bash(sed -n '...')`, etc. — a developer's
local shell-allowlist. Committing it:

1. Publishes the developer's personal Claude permission grants to the
   public repo. Anyone cloning gets the same allow list, which is
   effectively a pre-granted action policy for an AI agent on their
   machine.
2. Pairs poorly with `Bash(git commit *)` and `Bash(npm install *)` —
   these are *wide* and could be abused by a prompt-injection attack
   that lands inside an issue or a fetched doc.
3. `.claude/settings.json` (the shared file) is fine and is meant to
   be committed. The `.local.json` sibling is the per-user one and
   should be ignored.

The file is also out of date — it doesn't include newer permissions
the project has started using (e.g. `Bash(playwright ...)`) — so it
provides stale guidance, which is arguably worse than no guidance.

**Fix**

- Add `.claude/settings.local.json` (and ideally the whole `.claude/`
  directory except for `settings.json`) to `.gitignore`.
- `git rm --cached .claude/settings.local.json` and commit.
- Trim `Bash(git commit *)`, `Bash(git stash *)`, `Bash(npm install *)`
  from the shared file — these are dangerous when an AI agent can be
  manipulated. The list should be scoped to read-only shell commands
  and the project's own scripts.

---

### F-04 — `test-results/.last-run.json` is committed despite `.gitignore`  *(Medium)*

**Files:** `.gitignore:10`, `test-results/.last-run.json` (tracked)

**Evidence**

`git ls-files` lists `test-results/.last-run.json` even though
`.gitignore` contains `test-results/`. This is the classic "added
before the ignore rule" trap. The file is a Playwright artifact
(`{"status":"passed","failedTests":[]}`) and has no business being
in the repo.

No script in the repo depends on `test-results/` persisting across
runs. The `.gitignore` rule is correct; the existing tracked file is
the mistake.

**Fix**

- `git rm --cached test-results/.last-run.json` (then commit).
- Consider tightening `.gitignore` further with
  `test-results/` plus explicit `playwright-report/` and
  `blob-report/` ignores to prevent the same problem recurring.

---

### F-05 — `netlify/` directory is dead leftover  *(Low)*

**Files:** `netlify/functions/` (empty, untracked)

**Evidence**

`netlify/` is untracked, contains only an empty `functions/`
subdirectory, and is not referenced anywhere in code, workflows, or
docs. The README (`README.md:40-42`) describes GitHub Pages as the
deployment target, and all three workflows use the
`actions/deploy-pages` family. There is no `netlify.toml`, no
`netlify-cli` dependency, and no Netlify badge or link.

A search for `netlify` across the tracked code returns only the
project-review plan file.

**Fix**

- Delete the directory: `mavis-trash netlify/` (it's empty, so this is
  zero-risk).
- If Netlify was ever intended, document it in README and add a
  `netlify.toml`; otherwise keep it removed.

---

### F-06 — README claims Puppeteer; the codebase has no Puppeteer dependency  *(Medium)*

**Files:** `README.md:38`, `package.json:14-17`

**Evidence**

`README.md:36-38` instructs:

> ```bash
> node scripts/fetch-cruises.js
> ```
>
> The first fetch can take up to 90 seconds because Puppeteer launches
> a full headless Chrome instance to render the dynamic page.

But:

- `package.json` lists only `cheerio` and `express` as runtime
  dependencies; no `puppeteer` or `puppeteer-core` in `dependencies`
  or `devDependencies`.
- A content search for `puppeteer` returns zero matches in any
  non-`.mavis` file.
- The Playwright browser install at `deploy-pages.yml:42-43` is the
  only headless-Chrome installation, and it's used for Playwright
  tests, not scraping.

The README is therefore wrong about the implementation, and the
"90 seconds" figure (driven by cold-start headless Chrome) is also
inaccurate for the current code path.

**Fix**

- Rewrite the README paragraph to match the actual implementation,
  e.g.:

  > The first fetch makes live HTTP requests to each provider and
  > may take up to ~60 seconds while the providers' servers respond.

- Confirm that `node scripts/fetch-cruises.js` actually runs without
  a Puppeteer install, then drop the misleading line.

---

### F-07 — Stray `.venv/` Python virtualenv in a Node project  *(Low)*

**Files:** `.venv/` (untracked, not used by the project)

**Evidence**

`.venv/` is a Python 3.13 virtualenv created at
`C:\Users\Admin\AppData\Local\Microsoft\WindowsApps\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0`
(see `.venv/pyvenv.cfg:3`). It has its own internal `.gitignore`
(`*`), so it does not pollute the repo, but it sits inside the
Node project tree and will:

- Show up in editors, file watchers, and search indexes.
- Be slow on case-insensitive filesystems (lots of small files).
- Confuse anyone `ls`-ing the repo: "why is there Python in a
  Node project?"

No file in the project uses Python. No package.json script invokes
`python` or `pip`. No `requirements.txt` exists. It's a side-effect
of the developer running `python -m venv .venv` accidentally (or
intentionally) inside the repo.

**Fix**

- Move the venv outside the repo (`python -m venv ../.venv-…`) or
  simply delete it; nothing in the project needs it.
- Add `.venv/` to the root `.gitignore` for defense in depth (it
  already self-ignores, but a project-level rule documents intent).

---

### F-08 — `deploy-edge-functions.yml` has no `permissions:` block  *(Low)*

**Files:** `.github/workflows/deploy-edge-functions.yml:9-24`

**Evidence**

The workflow does not declare a `permissions:` block, so it inherits
the repository default. The job uses only `SUPABASE_ACCESS_TOKEN`
(no `GITHUB_TOKEN` for the push), but in the future a contributor
adding `actions/checkout` with the default `contents: read` (now
correct) plus a `git push` step would need to think about the token
leak. Declaring `permissions: { contents: read }` explicitly is
defense in depth.

**Fix**

- Add a minimal `permissions: { contents: read }` block at the top
  of the workflow, matching the hygiene already in `deploy-on-push.yml`.

---

### F-09 — `alerts.json` is intentionally committed and is read by code  *(Informational)*

**Files:** `alerts.json` (root), `scripts/fetch-cruises.js:243,266,270`

**Evidence**

`scripts/fetch-cruises.js:265-271` reads `alerts.json` at runtime and
matches new cruises against its criteria. The file is therefore
**not** stale — it is the source of truth for what alerts the
scrape pipeline will email out. Committing it to the repo (rather
than keeping it in repo as a runtime config) is the right call here
because:

- The scrape workflow runs from a fresh clone and needs the alert
  criteria available without external state.
- It's a low-sensitivity data file (just filters: region, price,
  nights).

No secrets are in the file. The `RESEND_API_KEY` and `ALERT_EMAIL`
are correctly read from environment (workflow secrets) and the
script only logs whether the env vars are *present* (not the
values), so nothing leaks to the log.

**Fix**

- No action needed. (If the alerts ever need to be per-environment,
  consider moving to a `public/providers/.../alerts.json` or a
  Supabase-stored config; but for now the design is sound.)

---

### F-10 — Dependency hygiene: express is the only major-bump candidate  *(Low)*

**Files:** `package.json:14-24`, `package-lock.json` (declared deps)

**Evidence**

| Dep                 | package.json | latest   | lockfile     | Note                                      |
|---------------------|--------------|----------|--------------|-------------------------------------------|
| cheerio             | `^1.2.0`     | 1.2.0    | 1.2.0        | Current                                    |
| express             | `^4.18.2`    | 5.2.1    | 4.22.1       | 4.x is in maintenance; 5.x is stable      |
| jimp                | `^1.6.1`     | 1.6.1    | 1.6.1        | Current                                    |
| @playwright/test    | `^1.59.1`    | 1.60.0   | 1.59.1       | One minor behind                           |

- **cheerio 1.2.0** has `engines: { node: ">=20.18.1" }` upstream,
  but the project still pins `node >= 18.0.0` in `package.json:19`.
  The lockfile resolves to 1.2.0, so this is currently a latent
  issue — `npm install` on Node 18.0–20.17 would likely warn or
  fail at install time on a fresh dep fetch. Either bump
  `engines.node` to `>= 20.18.1` (CI is already on Node 20, see
  `deploy-pages.yml:31` and `deploy-on-push.yml:31`) or pin
  cheerio to the 1.0.x line. *(Low)*
- **express 4 → 5** is the only real upgrade debt. Express 5 is
  GA, removes deprecated APIs (path-to-regexp, etc.), and
  improves async error handling. The lockfile resolves to
  4.22.1 (caret). The risk is moderate — `server.js` is 53 lines
  of trivial middleware, so a test-and-upgrade cycle would be
  small. Schedule as a separate PR.
- **jimp** is used only by `scripts/process-ship-silhouettes.js`
  (`require('jimp')` at line 19), which is **not** a `package.json`
  script target. So jimp *is* used — but only by a script the
  project doesn't run automatically. If the silhouette pipeline is
  one-shot (run once to produce `public/img/ship-*.png`, which
  exist and are committed), jimp can be removed from
  `devDependencies` and `process-ship-silhouettes.js` archived.
  Currently it's pure bloat in `npm install`. *(Low)*
- **Unused devDeps check:** `jimp` is the only one in question;
  see above. Everything else in `devDependencies`
  (`@playwright/test`) is used.
- **`node --watch`** is in the `dev` script; that's been a Node
  built-in since 18.11, so no issue.
- **Node 20+ features** check: no `structuredClone`, no top-level
  `await` in CommonJS files, no `??` patterns beyond what Node 14+
  supports. The `??` operator is used heavily in providers
  (`providers/princess-cruises.js`, `providers/ncl-cruises.js`,
  `providers/celebrity-cruises.js`, `providers/royal-caribbean.js`)
  and in `scripts/notify-subscribers.js` — these are Node 14+
  compatible. So the `engines: ">= 18"` claim is honest.

**Fix**

- Bump `express` to `^5.0.0` in a follow-up PR with a smoke test of
  `server.js`.
- Either bump `engines.node` to `>= 20.18.1` (matches CI) or pin
  `cheerio` to `^1.0.0` if Node 18 support is still required.
- If the silhouette pipeline is one-shot, move
  `scripts/process-ship-silhouettes.js` + `jimp` out of the repo
  (or convert jimp to a developer-only optional dep).

---

### F-11 — `supabase/config.toml` is minimal; no API keys committed  *(Informational)*

**Files:** `supabase/config.toml:1`, `supabase/migrations/`, `supabase/functions/`

**Evidence**

`supabase/config.toml` is a single line:

```toml
project_id = "yttgqscwgmsnewdjqbcc"
```

The hard-coded `project_id` is the public Supabase project reference —
not a secret. It is intentionally embedded in the deployed client code
(`public/app.js:72` references the same project at
`https://yttgqscwgmsnewdjqbcc.supabase.co/...`), so it must be
publicly readable. No API keys are committed.

The two migrations (`20260503000000_create_subscriptions.sql`,
`20260609000000_create_site_visits.sql`) and the three edge functions
(`subscribe`, `twilio-webhook`, `visitor-count`) are present and
referenced by `deploy-edge-functions.yml`. This all looks healthy.

**Fix**

- No action needed.

---

## What looks good (no action)

- `package.json:6-13` scripts are minimal and well-named; `start` and
  `dev` use Node built-ins.
- `package-lock.json` is present and `lockfileVersion: 3`.
- `playwright.config.cjs:19-24` `webServer` correctly starts
  `npm start` and reuses an existing server during local dev.
- `deploy-pages.yml:13-15` uses `concurrency: { group: pages,
  cancel-in-progress: true }` — good for avoiding overlapping
  deploys.
- `deploy-pages.yml:64` `continue-on-error: true` on the data-branch
  snapshot keeps the deploy from blocking on audit log issues.
- `test/ui-provider-load.test.js` is a particularly thorough sandbox
  test of the inline frontend script (uses `node:vm`); this is a
  good pattern.
- `scripts/fetch-live-cruise-data.js:14-16` deliberately uses only
  Node built-ins so the push-only workflow can run it without
  `npm ci`. Clever.
- The data-branch audit pattern (`deploy-pages.yml:62-99`) gives a
  history of cruise snapshots without polluting `main`.
- `.gitignore` is sensible: `node_modules/`, `.env`, generated
  `public/build-info.json`, generated `public/providers/*/cruises.json`,
  and `test-results/`.

---

## Top 3 things to fix first

1. **F-01** — `npm test` silently skips 4 of 6 unit tests and there
   is no CI test job at all. A broken provider will deploy without
   anyone noticing. **Fix:** expand the `node --test` file list and
   add a `test.yml` workflow that runs on PR.
2. **F-03** — `.claude/settings.local.json` is committed, with broad
   `Bash(git commit *)` / `Bash(npm install *)` allows. **Fix:** add
   to `.gitignore`, `git rm --cached`, narrow remaining allows.
3. **F-02** — Workflows pin `actions/*@vN` instead of commit SHAs.
   **Fix:** pin SHAs (and add `dependabot.yml` to track updates).

(F-04, F-05, F-06, F-07, F-08, F-10 are nice-to-haves; F-09, F-11
are informational.)

# Glidepath — product roadmap to production grade

Glidepath today is a working, honestly-documented forecasting demo: real
public data, a nightly server-side pipeline, a Prophet tactical model, an
elasticity strategic model, scenario/event tooling and real export formats.
This roadmap lays out what separates that from a **production-grade,
open-source forecasting tool an airport planning team could actually adopt**,
in dependency order. Phases are sequenced so each one ships value on its own;
dates are deliberately absent — the gates are the criteria at the end of each
phase, not the calendar.

**Where it stands (July 2026 audit):** both test suites green (22 Node,
17 pytest), committed bundle byte-identical to a fresh build, least-privilege
CI workflows, no synthetic data, lazy per-airport loading, graceful
degradation on every feed. The gaps are the ones you'd expect of a
portfolio-scale project: no license, two CDN-loaded export libraries, a
single-holdout backtest standing in for real forecast evaluation, no US/UK
coverage, no accessibility fallback for charts, and no packaged way for
someone else to run their own instance.

---

## Execution status — 2026-07 (phases 0–3 executed)

Shipped in this pass, verified by the test suites (44 Node / 22 pytest) and
an end-to-end browser smoke run:

- **Phase 0 — done**, two exceptions: MIT `LICENSE`, PptxGenJS vendored,
  CSP meta tag, loud nightly failures (per-step outcomes + staleness/anomaly
  checks + auto-filed pipeline-health issue), in-app staleness banner,
  SECURITY/CONTRIBUTING/CHANGELOG/issue templates. *Deferred:* SheetJS
  self-hosting (≥0.19 isn't published to npm — no integrity-checked tarball
  exists; host CSP-pinned instead) and Action SHA-pinning (needs the
  authentic SHAs from the GitHub API, unreachable from the sandbox this ran
  in — do not pin to guessed hashes).
- **Phase 1 — done except two research items:** rolling-origin backtests
  (3×12mo), seasonal-naïve skill scores, measured interval coverage, the
  held-out predicted-vs-actual disclosure panel, monthly forecast archive,
  in-browser Holt-Winters (ETS) for uploaded gateways, a real Prophet fit in
  CI. *Deferred:* per-airport model *selection* (ship-the-baseline-when-it-
  wins needs a season of archived skill scores first) and auto-fitting the
  elasticity coefficient (8–10 annual observations spanning COVID would
  produce false precision — kept as a documented assumption).
- **Phase 2 — offline-verifiable subset done:** schema validation as a CI +
  nightly gate, staleness/anomaly checker, provenance manifest,
  fixture-tested fetcher parsing (Eurostat JSON-stat, IMF derivation, BTS
  column mapping). *Deferred:* new live feeds (BTS TranStats, UK CAA, ANAC,
  BITRE) — each needs live API probing against the real endpoints, which
  the execution sandbox couldn't reach; shipping untested fetchers would
  violate the no-garbage-data rule.
- **Phase 3 — gate items done:** capacity constraints with
  constrained-vs-unconstrained trajectories and spill (UI + CSV), the
  design-day / peak-hour panel, shareable scenario URLs (sanitized on
  decode). *Deferred:* multi-airport comparison, presets-as-data, and
  chart images inside PPTX/DOCX — product depth that shouldn't gate the
  hardening/rigor work landing.

---

## Phase 0 — Open-source foundations & security hardening

*Theme: make it safe and legitimate to adopt. Everything here is small,
none of it is optional for a public tool.*

1. **Choose and add a license.** There is currently **no LICENSE file**, so
   despite the "open source" positioning, nobody can legally reuse this.
   MIT or Apache-2.0 both fit (Apache-2.0 adds an explicit patent grant);
   add `LICENSE`, a `license` field in `package.json`, and per-file headers
   are unnecessary. This is the single highest-leverage item in the plan.
2. **Self-host the export/upload libraries.** `GP_loadScript` pulls SheetJS
   (cdn.sheetjs.com) and PptxGenJS (jsdelivr) at runtime with no subresource
   integrity hash — a compromised CDN could run arbitrary code in a session
   holding a visitor's uploaded data. Vendor both pinned builds into
   [`vendor/`](vendor/README.md) exactly as React already was (same
   rationale, same README table), or at minimum add `integrity` +
   `crossorigin="anonymous"` to the injected script tags. Free-text fields
   in generated files are already escaped (`GP_csvCell`/`GP_escapeHtml`);
   this closes the remaining supply-chain edge.
3. **Add a Content-Security-Policy.** GitHub Pages can't set headers, but a
   `<meta http-equiv="Content-Security-Policy">` tag in `index.html` can
   pin `script-src` to `'self'` (plus the two CDNs until item 2 lands) and
   `connect-src 'self'` — cheap defense-in-depth for a static app.
4. **Pin GitHub Actions to commit SHAs** in all three workflows
   (`actions/checkout@v4` → `@<sha>`), and add Dependabot/Renovate for the
   one npm dep, the pinned pip requirements, and the Actions themselves.
5. **Make nightly failures loud.** Every pipeline step is
   `continue-on-error: true` — right for keeping last-good snapshots, wrong
   for observability: a feed can silently rot for weeks. Add a final
   workflow step that fails (and opens/updates a pinned issue) when any
   fetcher failed or when `generatedAt` of any snapshot exceeds N days, and
   surface a "data as of …" staleness banner in the app when the committed
   snapshot is older than ~10 days.
6. **Community scaffolding:** `CONTRIBUTING.md` (local setup already
   documented in the README — link it), `SECURITY.md` with a disclosure
   contact, issue/PR templates, and a `CHANGELOG.md` seeded from the git
   history.

**Gate:** a stranger can legally fork it, knows how to report a
vulnerability, and a dead feed pages somebody within a day.

## Phase 1 — Forecasting rigor

*Theme: earn the numbers. A production forecasting tool is judged on
calibration, not UI.*

1. **Rolling-origin backtesting.** Replace the single 12-month holdout in
   `backtest_mape()` with rolling-origin evaluation (e.g. 6 folds × 12-month
   horizons) per airport per metric; report MAPE distribution, not a point.
2. **Benchmark against naïve models.** Fit seasonal-naïve and ETS/SARIMA
   baselines in the same nightly run and publish a *skill score* (Prophet vs
   seasonal-naïve) in the model card. Where Prophet doesn't beat the
   baseline for an airport, ship the baseline — the model registry becomes
   per-airport model *selection*, disclosed in the UI.
3. **Interval calibration.** The band claims P10–P90; verify empirical
   coverage in backtests and disclose it (a "80% interval covered 74% of
   held-out months" line in the model card). Recalibrate `interval_width`
   per airport if systematically off.
4. **Forecast accountability over time.** Archive each nightly forecast
   (a dated `forecasts-history/` snapshot or a git-tag scheme) and add a
   "past forecasts vs what actually happened" view — the single most
   trust-building feature a forecasting product can have.
5. **Elasticity model validation.** The long-term model
   (`g = GDPpc·ε + pop + 0.5·tourism + lcc − 0.18·fuel`) uses defensible but
   asserted coefficients (the 0.5 tourism weight, 0.18 fuel drag, damped 0.6
   cargo beta). Document sources (IATA/ICAO elasticity literature), fit the
   income-elasticity term against each airport's own observed history where
   long enough, and show fitted-vs-assumed in the UI.
6. **Short-term forecasts for uploaded data.** Prophet stays server-side,
   but a client-side Holt-Winters/ETS implementation (small, dependency-free
   JS) can give uploaded gateways a tactical forecast with the same
   model-card honesty ("ETS, fit in your browser — not Prophet").
7. **Extend the Python test suite** to cover an actual (tiny, cached) Prophet
   fit behind a marker, so a Prophet/pandas version bump can't break the
   nightly unnoticed (the pinned `requirements.txt` makes this feasible).

**Gate:** every published number carries a measured, disclosed error; the
tool can show you how wrong it has historically been.

## Phase 2 — Data platform breadth & quality

*Theme: more airports, provable data quality.*

1. **Wire US coverage for real.** `fetch-bts.mjs` found no monthly dataset in
   the Socrata catalog; switch to BTS TranStats prezipped T-100 downloads
   (bulk CSV per year) which are stable and complete, and expand beyond the
   current 4-airport probe list to all US airports above a volume floor.
2. **Add national statistics feeds** in priority order of API friendliness:
   UK CAA airport statistics, Brazil ANAC, Australia BITRE, Japan MLIT.
   Each new fetcher follows the established contract: own its entries in
   `activity-index.json` + `series/`, never clobber other sources, keep
   last-good on failure, no synthetic data.
3. **Schema validation as a pipeline gate.** Define JSON Schemas for every
   snapshot shape (`activity-index`, `series/<IATA>`, `macro`, `imf-weo`,
   `forecasts/<IATA>`) and validate in CI and at the end of the nightly run
   before commit — a malformed upstream change should keep last-good, not
   ship garbage.
4. **Feed anomaly detection.** Flag (not block) suspicious deltas between
   snapshots — an airport's history shrinking, a >30% level shift in
   already-published months, a unit change — into the nightly summary issue.
5. **Recorded-fixture tests for fetchers.** Each fetcher gets a test run
   against checked-in captured API responses (Eurostat JSON-stat, StatCan
   WDS, IMF DataMapper), so parsing regressions surface in PR CI instead of
   at 03:17 UTC.
6. **Per-snapshot provenance manifest:** one `data/manifest.json` with source
   URLs, retrieval timestamps, licenses of each upstream dataset, and row
   counts — the audit trail the export screen already gestures at.

**Gate:** four+ markets live, every snapshot schema-validated, a bad upstream
day cannot corrupt the published data.

## Phase 3 — Product depth for airport planners

*Theme: close the gap between "demand curve" and "what planners actually
present to their boards".*

1. **Constrained vs unconstrained demand.** Let a user enter capacity
   constraints (annual pax cap, movements/hour, terminal m²) and show the
   spill: unconstrained demand vs capacity-constrained throughput — the
   core chart of every airport master plan.
2. **Design-day / peak-hour profiles.** Derive busy-day and peak-hour
   factors from the monthly seasonality (with disclosed assumptions), since
   terminal and runway planning happens at that granularity, not annual.
3. **Scenario sharing.** Encode gateway + levers + events in a shareable URL
   (the session JSON, compressed into the fragment) so a scenario can be
   sent to a colleague without a file round-trip. Validate imported state
   as strictly as `importSession` does today.
4. **Multi-airport comparison** (system planning): overlay 2–3 gateways'
   histories and forecasts, same levers applied.
5. **Scenario presets as data**: move the preset library (`PRESETS`) into a
   JSON file so users and contributors can add industry scenarios (fuel
   shock calibrated to 2022, pandemic calibrated to 2020) without code.
6. **Report polish:** charts rendered into the PPTX/DOCX (as images from the
   existing SVGs), configurable branding block, and a methodology appendix
   auto-included from the model cards.

**Gate:** a planner can produce a board-ready constrained-demand pack from
public data in under ten minutes.

## Phase 4 — Production engineering (runs parallel to 1–3)

*Theme: keep velocity safe as the codebase grows.*

1. **Typing.** Add TypeScript checking via JSDoc annotations (`checkJs`) or a
   full `.tsx` migration; the deliberate shared-global-scope architecture
   (see README § Architecture) can be preserved with a declaration file for
   the `GP_*` surface, or retired in favor of real ES modules once types
   make the cross-file contracts explicit — decide then, not now.
2. **End-to-end tests.** Playwright smoke suite: boot, pick a catalogue
   airport, walk every screen, upload a CSV, generate each export, import a
   session. Run on PR CI against the committed snapshots (no network).
3. **Accessibility to WCAG 2.1 AA.** The known limitation in the README:
   every SVG chart gets an off-screen data-table fallback and an aria
   summary; full keyboard navigation for levers and the event editor;
   contrast audit of the dark/pink palette; `prefers-reduced-motion`.
4. **Performance budget in CI:** bundle-size check (the app deliberately
   ships one small JS file — keep it provable), Lighthouse CI on the
   deployed preview.
5. **Error telemetry, opt-in and privacy-preserving** (a self-hosted
   endpoint or none at all — never a third-party tracker; the "nothing
   leaves the browser" promise for uploaded data is a product feature).
6. **Versioned releases:** tag releases, generate release notes from the
   changelog, and treat `main` as deployable-always (it already is — keep
   it that way under the heavier CI).

**Gate:** a regression in any screen, export, or the bundle size fails a PR
before a human reviews it.

## Phase 5 — Distribution & community

*Theme: from "a site you can visit" to "a tool you can run".*

1. **"Deploy your own" path.** The architecture is already fork-friendly
   (static site + Actions); productize it: a template-repo button, a setup
   doc (the four steps in `data/README.md` § Deploy, expanded), and a
   config file (`glidepath.config.json`) for instance-level choices —
   which markets to fetch, volume floor, branding.
2. **Private-data mode for airport teams.** The upload path already keeps
   data in-browser; add an *instance* mode where an airport commits its own
   confidential series to a private fork and the nightly pipeline fits
   Prophet on it server-side — same code, their runner, their data never
   leaving their repo.
3. **Connector plugin contract.** Formalize what `fetch-activity.mjs` and
   `fetch-bts.mjs` already do by convention (own your entries, never
   clobber, last-good on failure) into a documented interface so third
   parties can contribute national feeds as standalone fetchers.
4. **Docs site:** methodology handbook (Prophet settings, COVID handling,
   elasticity derivation, per-source caveats like the CATSA screened-pax
   proxy), user guide, and the accuracy-tracking dashboards from Phase 1.
5. **Governance:** maintainer expectations, review requirements for
   model-affecting changes (a forecast-methodology change needs a backtest
   comparison attached), and a public roadmap issue tracker replacing this
   file's static form.

**Gate:** an airport IT team can stand up a private, self-updating instance
in an afternoon without reading source code.

---

## 1.0 release criteria (the "production grade" checklist)

- [ ] LICENSE, SECURITY.md, CONTRIBUTING.md in place (Phase 0)
- [ ] No un-hashed third-party script at runtime; CSP present (Phase 0)
- [ ] Nightly failures alert within 24h; UI discloses snapshot staleness (Phase 0)
- [ ] Rolling backtests with published skill scores and interval coverage per airport (Phase 1)
- [ ] Past-forecast accountability view live (Phase 1)
- [ ] ≥4 markets, schema-validated snapshots, fixture-tested fetchers (Phase 2)
- [ ] Constrained-demand + design-day outputs (Phase 3)
- [ ] Playwright E2E green in CI; WCAG 2.1 AA audit passed (Phase 4)
- [ ] Template-repo deployment path documented and tested by an outside user (Phase 5)

## Non-goals

- **Real-time or intra-day data.** Glidepath is a planning tool; monthly
  granularity with nightly refresh is the contract.
- **Proprietary data sources.** The catalogue stays public-data-only; private
  data enters only through the in-browser upload or a self-hosted fork.
- **A backend service.** The static-site + Actions architecture is a feature
  (zero hosting cost, trivially forkable, nothing to breach). Anything that
  requires a server should ship as part of the self-host story, not as a
  central service.
- **Deep-learning forecasting.** With ~100–150 monthly observations per
  series, well-tuned classical models are the honest ceiling; effort goes to
  calibration and disclosure, not architecture novelty.

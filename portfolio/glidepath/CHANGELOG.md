# Changelog

Notable changes to Glidepath. Dates are UTC.

## Unreleased — model corrections & annual views (2026-07)

### Fixed
- Segment-targeted shock events now ground movements: flights scale with the
  TOTAL passenger factor the stacked events produce, so a single-sector
  collapse (e.g. a permanent transborder dip) pulls movements down in
  proportion — previously only all-traffic events touched movements, leaving
  them flat while passengers fell, contradicting the model's own
  movements ∝ pax coupling. Cargo still moves only with all-traffic events
  (a sector passenger shock isn't a freight shock).
- Event recovery glide off-by-one: the linear glide back to baseline now has
  `recovery` genuinely-recovering months, reaching baseline the month AFTER
  the window — previously the glide landed exactly on baseline in its last
  month, making `recovery: 1` indistinguishable from `recovery: 0`.
- Binding capacity caps now show up in the numbers, not just the amber chart
  line: the Baseline-assumptions KPIs (end value, CAGR, vs-baseline) report
  SERVED traffic with demand disclosed alongside (they used to read
  unconstrained demand, so a slot cap showed "+0 vs base"); the Long-term
  movements KPI and month-by-month table do the same; the Event-simulator
  headline KPI likewise. XLSX gains the constrained/spill columns the CSV
  already had, plus constrained summary rows; the PPTX headline KPIs and
  trajectory table and the DOCX brief report served values and spill under
  a binding cap.

### Added
- Annual/Monthly toggle on the Baseline-assumptions "Live impact" chart and
  the Event-simulator "Forecast with shocks" chart — annual mode plots the
  yearly roll-ups (base-year anchor included, constrained overlay too;
  event shading windows map to years) so annual totals read directly while
  shaping a forecast.
- Constrained (capacity) legend entry on both charts whenever a cap actually
  bites the metric on screen, and a compact axis format (`GP_fmt.axis`) so
  hundred-million annual ticks no longer clip the chart gutter.

## Unreleased — roadmap phases 0–3 (2026-07)

### Security / foundations (Phase 0)
- MIT license (scoped to `portfolio/glidepath/`), SECURITY.md, CONTRIBUTING.md.
- PptxGenJS self-hosted in `vendor/` (was jsdelivr CDN); Content-Security-Policy
  meta tag pinning scripts to self + cdn.sheetjs.com (the one non-vendorable lib).
- Export sanitizers: CSV formula-injection guard + HTML escaping for all
  free-text fields (`GP_csvCell`/`GP_escapeHtml`).
- Nightly pipeline now fails loudly: per-step outcomes are collected, snapshots
  are schema-validated before commit, and a failure/staleness report opens or
  updates a pinned issue. The app shows a staleness banner when the committed
  snapshot is older than 10 days.

### Forecasting rigor (Phase 1)
- Rolling-origin backtesting (3 folds × 12 months) replaces the single holdout;
  the model card reports the MAPE range, a skill score vs a seasonal-naïve
  baseline, and measured 80%-interval coverage.
- Held-out backtest disclosure: each forecast ships its final-fold predictions
  next to what actually happened, charted on the Short-term screen.
- Uploaded gateways get a short-term forecast: Holt-Winters (ETS), fit in the
  browser, with its own holdout MAPE and honest model card — Prophet remains
  server-side for catalogue airports.
- Nightly forecast archive (`data/forecasts-archive/YYYY-MM/`) for
  forecast-vs-realized tracking over time.

### Data platform (Phase 2, offline-verifiable subset)
- US measures restated to the total-passengers convention: T-100 rows are now
  aggregated on BOTH segment ends — pax = enplaned + deplaned, movements =
  departures + arrivals, freight = loaded + unloaded — matching Eurostat's
  PAS_CRD / CAF_PAS / FRM_LD_NLD definitions. The first cut summed origins
  only, i.e. enplanements (~half an airport's published total: ATL showed
  51.5M for 2025 against ~104M actual), which skewed cross-market comparisons
  and made user-entered capacity caps ~2x off. One-time restatement flags in
  check-snapshots are expected on the first refresh after this lands.
- US airports live: `fetch-bts.mjs` pulls monthly T-100 segment data (all
  carriers) straight from the TranStats download form — one per-year zip back
  to 2015, WebForms state + session cookies handled in-script, data CSV picked
  over the bundled field-description file — after live probing (Actions runs
  48–59) showed Socrata carries only annual summaries, PREZIP only cached user
  extracts, and the classic DownLoad_Table.asp endpoint is dead. 35 major US
  gateways with full catalogue metadata, pounds→tonnes freight, last-good
  fallback, loud non-zero failure. Pipeline reordered (BTS before
  Eurostat/StatCan) so US names/coords survive the reference trim; first
  verified end-to-end in run 29071108569 (135 months × 35 airports).
- `scripts/validate-data.mjs`: structural schema validation for every snapshot
  shape, run in CI and as a nightly pre-commit gate.
- `scripts/check-snapshots.mjs`: staleness + anomaly checks (shrinking series,
  large level shifts) feeding the nightly report.
- `scripts/build-manifest.mjs` → `data/manifest.json`: per-snapshot provenance
  (source, generatedAt, counts).
- Fetcher pure-logic exported and covered by recorded-fixture tests
  (Eurostat JSON-stat decode, IMF per-capita derivation).

### Uploads
- Sector (passenger-mix) upload: domestic / transborder / international
  columns are recognized in the mapping (before the plain pax pattern),
  editable in the working table, included in the template, and register
  through the same SEGMENTS machinery as pipeline airports — mix donut,
  per-sector levers and sector-targeted events now work for uploaded
  gateways. Splits persist through localStorage and session files.

### Planner features (Phase 3)
- Capacity constraints as a coupled system: a slot cap squeezes passengers
  (softened by a bounded up-gauging response — rate and ceiling are levers),
  a terminal cap pulls movements down with it, and cargo rides the flights
  actually flown — belly capacity recovers only `bellyBeta` of the up-gauge
  (the pax-vs-cargo trade-off under slot scarcity) and freighters compete
  for the same capped movements. Phased capacity steps model capital
  projects (e.g. 65M → 80M when the terminal opens). Constrained-vs-
  unconstrained trajectories and spill for every metric, in the UI and CSV.
- Baseline-assumptions levers reorganized into collapsible groups (demand
  drivers / fleet & freight / passenger segments / capacity & constraints).
- Design-day / peak-hour panel derived from the seasonal shape, with all
  assumptions disclosed.
- Shareable scenario links (catalogue gateways): the full lever/event state
  encoded in the URL fragment.

## 2026-07-07
- Export hardening (CSV formula & HTML injection), connect-screen copy fixes,
  README/pipeline doc alignment, initial ROADMAP.

## Earlier
- See git history: nightly data pipeline (Eurostat, StatCan, World Bank, IMF
  WEO, OpenFlights), Prophet short-term model with COVID event handling and
  GDP/capita regressor, elasticity long-term model, scenario/event tooling,
  uploads, session save/import, PPTX/XLSX/DOCX/CSV exports.

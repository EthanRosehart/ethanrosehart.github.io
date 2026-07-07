# Changelog

Notable changes to Glidepath. Dates are UTC.

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
- `scripts/validate-data.mjs`: structural schema validation for every snapshot
  shape, run in CI and as a nightly pre-commit gate.
- `scripts/check-snapshots.mjs`: staleness + anomaly checks (shrinking series,
  large level shifts) feeding the nightly report.
- `scripts/build-manifest.mjs` → `data/manifest.json`: per-snapshot provenance
  (source, generatedAt, counts).
- Fetcher pure-logic exported and covered by recorded-fixture tests
  (Eurostat JSON-stat decode, IMF per-capita derivation).

### Planner features (Phase 3)
- Capacity constraints: annual passenger and movement caps with
  constrained-vs-unconstrained trajectories and spill, in the UI and CSV export.
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

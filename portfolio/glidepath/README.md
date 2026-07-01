# Glidepath — aero demand forecasting

A single-page app that walks through an airport-demand forecasting workflow end
to end: pick a gateway → connect real public data → tactical (short-term) and
strategic (long-term) forecasts → scenario / event simulation → export a
deck, workbook, brief or CSV. Live at
[ethanrosehart.com/portfolio/glidepath](https://ethanrosehart.com/portfolio/glidepath/).

There is **no synthetic data**. An airport only appears if a public feed
(Eurostat, Statistics Canada, OpenFlights, World Bank) actually carries real
monthly passenger data for it, and every number in the app traces back to one
of those sources.

## What it does

| Screen | Purpose |
|---|---|
| **Select airport** | Search/browse gateways that have a live public passenger feed. |
| **Connect data** | Shows the three data sources (OpenFlights, Eurostat/StatCan aviation activity, World Bank macro) reconciling for the chosen airport. |
| **Overview** | KPI headline, annual throughput history, seasonality, passenger-mix donut. |
| **Short-term (Prophet)** | 12–24 month tactical forecast with confidence band, model card, and monthly detail table. |
| **Long-term** | 10/15/25-year strategic trajectory from the elasticity model, with a growth-driver decomposition. |
| **Baseline assumptions** | Lever panel (GDP, elasticity, population, tourism, fuel/yield, LCC stimulation, plus movements/cargo/segment levers where the gateway carries that data) with live scenario-vs-baseline impact. |
| **Event simulator** | Add time-bound shocks (a pandemic, a route collapse, a trade dispute) that dent or lift demand — full recovery or permanent re-baseline — and see them ride on top of the scenario. |
| **Export** | Generates a real PPTX deck, XLSX workbook, Word-openable DOCX brief, or a dependency-free CSV extract of everything above. |

## Forecasting methodology

- **Short-term (tactical):** [Meta Prophet](https://facebook.github.io/prophet/)
  (additive trend + multiplicative yearly seasonality + country public
  holidays), fit **server-side, nightly**, one model per airport per metric
  (passengers / movements / cargo). The 2020–21 COVID collapse is modeled as
  explicit monthly events rather than deleted, so it doesn't distort
  seasonality or inflate the uncertainty band while every observed month
  still trains the model. The browser only renders precomputed output — no
  forecasting happens client-side. See
  [`scripts/build-forecast.py`](scripts/build-forecast.py).
- **Long-term (strategic):** an elasticity model —
  `g = GDPpc·ε + pop + 0.5·tourism + lcc − 0.18·fuel` — compounding the real
  observed base year on its own seasonal shape. Movements track passengers
  less an up-gauging drag; cargo rides a damped share of the same demand
  trend plus its own growth shift. See `longTermForecast()` in
  [`data.jsx`](data.jsx).
- Both models only render for a metric when the gateway actually publishes
  it — there's no interpolation or backfill for a series that doesn't exist.

## Architecture

Static site, **no build step**: React 18 + Babel Standalone are loaded from
a CDN and JSX is transpiled in the browser at load time. This keeps the repo
trivially deployable on GitHub Pages (just static files) at the cost of a
slower first paint than a bundled/minified build — see
[Known limitations](#known-limitations).

```
index.html
├── data.jsx              airport catalogue, macro table, long-term model, formatters
├── charts.jsx            hand-built SVG LineChart / BarChart / Donut / Sparkline
├── screens-setup.jsx     Onboarding (airport picker) + Connect data
├── screens-forecast.jsx  Overview + Short-term tactical (Prophet)
├── screens-strategic.jsx Long-term + Scenario builder + Event simulator + Export
├── app.jsx               shell, nav, routing (in-memory + localStorage), data loading
└── styles.css            dark/pink design system
```

All six `.jsx` files are loaded as separate `<script type="text/babel">`
tags (no ES modules, no bundler), so they share one global scope — later
files close over `const`s declared in earlier ones (e.g. `AIRPORTS`, `MACRO`
from `data.jsx`) or read them off `window` (the `GP_*` exports at the bottom
of each file). Load order in `index.html` matters.

State is a handful of `useState`s in `App` (`app.jsx`), persisted to
`localStorage` (key `glidepath.v1`) so a reload resumes on the same screen,
airport and scenario.

## Data pipeline

Everything the app reads is a **committed JSON snapshot** under
[`data/`](data/), refreshed nightly by
[`.github/workflows/refresh-data.yml`](../../.github/workflows/refresh-data.yml)
on a GitHub Actions runner (server-side, no CORS/API-key issues) and served
same-origin to the browser. Data is split into a small **index** (catalogue
metadata, loaded on every visit) and **per-airport files** (the actual
monthly series and forecast, fetched lazily once a visitor selects that
gateway — wired into the "Connect data" screen's progress state, so that
step reflects the real fetch rather than a fixed animation). See
**[`data/README.md`](data/README.md)** for the full pipeline: file shapes,
per-market coverage (Eurostat / StatCan / BTS), and how to run each fetcher
locally.

## Running locally

The app fetches `data/*.json` with relative `fetch()` calls, which requires
a same-origin HTTP server (opening `index.html` via `file://` will fail on
CORS). From this directory:

```bash
python3 -m http.server 8000
# or: npx serve .
```

Then open `http://localhost:8000/`. The committed `data/*.json` snapshots
are used as-is — no API keys or local pipeline run needed to browse the app.

To refresh the data snapshots locally (Node 20+, plus Python 3.11 with
`prophet`/`holidays`/`pandas` for the forecast step), see
[`data/README.md`](data/README.md#run-it-locally).

## Deploying

Part of the root [ethanrosehart.github.io](../../README.md) GitHub Pages
site — any push to `main` redeploys automatically. The nightly workflow
commits refreshed `data/*.json` snapshots directly to `main`, which
triggers the same redeploy.

## Known limitations

- **No build step.** `index.html` now loads the production builds of
  React/ReactDOM (~47KB gzipped combined, down from ~262KB for the
  development builds), but Babel Standalone — the in-browser JSX compiler
  itself — still has to be downloaded and run on every page load (~665KB
  gzipped) to transpile the app's own ~130KB of JSX source. A lightweight
  bundler (esbuild/Vite) would precompile that ahead of time and let the
  browser skip downloading a compiler entirely, at the cost of adding an
  actual build step to an otherwise buildless static site.
- **US coverage is defined but not populated.** `scripts/fetch-bts.mjs`
  discovers and fetches BTS T-100 data by design, but as of the last nightly
  run the Socrata catalog exposes no working monthly segment dataset, so no
  US airports currently ship in `data/activity-index.json`. See
  [`data/README.md`](data/README.md) for status.
- **No automated tests.** Correctness of the forecasting math and data
  pipeline is currently verified by manual review / CI-log inspection only.
- Charts are hand-rolled SVG with no text/table fallback for screen
  readers — fine for a portfolio demo, worth revisiting for a
  production-grade dashboard.

## Credits / provenance

OpenFlights (airport reference) · World Bank Open Data (GDP/capita,
population) · Eurostat `avia_paoa`/`avia_gooa` (EU/EFTA passenger,
movement, cargo) · Statistics Canada WDS (CATSA screened-passenger proxy,
aircraft movements) · Meta Prophet (short-term forecasting). Full detail in
[`data/README.md`](data/README.md).

# Glidepath — aero demand forecasting

A single-page app that walks through an airport-demand forecasting workflow end
to end: pick a gateway → connect real public data (or upload your own) →
tactical (short-term) and strategic (long-term) forecasts → scenario / event
simulation → export a deck, workbook, brief or CSV. Live at
[ethanrosehart.com/portfolio/glidepath](https://ethanrosehart.com/portfolio/glidepath/).

There is **no synthetic data**. A catalogue airport only appears if a public
feed (Eurostat, Statistics Canada, OpenFlights, World Bank) actually carries
real monthly passenger data for it, and every number for it traces back to one
of those sources. A visitor can also bring their **own** monthly history — see
[Bring your own data](#bring-your-own-data) — which runs through the exact
same catalogue and forecasting machinery.

## What it does

| Screen | Purpose |
|---|---|
| **Select airport** | Upload your own data, or connect to the open-source catalogue and search/browse gateways with a live public passenger feed — presented as an explicit either/or, not one path buried under the other. Also where a previously saved session gets re-imported. |
| **Connect data** | Shows the three data sources (OpenFlights, Eurostat/StatCan aviation activity, World Bank macro) reconciling for the chosen airport. **Upload data** is a parallel step, not a relabeling of this one — both are always visible in the nav, split by an "or". |
| **Overview** | KPI headline, annual throughput history, seasonality, passenger-mix donut. |
| **Short-term (Prophet)** | 12–24 month tactical forecast with confidence band, model card, and monthly detail table. Not available for uploaded data — see below. |
| **Long-term** | 10/15/25-year strategic trajectory from the elasticity model, with a growth-driver decomposition. |
| **Baseline assumptions** | Lever panel (GDP, elasticity, population, tourism, fuel/yield, LCC stimulation, plus movements/cargo/segment levers where the gateway carries that data) with live scenario-vs-baseline impact. |
| **Event simulator** | Add time-bound shocks (a pandemic, a route collapse, a trade dispute) that dent or lift demand — full recovery or permanent re-baseline — and see them ride on top of the scenario. |
| **Export** | Generates a real PPTX deck, XLSX workbook, Word-openable DOCX brief, or a dependency-free CSV extract — including the scenario assumptions, the segment breakdown, and any shock events, not just the headline trajectory. Also offers **Save session**, a JSON round-trip file for the Select-airport import. |

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

## Bring your own data

"Select airport" also offers **Upload your own data**: pick a CSV or Excel
file (parsed client-side with [SheetJS](https://sheetjs.com), lazy-loaded the
same way `ExportView` loads it for downloads), confirm/fix the column mapping
(auto-guessed from the header row — headers don't need to match exactly, see
`GP_guessColumnRoles()` in `data.jsx` for what it recognizes, including
falling back to "passengers" for a lone unrecognized column like a plain
"Count" header when nothing else on the sheet could be it), then edit the
monthly numbers directly in a table before building the forecast. Every
non-empty sheet in a workbook is read, not just the first — if there's more
than one, a picker lets you combine them all (the common case: the same
monthly series split across tabs, e.g. by year) or pick a single one. Nothing
leaves the browser — there's no server for it to go to, and the panel says so.
The upload panel itself explains the expected shape and links a one-click
"Download template" CSV, rather than requiring a rigid predefined schema; the
trade-off for that flexibility is that a truly unrecognizable header still
needs a manual fix in the mapping dropdowns. "Build forecast" only enables
once a gateway name, short code, and one full calendar year of passengers
are all present — and says exactly which of those is still missing, rather
than leaving a visitor staring at a greyed-out button next to numbers that
already say "ready".

A custom gateway is registered through `GP_registerCustomAirport()` in
[`data.jsx`](data.jsx) — the exact same `ACTIVITY_META`/`AIRPORTS` catalogue
machinery a real pipeline-fed airport uses, so **every screen downstream
(Overview, long-term, scenario levers, event simulator, export) works
unchanged**. The one thing that's deliberately never populated is
`FORECASTS[iata]`: Meta Prophet is fit server-side, nightly, only for the
committed public feeds, so a custom airport has no short-term tactical
forecast — the "Short-term (Prophet)" nav entry is hidden for it, and
`DataCaveat` explains why on the Overview screen. Everything else — the
elasticity model, scenario/event tooling, and every export format — runs
identically to a catalogue airport, with export copy adjusted to say the
figures came from you rather than a public source.

Since there's no server involved, a custom airport's meta + monthly series
ride along in `localStorage` itself (not just its IATA-style code) so a
reload can restore it without anywhere to re-fetch from. One thing this
uncovered: `GP_setActivityIndex()` (which loads the real catalogue) used to
replace `ACTIVITY_META` wholesale, which would silently wipe a just-restored
custom airport out from under the session — the real catalogue fetch always
resolves *after* the synchronous localStorage restore, however briefly. It
now merges custom entries back in rather than overwriting them; see the test
named "the reload-restore race" in `test/data.test.mjs`.

## Save / import a session

Export offers **Save session** alongside the report formats: a small JSON
file — gateway reference, every scenario lever, every event, and (for an
uploaded gateway) the meta + monthly series itself — meant purely for
round-tripping, not for reading. Select airport's **Import session** reads
it back and reopens exactly where you left off: a catalogue airport just
needs its iata (the real data comes back from the live pipeline), while an
uploaded gateway is rebuilt via the same `GP_registerCustomAirport()` the
original upload used. The topbar's **Reset** clears a session and starts
over from scratch; for an uploaded gateway it also calls
`GP_removeCustomAirport()` so the cleared gateway doesn't linger as a match
in the airport search (`liveAirports()` filters on the same catalogue this
would otherwise leave behind — see the "ghost gateway" test in
`test/data.test.mjs`).

## Architecture

React 18 (production build, from a CDN). The app's own six `.jsx` files are
precompiled by [`build.mjs`](build.mjs) (esbuild) into a single minified
`dist/app.bundle.js` — the browser never downloads a JSX compiler, only that
one plain-JS file. See [Building](#building) for how the bundle gets
rebuilt.

```
index.html
├── data.jsx              airport catalogue, macro table, long-term model, formatters
├── charts.jsx            hand-built SVG LineChart / BarChart / Donut / Sparkline
├── screens-setup.jsx     Onboarding (airport picker) + Connect data + UploadData
├── screens-forecast.jsx  Overview + Short-term tactical (Prophet)
├── screens-strategic.jsx Long-term + Scenario builder + Event simulator + Export
├── app.jsx               shell, nav, routing (in-memory + localStorage), data loading
├── styles.css            dark/pink design system
├── build.mjs             esbuild: JSX → JS + minify, per file, then concatenate (see below)
└── dist/app.bundle.js    committed build output index.html actually loads
```

The six `.jsx` files intentionally share **one global scope** — there's no
ES module graph between them. Later files close over `const`s declared in
earlier ones (e.g. `AIRPORTS`, `MACRO` from `data.jsx`) or read them off
`window` (the `GP_*` exports at the bottom of each file); load order matters
(`data.jsx` → `charts.jsx` → `screens-setup.jsx` → `screens-forecast.jsx` →
`screens-strategic.jsx` → `app.jsx`). `build.mjs` preserves that on purpose:
it transforms each file **individually** (esbuild's `transform()`, never its
bundler) and concatenates the results in load order — the same shape as six
separate `<script>` tags, just precompiled and minified. This matters for
correctness, not just style: esbuild's minifier only renames identifiers it
can prove are local to a function, so top-level names crossing file
boundaries (`AIRPORTS`, `GP_Ico`, ...) survive unchanged after minification;
bundling the files together as an ES module graph instead would risk
tree-shaking code that looks "unused" within a single file but is actually
consumed by a later one.

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

Then open `http://localhost:8000/`. The committed `dist/app.bundle.js` and
`data/*.json` snapshots are used as-is — no build, API keys, or local
pipeline run needed just to browse the app.

To refresh the data snapshots locally (Node 20+, plus Python 3.11 with
`prophet`/`holidays`/`pandas` for the forecast step), see
[`data/README.md`](data/README.md#run-it-locally).

## Building

```bash
npm install         # esbuild only — one devDependency
npm run build        # writes dist/app.bundle.js
npm run watch         # rebuilds on every .jsx save, for active development
```

The committed `dist/app.bundle.js` is what `index.html` actually loads, so
if you edit a `.jsx` file, either run `npm run build` before committing or
just push — [`.github/workflows/build-glidepath.yml`](../../.github/workflows/build-glidepath.yml)
rebuilds it in CI and commits the result back to `main` (same bot-commit
pattern as the nightly data refresh), so the author workflow stays
edit-and-push even though the site ships a precompiled bundle.

## Testing

```bash
node --test                                     # data.jsx: the elasticity model, annualization, formatters
pip install -r scripts/requirements.txt
pytest scripts/test_build_forecast.py -v        # build-forecast.py: series framing, seasonality, COVID window, holidays
```

[`.github/workflows/test-glidepath.yml`](../../.github/workflows/test-glidepath.yml)
runs both suites on every push/PR touching `portfolio/glidepath/`.
`test/data.test.mjs` loads `data.jsx` itself (not a copy) into a `node:vm`
sandbox and exercises it through its real public `window.GP_*` API — the
same functions `app.jsx` and the screens call — so a regression in the
elasticity model, event shocks, or segment reconciliation gets caught
here rather than by a visitor. The Python suite covers `build-forecast.py`'s
pure-logic helpers (series framing, seasonal index, the COVID dummy-event
window, holiday-date snapping); the actual Prophet fit is comparatively
low-risk (it's a well-tested library) and is exercised for real against
live data by the nightly run instead of being re-fit in CI.

## Deploying

Part of the root [ethanrosehart.github.io](../../README.md) GitHub Pages
site — any push to `main` redeploys automatically. Two bots commit straight
to `main` and trigger that same redeploy: the nightly data refresh
(`refresh-data.yml`) and, on any `.jsx` change, the bundle rebuild
(`build-glidepath.yml`).

## Known limitations

- **Uploaded data has no short-term forecast and no passenger-segment split.**
  Both are deliberate scope choices (Prophet is fit server-side only for the
  committed public feeds; segment upload adds a column-mapping case not worth
  the complexity yet) rather than a technical wall — see
  [Bring your own data](#bring-your-own-data).
- **US coverage is defined but not populated.** `scripts/fetch-bts.mjs`
  discovers and fetches BTS T-100 data by design, but as of the last nightly
  run the Socrata catalog exposes no working monthly segment dataset, so no
  US airports currently ship in `data/activity-index.json`. See
  [`data/README.md`](data/README.md) for status.
- Charts are hand-rolled SVG with no text/table fallback for screen
  readers — fine for a portfolio demo, worth revisiting for a
  production-grade dashboard.

## Credits / provenance

OpenFlights (airport reference) · World Bank Open Data (GDP/capita,
population) · Eurostat `avia_paoa`/`avia_gooa` (EU/EFTA passenger,
movement, cargo) · Statistics Canada WDS (CATSA screened-passenger proxy,
aircraft movements) · Meta Prophet (short-term forecasting). Full detail in
[`data/README.md`](data/README.md).

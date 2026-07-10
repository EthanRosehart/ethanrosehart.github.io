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
| **Connect data** | Shows the data sources reconciling for the chosen airport — OpenFlights, Eurostat/StatCan aviation activity, World Bank macro, and (where the country's covered) an IMF WEO row for the GDP/capita forecast. **Upload data** is a parallel step, not a relabeling of this one — both are always visible in the nav, split by an "or". |
| **Overview** | KPI headline, annual throughput history, seasonality, passenger-mix donut. |
| **Short-term** | 12–24 month tactical forecast with confidence band, model card, monthly detail table, and a **held-out backtest panel** (what the model predicted for the last 12 months it never saw, vs what happened). Meta Prophet (server-side, nightly) for catalogue gateways; **Holt-Winters ETS, fit in the browser**, for uploaded data — the model card always says which. |
| **Long-term** | 10/15/25-year strategic trajectory from the elasticity model, with a growth-driver decomposition, a **capacity-constrained overlay + spill** when a cap is set, and a **design-day / peak-hour panel** derived from the seasonal shape (assumptions disclosed). |
| **Baseline assumptions** | Lever panel organized into collapsible groups — demand drivers (GDP, elasticity, population, tourism, fuel/yield, LCC), fleet & freight, passenger segments (where published), and **capacity & constraints** (annual pax/movement caps plus the constraint-response levers: up-gauging rate, its ceiling, bellyhold cargo share) — with live scenario-vs-baseline impact. |
| **Event simulator** | Add time-bound shocks (a pandemic, a route collapse, a trade dispute) that dent or lift demand — full recovery or permanent re-baseline — and see them ride on top of the scenario. |
| **Export** | Generates a real PPTX deck, XLSX workbook, Word-openable DOCX brief, or a dependency-free CSV extract — including the scenario assumptions, the segment breakdown, any shock events, and (when a cap is set) the constrained trajectory + spill. Also offers **Save session** (JSON round-trip for the Select-airport import) and, for catalogue gateways, a **Share link** that carries the whole scenario in the URL. |

## Forecasting methodology

- **Short-term (tactical):** [Meta Prophet](https://facebook.github.io/prophet/)
  (additive trend + multiplicative yearly seasonality + country public
  holidays), fit **server-side, nightly**, one model per airport per metric
  (passengers / movements / cargo). The 2020–21 COVID collapse is modeled as
  explicit monthly events rather than deleted, so it doesn't distort
  seasonality or inflate the uncertainty band while every observed month
  still trains the model. Where a real GDP/capita history is on file for the
  airport's country, it rides along as an `extra_regressor` — real World
  Bank annual levels, interpolated monthly for training; for the horizon,
  each future year uses a real **IMF World Economic Outlook** growth
  forecast where one's published for that year, falling back to
  extrapolating the trailing World Bank rate only for years IMF doesn't
  cover. (World Bank alone publishes no GDP forecast product — OECD does,
  but its SDMX API was tried three times for this and dropped after
  persistent HTTP 500s; IMF's plain-JSON API sidesteps that entirely.)
  Every forecast's `gdpRegressor`/`gdpForecast` flags disclose whether the
  regressor ran and whether a real forecast (vs. only extrapolation) drove
  it; see `gdp_monthly_series()` in
  [`scripts/build-forecast.py`](scripts/build-forecast.py). Accuracy is
  measured by **rolling-origin backtesting** (up to 3 refits, each scored on
  the next 12 months it never saw): the model card reports the mean MAPE and
  per-fold values, a **skill score vs a seasonal-naïve benchmark**, and the
  **measured coverage of the 80% interval** on those held-out months — plus
  a month-by-month predicted-vs-actual chart of the most recent fold. For
  catalogue gateways the browser only renders this precomputed output.
- **Short-term for uploaded data:** a **Holt-Winters (ETS)** model —
  additive trend, multiplicative monthly seasonality, smoothing constants
  grid-searched on one-step error — fit *in the browser* on the uploaded
  months (`GP_etsForecast` in [`data.jsx`](data.jsx), ≥24 contiguous months
  required). It carries the same holdout-backtest disclosure (MAPE,
  seasonal-naïve comparison, interval coverage, predicted-vs-actual chart);
  its interval is an approximation from in-sample residuals and the model
  card says so. The same fallback serves any catalogue gateway Prophet
  hasn't cleared its history minimum for.
- **Long-term (strategic):** an elasticity model —
  `g = GDPpc·ε + pop + 0.5·tourism + lcc − 0.18·fuel` — compounding the real
  observed base year on its own seasonal shape. Movements track passengers
  less an up-gauging drag; cargo rides a damped share of the same demand
  trend plus its own growth shift. The GDP/capita lever's default is that
  same real IMF forecast when published, falling back to the World Bank
  trailing mean otherwise (`gdpcapProj`/`gdpcap` in `data.jsx`'s `MACRO`
  table). See `longTermForecast()` in [`data.jsx`](data.jsx).
- **Capacity constraints (a coupled system, not independent clamps):**
  optional annual passenger / movements caps on the Baseline-assumptions
  screen, where one binding cap propagates to every output. A slot cap
  squeezes passengers, softened by an **up-gauging response** (extra
  passengers-per-movement per binding year, a lever) that runs out at a
  **ceiling** vs the observed base-year ratio (also a lever — stands,
  runway mix and the fleet only stretch so far). A terminal cap pulls
  movements down with it (airlines don't fly demand that can't clear the
  terminal). **Cargo rides the flights actually flown, on both halves of
  its `bellyShare` split**: belly capacity falls with capped passenger
  flights and recovers only `bellyBeta` of the up-gauge (bigger airframes
  add belly volume, but denser cabins and fuller loads eat it with bags —
  below 100% that's the classic slot-scarcity trade-off, where packing
  more passengers through capped movements costs cargo per passenger),
  while the freighter share is squeezed by slot scarcity but untouched by
  a purely terminal cap. **Caps can change over the horizon** via capacity
  steps (a capital project: 65M today, 80M once the terminal opens — the
  up-gauging clock only ticks while the slot cap actually binds, so an
  expansion freezes further response). The classic ratios stay sane by
  construction: pax-per-movement never exceeds base-year × (1 + ceiling),
  constrained values never exceed demand. Spill = demand the
  infrastructure can't serve; capped years' months scale proportionally
  (disclosed simplification — real spill concentrates in peaks) and the
  unconstrained curves stay on the charts so every gap is visible. All
  constrained series ride into the CSV export. See the coupled-constraint
  block in `longTermForecast()` ([`data.jsx`](data.jsx)).
- **Design day / peak hour:** derived on the Long-term screen from the
  observed seasonal shape — busy day = average day of the peak month × 1.10,
  peak hour = a size-dependent share of the busy day (12%/10%/8%). Every
  heuristic is printed next to the numbers; replace with measured factors
  when daily data exists (see `GP_designDay` in `data.jsx`).
- Both models only render for a metric when the gateway actually publishes
  it — there's no interpolation or backfill for a series that doesn't exist.
- **Demand seasonality** (the "share of an average month" chart on Overview)
  normally reads Prophet's fitted yearly component. For a gateway with no
  Prophet forecast — every custom/uploaded one, or a real gateway Prophet
  hasn't fit yet — `GP_observedSeasonality()` in `data.jsx` computes the same
  1.0-centered index directly from the observed months (each calendar
  month's average share of an average month, across every complete calendar
  year present), so the panel always has something real to show instead of
  hiding.

## Bring your own data

"Select airport" also offers **Upload your own data**: pick a CSV or Excel
file (parsed client-side with [SheetJS](https://sheetjs.com), lazy-loaded the
same way `ExportView` loads it for downloads), confirm/fix the column mapping
(auto-guessed from the header row — headers don't need to match exactly, see
`GP_guessColumnRoles()` in `data.jsx` for what it recognizes, including
falling back to "passengers" for a lone unrecognized column like a plain
"Count" header when nothing else on the sheet could be it), then edit the
monthly numbers directly in a table before building the forecast. Besides
passengers/movements/cargo, the upload accepts an optional **passenger-mix
split by sector** — columns for domestic / transborder / international
passengers (headers like "Domestic passengers" or "Intl PAX" are recognized,
and sector patterns are matched before the plain passenger pattern so they
don't get mistaken for the headline). Any two or more sectors register
through the same `SEGMENTS` machinery the pipeline feeds, unlocking the mix
donut, per-sector demand levers and sector-targeted shock events; sectors
don't need to sum exactly to the headline total, which stays the source of
truth (the model rescales them). The downloadable template includes the
sector columns with a note that they're optional. Every
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
(Overview, short-term, long-term, scenario levers, event simulator, export)
works unchanged**. The one thing that's deliberately never populated is
`FORECASTS[iata]`: Meta Prophet is fit server-side, nightly, only for the
committed public feeds. A custom airport's short-term screen instead runs
the in-browser Holt-Winters model (the nav entry reads "Short-term (ETS)"
and the model card says exactly what fit it), and `DataCaveat` explains the
difference on the Overview screen. Everything else — the elasticity model,
scenario/event tooling, and every export format — runs identically to a
catalogue airport, with export copy adjusted to say the figures came from
you rather than a public source.

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

React 18 and PptxGenJS (production builds, self-hosted in
[`vendor/`](vendor/README.md) — nothing the app needs to *boot* comes from
a third-party CDN, so a CDN outage can't take the app down with it). One
optional feature lazy-loads a pinned third-party script on demand and
fails soft: the XLSX export and the spreadsheet-upload parser (SheetJS
from cdn.sheetjs.com — versions ≥0.19 aren't published to npm, so there's
no integrity-checked copy to vendor; its host is pinned in `index.html`'s
**Content-Security-Policy**, which locks scripts to self + that one host).
The Google Fonts stylesheet falls back to system fonts if unreachable.
MIT-licensed ([`LICENSE`](LICENSE), scoped to this directory); see
[`SECURITY.md`](SECURITY.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).
The app's own six `.jsx` files are
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
window, holiday-date snapping, the GDP/capita regressor's interpolation and
extrapolation math); the actual Prophet fit is comparatively low-risk (it's
a well-tested library) and is exercised for real against live data by the
nightly run instead of being re-fit in CI.

## Deploying

Part of the root [ethanrosehart.github.io](../../README.md) GitHub Pages
site — any push to `main` redeploys automatically. Two bots commit straight
to `main` and trigger that same redeploy: the nightly data refresh
(`refresh-data.yml`) and, on any `.jsx` change, the bundle rebuild
(`build-glidepath.yml`).

## Known limitations

- **Uploaded data's short-term forecast is in-browser Holt-Winters, not
  Prophet** — same screen, honest model card; see
  [Bring your own data](#bring-your-own-data).
- **US coverage: ~35 largest gateways via BTS T-100 (all carriers, segment).**
  `scripts/fetch-bts.mjs` requests one extract per year (back to 2015) from
  the TranStats download form — the run log documents the whole exchange —
  and aggregates passengers / movements / freight by origin airport × month.
  Socrata discovery still runs first (it wins automatically if DOT ever
  publishes a monthly table there); a total failure keeps last-good data and
  exits non-zero into the pipeline-health issue. T-100 publishes on a ~2–3
  month lag, so US airports trail the European feed slightly.
- Charts are hand-rolled SVG with no text/table fallback for screen
  readers — fine for a portfolio demo, worth revisiting for a
  production-grade dashboard.
- **The XLSX export and spreadsheet upload lazy-load one pinned CDN script**
  (SheetJS — not published to npm at current versions, so it can't be
  vendored like React and PptxGenJS were). Its host is pinned in the page
  CSP and a CDN failure degrades gracefully (CSV export and the rest of the
  app keep working). Free-text fields that reach the generated files (event
  labels, uploaded gateway names) are escaped against CSV formula injection
  and HTML injection (`GP_csvCell` / `GP_escapeHtml` in `data.jsx`).

## Roadmap

[`ROADMAP.md`](ROADMAP.md) lays out the path from this portfolio demo to a
production-grade, adoptable open-source tool — licensing and security
hardening, forecast backtesting rigor, more national data feeds,
planner-grade outputs (constrained demand, design-day profiles), and a
packaged self-hosting story.

## Credits / provenance

OpenFlights (airport reference) · World Bank Open Data (GDP/capita,
population) · IMF World Economic Outlook (forward GDP/capita forecast) ·
Eurostat `avia_paoa`/`avia_gooa` (EU/EFTA passenger, movement, cargo) ·
Statistics Canada WDS (CATSA screened-passenger proxy, aircraft
movements) · Meta Prophet (short-term forecasting). Full detail in
[`data/README.md`](data/README.md).

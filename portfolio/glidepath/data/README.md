# Glidepath — data pipeline

The app runs as a **static site** (works on GitHub Pages). It never calls
external APIs from the browser. Instead, a nightly GitHub Action fetches public
data **server-side** and commits JSON snapshots that the site serves. There is
**no synthetic data** — an airport only appears if a public feed carries real
monthly activity for it.

```
┌──────────────────────────┐     nightly cron (03:17 UTC)
│ GitHub Action runner      │ ── fetch ──▶ OpenFlights · Eurostat · StatCan
│ scripts/*.mjs + *.py      │ ◀── JSON ──   World Bank · (Prophet, server-side)
             │ git commit data/
             ▼
┌──────────────────────────┐
│ Repo  →  GitHub Pages     │  (auto-redeploy on push)
             │ same-origin fetch()
             ▼
┌──────────────────────────┐
│ Browser (index.html)      │  loads the small index files on mount to build
│ app.jsx loader            │  the airport catalogue; fetches one airport's own
└──────────────────────────┘  series/forecast only once that gateway is selected
```

Data is split into a small **index** (catalogue metadata, loaded on every page
visit) and **per-airport files** (the actual monthly numbers, fetched lazily —
only for the airport a visitor selects). This keeps the initial page load to a
few tens of KB instead of downloading every airport's history up front.

The pipeline runs in this order (see `.github/workflows/refresh-data.yml`):
`fetch-openflights` → `fetch-activity` → `fetch-bts` → `fetch-data` →
`build-forecast`. Each step is best-effort and keeps the last good snapshot on
failure.

## What's wired

### Airport reference — `data/airports.json` (`scripts/fetch-openflights.mjs`)
Fetches OpenFlights `airports.dat` (public CSV) and emits the **full** reference
for every airport with both an IATA and ICAO code. `fetch-activity.mjs` uses it
to map the ICAO codes the aviation feeds report back to IATA, then **trims** the
file down to just the airports that carry data, so the browser load stays small.

### Monthly activity — `data/activity-index.json` + `data/series/<IATA>.json`
(`scripts/fetch-activity.mjs`, `scripts/fetch-bts.mjs`)

Real monthly **passengers / movements / cargo** by airport. **This is the
series the forecasts run on.** `activity-index.json` holds catalogue metadata
only (source, months, latest, which metrics are available, and a precomputed
`annualPax` figure for the picker's "68.0M/yr" summary) — no series data, so
the browser can build its entire airport catalogue (enriched by
`airports.json`) from one small file; there is no hand-curated airport list.
Each airport's actual monthly numbers live in their own
`data/series/<IATA>.json`, fetched by the browser only once that gateway is
selected.

`fetch-activity.mjs` owns the Eurostat/StatCan-sourced entries; `fetch-bts.mjs`
runs after it and separately maintains its own (currently empty, see below)
entries in the same index + `series/` directory, so the two scripts never
clobber each other's airports. Both prune `series/<IATA>.json` files for
airports that drop out of their respective sets.

| Market | Source | Notes |
|--------|--------|-------|
| Europe | Eurostat `avia_paoa` (PAS_CRD pax, CAF_PAS flights) + `avia_gooa` (FRM_LD_NLD cargo, tonnes) | A single all-airports pull is rejected with HTTP 413 (async). The script enumerates reporting airports with a small `lastTimePeriod` call, ranks by recent volume, and batch-fetches full series for the busiest ~70 in `rep_airp` chunks, splitting any chunk that still trips the 413 guard. Passenger composition is also pulled by transport coverage (`tra_cov` NAT/INTL) into `paxSeg`. |
| Canada | StatCan WDS — 23-10-0312 (screened pax) + 23-10-0296 (aircraft movements, with 23-10-0008 as fallback) | The eight CATSA Class-1 airports, resolved by airport name against the cube metadata. StatCan stopped updating the older movements cube 23-10-0008 after 2022-09, so the current cube 23-10-0296 ("NAV CANADA services and other selected airports") is tried first. Screened pax are also split by sector (domestic / transborder / international) into `paxSeg`. |
| US | BTS T-100 (`scripts/fetch-bts.mjs`) | Not currently wired — the Socrata catalog exposes no monthly segment table. US airports are simply absent (no modeling). |

Eurostat airport codes are `<geo>_<ICAO>` (e.g. `ES_LEMD`, `AT_LOWG`); the geo
prefix gives the country (`EL`→GR, `UK`→GB, else ISO-3166 alpha-2). The country,
ISO codes, region and display name ride on each airport in
`activity-index.json`.

### Macro drivers — `data/macro.json` (`scripts/fetch-data.mjs`)
Pulls three World Bank indicators for every country present in
`activity-index.json`:

| Field           | World Bank indicator   | Reduction                       | Feeds                        |
|-----------------|------------------------|----------------------------------|------------------------------|
| `gdp`           | `NY.GDP.MKTP.KD.ZG`    | trailing 5-yr mean               | reference                    |
| `gdpcap`        | `NY.GDP.PCAP.KD.ZG`    | trailing 5-yr mean                | GDP/capita lever + regressor extrapolation rate |
| `gdpcapSeries`  | `NY.GDP.PCAP.KD`       | full yearly level series, untouched | Prophet's GDP/capita regressor (`build-forecast.py`) |
| `pop`           | `SP.POP.TOTL`          | latest year-over-year % change   | population lever              |

The loader overlays these over the `MACRO` table in `data.jsx`, creating a
default entry (`GP_ensureMacro`) for any country not already listed, so the
long-term elasticity lever reflects live macro for every catalogue airport.
`gdpcapSeries` is the one field kept as real annual levels rather than
reduced to a single number — `build-forecast.py` needs actual history to
interpolate, not just a summary growth rate (see below). Country coverage
here is derived from the real airport catalogue (`activity-index.json`),
not a hardcoded list — a stale filename bug quietly limited this to 9
countries for a while; fixed, now ~30.

### Forward GDP forecast — `data/imf-weo.json` (`scripts/fetch-imf.mjs`)
World Bank's Indicators API is historical-actuals only — it has no GDP
*forecast* product. IMF's **World Economic Outlook** (WEO, refreshed every
April/October) does: real GDP/capita growth projections 2–5 years out, per
country. Pulled via IMF's plain-JSON DataMapper API (`NGDPRPC` — real
GDP/capita, constant prices, national currency; growth is derived from
consecutive years' levels) rather than OECD's SDMX Economic Outlook feed,
which was tried three separate times for this same purpose and dropped
after persistent HTTP 500s (see git history on the now-deleted
`fetch-oecd.mjs`) — IMF's API has no dataflow version or key-shape to guess
at. A country IMF doesn't cover is never a hard failure: both consumers
below fall back to their pre-existing behavior.

This feeds two places:
- **The long-term model's GDP lever default** (`gdpcapProj` in `data.jsx`'s
  `MACRO` table, merged in by `app.jsx`) — a real forecast now, not a dead
  field; falls back to the World Bank trailing mean (`gdpcap`) for a
  country IMF doesn't cover.
- **Prophet's GDP/capita regressor**, for the specific future years IMF
  covers — see below.

The **Connect data** screen shows IMF as a fourth row alongside OpenFlights,
aviation activity and World Bank, and the topbar's "sources live" tooltip
counts it too — but only when this specific airport's country actually has
IMF coverage (`MACRO[cc].gdpcapProj != null`), not just whenever the fetch
itself succeeds. A country the WEO doesn't cover shows an amber "No
coverage" row rather than red/blocking, and the count reads "3 sources
live" instead of "4" — coverage gaps are a normal, disclosed case here, not
an error.

### Short-term forecasts — `data/forecast-meta.json` + `data/forecasts/<IATA>.json`
(`scripts/build-forecast.py`)

Meta **Prophet** (additive trend + multiplicative yearly seasonality + country
public holidays, via the `holidays` package) fit **server-side** per airport per
metric on the real series in `data/series/<IATA>.json`. `forecast-meta.json`
holds only the shared model metadata (generatedAt, model, library, interval,
horizon) — tiny, loaded once. Each airport's actual forecast output lives in
its own `data/forecasts/<IATA>.json`, fetched by the browser only once that
gateway is selected (the same lazy pattern as the activity series). The
browser renders these directly — no forecasting happens client-side. Each
airport's ISO-2 country (for the holiday calendar) is read from
`activity-index.json`.

The **COVID collapse (2020-03 → 2021-12)** is modeled as one explicit dummy
event per month rather than fed in as ordinary data — Prophet attributes the
dip/recovery to those events (which never recur, so zero forward effect) instead
of letting them distort the multiplicative seasonality or inflate the
trend-uncertainty band. Nothing is dropped: every observed month still trains the
model and appears on the actuals chart. In CI this cut median passenger backtest
MAPE from ~16% to ~5%.

When a **GDP/capita** series is available for the airport's country
(`gdpcapSeries` above), it rides along as a Prophet `extra_regressor` —
`gdp_monthly_series()` anchors each real annual level at that year's
midpoint and linearly interpolates between anchors for the training
window. For the forecast horizon, each future year uses the real IMF WEO
rate for that year where one exists (`imf-weo.json` above), falling back
to compounding the trailing growth rate (`gdpcap`) only for a year IMF
doesn't cover — which, absent any IMF data at all, is every future year,
same disclosed-extrapolation behavior as before IMF was wired in. Every
metric's forecast JSON carries `gdpRegressor` (the regressor was used) and
`gdpForecast` (at least one covered year was a real IMF rate, not just
extrapolated) flags; the Short-term screen's model card shows the
GDP/capita row whenever `gdpRegressor` is set. A country with no
`gdpcapSeries` at all just fits without the regressor, same as before.

> Income elasticity, tourism and fuel remain model assumptions in the long-term
> lever (no clean single public series for either). Passengers, movements,
> cargo, macro drivers and GDP/capita — history *and*, via IMF, a real
> forecast — are the wired real feeds.

## Run it locally
```bash
node scripts/fetch-openflights.mjs # airports.json (OpenFlights full reference)
node scripts/fetch-activity.mjs    # activity-index.json + series/<IATA>.json (Eurostat + StatCan) + trims airports.json
node scripts/fetch-bts.mjs         # activity-index.json + series/<IATA>.json (US BTS — currently a no-op)
node scripts/fetch-data.mjs        # macro.json (World Bank, no key)
node scripts/fetch-imf.mjs         # imf-weo.json (IMF WEO forward GDP/capita forecast, no key)
pip install -r scripts/requirements.txt
python scripts/build-forecast.py   # forecast-meta.json + forecasts/<IATA>.json (Meta Prophet)
```
Node 20+. Each rewrites its snapshot under `data/`. Commit the result, or let the
Action do it.

## Deploy on GitHub Pages
1. Push this folder to a repo.
2. Settings → Pages → deploy from branch (root).
3. Settings → Actions → General → Workflow permissions → **Read and write**
   (so the bot can commit the nightly snapshot).
4. Actions tab → "Refresh data" → **Run workflow** to seed the first pull.

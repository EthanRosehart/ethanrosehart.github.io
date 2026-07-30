# Glidepath — data pipeline

The app runs as a **static site** (works on GitHub Pages). It never calls
external APIs from the browser. Instead, a nightly GitHub Action fetches public
data **server-side** and commits JSON snapshots that the site serves. There is
**no synthetic data** — an airport only appears if a public feed carries real
monthly activity for it.

```
┌──────────────────────────┐     nightly cron (03:17 UTC)
│ GitHub Action runner      │ ── fetch ──▶ OpenFlights · Eurostat · StatCan
│ scripts/*.mjs + *.py      │ ◀── JSON ──   World Bank · (forecasts, server-side)
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
`fetch-openflights` → `fetch-bts` → `fetch-activity` → `fetch-data` →
`fetch-imf` → `build-forecast`. (BTS runs before the Eurostat/StatCan step
because it needs the still-untrimmed OpenFlights reference for US airport
names/coords; `fetch-activity` then carries the BTS entries forward and
trims the reference to the union of both catalogues.) Each step is best-effort and keeps the last
good snapshot on failure, retrying transient network/5xx blips first
(`fetchWithRetry` in `scripts/_util.mjs`) so a one-off hiccup isn't
mistaken for an outage — but failures are **not silent**: after the
fetchers, `scripts/validate-data.mjs` schema-checks every snapshot as a
hard gate before anything is committed, `scripts/check-snapshots.mjs`
fails the run on staleness (a snapshot >10 days old means a fetcher has
been quietly failing) or a mass catalogue loss (gateways vanishing
wholesale in one night) and warns on the softer anomalies (a couple of
airports rotating out, shrunken series, wholesale level shifts vs
yesterday's baseline), and the workflow's final step opens or updates a
*pipeline-health issue* and fails the run when anything is wrong. The app itself shows a staleness banner when the
committed snapshot is older than 10 days. Two more artifacts are written
each night: **`data/manifest.json`** (`scripts/build-manifest.mjs`) — the
provenance manifest: upstream source, license/terms, generatedAt and row
counts for every snapshot — and, on the first run of each month, a copy of
every forecast into **`data/forecasts-archive/YYYY-MM/`** so
forecast-vs-realized accuracy can be tracked over time.

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
runs before it and separately maintains its own entries in the same index +
`series/` directory, so the two scripts never clobber each other's airports.
Both prune `series/<IATA>.json` files for airports that drop out of their
respective sets, which makes a bad night genuinely destructive — so three
guards sit in front of that pruning:

1. **Total-outage guard** — if a whole source produces nothing on a run but
   the previous index carried its airports, the previous entries are carried
   forward untouched (their series files stay, including their last-good
   `paxSeg` splits) and the run exits non-zero for the pipeline-health issue,
   so one bad night can never wipe a market.
2. **Partial-reply guard** (`chooseSeries()` in `scripts/_util.mjs`) — the
   dangerous case is the one in between, where a feed answers but *short*.
   On 2026-07-25 Eurostat returned all 70 European airports with a truncated
   window for 29 of them; 12-month replies overwrote 132-month histories,
   then failed the 24-month catalogue floor, and Paris CDG, Zurich, Dublin,
   Brussels, Athens, Istanbul and 23 more dropped off the live site. A fresh
   series now has to clear the month floor *and* not be a material shrink
   (>20%) against what's already on disk, or last-good is kept and the run
   log says why.
3. **Mass-drop alert** (`massDropAlert()` in `scripts/check-snapshots.mjs`) —
   losing more than 2 airports, or more than 5% of the catalogue, in a single
   run exits non-zero and pages. That night printed 116 anomaly warnings and
   still reported "Pipeline healthy"; it now fails the run.
4. **Sticky membership** — the root cause of all of the above. Catalogue
   membership used to be re-derived from one live Eurostat call every night
   while the data itself lived on disk, so a feed that answered thinly (or
   not at all) evicted airports whose committed history was perfectly
   intact, and the prune step then deleted their series files. An airport
   already in the catalogue with a usable, not-yet-ancient history now stays
   a candidate whether or not tonight's enumerate mentions it, and rides on
   last-good until the feed returns. It only retires once nothing new has
   been published for `STICKY_MAX_AGE_MONTHS` (18) — genuinely discontinued
   rather than briefly down.

Because membership is sticky, "the index still lists Eurostat airports" is
no longer evidence that Eurostat answered — so the outage signal keys on
whether a source produced any **fresh** series tonight, not on whether its
entries exist. That signal is `fetch-activity` **exit code 2**, deliberately
distinct from a crash: it means the run completed, wrote a coherent
snapshot, and kept every airport on committed history, so the workflow
files it as a *note* rather than paging. Every airport also carries a
`refreshedAt` stamp (set only on a live refresh, otherwise carried forward),
which is what makes that demotion safe — `sourceStaleness()` escalates it to
a real alert once the feed has been dark past the freshness window. An entry
with no prior stamp starts its clock at that run; that is a watch-start, not
a claim about when the feed last delivered, and it errs toward alerting late
rather than never. And because a properly-dead host would otherwise cost ~50
backed-off retries a night (~24 minutes of sleeping), `fetchWithRetry` trips
a per-host breaker after two exhausted calls and fails fast until that host
answers again.

One coupling worth knowing: a **new** airport can only enter the catalogue
if `data/airports.json` carries its ICAO→IATA mapping, and `fetch-activity`
trims that file to the current catalogue at the end of each run.
`fetch-openflights` restores the full reference at the start of every night,
so this is fine in the normal case — but on a night where OpenFlights fails,
no new gateway can be added (existing ones are safe, via the stickiness
above).

| Market | Source | Notes |
|--------|--------|-------|
| Europe | Eurostat `avia_paoa` (PAS_CRD pax, CAF_PAS flights) + `avia_gooa` (FRM_LD_NLD cargo, tonnes) | A single all-airports pull is rejected with HTTP 413 (async). The script enumerates reporting airports with a small `lastTimePeriod` call, then batch-fetches full series for **every** one of them in `rep_airp` chunks, splitting any chunk that still trips the 413 guard. **No cap and no volume ranking** — an earlier version kept only the "busiest 70" by summing whatever months the enumerate call returned, which stops being a size measure the moment a pull decodes thin (2026-07-26: we read 3–5 months for some airports and none for others — our own query bug, see **Pin every dimension** below — so mid-size airports outranked Paris CDG at zero and CDG fell out of the catalogue). The cap only ever existed to bound the nightly Prophet build; that budget is cheap. Every dimension of the cube is pinned (`ES_PINS`). Passenger composition is also pulled by transport coverage (`tra_cov` NAT/INTL) into `paxSeg` — the one place `tra_cov` is deliberately varied. |
| Canada | StatCan WDS — 23-10-0312 (screened pax) + 23-10-0296 (aircraft movements, with 23-10-0008 as fallback) | The eight CATSA Class-1 airports, resolved by airport name against the cube metadata. StatCan stopped updating the older movements cube 23-10-0008 after 2022-09, so the current cube 23-10-0296 ("NAV CANADA services and other selected airports") is tried first. Screened pax are also split by sector (domestic / transborder / international) into `paxSeg`. |
| US | DOT BTS **T-100 segment, all carriers** — TranStats download form, per-year extracts (`scripts/fetch-bts.mjs`) | Live probing (Actions runs 48–59) established that DOT's Socrata catalogs carry only *annual* T-100 summaries and the PREZIP area holds unpredictable cached user extracts; the reliable monthly source is the table's own download form (`DL_SelectFields.aspx`). The fetcher requests one zip per year back to 2015: it GETs the form, harvests the WebForms hidden state and session cookies, posts the per-column checkboxes (YEAR, MONTH, ORIGIN, PASSENGERS, FREIGHT, DEPARTURES_PERFORMED) with `cboGeography=All`/`cboYear`/`cboPeriod=All`, unzips the reply with a dependency-free reader (picking the data CSV over the bundled field-description file) and aggregates BOTH ends of every segment so the measures match the catalogue's conventions: passengers = enplaned + deplaned (total passengers, the figure airports publish — origin-only sums would be enplanements, roughly half), movements = departures + arrivals, freight = tonnes loaded + unloaded (lbs→tonnes), matching Eurostat's PAS_CRD / CAF_PAS / FRM_LD_NLD definitions, by airport × month for the ~35 largest US gateways. Socrata is still tried first (it wins automatically if DOT ever publishes a monthly table there) and PREZIP remains a merge-safe fallback. Best-effort with last-good fallback; total failure exits non-zero into the pipeline-health issue. Note T-100 publishes with a ~2–3 month lag, so US `latest` months trail the European feed. |

Eurostat airport codes are `<geo>_<ICAO>` (e.g. `ES_LEMD`, `AT_LOWG`); the geo
prefix gives the country (`EL`→GR, `UK`→GB, else ISO-3166 alpha-2). The country,
ISO codes, region and display name ride on each airport in
`activity-index.json`.

#### Pin every dimension

`avia_paoa` and `avia_gooa` are **seven-dimension** cubes — `freq`, `unit`,
`tra_meas`, `rep_airp`, `schedule`, `tra_cov`, `time` — and `esDecode()` walks
only two of them (`rep_airp` × `time`). Anything left unpinned in the query
comes back with more than one category and the stride maths silently reads
**category 0**, which is whatever sorts first, not whatever holds data.

`schedule` is the trap: it carries two generations of codes whose labels are
identical. `TOTAL` and `TOT` both read "Total" in the dataviewer. The old
generation sorts first and is near-empty:

| `schedule` | Frankfurt | Amsterdam | Madrid | Paris CDG |
|---|---|---|---|---|
| `TOTAL` (what we sent) | 5 | 3 | 3 | **0** |
| `TOT` (where the data lives) | 133 | 135 | 135 | 132 |

Same story on all three metrics. So every dimension is now pinned in one
place —

```js
export const ES_PINS = { schedule: "TOT", tra_cov: "TOTAL" };
```

— spread into the enumerate, all three metric pulls and the segment pulls
(`paxSeg` overrides `tra_cov` on purpose), and `esDecode()` **throws** rather
than decode a response with any loose dimension. `scripts/probe-eurostat.mjs`
(manual workflow `Probe Eurostat`) imports `ES_PINS` and `esDecode` from the
fetcher and checks the real production query against the live API — re-run it
whenever Eurostat changes shape or the pins are edited.

### Macro drivers — `data/macro.json` (`scripts/fetch-data.mjs`)
Pulls three World Bank indicators for every country present in
`activity-index.json`:

| Field           | World Bank indicator   | Reduction                       | Feeds                        |
|-----------------|------------------------|----------------------------------|------------------------------|
| `gdp`           | `NY.GDP.MKTP.KD.ZG`    | trailing 5-yr mean               | reference                    |
| `gdpcap`        | `NY.GDP.PCAP.KD.ZG`    | trailing 5-yr mean                | GDP/capita lever + regressor extrapolation rate |
| `gdpcapSeries`  | `NY.GDP.PCAP.KD`       | full yearly level series, untouched | the Prophet candidate's GDP/capita regressor (`build-forecast.py`) |
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
country. Pulled via IMF's plain-JSON DataMapper API by deriving per-capita
growth from two WEO series — `NGDP_RPCH` (real GDP growth, %) and `LP`
(population): `(1+gdp)/(1+popGrowth)-1`. Probing the live API (see the
fetcher's header) established that DataMapper's WEO dataset has NO direct
real-per-capita series, that the similarly-named `NGDPRPC_PCH` belongs to
the Sub-Saharan-Africa REO dataset (the trap PR #20 burned a day on), and
that the country/periods filters are silently ignored — so each indicator
is fetched whole, once, and all selection happens in the script. Chosen
over OECD's SDMX Economic Outlook feed,
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

**Three candidate models** are fit **server-side** per airport per metric on the
real series in `data/series/<IATA>.json`, scored on identical rolling-origin
folds, and the winner is published:

| candidate | what it is |
| --- | --- |
| `snaive`  | Seasonal naive — each month repeats the most recent observed value for that calendar month. No trend, no holidays. |
| `ets`     | Holt-Winters — additive **damped** trend + multiplicative monthly seasonality, smoothing constants and the damping factor φ grid-searched on one-step error. |
| `prophet` | Meta **Prophet** — additive trend + multiplicative yearly seasonality + country public holidays (via the `holidays` package) + COVID events + a GDP/capita regressor where one exists. |

The seasonal naive is a **competitor, not a footnote**: across the whole
catalogue it beats Prophet on most series, and a fitted model that can't beat it
isn't earning its complexity. Candidates are tried simplest-first and a more
complex one only takes over when it cuts the error by ≥5% relative
(`SELECT_MARGIN`) — ties go to the simpler model, and the margin stops ordinary
fold noise from flipping the published model from night to night.

Selection runs on **MASE**, not MAPE. MAPE divides by the actual, so it explodes
as a series approaches zero: `ISL/atm` scored 22,949% not because the model is
that bad but because Atatürk closed to commercial traffic and monthly movements
fell from 33,486 to a few hundred. MASE divides by the *in-sample seasonal-naive
MAE* instead — finite at zero, comparable across airports, and MASE < 1 literally
reads "beat a seasonal naive". MAPE is still published because planners recognise
it, but it decides nothing. On a series with no year-over-year variation at all
(a flat feed, or one that repeats exactly) the MASE denominator degenerates to
zero; `mase` is then honestly `null` and selection ranks on unscaled `mae`.

`forecast-meta.json` holds only the shared model metadata (generatedAt, models,
selection rule, `chosenCounts`, library, interval, horizon) — tiny, loaded once.
Each airport's actual forecast output lives in its own
`data/forecasts/<IATA>.json`, fetched by the browser only once that gateway is
selected (the same lazy pattern as the activity series). Each airport's ISO-2
country (for the holiday calendar) is read from `activity-index.json`.

**Payload layout per metric.** The chosen model's arrays sit at the **top level**
(`forecast`, `backtest`, and its scores), so an older client and the validator
read it unchanged. `candidates` carries every candidate's scores plus the
*alternatives'* `forecast`/`backtest` — that's what the model toggle on the
Short-term screen switches between. The winner's arrays are deliberately **not**
duplicated inside `candidates`; that would add ~2.5 KB per metric across 446
airports to a nightly commit, and `validate-data.mjs` fails the build if a
regression starts duplicating them. Nothing is fit client-side for a catalogue
gateway — the browser only fits ETS for an *uploaded* gateway, which has no
nightly output at all.

The **COVID collapse (2020-03 → 2021-12)** is modeled as one explicit dummy
event per month rather than fed in as ordinary data — Prophet attributes the
dip/recovery to those events (which never recur, so zero forward effect) instead
of letting them distort the multiplicative seasonality or inflate the
trend-uncertainty band. Nothing is dropped: every observed month still trains the
model and appears on the actuals chart. In CI this cut median passenger backtest
MAPE from ~16% to ~5%.

**Backtesting is rolling-origin** (`rolling_backtest()` in
`build-forecast.py`): up to 3 refits per series, each trained with a further
12 months held out and scored on those unseen months — and **every candidate is
scored on the same folds**, which is the only thing that makes the MASE
comparison meaningful. Each metric's forecast JSON carries `chosen`,
`chosen_reason`, `mase` (mean across folds — the number selection ran on),
`mase_folds`, `mape`, `mape_folds`, `mae`, `naive_mape`/`naive_mase` (the
seasonal-naive candidate's own scores, over those same folds), `skill`
(1 − mape/naive_mape), `coverage` / `band_scale` / `coverage_cal` (the band
calibration described below), and `backtest` (the most recent fold's month-by-month
predicted-vs-actual, which the Short-term screen charts) — plus the same score
set per candidate under `candidates`. For a quick local run against a subset of
airports: `GLIDEPATH_ONLY="AMS,YYZ" python scripts/build-forecast.py` (skips
pruning, so the other committed forecasts survive).

**Bands are calibrated against measured coverage.** The three candidates derive
their intervals three incompatible ways — Prophet samples a posterior, ETS grows
one from in-sample residuals, the seasonal naive uses a seasonal-random-walk
sigma — and none of them delivered the 80% they claimed. Measured on a
60-airport sample:

| candidate | median coverage of its raw "80%" band |
| --- | --- |
| `snaive`  | 100% (far too wide) |
| `ets`     | 97% (too wide) |
| `prophet` | 39% (far too narrow) |

So the label was wrong in both directions, differently per model. Each candidate
now publishes a `band_scale`: the INTERVAL-th quantile of each held-out month's
error measured *in units of that month's own one-sided band half-width*
(`band_scale_of`). Above 1 it widens a band that was too narrow, below 1 it
tightens one that was too wide, and it works uniformly regardless of how the raw
band was derived. It's clamped to `[0.25, 4.0]` — a handful of held-out months
can throw an extreme quantile, and a 30x band is less useful than an honestly
wrong one.

Two coverage numbers are published, and the distinction matters:

- **`coverage`** — the RAW band's coverage, measured out-of-sample. Still the
  honest headline.
- **`coverage_cal`** — what the scaled band achieves on those same held-out
  months. The factor was fitted on exactly those months, so this is **in-sample**
  and the model card says so.

The scale is applied to the forward `forecast` rows only. The `backtest` rows
shipped for the accountability chart keep their raw band deliberately: widening
them would flatter the model on the very months the factor was fitted to. The
in-browser ETS (uploaded gateways) applies the same formula to its single
12-month holdout, with a floor of 8 scoreable months before it will calibrate at
all. Where the clamp binds and coverage is still under 65%, the Short-term screen
says to read the point forecast rather than the range.

### Which model the long-term forecast compounds off
The long-term elasticity model raises **one base year** to the power of the
horizon, so that year moves the endpoint more than any single lever. It is built
from the *current* calendar year, with its not-yet-observed months filled in by
the short-term model chosen above (or the one the visitor toggled to) — so the
strategic curve starts from where the tactical model says this year lands rather
than from a year that may be well over a year stale. Each metric is completed by
its own tactical forecast, falling back to the prior year's same month when no
model can reach it; `GP_longTerm` returns `baseMode`, `baseObservedMonths`,
`baseForecastMonths`, `baseCompletion` and `baseModel` so every screen showing a
base-year number can disclose how it was assembled. The Long-term screen has a
**Last full year** switch that reverts to the old observed-only base — a modeled
base year inherits the tactical model's error into every projected year, and that
trade is the user's to make.

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
node scripts/fetch-bts.mjs         # activity-index.json + series/<IATA>.json (US BTS T-100, ~35 gateways)
node scripts/fetch-activity.mjs    # activity-index.json + series/<IATA>.json (Eurostat + StatCan) + trims airports.json
node scripts/fetch-data.mjs        # macro.json (World Bank, no key)
node scripts/fetch-imf.mjs         # imf-weo.json (IMF WEO forward GDP/capita forecast, no key)
pip install -r scripts/requirements.txt
python scripts/build-forecast.py   # forecast-meta.json + forecasts/<IATA>.json (3 candidates, best by MASE)
```
Node 20+. Each rewrites its snapshot under `data/`. Commit the result, or let the
Action do it.

## Deploy on GitHub Pages
1. Push this folder to a repo.
2. Settings → Pages → deploy from branch (root).
3. Settings → Actions → General → Workflow permissions → **Read and write**
   (so the bot can commit the nightly snapshot).
4. Actions tab → "Refresh data" → **Run workflow** to seed the first pull.

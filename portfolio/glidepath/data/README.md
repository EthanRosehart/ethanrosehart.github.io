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
             │ git commit data/*.json
             ▼
┌──────────────────────────┐
│ Repo  →  GitHub Pages     │  (auto-redeploy on push)
             │ same-origin fetch("data/*.json")
             ▼
┌──────────────────────────┐
│ Browser (index.html)      │  builds its airport catalogue from the snapshots;
│ app.jsx loader            │  falls back to nothing if a file is missing
└──────────────────────────┘
```

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

### Monthly activity — `data/activity.json` (`scripts/fetch-activity.mjs`)
Real monthly **passengers / movements / cargo** by airport. **This is the series
the forecasts run on.** The browser builds its entire airport catalogue from this
file (enriched by `airports.json`); there is no hand-curated airport list.

| Market | Source | Notes |
|--------|--------|-------|
| Europe | Eurostat `avia_paoa` (PAS_CRD pax, CAF_PAS flights) + `avia_gooa` (FRM_LD_NLD cargo, tonnes) | A single all-airports pull is rejected with HTTP 413 (async). The script enumerates reporting airports with a small `lastTimePeriod` call, ranks by recent volume, and batch-fetches full series for the busiest ~70 in `rep_airp` chunks, splitting any chunk that still trips the 413 guard. |
| Canada | StatCan WDS — 23-10-0312 (screened pax) + 23-10-0008 (movements) | The eight CATSA Class-1 airports, resolved by airport name against the cube metadata. |
| US | BTS T-100 (`scripts/fetch-bts.mjs`) | Not currently wired — the Socrata catalog exposes no monthly segment table. US airports are simply absent (no modeling). |

Eurostat airport codes are `<geo>_<ICAO>` (e.g. `ES_LEMD`, `AT_LOWG`); the geo
prefix gives the country (`EL`→GR, `UK`→GB, else ISO-3166 alpha-2). The country,
ISO codes, region and display name ride on each airport in `activity.json`.

### Macro drivers — `data/macro.json` (`scripts/fetch-data.mjs`)
Pulls three World Bank indicators for every country present in `activity.json`:

| Field    | World Bank indicator   | Reduction                       | Feeds            |
|----------|------------------------|---------------------------------|------------------|
| `gdp`    | `NY.GDP.MKTP.KD.ZG`    | trailing 5-yr mean              | reference        |
| `gdpcap` | `NY.GDP.PCAP.KD.ZG`    | trailing 5-yr mean              | GDP/capita lever |
| `pop`    | `SP.POP.TOTL`          | latest year-over-year % change  | population lever |

The loader overlays these over the `MACRO` table in `data.jsx`, creating a
default entry (`GP_ensureMacro`) for any country not already listed, so the
long-term elasticity lever reflects live macro for every catalogue airport.

### Short-term forecasts — `data/forecast.json` (`scripts/build-forecast.py`)
Meta **Prophet** (additive trend + multiplicative yearly seasonality + country
public holidays, via the `holidays` package) fit **server-side** per airport per
metric on the real `activity.json` series. The browser renders these directly —
no forecasting happens client-side. Each airport's ISO-2 country (for the holiday
calendar) is read from `activity.json`.

> Income elasticity, tourism and fuel remain model assumptions in the long-term
> lever (no clean single public series). Passengers, movements, cargo and macro
> drivers are the wired real feeds.

## Run it locally
```bash
node scripts/fetch-openflights.mjs # airports.json (OpenFlights full reference)
node scripts/fetch-activity.mjs    # activity.json (Eurostat + StatCan) + trims airports.json
node scripts/fetch-bts.mjs         # activity.json (US BTS — currently a no-op)
node scripts/fetch-data.mjs        # macro.json    (World Bank, no key)
python scripts/build-forecast.py   # forecast.json (Meta Prophet; pip install prophet holidays pandas)
```
Node 20+. Each rewrites its snapshot under `data/`. Commit the result, or let the
Action do it.

## Deploy on GitHub Pages
1. Push this folder to a repo.
2. Settings → Pages → deploy from branch (root).
3. Settings → Actions → General → Workflow permissions → **Read and write**
   (so the bot can commit the nightly snapshot).
4. Actions tab → "Refresh data" → **Run workflow** to seed the first pull.

# Glidepath — data pipeline

The app runs as a **static site** (works on GitHub Pages). It never calls
external APIs from the browser. Instead, a nightly GitHub Action fetches public
data **server-side** and commits a JSON snapshot that the site serves.

```
┌──────────────────────────┐     nightly cron (03:17 UTC)
│ GitHub Action runner      │ ── fetch ──▶ World Bank Indicators API
│ scripts/fetch-data.mjs    │ ◀── JSON ──   World Bank · Eurostat · StatCan
│ scripts/fetch-activity.mjs│
             │ git commit data/macro.json
             ▼
┌──────────────────────────┐
│ Repo  →  GitHub Pages     │  (auto-redeploy on push)
└────────────┬─────────────┘
             │ same-origin fetch("data/macro.json" + "data/activity.json")
             ▼
┌──────────────────────────┐
│ Browser (index.html)      │  merges live values over built-in baselines;
│ app.jsx loader            │  falls back to defaults if the file is missing
└──────────────────────────┘
```

## What's wired

### Macro drivers — `data/macro.json` (`scripts/fetch-data.mjs`)
Pulls three World Bank indicators for every country in the airport set:

| Field    | World Bank indicator   | Reduction                       | Feeds            |
|----------|------------------------|---------------------------------|------------------|
| `gdp`    | `NY.GDP.MKTP.KD.ZG`    | trailing 5-yr mean              | reference        |
| `gdpcap` | `NY.GDP.PCAP.KD.ZG`    | trailing 5-yr mean              | GDP/capita lever |
| `pop`    | `SP.POP.TOTL`          | latest year-over-year % change  | population lever |

These overwrite `MACRO[cc].gdpcap` and `MACRO[cc].pop` in `data.jsx`, which set
the default scenario for the long-term elasticity model.

### Airport reference — `data/airports.json` (`scripts/fetch-openflights.mjs`)
Fetches the OpenFlights `airports.dat` (public CSV on GitHub) and filters it to
the Glidepath set. The app enriches its catalogue (ICAO, lat/lon, elevation,
timezone) from this authoritative source on load. OpenFlights is a static
dataset, not a live API — widen the set by adding IATA codes to `WANT` (and an
`ANCHOR` row in `data.jsx` so the airport can forecast).

### GDP projections — `data/oecd.json` (`scripts/fetch-oecd.mjs`)
Pulls forward-looking real GDP-growth **projections** from the OECD Economic
Outlook (SDMX API). These set the **GDP-growth lever default** in the long-term
model — `defaultScenario` prefers `MACRO[cc].gdpcapProj` (OECD projection) over
the World Bank historical mean. OECD renames its SDMX dataflow between releases;
if a run returns nothing, update `DATAFLOW`/`KEY` in the script (it logs what it
parsed, and keeps the last good snapshot on failure).

### Monthly passengers — `data/activity.json` (`scripts/fetch-activity.mjs`)
Real monthly passenger counts by airport. **This is the series the forecasts run
on** — when an airport is `observed`, `buildHistory` in `data.jsx` replaces its
synthetic passengers with these values, and both the short-term ML and long-term
elasticity models fit the real data.

| Market           | Source                                            | Coverage              |
|------------------|---------------------------------------------------|-----------------------|
| Europe (11 apts) | Eurostat `avia_paoc` (PAS_CRD, monthly)           | live, no key          |
| Canada (6 apts)  | StatCan WDS — Table 23-10-0253                     | live, coordinate map  |
| US (4 apts)      | none (no single clean public monthly feed)        | modeled               |

Eurostat airport codes are `<geo>_<ICAO>` (e.g. `UK_EGTE`, `AT_LOWG`). The
StatCan path resolves each airport via the `STATCAN_COORD` map in the script —
verify the member ids against the cube metadata if you add airports.

> Income elasticity, tourism and fuel remain model assumptions (no clean single
> public series). Passengers and macro drivers are the wired feeds.

## Run it locally
```bash
node scripts/fetch-openflights.mjs # airports.json (OpenFlights reference)
node scripts/fetch-data.mjs        # macro.json    (World Bank, no key)
node scripts/fetch-oecd.mjs        # oecd.json     (OECD Economic Outlook)
node scripts/fetch-activity.mjs    # activity.json (Eurostat + StatCan)
```
Node 20+. Each rewrites its snapshot under `data/`. Commit the result, or let
the Action do it. If a feed is down, the activity/OECD scripts keep the last
good series per airport rather than dropping it.

## Deploy on GitHub Pages
1. Push this folder to a repo.
2. Settings → Pages → deploy from branch (root).
3. Settings → Actions → General → Workflow permissions → **Read and write**
   (so the bot can commit the nightly snapshot).
4. Actions tab → "Refresh macro data" → **Run workflow** to seed the first pull.

## Add more live feeds later
US aviation (BTS T-100) is the main unwired series — US airports stay modeled.
Wire it the same way: add a fetch to a script under `scripts/`, write a file
under `data/`, and read it in `app.jsx`. The browser contract never changes —
it only ever reads committed JSON.

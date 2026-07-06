#!/usr/bin/env node
/* ============================================================
 * fetch-imf.mjs — IMF World Economic Outlook (WEO) GDP/capita forecast
 *
 * Pulls a REAL forward-looking real GDP/capita growth forecast from the
 * IMF's DataMapper API (WEO database, refreshed every April/October) and
 * writes data/imf-weo.json. This is a genuine third-party projection, not
 * an extrapolation of history — unlike the trailing-rate extrapolation
 * build-forecast.py falls back to for a country this file doesn't cover.
 *
 * Uses NGDPRPPPPC (real GDP per capita, constant prices, PPP 2017 int'l $)
 * rather than an aggregate growth indicator: the long-term model's "gdp"
 * lever is specifically PER-CAPITA growth — population growth is already
 * a separate additive term (see defaultScenario() in data.jsx) — so
 * feeding it aggregate growth would double-count population. Growth
 * rates are derived from consecutive years' levels, which also cancels
 * the (constant, per-country) PPP conversion factor: only the ratio
 * between consecutive years is used.
 *
 * Hard-won API lessons, in CI logs of PR #20's dispatch runs:
 *   - NGDPRPC_PCH is NOT a WEO indicator — it belongs to the Sub-Saharan
 *     Africa Regional Economic Outlook dataset. Querying it "worked" but
 *     returned only African countries/aggregates (AGO, BEN, … CEMAC).
 *   - The /{indicator}/{country} path filter and the ?periods= param are
 *     silently IGNORED whenever they don't match — the API just dumps the
 *     indicator's entire dataset instead of erroring. So this fetcher
 *     requests the whole indicator ONCE (small — one number per country
 *     per year) and does country/year selection itself, where behavior
 *     is guaranteed.
 *
 * Deliberately NOT OECD's SDMX Economic Outlook endpoint: that was tried
 * three separate times for this exact purpose (see git history on the
 * now-deleted fetch-oecd.mjs) and dropped after persistent HTTP 500s.
 * IMF's DataMapper is a plain JSON REST API — no SDMX, no dataflow
 * version to guess, no key-shape trial and error.
 *
 * A country this fetch can't resolve (or a total fetch failure) is never
 * a hard failure for the app: build-forecast.py's gdp_monthly_series()
 * falls back to extrapolating World Bank's trailing growth rate instead.
 *
 * Run locally:  node scripts/fetch-imf.mjs
 * ============================================================ */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data", "imf-weo.json");
const ACTIVITY = resolve(__dirname, "..", "data", "activity-index.json");

/* ISO3 -> friendly name, same baseline/derivation pattern as fetch-data.mjs
   (kept independent rather than shared so either fetcher can run alone). */
const BASELINE = {
  CAN: "Canada", USA: "United States", GBR: "United Kingdom",
  NLD: "Netherlands", DEU: "Germany", DNK: "Denmark",
  AUT: "Austria", ITA: "Italy", POL: "Poland",
};

async function deriveCountries() {
  const countries = { ...BASELINE };
  try {
    const act = JSON.parse(await readFile(ACTIVITY, "utf8"));
    for (const a of Object.values(act.airports || {})) {
      if (a.cc && a.countryName) countries[a.cc] = a.countryName;
    }
  } catch {
    console.warn("activity-index.json not readable — using baseline country list.");
  }
  return countries;
}

const INDICATOR = "NGDPRPPPPC"; // real GDP per capita, constant prices (PPP, 2017 int'l $) — a real WEO DataMapper indicator
const API = "https://www.imf.org/external/datamapper/api/v1";
const YEARS_BACK = 1; // one actual year further back, so the first projected year has a predecessor to grow from
const YEARS_FWD = 5;  // WEO's typical projection horizon

/** One request for the indicator's entire dataset — no country path
 *  segment, no periods param, since both are silently ignored on any
 *  mismatch (see header). Returns { CC: { "2025": level, ... }, ... }
 *  for every country IMF publishes; the caller selects what it needs. */
async function fetchAllLevels() {
  const url = `${API}/${INDICATOR}`;
  const res = await fetch(url, { headers: { "User-Agent": "glidepath-data-bot" } });
  if (!res.ok) throw new Error(`IMF ${INDICATOR}: HTTP ${res.status}`);
  const body = await res.json();
  const values = body?.values?.[INDICATOR];
  if (!values || typeof values !== "object" || !Object.keys(values).length) {
    throw new Error(`IMF ${INDICATOR}: unexpected payload shape`);
  }
  return values;
}

const round1 = (n) => Math.round(n * 10) / 10;

/** {"2025": level, "2026": level, ...} -> [{year, pct}] ascending, one entry
 *  per year that has both itself and its predecessor's level (the earliest
 *  year in the window, with no predecessor in this response, is dropped
 *  rather than guessed at). Years outside [now-YEARS_BACK, now+YEARS_FWD]
 *  are excluded here — the dataset ships IMF's full history, which the app
 *  doesn't need (World Bank actuals already cover the past). */
function growthRates(levelsByYear) {
  const now = new Date().getFullYear();
  const years = Object.keys(levelsByYear)
    .map(Number)
    .filter((y) => y >= now - YEARS_BACK && y <= now + YEARS_FWD)
    .sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < years.length; i++) {
    const y0 = years[i - 1], y1 = years[i];
    const v0 = levelsByYear[y0], v1 = levelsByYear[y1];
    if (v0 == null || v1 == null || v0 === 0) continue;
    out.push({ year: y1, pct: round1(((v1 / v0) - 1) * 100) });
  }
  return out;
}

async function main() {
  const countries = await deriveCountries();
  const codes = Object.keys(countries);
  console.log(`Fetching IMF WEO (${INDICATOR}), selecting ${codes.length} countries…`);

  const values = await fetchAllLevels();

  const upcomingYear = new Date().getFullYear() + 1;
  const out = {};
  const missing = [];
  for (const cc of codes) {
    const levels = values[cc];
    if (!levels) { missing.push(cc); continue; }
    const rates = growthRates(levels);
    if (!rates.length) { missing.push(cc); continue; }
    // near-term default for the long-term model's GDP lever: the next
    // calendar year's growth, not an average across the horizon — the most
    // immediately actionable single number. `rates[0]` is actually THIS
    // year's growth (the earliest window has no predecessor to grow from
    // until periods[1]), so pick the real next-year entry explicitly rather
    // than assuming index 0 — falling back to it only if IMF's window
    // somehow doesn't reach a year out.
    const nextYear = rates.find(r => r.year === upcomingYear) || rates[0];
    out[cc] = { name: countries[cc], nextYear, years: rates }; // years: full horizon, for Prophet's per-year regressor extrapolation
    console.log(`  ${cc}  next=${nextYear.year}:${nextYear.pct}%  horizon=${rates.length}yr`);
  }
  if (missing.length) console.warn(`IMF: no WEO coverage for ${missing.length}/${codes.length} countries — ${missing.join(", ")}`);
  if (!Object.keys(out).length) throw new Error("no IMF WEO values parsed for any country — check INDICATOR/payload shape");

  const result = {
    generatedAt: new Date().toISOString(),
    source: "IMF World Economic Outlook (DataMapper API, www.imf.org/external/datamapper) — real GDP/capita growth forecast",
    indicator: `${INDICATOR} · real GDP per capita, constant prices (PPP, 2017 int'l $) — growth computed between consecutive years' levels`,
    note: ("Genuine forward-looking forecast (WEO, refreshed each April/October), not an extrapolation of history. "
      + "Feeds the long-term model's GDP lever default (gdpcapProj) and, per year, Prophet's GDP/capita regressor "
      + "beyond the last observed year, in build-forecast.py. A country missing here falls back to the trailing "
      + "World Bank growth-rate extrapolation instead — never a hard failure."),
    countries: out,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log("Wrote", OUT, `— ${Object.keys(out).length} countries.`);
}

main().catch((err) => {
  console.error("IMF WEO snapshot failed:", err.message);
  // Non-zero exit so the workflow surfaces the failure, but nothing is
  // written — a previously-committed data/imf-weo.json stays in place
  // untouched, and build-forecast.py's fallback path is unaffected either way.
  process.exit(1);
});

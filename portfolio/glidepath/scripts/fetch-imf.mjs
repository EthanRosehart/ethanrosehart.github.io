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
 * Derives per-capita growth from two WEO series:
 *     NGDP_RPCH  real GDP growth, annual % change
 *     LP         population, millions (levels)
 *     percap% = ((1 + gdp/100) / (1 + popGrowth/100) - 1) * 100
 * because the long-term model's "gdp" lever is specifically PER-CAPITA
 * growth — population growth is already a separate additive term (see
 * defaultScenario() in data.jsx) — and DataMapper's WEO dataset exposes
 * NO real-per-capita indicator directly. Facts from probing the live API
 * (run 28769363322's IMF step dumps /indicators and response shapes):
 *   - the catalogue's only WEO per-capita series are CURRENT-price
 *     (NGDPDPC, PPPPC) — wrong for a real-growth lever;
 *   - NGDPRPC_PCH ("Real Per Capita GDP Growth") is dataset=AFRREO,
 *     Sub-Saharan Africa only — the trap PR #20 burned a day on;
 *   - NGDPRPPPPC does not exist (bare {"api"} response);
 *   - the /{indicator}/{country} path filter and ?periods= param are
 *     silently IGNORED — every request returns the indicator's whole
 *     dataset (229 countries, 1980..2031). So fetch each indicator once
 *     and do all country/year selection here, where behavior is real.
 *
 * Deliberately NOT OECD's SDMX Economic Outlook endpoint: that was tried
 * three separate times for this exact purpose (see git history on the
 * now-deleted fetch-oecd.mjs) and dropped after persistent HTTP 500s.
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

const API = "https://www.imf.org/external/datamapper/api/v1";
const GDP_IND = "NGDP_RPCH"; // real GDP growth, annual % change (WEO)
const POP_IND = "LP";        // population, millions (WEO)
const YEARS_BACK = 1; // one year of LP history so the first year has a predecessor for population growth
const YEARS_FWD = 5;  // WEO's typical projection horizon

/** One request for an indicator's entire dataset (filters are no-ops, see
 *  header). Returns { CC: { "2025": value, ... }, ... }. */
async function fetchDataset(indicator) {
  const res = await fetch(`${API}/${indicator}`, { headers: { "User-Agent": "glidepath-data-bot" } });
  if (!res.ok) throw new Error(`IMF ${indicator}: HTTP ${res.status}`);
  const body = await res.json();
  const values = body?.values?.[indicator];
  if (!values || typeof values !== "object" || !Object.keys(values).length) {
    throw new Error(`IMF ${indicator}: unexpected payload shape`);
  }
  return values;
}

const round1 = (n) => Math.round(n * 10) / 10;

/** Real per-capita growth per year in [now .. now+YEARS_FWD], from the
 *  country's aggregate growth pcts and population levels. A year needs its
 *  own gdp pct plus this and last year's population; anything missing just
 *  drops that year. -> [{year, pct}] ascending. */
function perCapitaRates(gdpPct, popLevels) {
  const now = new Date().getFullYear();
  const out = [];
  for (let y = now; y <= now + YEARS_FWD; y++) {
    const g = gdpPct?.[y];
    const p1 = popLevels?.[y], p0 = popLevels?.[y - 1];
    if (g == null || p1 == null || p0 == null || p0 <= 0) continue;
    const popG = (p1 / p0) - 1;
    out.push({ year: y, pct: round1(((1 + g / 100) / (1 + popG) - 1) * 100) });
  }
  return out;
}

async function main() {
  const countries = await deriveCountries();
  const codes = Object.keys(countries);
  console.log(`Fetching IMF WEO (${GDP_IND} + ${POP_IND}), selecting ${codes.length} countries…`);

  const [gdp, pop] = await Promise.all([fetchDataset(GDP_IND), fetchDataset(POP_IND)]);

  const upcomingYear = new Date().getFullYear() + 1;
  const out = {};
  const missing = [];
  for (const cc of codes) {
    const rates = perCapitaRates(gdp[cc], pop[cc]);
    if (!rates.length) { missing.push(cc); continue; }
    // near-term default for the long-term model's GDP lever: the next
    // calendar year's growth, not an average across the horizon — the most
    // immediately actionable single number. rates[0] is THIS year's growth,
    // so pick the real next-year entry explicitly, falling back to it only
    // if IMF's window somehow doesn't reach a year out.
    const nextYear = rates.find(r => r.year === upcomingYear) || rates[0];
    out[cc] = { name: countries[cc], nextYear, years: rates }; // years: full horizon, for Prophet's per-year regressor extrapolation
    console.log(`  ${cc}  next=${nextYear.year}:${nextYear.pct}%  horizon=${rates.length}yr`);
  }
  if (missing.length) console.warn(`IMF: no WEO coverage for ${missing.length}/${codes.length} countries — ${missing.join(", ")}`);
  if (!Object.keys(out).length) throw new Error("no IMF WEO values parsed for any country — check indicators/payload shape");

  const result = {
    generatedAt: new Date().toISOString(),
    source: "IMF World Economic Outlook (DataMapper API, www.imf.org/external/datamapper) — real GDP/capita growth forecast",
    indicator: `${GDP_IND} (real GDP growth, %) ÷ ${POP_IND} (population) — real per-capita growth derived per year; WEO's DataMapper has no direct real-per-capita series`,
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

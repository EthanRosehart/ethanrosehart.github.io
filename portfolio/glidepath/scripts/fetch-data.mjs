#!/usr/bin/env node
/* ============================================================
 * fetch-data.mjs — Glidepath macro snapshot builder
 *
 * Runs on a GitHub Actions runner (Node 20+), NOT in a browser,
 * so there are no CORS limits. It pulls public macro indicators
 * from the World Bank Open Data API for every country in the
 * Glidepath airport set, reduces them to forecast-ready numbers,
 * and writes data/macro.json. GitHub Pages then serves that file
 * and the app reads it same-origin.
 *
 * No API key required. Run locally with:  node scripts/fetch-data.mjs
 * ============================================================ */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data", "macro.json");
const ACTIVITY = resolve(__dirname, "..", "data", "activity.json");

/* ISO3 -> friendly name. The live set is derived from the airports that
   actually carry data (activity.json); this baseline guarantees coverage
   even on a cold checkout before the activity feed has run. */
const COUNTRIES = {
  CAN: "Canada", USA: "United States", GBR: "United Kingdom",
  NLD: "Netherlands", DEU: "Germany", DNK: "Denmark",
  AUT: "Austria", ITA: "Italy", POL: "Poland",
};

async function deriveCountries() {
  try {
    const act = JSON.parse(await readFile(ACTIVITY, "utf8"));
    for (const a of Object.values(act.airports || {})) {
      if (a.cc && a.countryName) COUNTRIES[a.cc] = a.countryName;
    }
    console.log(`Derived ${Object.keys(COUNTRIES).length} countries from activity.json.`);
  } catch { console.warn("activity.json not readable — using baseline country list."); }
}

const IND = {
  gdp:      "NY.GDP.MKTP.KD.ZG", // real GDP growth (annual %)
  gdpcap:   "NY.GDP.PCAP.KD.ZG", // real GDP per capita growth (annual %)
  gdpLevel: "NY.GDP.PCAP.KD",    // real GDP per capita, level (constant 2015 US$)
  pop:      "SP.POP.TOTL",       // total population
};

const API = "https://api.worldbank.org/v2";

async function fetchIndicator(indicator) {
  const codes = Object.keys(COUNTRIES).join(";");
  const url = `${API}/country/${codes}/indicator/${indicator}?format=json&per_page=4000&date=2010:2025`;
  const res = await fetch(url, { headers: { "User-Agent": "glidepath-data-bot" } });
  if (!res.ok) throw new Error(`${indicator}: HTTP ${res.status}`);
  const body = await res.json();
  const rows = Array.isArray(body) ? body[1] : null;
  if (!rows) throw new Error(`${indicator}: unexpected payload`);
  // group by country -> [{year, value}] sorted ascending, nulls dropped
  const byCC = {};
  for (const r of rows) {
    const cc = r.countryiso3code;
    if (!COUNTRIES[cc]) continue;
    if (r.value == null) continue;
    (byCC[cc] ||= []).push({ year: +r.date, value: +r.value });
  }
  for (const cc of Object.keys(byCC)) byCC[cc].sort((a, b) => a.year - b.year);
  return byCC;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const round1 = (n) => Math.round(n * 10) / 10;
const trailingMean = (series, n = 5) => {
  const vals = series.slice(-n).map((x) => x.value);
  return vals.length ? round1(mean(vals)) : null;
};

async function main() {
  await deriveCountries();
  console.log("Fetching World Bank indicators for", Object.keys(COUNTRIES).length, "countries…");
  const [gdp, gdpcap, gdpLevel, pop] = await Promise.all([
    fetchIndicator(IND.gdp),
    fetchIndicator(IND.gdpcap),
    fetchIndicator(IND.gdpLevel),
    fetchIndicator(IND.pop),
  ]);

  const countries = {};
  for (const cc of Object.keys(COUNTRIES)) {
    const popSeries = pop[cc] || [];
    const last = popSeries[popSeries.length - 1];
    const prev = popSeries[popSeries.length - 2];
    const popGrowth = last && prev ? round1(((last.value / prev.value) - 1) * 100) : null;
    // real yearly GDP/capita levels (not just the trailing-mean growth rate
    // above) — World Bank has no GDP forecast product, so build-forecast.py
    // uses this history plus the trailing growth rate to extrapolate forward
    // for Prophet's regressor; see gdp_monthly_series() there.
    const levelSeries = gdpLevel[cc] || [];
    const gdpcapSeries = Object.fromEntries(levelSeries.map((r) => [r.year, r.value]));
    countries[cc] = {
      name: COUNTRIES[cc],
      gdp: trailingMean(gdp[cc] || []),
      gdpcap: trailingMean(gdpcap[cc] || []),
      pop: popGrowth,
      popTotal: last ? last.value : null,
      year: last ? last.year : null,
      gdpcapSeries: Object.keys(gdpcapSeries).length ? gdpcapSeries : null,
    };
    console.log(`  ${cc}  gdp=${countries[cc].gdp}  gdpcap=${countries[cc].gdpcap}  pop=${countries[cc].pop}%  (${countries[cc].year})  gdpcapSeries[${levelSeries.length}yr]`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: "World Bank Open Data — Indicators API (api.worldbank.org/v2)",
    note: "Committed snapshot. Refreshed nightly by .github/workflows/refresh-data.yml. The browser reads THIS file, never the live API.",
    indicators: {
      gdp: "NY.GDP.MKTP.KD.ZG · real GDP growth, trailing 5-yr mean (%)",
      gdpcap: "NY.GDP.PCAP.KD.ZG · real GDP per capita growth, trailing 5-yr mean (%)",
      gdpcapSeries: "NY.GDP.PCAP.KD · real GDP per capita, level (constant 2015 US$), by year — real World Bank actuals only, no forecast; build-forecast.py extrapolates forward from this using the trailing growth rate above",
      pop: "SP.POP.TOTL · population, latest year-over-year growth (%)",
    },
    countries,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log("Wrote", OUT);
}

main().catch((err) => {
  console.error("Snapshot failed:", err.message);
  // Non-zero exit so the workflow surfaces the failure but the
  // previously-committed data/macro.json stays in place untouched.
  process.exit(1);
});

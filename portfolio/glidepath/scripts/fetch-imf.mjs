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
 * Uses NGDPRPC (real GDP per capita, constant prices, national currency)
 * rather than an aggregate growth indicator: the long-term model's "gdp"
 * lever is specifically PER-CAPITA growth — population growth is already
 * a separate additive term (see defaultScenario() in data.jsx) — so
 * feeding it aggregate growth would double-count population. Growth
 * rates are derived from consecutive years' levels, which also sidesteps
 * any currency conversion: levels stay in national currency; only the
 * ratio between consecutive years is used.
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

const INDICATOR = "NGDPRPC"; // real GDP per capita, constant prices (national currency)
const API = "https://www.imf.org/external/datamapper/api/v1";
const YEARS_BACK = 1; // one actual year further back, so the first projected year has a predecessor to grow from
const YEARS_FWD = 5;  // WEO's typical projection horizon

/** One request per country: batching multiple countries into a single path
 *  doesn't appear to be supported by the real API — a semicolon-joined
 *  segment silently fell through to the root {"api":{"version":...}}
 *  response, and a slash-joined multi-segment path 404'd. The documented
 *  single-country example (.../INDICATOR/COUNTRY?periods=...) is the one
 *  actually verified to work. Throws on a genuine failure for this country;
 *  callers treat that as "no data for this country," never a hard stop. */
async function fetchCountryLevels(cc, periods, diag) {
  const url = `${API}/${INDICATOR}/${cc}?periods=${periods.join(",")}`;
  const res = await fetch(url, { headers: { "User-Agent": "glidepath-data-bot" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const levels = body?.values?.[INDICATOR]?.[cc];
  if (!levels || typeof levels !== "object") {
    // diagnostic only, temporary, and only logged once: dump the real
    // top-level keys/body sample the first time the shape doesn't match
    // what's assumed, so a CI log shows exactly what came back instead of
    // guessing blind again.
    if (diag && !diag.logged) {
      diag.logged = true;
      console.error(`IMF ${cc} response top-level keys:`, body && typeof body === "object" ? Object.keys(body) : typeof body);
      console.error(`IMF ${cc} response sample:`, JSON.stringify(body).slice(0, 1500));
    }
    throw new Error("unexpected payload shape");
  }
  return levels; // { "2025": 12345.6, "2026": ..., ... }
}

async function fetchLevels(codes) {
  const now = new Date().getFullYear();
  const periods = [];
  for (let y = now - YEARS_BACK; y <= now + YEARS_FWD; y++) periods.push(y);
  const diag = { logged: false };
  const values = {};
  const failed = [];
  await Promise.all(codes.map(async (cc) => {
    try {
      values[cc] = await fetchCountryLevels(cc, periods, diag);
    } catch (e) {
      failed.push(`${cc} (${e.message})`);
    }
  }));
  if (failed.length) console.warn(`IMF: no data for ${failed.length}/${codes.length} countries — ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? ", …" : ""}`);
  return values; // { CC: { "2025": 12345.6, "2026": ..., ... }, ... }
}

const round1 = (n) => Math.round(n * 10) / 10;

/** {"2025": level, "2026": level, ...} -> [{year, pct}] ascending, one entry
 *  per year that has both itself and its predecessor's level (the earliest
 *  year in the window, with no predecessor in this response, is dropped
 *  rather than guessed at). */
function growthRates(levelsByYear) {
  const years = Object.keys(levelsByYear).map(Number).sort((a, b) => a - b);
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
  console.log(`Fetching IMF WEO (${INDICATOR}) for ${codes.length} countries…`);

  const values = await fetchLevels(codes);

  const upcomingYear = new Date().getFullYear() + 1;
  const out = {};
  for (const cc of codes) {
    const levels = values[cc];
    if (!levels) continue;
    const rates = growthRates(levels);
    if (!rates.length) continue;
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
  if (!Object.keys(out).length) throw new Error("no IMF WEO values parsed for any country — check INDICATOR/payload shape");

  const result = {
    generatedAt: new Date().toISOString(),
    source: "IMF World Economic Outlook (DataMapper API, www.imf.org/external/datamapper) — real GDP/capita growth forecast",
    indicator: `${INDICATOR} · real GDP per capita, constant prices, national currency — growth computed between consecutive years' levels`,
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

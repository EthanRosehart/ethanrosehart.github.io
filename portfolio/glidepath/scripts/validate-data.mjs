#!/usr/bin/env node
/* ============================================================
 * validate-data.mjs — structural schema validation for every
 * committed snapshot under data/.
 *
 * Runs in two places:
 *   - CI (test-glidepath.yml), so a fetcher change that breaks a shape
 *     fails the PR;
 *   - the nightly refresh (refresh-data.yml), as a hard gate BEFORE the
 *     commit step — a malformed upstream response must keep last-good,
 *     never ship garbage to the site.
 *
 * Deliberately dependency-free (no ajv): the shapes are few and stable,
 * and a ~150-line structural checker keeps the pipeline's zero-runtime-
 * dependency property. Exported pure so test/pipeline.test.mjs can feed
 * it fixtures.
 *
 * Run locally:  node scripts/validate-data.mjs
 * Exit: 0 clean, 1 any violation (all violations are printed, not just
 * the first).
 * ============================================================ */
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, "..", "data");

/* ---- tiny structural checkers -------------------------------- */
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isMonthKey = (k) => /^\d{4}-\d{2}$/.test(k);
const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);

/** {"YYYY-MM": finite number} — the core monthly-series shape. */
export function checkMonthlySeries(v, path, errs) {
  if (!isObj(v)) { errs.push(`${path}: expected an object of "YYYY-MM" -> number`); return; }
  for (const [k, val] of Object.entries(v)) {
    if (!isMonthKey(k)) errs.push(`${path}.${k}: bad month key (want "YYYY-MM")`);
    if (!isFiniteNum(val)) errs.push(`${path}.${k}: value must be a finite number, got ${JSON.stringify(val)}`);
  }
}

const METRICS = ["pax", "atm", "cargo"];
const SEG_KEYS = ["domestic", "transborder", "international"];

/** data/series/<IATA>.json: { series:{pax/atm/cargo: monthly}, paxSeg? } */
export function checkSeriesDoc(doc, path, errs) {
  if (!isObj(doc) || !isObj(doc.series)) { errs.push(`${path}: missing "series" object`); return; }
  const keys = Object.keys(doc.series);
  if (!keys.length) errs.push(`${path}: series is empty`);
  for (const k of keys) {
    if (!METRICS.includes(k)) { errs.push(`${path}.series.${k}: unknown metric`); continue; }
    checkMonthlySeries(doc.series[k], `${path}.series.${k}`, errs);
  }
  if (!doc.series.pax || !Object.keys(doc.series.pax).length) errs.push(`${path}: no pax series — an airport without passengers shouldn't ship`);
  if (doc.paxSeg != null) {
    if (!isObj(doc.paxSeg)) errs.push(`${path}.paxSeg: expected an object`);
    else for (const k of Object.keys(doc.paxSeg)) {
      if (!SEG_KEYS.includes(k)) { errs.push(`${path}.paxSeg.${k}: unknown segment`); continue; }
      checkMonthlySeries(doc.paxSeg[k], `${path}.paxSeg.${k}`, errs);
    }
  }
}

/** data/activity-index.json: catalogue metadata, no series. */
export function checkActivityIndex(doc, errs) {
  const path = "activity-index";
  if (!isObj(doc) || !isObj(doc.airports)) { errs.push(`${path}: missing "airports" object`); return; }
  if (typeof doc.generatedAt !== "string" || isNaN(Date.parse(doc.generatedAt))) errs.push(`${path}.generatedAt: missing/unparsable`);
  for (const [iata, a] of Object.entries(doc.airports)) {
    const p = `${path}.${iata}`;
    if (!isObj(a)) { errs.push(`${p}: not an object`); continue; }
    if (a.observed !== true) errs.push(`${p}.observed: must be true (unobserved airports don't ship)`);
    if (typeof a.source !== "string" || !a.source) errs.push(`${p}.source: missing`);
    if (!Array.isArray(a.metrics) || !a.metrics.length || a.metrics.some((m) => !METRICS.includes(m))) errs.push(`${p}.metrics: must be a non-empty subset of ${METRICS.join("/")}`);
    if (!isFiniteNum(a.months) || a.months <= 0) errs.push(`${p}.months: must be a positive number`);
    if (a.latest != null && !isMonthKey(a.latest)) errs.push(`${p}.latest: bad month key`);
    if (a.annualPax != null && !isFiniteNum(a.annualPax)) errs.push(`${p}.annualPax: must be a number or null`);
    if ("series" in a || "monthly" in a) errs.push(`${p}: index must not carry series data (split layout)`);
  }
}

/** data/airports.json (OpenFlights reference, trimmed). */
export function checkAirportsRef(doc, errs) {
  const path = "airports-ref";
  if (!isObj(doc) || !isObj(doc.airports)) { errs.push(`${path}: missing "airports" object`); return; }
  for (const [iata, r] of Object.entries(doc.airports)) {
    const p = `${path}.${iata}`;
    if (!isObj(r)) { errs.push(`${p}: not an object`); continue; }
    if (r.lat != null && !isFiniteNum(r.lat)) errs.push(`${p}.lat: not a number`);
    if (r.lon != null && !isFiniteNum(r.lon)) errs.push(`${p}.lon: not a number`);
  }
}

/** data/macro.json (World Bank). */
export function checkMacro(doc, errs) {
  const path = "macro";
  if (!isObj(doc) || !isObj(doc.countries)) { errs.push(`${path}: missing "countries" object`); return; }
  for (const [cc, c] of Object.entries(doc.countries)) {
    const p = `${path}.${cc}`;
    if (!/^[A-Z]{3}$/.test(cc)) errs.push(`${p}: country key must be ISO3`);
    if (!isObj(c)) { errs.push(`${p}: not an object`); continue; }
    for (const f of ["gdp", "gdpcap", "pop"]) if (c[f] != null && !isFiniteNum(c[f])) errs.push(`${p}.${f}: must be a number or null`);
    if (c.gdpcapSeries != null) {
      if (!isObj(c.gdpcapSeries)) errs.push(`${p}.gdpcapSeries: expected an object`);
      else for (const [y, v] of Object.entries(c.gdpcapSeries)) {
        if (!/^\d{4}$/.test(y)) errs.push(`${p}.gdpcapSeries.${y}: bad year key`);
        if (!isFiniteNum(v)) errs.push(`${p}.gdpcapSeries.${y}: not a number`);
      }
    }
  }
}

/** data/imf-weo.json (IMF WEO forward rates). */
export function checkImf(doc, errs) {
  const path = "imf-weo";
  if (!isObj(doc) || !isObj(doc.countries)) { errs.push(`${path}: missing "countries" object`); return; }
  for (const [cc, c] of Object.entries(doc.countries)) {
    const p = `${path}.${cc}`;
    if (!isObj(c) || !isObj(c.nextYear)) { errs.push(`${p}: missing nextYear`); continue; }
    if (!isFiniteNum(c.nextYear.pct)) errs.push(`${p}.nextYear.pct: not a number`);
    if (!Array.isArray(c.years) || !c.years.length) errs.push(`${p}.years: must be a non-empty array`);
    else for (const r of c.years) if (!isFiniteNum(r?.year) || !isFiniteNum(r?.pct)) errs.push(`${p}.years: each entry needs numeric year+pct`);
  }
}

/** data/forecasts/<IATA>.json: metric -> forecast payload. */
export function checkForecastDoc(doc, path, errs) {
  if (!isObj(doc) || !Object.keys(doc).length) { errs.push(`${path}: empty forecast doc`); return; }
  for (const [metric, m] of Object.entries(doc)) {
    const p = `${path}.${metric}`;
    if (!METRICS.includes(metric)) { errs.push(`${p}: unknown metric`); continue; }
    if (!isObj(m)) { errs.push(`${p}: not an object`); continue; }
    if (!Array.isArray(m.forecast) || !m.forecast.length) { errs.push(`${p}.forecast: must be a non-empty array`); continue; }
    for (const r of m.forecast) {
      if (!isObj(r) || !isMonthKey(r.date ?? "") || !isFiniteNum(r.v) || !isFiniteNum(r.lo) || !isFiniteNum(r.hi)) {
        errs.push(`${p}.forecast: rows need date "YYYY-MM" + numeric v/lo/hi`); break;
      }
      if (r.lo > r.hi) { errs.push(`${p}.forecast ${r.date}: lo > hi`); break; }
      if (r.v < 0 || r.lo < 0) { errs.push(`${p}.forecast ${r.date}: negative volumes`); break; }
    }
    if (m.mape != null && !isFiniteNum(m.mape)) errs.push(`${p}.mape: must be a number or null`);
    if (m.seasonal12 != null && (!Array.isArray(m.seasonal12) || m.seasonal12.length !== 12)) errs.push(`${p}.seasonal12: must be 12 values`);
    if (m.backtest != null) {
      if (!Array.isArray(m.backtest)) errs.push(`${p}.backtest: must be an array`);
      else for (const r of m.backtest) if (!isObj(r) || !isMonthKey(r.date ?? "") || !isFiniteNum(r.v) || !isFiniteNum(r.actual)) { errs.push(`${p}.backtest: rows need date + numeric v/actual`); break; }
    }
  }
}

/* ---- runner --------------------------------------------------- */
async function loadJSON(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function validateDataDir(dataDir = DATA) {
  const errs = [];
  const need = async (name, fn) => {
    try { fn(await loadJSON(resolve(dataDir, name)), errs); }
    catch (e) { errs.push(`${name}: ${e.message}`); }
  };
  await need("activity-index.json", checkActivityIndex);
  await need("airports.json", checkAirportsRef);
  await need("macro.json", checkMacro);
  await need("imf-weo.json", checkImf);

  // per-airport series must exist for every index entry, and vice versa
  let indexIatas = new Set();
  try { indexIatas = new Set(Object.keys((await loadJSON(resolve(dataDir, "activity-index.json"))).airports || {})); } catch {}
  let seriesFiles = [];
  try { seriesFiles = (await readdir(resolve(dataDir, "series"))).filter((f) => f.endsWith(".json")); } catch { errs.push("series/: directory missing"); }
  for (const f of seriesFiles) {
    const iata = f.slice(0, -5);
    if (!indexIatas.has(iata)) errs.push(`series/${f}: orphaned — not in activity-index`);
    try { checkSeriesDoc(await loadJSON(resolve(dataDir, "series", f)), `series/${iata}`, errs); }
    catch (e) { errs.push(`series/${f}: ${e.message}`); }
  }
  const seriesIatas = new Set(seriesFiles.map((f) => f.slice(0, -5)));
  for (const iata of indexIatas) if (!seriesIatas.has(iata)) errs.push(`activity-index.${iata}: no series/${iata}.json on disk`);

  // forecasts are best-effort per airport (Prophet needs history), but any
  // file that exists must be well-formed and belong to a catalogue airport
  let fcFiles = [];
  try { fcFiles = (await readdir(resolve(dataDir, "forecasts"))).filter((f) => f.endsWith(".json")); } catch { errs.push("forecasts/: directory missing"); }
  for (const f of fcFiles) {
    const iata = f.slice(0, -5);
    if (!indexIatas.has(iata)) errs.push(`forecasts/${f}: orphaned — not in activity-index`);
    try { checkForecastDoc(await loadJSON(resolve(dataDir, "forecasts", f)), `forecasts/${iata}`, errs); }
    catch (e) { errs.push(`forecasts/${f}: ${e.message}`); }
  }
  return errs;
}

async function main() {
  const errs = await validateDataDir();
  if (errs.length) {
    console.error(`validate-data: ${errs.length} violation(s):`);
    for (const e of errs) console.error("  - " + e);
    process.exit(1);
  }
  console.log("validate-data: all snapshots structurally valid.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("validate-data failed:", e.message); process.exit(1); });
}

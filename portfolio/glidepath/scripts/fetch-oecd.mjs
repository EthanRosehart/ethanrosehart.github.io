#!/usr/bin/env node
/* ============================================================
 * fetch-oecd.mjs — OECD Economic Outlook GDP-growth projections
 *
 * Pulls forward-looking real GDP growth projections from the OECD
 * SDMX API (Economic Outlook) and writes data/oecd.json. These are
 * projections, not history — so they set the GDP-growth lever's
 * default in the long-term elasticity model (preferred over the
 * World Bank historical mean in data/macro.json).
 *
 * OECD's SDMX-JSON dataflow ids change between releases. The query
 * below targets the Economic Outlook real-GDP-growth series; if a
 * release renames the dataflow, update DATAFLOW / KEY and re-run.
 * The script logs what it parsed so a bad key surfaces immediately.
 *
 * Run locally:  node scripts/fetch-oecd.mjs
 * ============================================================ */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data", "oecd.json");

const NAMES = {
  CAN:"Canada", USA:"United States", GBR:"United Kingdom", NLD:"Netherlands",
  DEU:"Germany", DNK:"Denmark", AUT:"Austria", ITA:"Italy", POL:"Poland",
};
const codes = Object.keys(NAMES);

/* OECD SDMX-JSON. Economic Outlook, real GDP growth (annual %, GDPV_ANNPCT),
   and real GDP per capita growth. Verify the dataflow on release changes:
   https://data-explorer.oecd.org → Economic Outlook → share → SDMX query. */
const BASE = "https://sdmx.oecd.org/public/rest/data";
// agency,dataflow with NO trailing version -> SDMX serves the latest release.
// (A trailing comma / empty version makes OECD return HTTP 500.)
const DATAFLOW = "OECD.ECO.MAD,DSD_EO@DF_EO";    // Economic Outlook dataflow
const startPeriod = new Date().getFullYear();     // current year's projection onward

async function fetchMeasure(measure) {
  // key: <REF_AREA>.<MEASURE>.<FREQ>. Leave REF_AREA empty (all countries) and
  // filter client-side — the proven Data Explorer query is ".GDPV_ANNPCT.A";
  // a plus-joined REF_AREA list makes OECD's SDMX return HTTP 500.
  const key = `.${measure}.A`;
  const url = `${BASE}/${DATAFLOW}/${key}?startPeriod=${startPeriod}&dimensionAtObservation=AllDimensions&format=jsondata`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.sdmx.data+json", "User-Agent": "glidepath-data-bot" } });
  if (!res.ok) {
    let body = ""; try { body = (await res.text()).slice(0, 180); } catch {}
    throw new Error(`oecd ${measure}: HTTP ${res.status} ${url} ${body}`);
  }
  const js = await res.json();
  const ds = js?.data?.dataSets?.[0];
  const dims = js?.data?.structure?.dimensions?.observation;
  if (!ds || !dims) throw new Error(`oecd ${measure}: unexpected payload`);
  const areaDim = dims.find((d) => d.id === "REF_AREA");
  const timeDim = dims.find((d) => d.id === "TIME_PERIOD");
  const areaIdx = dims.indexOf(areaDim), timeIdx = dims.indexOf(timeDim);
  // pick the earliest projected year per country
  const byArea = {};
  for (const [k, v] of Object.entries(ds.observations || {})) {
    const parts = k.split(":").map(Number);
    const cc = areaDim.values[parts[areaIdx]].id;
    const yr = +timeDim.values[parts[timeIdx]].id;
    const val = Array.isArray(v) ? v[0] : v;
    if (val == null) continue;
    if (!byArea[cc] || yr < byArea[cc].yr) byArea[cc] = { yr, val: Math.round(val * 10) / 10 };
  }
  return byArea;
}

async function loadPrev() { try { return JSON.parse(await readFile(OUT, "utf8")); } catch { return null; } }

async function main() {
  const prev = await loadPrev();
  let gdp = {}, gdpcap = {};
  try { gdp = await fetchMeasure("GDPV_ANNPCT"); } catch (e) { console.warn(" ", e.message); }
  try { gdpcap = await fetchMeasure("GDPVD_CAP_ANNPCT"); } catch (e) { console.warn(" ", e.message); }

  const countries = {};
  for (const cc of codes) {
    const g = gdp[cc], gc = gdpcap[cc];
    if (g || gc) {
      countries[cc] = {
        name: NAMES[cc],
        gdpProj: g ? g.val : null,
        gdpcapProj: gc ? gc.val : (g ? g.val : null),
        horizon: g ? `${g.yr}` : (gc ? `${gc.yr}` : null),
        measure: "GDPV_ANNPCT",
      };
      console.log(`  ${cc}  gdpProj=${countries[cc].gdpProj}  gdpcapProj=${countries[cc].gdpcapProj}  (${countries[cc].horizon})`);
    } else if (prev?.countries?.[cc]) {
      countries[cc] = prev.countries[cc];
      console.warn(`  ${cc}  no live value — kept previous`);
    }
  }
  if (!Object.keys(countries).length) throw new Error("no OECD values parsed — check DATAFLOW/KEY");

  const out = {
    generatedAt: new Date().toISOString(),
    seed: false,
    source: "OECD Economic Outlook — real GDP growth projections (SDMX, OECD.ECO)",
    note: "Forward-looking real GDP growth projections. Sets the GDP-growth lever default in the long-term model.",
    countries,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUT} — ${Object.keys(countries).length} countries.`);
}

main().catch((err) => { console.error("OECD snapshot failed:", err.message); process.exit(1); });

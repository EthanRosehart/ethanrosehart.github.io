#!/usr/bin/env node
/* ============================================================
 * fetch-activity.mjs — Glidepath monthly activity snapshot (EU + Canada)
 *
 * Runs server-side in GitHub Actions (no browser CORS). Pulls real monthly
 * series by airport and writes the per-metric shape into data/activity.json:
 *
 *   airports[IATA] = {
 *     observed, source, rep_airp, months, latest,
 *     series: { pax:{ "YYYY-MM":n }, atm:{...}, cargo:{...} },
 *     monthly: <alias of series.pax, for backward compat>
 *   }
 *
 *   • Europe  → Eurostat  avia_paoc (passengers), avia_gooc (freight, t),
 *               avia_paoc/CAF (commercial flights)             — no key
 *   • Canada  → Statistics Canada WDS: 23-10-0253 (passengers),
 *               23-10-0254 (cargo), 23-10-0008 (aircraft movements).
 *               Airport coordinates are resolved by name from the cube
 *               metadata, so new airports (e.g. YYZ) need no hand-mapping.
 *   • US      → handled separately by fetch-bts.mjs (BTS T-100), merged in.
 *
 * Every fetch is best-effort and per-metric: a failure keeps the last good
 * series for that metric and never injects synthetic data.
 *
 * Run locally:  node scripts/fetch-activity.mjs
 * ============================================================ */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data", "activity.json");

/* airport set — iata, ISO3, ICAO. Keep in sync with data.jsx. US handled by
   fetch-bts.mjs, so it's omitted here. */
const AIRPORTS = [
  ["YYZ","CAN","CYYZ"],["YTZ","CAN","CYTZ"],["YOW","CAN","CYOW"],["YHM","CAN","CYHM"],
  ["YQB","CAN","CYQB"],["YHZ","CAN","CYHZ"],["YKF","CAN","CYKF"],
  ["EXT","GBR","EGTE"],["NQY","GBR","EGHQ"],["INV","GBR","EGPE"],["RTM","NLD","EHRD"],
  ["FMM","DEU","EDJA"],["AAR","DNK","EKAH"],["GRZ","AUT","LOWG"],["KLU","AUT","LOWK"],
  ["SZG","AUT","LOWS"],["NAP","ITA","LIRN"],["WRO","POL","EPWR"],
];
const EU_GEO = { GBR:"UK", NLD:"NL", DEU:"DE", DNK:"DK", AUT:"AT", ITA:"IT", POL:"PL" };

const UA = { "User-Agent": "glidepath-data-bot" };

function normMonth(s) {
  // accept "2015M01", "2015-01", "2015-01-01" -> "2015-01"
  return String(s).replace("M", "-").slice(0, 7);
}

/* ============================================================
   EUROSTAT — JSON-stat dissemination API
   ============================================================ */
async function eurostat(dataset, params) {
  const base = `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${dataset}`;
  const qs = new URLSearchParams({ format: "JSON", lang: "EN", freq: "M", sinceTimePeriod: "2015-01", ...params });
  const res = await fetch(`${base}?${qs}`, { headers: UA });
  if (!res.ok) throw new Error(`${dataset} HTTP ${res.status}`);
  const js = await res.json();
  const timeDim = js.dimension?.time;
  if (!timeDim) throw new Error(`${dataset}: no time dimension`);
  const idx = timeDim.category.index;                 // { "2015-01": 0, ... }
  const order = Object.entries(idx).sort((a, b) => a[1] - b[1]).map((e) => e[0]);
  const monthly = {};
  for (let i = 0; i < order.length; i++) {
    const v = js.value[i];
    if (v != null) monthly[normMonth(order[i])] = Math.round(v);
  }
  return monthly;
}

/* Per-metric Eurostat pulls. Codes verified against the Eurostat data browser;
   anything that 404s/empties is skipped (the metric just won't appear). */
const euMetric = {
  pax:   (rep) => eurostat("avia_paoc", { unit: "PAS", tra_meas: "PAS_CRD", rep_airp: rep }),
  cargo: (rep) => eurostat("avia_gooc", { unit: "T",   tra_meas: "FRM_LD_NLD", rep_airp: rep }),
  // commercial air flights (passenger) as a movements proxy
  atm:   (rep) => eurostat("avia_paoc", { unit: "FLIGHT", tra_meas: "CAF_PAS", rep_airp: rep }),
};

/* ============================================================
   STATISTICS CANADA — WDS REST
   Resolve each airport's geography member id by name from the cube
   metadata, then pull the full vector. Coordinates are
   "<geoMemberId>.0.0.0.0.0.0.0.0.0" (matches the working pax pattern).
   ============================================================ */
const STATCAN_PID = { pax: 23100253, cargo: 23100254, atm: 23100008 };
const STATCAN_NAME = {
  YYZ: /pearson/i, YTZ: /billy bishop|city centre|toronto.*island/i, YOW: /ottawa/i,
  YHM: /hamilton/i, YQB: /qu[ée]bec/i, YHZ: /halifax/i, YKF: /waterloo|kitchener/i,
};
const _metaCache = {};
async function statcanMeta(pid) {
  if (_metaCache[pid]) return _metaCache[pid];
  const res = await fetch("https://www150.statcan.gc.ca/t1/wds/rest/getCubeMetadata", {
    method: "POST", headers: { "Content-Type": "application/json", ...UA },
    body: JSON.stringify([{ productId: pid }]),
  });
  if (!res.ok) throw new Error(`statcan meta ${pid}: HTTP ${res.status}`);
  const js = await res.json();
  const dims = js?.[0]?.object?.dimension;
  if (!dims || !dims.length) throw new Error(`statcan meta ${pid}: no dimensions`);
  // geography is dimension 1; member objects have memberId + memberNameEn
  const members = dims[0].member || [];
  return (_metaCache[pid] = members.map((m) => ({ id: m.memberId, name: m.memberNameEn || "" })));
}
async function statcanCoord(pid, iata) {
  const re = STATCAN_NAME[iata];
  if (!re) return null;
  const members = await statcanMeta(pid);
  const hit = members.find((m) => re.test(m.name));
  if (!hit) return null;
  return `${hit.id}.0.0.0.0.0.0.0.0.0`;
}
async function statcanSeries(pid, coord) {
  const res = await fetch("https://www150.statcan.gc.ca/t1/wds/rest/getDataFromCubePidCoordAndLatestNPeriods", {
    method: "POST", headers: { "Content-Type": "application/json", ...UA },
    body: JSON.stringify([{ productId: pid, coordinate: coord, latestN: 144 }]),
  });
  if (!res.ok) throw new Error(`statcan ${pid}: HTTP ${res.status}`);
  const js = await res.json();
  const pts = js?.[0]?.object?.vectorDataPoint;
  if (!pts) throw new Error(`statcan ${pid}: no data points`);
  const monthly = {};
  for (const p of pts) if (p.value != null) monthly[normMonth(p.refPer)] = Math.round(p.value);
  return monthly;
}
const caMetric = {
  pax:   (iata) => statcanCoord(STATCAN_PID.pax,   iata).then((c) => c && statcanSeries(STATCAN_PID.pax,   c)),
  cargo: (iata) => statcanCoord(STATCAN_PID.cargo, iata).then((c) => c && statcanSeries(STATCAN_PID.cargo, c)),
  atm:   (iata) => statcanCoord(STATCAN_PID.atm,   iata).then((c) => c && statcanSeries(STATCAN_PID.atm,   c)),
};

/* ============================================================ */
async function loadPrevious() {
  try { return JSON.parse(await readFile(OUT, "utf8")); } catch { return null; }
}
function prevSeries(prev, iata, metric) {
  const a = prev?.airports?.[iata];
  if (!a) return null;
  if (a.series && a.series[metric] && Object.keys(a.series[metric]).length) return a.series[metric];
  if (metric === "pax" && a.monthly && Object.keys(a.monthly).length) return a.monthly;
  return null;
}

async function fetchMetric(fn, arg) {
  try { const s = await fn(arg); return s && Object.keys(s).length >= 12 ? s : null; }
  catch (e) { return { __err: e.message }; }
}

async function main() {
  const prev = await loadPrevious();
  const airports = {};
  let liveMetrics = 0;

  for (const [iata, cc, icao] of AIRPORTS) {
    const isEU = !!EU_GEO[cc];
    const rep = isEU ? `${EU_GEO[cc]}_${icao}` : icao;
    const source = isEU ? "eurostat" : "statcan";
    const pick = isEU ? euMetric : caMetric;
    const arg = isEU ? rep : iata;

    const series = {};
    for (const metric of ["pax", "atm", "cargo"]) {
      if (!pick[metric]) continue;
      const got = await fetchMetric(pick[metric], arg);
      if (got && !got.__err) {
        series[metric] = got; liveMetrics++;
        console.log(`  ${iata}/${metric}  ${source}  ${Object.keys(got).length} months`);
      } else {
        const kept = prevSeries(prev, iata, metric);
        if (kept) { series[metric] = kept; console.warn(`  ${iata}/${metric}  failed${got?.__err?` (${got.__err})`:""} — kept previous`); }
        else console.warn(`  ${iata}/${metric}  failed${got?.__err?` (${got.__err})`:""} — absent`);
      }
    }

    if (series.pax) {
      const paxKeys = Object.keys(series.pax);
      airports[iata] = { observed: true, source, rep_airp: rep,
        months: paxKeys.length, latest: paxKeys.sort().pop(),
        series, monthly: series.pax };
    } else {
      // no passengers => not shown; preserve any prior snapshot
      const before = prev?.airports?.[iata];
      if (before) airports[iata] = before;
      console.warn(`  ${iata}  no passenger series — ${before ? "kept previous" : "absent"}`);
    }
  }

  // carry over airports owned by other fetchers (e.g. US via fetch-bts)
  if (prev?.airports) for (const k of Object.keys(prev.airports)) if (!airports[k]) airports[k] = prev.airports[k];

  const out = {
    generatedAt: new Date().toISOString(),
    note: "Monthly activity (passengers / movements / cargo) by airport. Refreshed nightly by .github/workflows/refresh-data.yml; read same-origin by the browser. No synthetic data.",
    sources: {
      eurostat: "Eurostat avia_paoc (PAS_CRD passengers; CAF_PAS flights) + avia_gooc (FRM_LD_NLD freight, tonnes)",
      statcan: "Statistics Canada WDS: 23-10-0253 passengers, 23-10-0254 cargo, 23-10-0008 aircraft movements",
      bts: "US DOT BTS T-100 (see fetch-bts.mjs)",
    },
    airports,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out) + "\n", "utf8");
  console.log(`Wrote ${OUT} — ${Object.keys(airports).length} airports, ${liveMetrics} live metric-series.`);
}

main().catch((err) => { console.error("Activity snapshot failed:", err.message); process.exit(1); });

#!/usr/bin/env node
/* ============================================================
 * fetch-activity.mjs — Glidepath monthly activity snapshot (EU + Canada)
 *
 * Writes the per-metric shape into data/activity.json:
 *   airports[IATA] = { observed, source, rep_airp, months, latest,
 *                      series:{ pax:{"YYYY-MM":n}, atm:{...}, cargo:{...} },
 *                      monthly:<alias of series.pax> }
 *
 *   • Europe → Eurostat avia_paoc (passengers), avia_gooc (freight, t)
 *   • Canada → StatCan WDS 23-10-0253 (passengers, hand-mapped coords),
 *              23-10-0254 (cargo) + 23-10-0008 (movements) resolved by name.
 *   • US     → fetch-bts.mjs (separate), merged in.
 *
 * Best-effort + per-metric: a failure keeps the last good series and never
 * injects synthetic data. Every failure logs a reason for CI debugging.
 *
 * Run locally:  node scripts/fetch-activity.mjs
 * ============================================================ */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data", "activity.json");

const AIRPORTS = [
  // Canada — only airports with a real MONTHLY passenger source (StatCan
  // 23-10-0312 screened passengers, 8 largest). The annual-only airports
  // (YTZ/YHM/YQB/YKF) have no monthly pax feed and are intentionally omitted.
  ["YYZ","CAN","CYYZ"],["YOW","CAN","CYOW"],["YHZ","CAN","CYHZ"],
  ["EXT","GBR","EGTE"],["NQY","GBR","EGHQ"],["INV","GBR","EGPE"],["RTM","NLD","EHRD"],
  ["FMM","DEU","EDJA"],["AAR","DNK","EKAH"],["GRZ","AUT","LOWG"],["KLU","AUT","LOWK"],
  ["SZG","AUT","LOWS"],["NAP","ITA","LIRN"],["WRO","POL","EPWR"],
];
const EU_GEO = { GBR:"UK", NLD:"NL", DEU:"DE", DNK:"DK", AUT:"AT", ITA:"IT", POL:"PL" };
const UA = { "User-Agent": "glidepath-data-bot" };

function normMonth(s) { return String(s).replace("M", "-").slice(0, 7); }

/* ============================================================
   EUROSTAT — JSON-stat. Built as a plain template (proven for
   avia_paoc) so the query is byte-identical to the working pax
   call; only dataset/unit/tra_meas vary per metric.
   ============================================================ */
async function eurostat(dataset, unit, traMeas, rep) {
  const base = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";
  const url = `${base}/${dataset}?format=JSON&lang=EN&freq=M&unit=${unit}&tra_meas=${traMeas}&rep_airp=${rep}&sinceTimePeriod=2015-01`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) {
    let body = ""; try { body = (await res.text()).slice(0, 180); } catch {}
    throw new Error(`${dataset} HTTP ${res.status} ${body}`);
  }
  const js = await res.json();
  const timeDim = js.dimension?.time;
  if (!timeDim) throw new Error(`${dataset}: no time dimension`);
  const idx = timeDim.category.index;
  const order = Object.entries(idx).sort((a, b) => a[1] - b[1]).map((e) => e[0]);
  const monthly = {};
  for (let i = 0; i < order.length; i++) {
    const v = js.value[String(i)] ?? js.value[i];
    if (v != null) monthly[normMonth(order[i])] = Math.round(v);
  }
  return monthly;
}
const euMetric = {
  pax:   (rep) => eurostat("avia_paoa", "PAS", "PAS_CRD", rep),
  cargo: (rep) => eurostat("avia_gooa", "T", "FRM_LD_NLD", rep),
  atm:   (rep) => eurostat("avia_paoa", "FLIGHT", "CAF_PAS", rep),
};

/* ============================================================
   STATISTICS CANADA — WDS REST
   Resolve the airport member by name across whichever dimension
   holds airports, choose the right characteristic member per
   metric, and build a full memberId coordinate. Cubes:
     23-10-0253 passengers · 23-10-0254 cargo · 23-10-0008 movements
   ============================================================ */
// 23-10-0312 = screened passengers (monthly, 8 largest airports); 23-10-0008
// = aircraft movements (monthly). No monthly per-airport cargo exists publicly.
const STATCAN_PID = { pax: 23100312, atm: 23100008 };
const STATCAN_NAME = {
  YYZ: /pearson|toronto/i, YOW: /ottawa/i, YHZ: /halifax/i,
};
// preferred characteristic member per metric (total throughput where offered)
const STATCAN_CHAR = {
  pax: /screened|passenger|total/i,
  atm: /total itinerant|itinerant.*total|total movements|total/i,
};
const _meta = {};
async function statcanMeta(pid) {
  if (_meta[pid]) return _meta[pid];
  const res = await fetch("https://www150.statcan.gc.ca/t1/wds/rest/getCubeMetadata", {
    method: "POST", headers: { "Content-Type": "application/json", ...UA },
    body: JSON.stringify([{ productId: pid }]),
  });
  if (!res.ok) throw new Error(`meta ${pid} HTTP ${res.status}`);
  const js = await res.json();
  const obj = js?.[0]?.object;
  if (!obj) throw new Error(`meta ${pid}: ${js?.[0]?.status || "no object"}`);
  const dims = (obj.dimension || []).map((d) => ({
    name: d.dimensionNameEn || "",
    members: (d.member || []).map((m) => ({ id: m.memberId, name: m.memberNameEn || "" })),
  }));
  dims.forEach((d, i) => console.log(`    [meta ${pid}] dim${i} "${d.name}" ${d.members.length}m e.g. ${d.members.slice(0, 4).map((m) => `${m.id}:${m.name}`).join(" | ")}`));
  return (_meta[pid] = dims);
}
async function statcanCoord(pid, iata, metric) {
  const dims = await statcanMeta(pid);
  const re = STATCAN_NAME[iata];
  // find which dimension holds the airport, and its member
  let geoDim = -1, geoMember = null;
  dims.forEach((d, i) => { const hit = d.members.find((m) => re.test(m.name)); if (hit) { geoDim = i; geoMember = hit; } });
  if (!geoMember) throw new Error(`no airport member for ${iata} in ${pid}`);
  const charRe = STATCAN_CHAR[metric];
  const parts = dims.map((d, i) => {
    if (i === geoDim) return geoMember.id;
    const pref = d.members.find((m) => charRe.test(m.name));
    return (pref || d.members[0]).id;          // prefer total throughput, else first
  });
  while (parts.length < 10) parts.push(0);
  const coord = parts.join(".");
  console.log(`    [coord ${pid}/${iata}/${metric}] ${coord} (airport "${geoMember.name}")`);
  return coord;
}
async function statcanSeries(pid, coord) {
  const res = await fetch("https://www150.statcan.gc.ca/t1/wds/rest/getDataFromCubePidCoordAndLatestNPeriods", {
    method: "POST", headers: { "Content-Type": "application/json", ...UA },
    body: JSON.stringify([{ productId: pid, coordinate: coord, latestN: 144 }]),
  });
  if (!res.ok) throw new Error(`data ${pid} HTTP ${res.status}`);
  const js = await res.json();
  const obj = js?.[0]?.object;
  const pts = obj?.vectorDataPoint;
  if (!pts) throw new Error(`data ${pid}: ${js?.[0]?.status || "no points"}`);
  const monthly = {};
  for (const p of pts) if (p.value != null) monthly[normMonth(p.refPer)] = Math.round(p.value);
  return monthly;
}
const caMetric = {
  pax: async (iata) => statcanSeries(STATCAN_PID.pax, await statcanCoord(STATCAN_PID.pax, iata, "pax")),
  atm: async (iata) => statcanSeries(STATCAN_PID.atm, await statcanCoord(STATCAN_PID.atm, iata, "atm")),
};

/* ============================================================ */
async function loadPrevious() { try { return JSON.parse(await readFile(OUT, "utf8")); } catch { return null; } }
function prevSeries(prev, iata, metric) {
  const a = prev?.airports?.[iata]; if (!a) return null;
  if (a.series?.[metric] && Object.keys(a.series[metric]).length) return a.series[metric];
  if (metric === "pax" && a.monthly && Object.keys(a.monthly).length) return a.monthly;
  return null;
}
async function tryMetric(fn, arg) {
  try { const s = await fn(arg); return Object.keys(s || {}).length >= 12 ? { series: s } : { err: `only ${Object.keys(s||{}).length} months` }; }
  catch (e) { return { err: e.message }; }
}

async function main() {
  const prev = await loadPrevious();
  const airports = {};
  let live = 0;

  for (const [iata, cc, icao] of AIRPORTS) {
    const isEU = !!EU_GEO[cc];
    const rep = isEU ? `${EU_GEO[cc]}_${icao}` : icao;
    const source = isEU ? "eurostat" : "statcan";
    const pick = isEU ? euMetric : caMetric;
    const arg = isEU ? rep : iata;

    const series = {};
    for (const metric of ["pax", "atm", "cargo"]) {
      if (!pick[metric]) continue;
      const r = await tryMetric(pick[metric], arg);
      if (r.series) { series[metric] = r.series; live++; console.log(`  ${iata}/${metric}  ${source}  ${Object.keys(r.series).length} months`); }
      else {
        const kept = prevSeries(prev, iata, metric);
        if (kept) { series[metric] = kept; console.warn(`  ${iata}/${metric}  failed (${r.err}) — kept previous`); }
        else console.warn(`  ${iata}/${metric}  failed (${r.err}) — absent`);
      }
    }

    if (series.pax) {
      const paxKeys = Object.keys(series.pax);
      airports[iata] = { observed: true, source, rep_airp: rep, months: paxKeys.length, latest: paxKeys.sort().pop(), series, monthly: series.pax };
    } else {
      const before = prev?.airports?.[iata];
      if (before) airports[iata] = before;
      console.warn(`  ${iata}  no passenger series — ${before ? "kept previous" : "absent"}`);
    }
  }

  // carry over only airports owned by the US/BTS fetcher; never resurrect a
  // dropped or seed airport.
  if (prev?.airports) for (const k of Object.keys(prev.airports)) {
    if (!airports[k] && prev.airports[k]?.source === "bts") airports[k] = prev.airports[k];
  }

  const out = {
    generatedAt: new Date().toISOString(),
    note: "Monthly activity (passengers / movements / cargo) by airport. Refreshed nightly; read same-origin by the browser. No synthetic data.",
    sources: {
      eurostat: "Eurostat avia_paoc (PAS_CRD) + avia_gooc (FRM_LD_NLD, tonnes)",
      statcan: "Statistics Canada WDS 23-10-0253 (pax), 23-10-0254 (cargo), 23-10-0008 (movements)",
      bts: "US DOT BTS T-100 (fetch-bts.mjs)",
    },
    airports,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out) + "\n", "utf8");
  console.log(`Wrote ${OUT} — ${Object.keys(airports).length} airports, ${live} live metric-series.`);
}

main().catch((err) => { console.error("Activity snapshot failed:", err.message); process.exit(1); });

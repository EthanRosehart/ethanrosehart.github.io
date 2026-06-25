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
  ["YYZ","CAN","CYYZ"],["YTZ","CAN","CYTZ"],["YOW","CAN","CYOW"],["YHM","CAN","CYHM"],
  ["YQB","CAN","CYQB"],["YHZ","CAN","CYHZ"],["YKF","CAN","CYKF"],
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
  pax:   (rep) => eurostat("avia_paoc", "PAS", "PAS_CRD", rep),
  cargo: (rep) => eurostat("avia_gooc", "T", "FRM_LD_NLD", rep),
};

/* ============================================================
   STATISTICS CANADA — WDS REST
   ============================================================ */
const STATCAN_PID = { pax: 23100253, cargo: 23100254, atm: 23100008 };
// proven passenger geography member ids (coordinate dim 1) — no regression.
const STATCAN_PAX_GEO = { YTZ: 11, YOW: 10, YHZ: 8, YQB: 9, YHM: 6, YKF: 5 };
// name patterns to resolve members dynamically (YYZ pax + all cargo/movements)
const STATCAN_NAME = {
  YYZ: /pearson/i, YTZ: /billy bishop|city centre|toronto.*(island|city)/i, YOW: /ottawa/i,
  YHM: /hamilton/i, YQB: /qu[ée]bec/i, YHZ: /halifax/i, YKF: /waterloo|kitchener|region of waterloo/i,
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
  const geo = (obj.dimension || []).find((d) => /geogra|airport/i.test(d.dimensionNameEn || "")) || obj.dimension?.[0];
  const members = (geo?.member || []).map((m) => ({ id: m.memberId, name: m.memberNameEn || "" }));
  console.log(`    [meta ${pid}] ${members.length} members; e.g. ${members.slice(0,3).map(m=>`${m.id}:${m.name}`).join(" | ")}`);
  return (_meta[pid] = members);
}
async function statcanCoordByName(pid, iata) {
  const re = STATCAN_NAME[iata];
  if (!re) throw new Error(`no name pattern for ${iata}`);
  const members = await statcanMeta(pid);
  const hit = members.find((m) => re.test(m.name));
  if (!hit) throw new Error(`no member name match in ${pid} (${members.length} members)`);
  return `${hit.id}.0.0.0.0.0.0.0.0.0`;
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
  pax: async (iata) => {
    const coord = STATCAN_PAX_GEO[iata] != null
      ? `${STATCAN_PAX_GEO[iata]}.0.0.0.0.0.0.0.0.0`
      : await statcanCoordByName(STATCAN_PID.pax, iata);
    return statcanSeries(STATCAN_PID.pax, coord);
  },
  cargo: async (iata) => statcanSeries(STATCAN_PID.cargo, await statcanCoordByName(STATCAN_PID.cargo, iata)),
  atm:   async (iata) => statcanSeries(STATCAN_PID.atm,   await statcanCoordByName(STATCAN_PID.atm,   iata)),
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

  if (prev?.airports) for (const k of Object.keys(prev.airports)) if (!airports[k]) airports[k] = prev.airports[k];

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

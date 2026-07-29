#!/usr/bin/env node
/* ============================================================
 * probe-eurostat.mjs — diagnostic, not part of the nightly.
 *
 * ROUND 2 found it. avia_paoa's `schedule` dimension carries BOTH "TOTAL"
 * and "TOT"; "TOTAL" sorts first and is nearly empty, and esDecode()
 * implicitly reads category 0 of every dimension we don't pin. So we have
 * been decoding the empty slice:
 *
 *   EDDF production (nothing pinned) ........   5 months
 *   EDDF + schedule=TOTAL ..................    5 months
 *   EDDF + schedule=TOT ....................  133 months
 *   LFPG production ........................    0 airports decoded
 *   LFPG + tra_cov=TOTAL & schedule=TOT ....  132 months
 *   enumerate production ................... 252 airports, LFPG absent
 *   enumerate + tra_cov=TOTAL,schedule=TOT . 413 airports, LFPG present
 *
 * One loose end: EHAM decodes 0 months under BOTH schedule codes, while
 * LEMD goes 3 -> 135. So at least one country files under something else
 * again, and hardcoding a single code would just move the blind spot.
 *
 * ROUND 3 maps it exhaustively: every schedule code x every relevant
 * tra_cov, per airport, decoded with the real esDecode. The fix should
 * pick the category that HAS data rather than trusting any one code.
 *
 * Run:  node scripts/probe-eurostat.mjs
 * ============================================================ */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { esDecode } from "./fetch-activity.mjs";

const BASE = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";
const UA = { "User-Agent": "glidepath-data-bot" };
const SCHEDULES = ["TOTAL", "TOT", "SCHED", "NSCHED", "N_SCHED", "UNK"];
const COVERS = ["TOTAL", "NAT", "INTL"];

function url(dataset, q, reps = []) {
  const usp = new URLSearchParams({ format: "JSON", lang: "EN", freq: "M", ...q });
  let u = `${BASE}/${dataset}?${usp.toString()}`;
  for (const r of reps) u += `&rep_airp=${encodeURIComponent(r)}`;
  return u;
}
async function months(dataset, q, rep, icao) {
  const res = await fetch(url(dataset, q, [rep]), { headers: UA });
  if (!res.ok) return `HTTP${res.status}`;
  let js; try { js = await res.json(); } catch { return "badJSON"; }
  let out; try { out = esDecode(js, dataset); } catch (e) { return "throw"; }
  return out[icao] ? String(Object.keys(out[icao].monthly).length) : "0";
}

const AIRPORTS = [
  ["DE_EDDF", "EDDF", "Frankfurt   (we hold 133mo)"],
  ["NL_EHAM", "EHAM", "Amsterdam   (we hold 135mo)"],
  ["ES_LEMD", "LEMD", "Madrid      (we hold 135mo)"],
  ["FR_LFPG", "LFPG", "Paris CDG   (LOST)"],
  ["CH_LSZH", "LSZH", "Zurich      (LOST)"],
  ["IE_EIDW", "EIDW", "Dublin      (LOST)"],
];

async function main() {
  const PAX = { unit: "PAS", tra_meas: "PAS_CRD", sinceTimePeriod: "2015-01" };

  console.log(`\n### A. PAX — months decoded per (schedule x tra_cov=TOTAL)\n`);
  console.log(`  ${"airport".padEnd(34)} ${SCHEDULES.map((s) => s.padStart(8)).join("")}`);
  for (const [rep, icao, label] of AIRPORTS) {
    const row = [];
    for (const sch of SCHEDULES) row.push((await months("avia_paoa", { ...PAX, tra_cov: "TOTAL", schedule: sch }, rep, icao)).padStart(8));
    console.log(`  ${label.padEnd(34)} ${row.join("")}`);
  }

  console.log(`\n### B. PAX — Amsterdam across tra_cov, schedule=TOT and unpinned\n`);
  for (const cov of COVERS) {
    const withTot = await months("avia_paoa", { ...PAX, tra_cov: cov, schedule: "TOT" }, "NL_EHAM", "EHAM");
    const noSched = await months("avia_paoa", { ...PAX, tra_cov: cov }, "NL_EHAM", "EHAM");
    console.log(`  tra_cov=${cov.padEnd(6)}  schedule=TOT: ${withTot.padStart(4)}    schedule unpinned: ${noSched.padStart(4)}`);
  }
  console.log(`  (for contrast, Madrid)`);
  for (const cov of COVERS) {
    const withTot = await months("avia_paoa", { ...PAX, tra_cov: cov, schedule: "TOT" }, "ES_LEMD", "LEMD");
    console.log(`  tra_cov=${cov.padEnd(6)}  schedule=TOT: ${withTot.padStart(4)}`);
  }

  console.log(`\n### C. MOVEMENTS (CAF_PAS) — same grid, tra_cov=TOTAL\n`);
  const ATM = { unit: "FLIGHT", tra_meas: "CAF_PAS", sinceTimePeriod: "2015-01" };
  console.log(`  ${"airport".padEnd(34)} ${SCHEDULES.map((s) => s.padStart(8)).join("")}`);
  for (const [rep, icao, label] of AIRPORTS.slice(0, 4)) {
    const row = [];
    for (const sch of SCHEDULES) row.push((await months("avia_paoa", { ...ATM, tra_cov: "TOTAL", schedule: sch }, rep, icao)).padStart(8));
    console.log(`  ${label.padEnd(34)} ${row.join("")}`);
  }

  console.log(`\n### D. CARGO (avia_gooa) — its own dimension list may differ\n`);
  const CARGO = { unit: "T", tra_meas: "FRM_LD_NLD", sinceTimePeriod: "2015-01" };
  const res = await fetch(url("avia_gooa", { ...CARGO }, ["DE_EDDF"]), { headers: UA });
  const js = await res.json();
  js.id.forEach((d, i) => {
    const cat = js.dimension?.[d]?.category?.index || {};
    const ordered = Object.entries(cat).sort((a, b) => a[1] - b[1]).map(([k]) => k);
    if (d === "time") return;
    console.log(`  ${d.padEnd(10)} size=${js.size[i]}  [0]=${ordered[0]}  all: ${ordered.slice(0, 8).join(",")}`);
  });
  console.log();
  console.log(`  ${"airport".padEnd(34)} ${SCHEDULES.map((s) => s.padStart(8)).join("")}`);
  for (const [rep, icao, label] of AIRPORTS.slice(0, 4)) {
    const row = [];
    for (const sch of SCHEDULES) row.push((await months("avia_gooa", { ...CARGO, tra_cov: "TOTAL", schedule: sch }, rep, icao)).padStart(8));
    console.log(`  ${label.padEnd(34)} ${row.join("")}`);
  }

  console.log(`\n### done. The winning code per metric is what fetch-activity must pin.\n`);
}

main().catch((e) => { console.error("probe failed:", e); process.exit(1); });

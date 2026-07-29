#!/usr/bin/env node
/* ============================================================
 * probe-eurostat.mjs — diagnostic, not part of the nightly.
 *
 * ROUND 1 established that Eurostat is fine and we are not:
 *   - batch of 25, sinceTimePeriod=2015-01 -> HTTP 200, time=138 months
 *   - enumerate lastTimePeriod=12 -> 871 airports, FR_LFPG PRESENT
 * yet production decodes 3-6 months and only 252 airports, and never sees
 * CDG at all. So the loss happens in our decoder, not on the wire.
 *
 * The suspect: avia_paoa is a 7-dimension cube and we only pin `unit` and
 * `tra_meas`. esDecode() indexes rep_airp and time and implicitly reads
 * category 0 of every other dimension — so whatever `tra_cov` and
 * `schedule` happen to sort first is the slice we read. Round 1 showed
 * `schedule` now carries BOTH "TOTAL" and "TOT", which smells like a
 * structure migration that moved the data out from under index 0.
 *
 * This round runs the REAL esDecode against each variant, so the number
 * printed is exactly what fetch-activity would see.
 *
 * Run:  node scripts/probe-eurostat.mjs
 * ============================================================ */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { esDecode } from "./fetch-activity.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, "..", "data");
const BASE = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";
const UA = { "User-Agent": "glidepath-data-bot" };

function url(dataset, q, reps = []) {
  const usp = new URLSearchParams({ format: "JSON", lang: "EN", freq: "M", ...q });
  let u = `${BASE}/${dataset}?${usp.toString()}`;
  for (const r of reps) u += `&rep_airp=${encodeURIComponent(r)}`;
  return u;
}

async function get(dataset, q, reps = []) {
  const res = await fetch(url(dataset, q, reps), { headers: UA });
  if (!res.ok) return { err: `HTTP ${res.status} ${(await res.text()).slice(0, 150).replace(/\s+/g, " ")}` };
  return { js: await res.json() };
}

/* what the cube looks like, and what OUR decoder gets out of it */
async function decodeProbe(label, dataset, q, reps, watch = []) {
  const { js, err } = await get(dataset, q, reps);
  if (err) { console.log(`  ${label.padEnd(46)} ${err}`); return; }
  const shape = js.id.map((d, i) => `${d}:${js.size[i]}`).join(" ");
  let out;
  try { out = esDecode(js, dataset); }
  catch (e) { console.log(`  ${label.padEnd(46)} esDecode THREW ${e.message}`); return; }
  const icaos = Object.keys(out);
  const months = (ic) => (out[ic] ? Object.keys(out[ic].monthly).length : 0);
  const watched = watch.map((w) => `${w}:${months(w)}mo`).join(" ");
  console.log(`  ${label.padEnd(46)} decoded ${String(icaos.length).padStart(4)} airports  ${watched}`);
  console.log(`      cube  ${shape}`);
}

async function main() {
  const idx = JSON.parse(await readFile(resolve(DATA, "activity-index.json"), "utf8"));
  const euCodes = Object.values(idx.airports)
    .filter((a) => a.source === "eurostat" && a.rep_airp).map((a) => a.rep_airp);
  const PAX = { unit: "PAS", tra_meas: "PAS_CRD" };
  const SINCE = { sinceTimePeriod: "2015-01" };

  console.log(`\n### A. WHICH DIMENSIONS ARE WE LEAVING UNPINNED, AND IN WHAT ORDER?`);
  console.log(`###    category 0 of each unpinned dim is what esDecode silently reads\n`);
  const { js } = await get("avia_paoa", { ...PAX, ...SINCE }, ["DE_EDDF"]);
  if (js) {
    js.id.forEach((d, i) => {
      const cat = js.dimension?.[d]?.category?.index || {};
      const ordered = Object.entries(cat).sort((a, b) => a[1] - b[1]).map(([k]) => k);
      if (d === "time") { console.log(`  ${d.padEnd(10)} size=${js.size[i]}  (${ordered[0]}..${ordered[ordered.length - 1]})`); return; }
      console.log(`  ${d.padEnd(10)} size=${js.size[i]}  [0]=${ordered[0]}   all: ${ordered.slice(0, 8).join(",")}`);
    });
  }

  console.log(`\n### B. SINGLE AIRPORT, PINNING THE UNPINNED DIMS — real esDecode output`);
  console.log(`###    we hold 133 months for EDDF; Eurostat's window is 138\n`);
  await decodeProbe("production (nothing else pinned)", "avia_paoa", { ...PAX, ...SINCE }, ["DE_EDDF"], ["EDDF"]);
  await decodeProbe("+ tra_cov=TOTAL", "avia_paoa", { ...PAX, ...SINCE, tra_cov: "TOTAL" }, ["DE_EDDF"], ["EDDF"]);
  await decodeProbe("+ schedule=TOTAL", "avia_paoa", { ...PAX, ...SINCE, schedule: "TOTAL" }, ["DE_EDDF"], ["EDDF"]);
  await decodeProbe("+ schedule=TOT", "avia_paoa", { ...PAX, ...SINCE, schedule: "TOT" }, ["DE_EDDF"], ["EDDF"]);
  await decodeProbe("+ tra_cov=TOTAL & schedule=TOTAL", "avia_paoa", { ...PAX, ...SINCE, tra_cov: "TOTAL", schedule: "TOTAL" }, ["DE_EDDF"], ["EDDF"]);
  await decodeProbe("+ tra_cov=TOTAL & schedule=TOT", "avia_paoa", { ...PAX, ...SINCE, tra_cov: "TOTAL", schedule: "TOT" }, ["DE_EDDF"], ["EDDF"]);

  console.log(`\n### C. SAME, FOR THE AIRPORT WE LOST\n`);
  for (const [lbl, extra] of [["production", {}], ["tra_cov+schedule=TOTAL", { tra_cov: "TOTAL", schedule: "TOTAL" }], ["tra_cov=TOTAL schedule=TOT", { tra_cov: "TOTAL", schedule: "TOT" }]]) {
    await decodeProbe(`LFPG ${lbl}`, "avia_paoa", { ...PAX, ...SINCE, ...extra }, ["FR_LFPG"], ["LFPG"]);
  }

  console.log(`\n### D. ENUMERATE — how many airports survive esDecode with the dims pinned?`);
  console.log(`###    production decodes 252 of the 871 the API returns\n`);
  await decodeProbe("enumerate lastTimePeriod=12 (production)", "avia_paoa", { ...PAX, lastTimePeriod: "12" }, [], ["LFPG", "EDDF"]);
  await decodeProbe("enumerate + tra_cov+schedule=TOTAL", "avia_paoa", { ...PAX, lastTimePeriod: "12", tra_cov: "TOTAL", schedule: "TOTAL" }, [], ["LFPG", "EDDF"]);
  await decodeProbe("enumerate + tra_cov=TOTAL schedule=TOT", "avia_paoa", { ...PAX, lastTimePeriod: "12", tra_cov: "TOTAL", schedule: "TOT" }, [], ["LFPG", "EDDF"]);

  console.log(`\n### E. FULL PRODUCTION BATCH with the dims pinned (25 airports)\n`);
  await decodeProbe("25 airports, production", "avia_paoa", { ...PAX, ...SINCE }, euCodes.slice(0, 25), ["EHAM", "LEMD"]);
  await decodeProbe("25 airports, pinned TOTAL/TOTAL", "avia_paoa", { ...PAX, ...SINCE, tra_cov: "TOTAL", schedule: "TOTAL" }, euCodes.slice(0, 25), ["EHAM", "LEMD"]);
  await decodeProbe("25 airports, pinned TOTAL/TOT", "avia_paoa", { ...PAX, ...SINCE, tra_cov: "TOTAL", schedule: "TOT" }, euCodes.slice(0, 25), ["EHAM", "LEMD"]);

  console.log(`\n### F. THE OTHER TWO METRICS, pinned the same way\n`);
  await decodeProbe("atm production", "avia_paoa", { unit: "FLIGHT", tra_meas: "CAF_PAS", ...SINCE }, ["DE_EDDF"], ["EDDF"]);
  await decodeProbe("atm pinned", "avia_paoa", { unit: "FLIGHT", tra_meas: "CAF_PAS", ...SINCE, tra_cov: "TOTAL", schedule: "TOTAL" }, ["DE_EDDF"], ["EDDF"]);
  await decodeProbe("cargo production", "avia_gooa", { unit: "T", tra_meas: "FRM_LD_NLD", ...SINCE }, ["DE_EDDF"], ["EDDF"]);
  await decodeProbe("cargo pinned", "avia_gooa", { unit: "T", tra_meas: "FRM_LD_NLD", ...SINCE, tra_cov: "TOTAL", schedule: "TOTAL" }, ["DE_EDDF"], ["EDDF"]);

  console.log(`\n### done. 130+ months and ~400 airports = the fix. \n`);
}

main().catch((e) => { console.error("probe failed:", e); process.exit(1); });

#!/usr/bin/env node
/* ============================================================
 * probe-eurostat.mjs — diagnostic, not part of the nightly.
 *
 * Answers one question: when fetch-activity asks Eurostat for a long
 * history, why does it get back ~6 months?
 *
 * Context (2026-07): the committed catalogue carries 133-135 months per
 * airport, but every nightly pull now returns 3-6, so chooseSeries() holds
 * everything on last-good. A Eurostat data-viewer export proves the table
 * is healthy — Paris CDG has 42 unbroken months ending 2025-12, only 6
 * months behind the newest month in the dataset, i.e. squarely inside the
 * normal 4-6 month reporting lag that 292 other airports also sit in. Yet
 * CDG never even appears in our enumerate call. So the fault is in what we
 * ask for, not in what Eurostat has.
 *
 * Each probe prints the shape of the response rather than the data: the
 * width of the shared `time` dimension is the tell, because in JSON-stat
 * that dimension is shared across every airport in the reply. A narrow
 * time dimension means the API truncated the window for the whole request;
 * per-airport nulls inside a wide window would mean something else.
 *
 * Run:  node scripts/probe-eurostat.mjs
 * ============================================================ */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Response shape: status, dimension widths, the time window actually
 *  returned, and whether a specific airport made it in. */
async function probe(label, dataset, q, reps = [], lookFor = null) {
  const u = url(dataset, q, reps);
  const line = (s) => console.log(`  ${label.padEnd(34)} ${s}`);
  let res;
  try { res = await fetch(u, { headers: UA }); }
  catch (e) { line(`NETWORK FAIL ${e.message}`); return; }
  if (!res.ok) {
    let body = ""; try { body = (await res.text()).slice(0, 220).replace(/\s+/g, " "); } catch {}
    line(`HTTP ${res.status}  ${body}`);
    return;
  }
  let js;
  try { js = await res.json(); }
  catch (e) { line(`unparsable JSON: ${e.message}`); return; }

  const times = Object.keys(js?.dimension?.time?.category?.index || {}).sort();
  const reps_ = Object.keys(js?.dimension?.rep_airp?.category?.index || {});
  const nVals = js?.value ? (Array.isArray(js.value) ? js.value.filter((v) => v != null).length : Object.keys(js.value).length) : 0;
  let extra = "";
  if (lookFor) {
    const hit = reps_.includes(lookFor);
    extra = `  ${lookFor}:${hit ? "PRESENT" : "ABSENT"}`;
  }
  line(`HTTP 200  time=${String(times.length).padStart(3)} [${times[0] || "-"}..${times[times.length - 1] || "-"}]  airports=${String(reps_.length).padStart(4)}  values=${nVals}${extra}`);
  // anything the API wants to tell us about truncation lives here
  for (const k of ["warning", "note", "extension", "label"]) {
    if (js[k] && k !== "label") console.log(`      ${k}: ${JSON.stringify(js[k]).slice(0, 300)}`);
  }
}

async function main() {
  const idx = JSON.parse(await readFile(resolve(DATA, "activity-index.json"), "utf8"));
  const euCodes = Object.values(idx.airports)
    .filter((a) => a.source === "eurostat" && a.rep_airp)
    .map((a) => a.rep_airp);
  const PAX = { unit: "PAS", tra_meas: "PAS_CRD" };

  console.log(`\n### 1. ENUMERATE — exactly what fetch-activity sends (no rep_airp filter)`);
  console.log(`###    if CDG is ABSENT here, that alone explains why it left the catalogue\n`);
  await probe("lastTimePeriod=12 (production)", "avia_paoa", { ...PAX, lastTimePeriod: "12" }, [], "FR_LFPG");
  await probe("lastTimePeriod=24", "avia_paoa", { ...PAX, lastTimePeriod: "24" }, [], "FR_LFPG");
  await probe("lastTimePeriod=36", "avia_paoa", { ...PAX, lastTimePeriod: "36" }, [], "FR_LFPG");
  await probe("sinceTimePeriod=2015-01", "avia_paoa", { ...PAX, sinceTimePeriod: "2015-01" }, [], "FR_LFPG");

  console.log(`\n### 2. SINGLE AIRPORT — does the time filter work at all?`);
  console.log(`###    Frankfurt is live (latest 2026-01); we hold 133 months for it\n`);
  await probe("EDDF sinceTimePeriod=2015-01", "avia_paoa", { ...PAX, sinceTimePeriod: "2015-01" }, ["DE_EDDF"]);
  await probe("EDDF lastTimePeriod=120", "avia_paoa", { ...PAX, lastTimePeriod: "120" }, ["DE_EDDF"]);
  await probe("EDDF no time param", "avia_paoa", PAX, ["DE_EDDF"]);
  await probe("EDDF since+until", "avia_paoa", { ...PAX, sinceTimePeriod: "2015-01", untilTimePeriod: "2026-12" }, ["DE_EDDF"]);

  console.log(`\n### 3. CDG DIRECTLY — the airport we lost. 42 months per the data viewer\n`);
  await probe("LFPG sinceTimePeriod=2015-01", "avia_paoa", { ...PAX, sinceTimePeriod: "2015-01" }, ["FR_LFPG"]);
  await probe("LFPG lastTimePeriod=120", "avia_paoa", { ...PAX, lastTimePeriod: "120" }, ["FR_LFPG"]);

  console.log(`\n### 4. BATCH SIZE — does asking for more airports shrink the window?`);
  console.log(`###    production uses chunks of 25\n`);
  for (const n of [1, 5, 10, 25]) {
    await probe(`${String(n).padStart(2)} airports since=2015-01`, "avia_paoa",
      { ...PAX, sinceTimePeriod: "2015-01" }, euCodes.slice(0, n));
  }

  console.log(`\n### 5. OTHER METRICS — same question for movements and cargo\n`);
  await probe("EDDF atm since=2015-01", "avia_paoa", { unit: "FLIGHT", tra_meas: "CAF_PAS", sinceTimePeriod: "2015-01" }, ["DE_EDDF"]);
  await probe("EDDF cargo since=2015-01", "avia_gooa", { unit: "T", tra_meas: "FRM_LD_NLD", sinceTimePeriod: "2015-01" }, ["DE_EDDF"]);

  console.log(`\n### 6. DIMENSION CODES — is PAS_CRD still the right tra_meas?`);
  console.log(`###    the data-viewer export used "Passengers on board"\n`);
  try {
    const u = url("avia_paoa", { lastTimePeriod: "1" }, ["DE_EDDF"]);
    const js = await (await fetch(u, { headers: UA })).json();
    for (const dim of ["unit", "tra_meas", "tra_cov", "schedule"]) {
      const cat = js?.dimension?.[dim]?.category;
      if (!cat) continue;
      const codes = Object.keys(cat.index || {});
      console.log(`  ${dim}: ${codes.map((c) => `${c}=${(cat.label || {})[c] || "?"}`).join(" | ").slice(0, 300)}`);
    }
  } catch (e) { console.log(`  dimension probe failed: ${e.message}`); }

  console.log(`\n### done. Read the time= column: 100+ means the filter works,`);
  console.log(`### single digits mean the API truncated the window.\n`);
}

main().catch((e) => { console.error("probe failed:", e); process.exit(1); });

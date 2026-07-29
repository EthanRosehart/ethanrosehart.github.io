#!/usr/bin/env node
/* ============================================================
 * probe-eurostat.mjs — verifies the live Eurostat query against the API.
 *
 * Not part of the nightly. It exists because the dev sandbox can't reach
 * ec.europa.eu, so the only way to check this code against the real API is
 * from a runner (.github/workflows/probe-eurostat.yml, manual dispatch).
 *
 * WHAT IT CAUGHT (July 2026): avia_paoa is a 7-dimension cube; esDecode()
 * walks rep_airp and time and silently reads category 0 of anything else.
 * `schedule` carries two generations of codes with identical labels —
 * "TOTAL" and "TOT" both read "Total" — the older sorts first and is
 * near-empty, and we were reading it. Frankfurt decoded 5 months instead
 * of 133; Paris CDG decoded nothing at all and vanished from the
 * catalogue. Fix: pin every dimension (ES_PINS) and make esDecode throw
 * rather than guess.
 *
 * It now imports ES_PINS and esDecode from fetch-activity, so it tests the
 * REAL production configuration — if someone changes the pins, this checks
 * the new ones. Exits non-zero when a check fails, so the workflow goes red.
 *
 * Run:  node scripts/probe-eurostat.mjs
 * ============================================================ */
import { esDecode, ES_PINS, normMonth } from "./fetch-activity.mjs";

const BASE = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";
const UA = { "User-Agent": "glidepath-data-bot" };
/* what the nightly asks for, per metric — keep in step with main() */
const METRICS = [
  ["pax", "avia_paoa", { unit: "PAS", tra_meas: "PAS_CRD" }],
  ["atm", "avia_paoa", { unit: "FLIGHT", tra_meas: "CAF_PAS" }],
  ["cargo", "avia_gooa", { unit: "T", tra_meas: "FRM_LD_NLD" }],
];
/* a spread of airports, including gateways the bug removed from the site */
const AIRPORTS = [
  ["DE_EDDF", "EDDF", "Frankfurt"], ["NL_EHAM", "EHAM", "Amsterdam"],
  ["ES_LEMD", "LEMD", "Madrid"], ["FR_LFPG", "LFPG", "Paris CDG"],
  ["CH_LSZH", "LSZH", "Zurich"], ["IE_EIDW", "EIDW", "Dublin"],
  ["BE_EBBR", "EBBR", "Brussels"], ["PT_LPPT", "LPPT", "Lisboa"],
];
const MIN_EXPECTED = 100;   // we hold 130+ for these; anything near 0 is the bug back

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${msg}`); };

function url(dataset, q, reps = []) {
  const usp = new URLSearchParams({ format: "JSON", lang: "EN", freq: "M", ...q });
  let u = `${BASE}/${dataset}?${usp.toString()}`;
  for (const r of reps) u += `&rep_airp=${encodeURIComponent(r)}`;
  return u;
}
async function fetchDecode(dataset, q, reps) {
  const res = await fetch(url(dataset, q, reps), { headers: UA });
  if (!res.ok) return { err: `HTTP ${res.status}` };
  const js = await res.json();
  try { return { out: esDecode(js, dataset), js }; }
  catch (e) { return { err: `esDecode: ${e.message}` }; }
}

async function main() {
  console.log(`\nES_PINS in force: ${JSON.stringify(ES_PINS)}\n`);

  console.log(`### 1. every metric returns real history for every airport\n`);
  for (const [metric, dataset, q] of METRICS) {
    for (const [rep, icao, name] of AIRPORTS) {
      const { out, err } = await fetchDecode(dataset, { ...q, ...ES_PINS, sinceTimePeriod: "2015-01" }, [rep]);
      if (err) { check(false, `${metric.padEnd(5)} ${name.padEnd(10)} ${err}`); continue; }
      const n = out[icao] ? Object.keys(out[icao].monthly).length : 0;
      check(n >= MIN_EXPECTED, `${metric.padEnd(5)} ${name.padEnd(10)} ${String(n).padStart(3)} months`);
    }
  }

  console.log(`\n### 2. the enumerate sees the whole catalogue, CDG included\n`);
  const { out, err } = await fetchDecode("avia_paoa",
    { unit: "PAS", tra_meas: "PAS_CRD", ...ES_PINS, lastTimePeriod: "12" }, []);
  if (err) check(false, `enumerate ${err}`);
  else {
    const n = Object.keys(out).length;
    check(n > 350, `enumerate decoded ${n} airports (was 252 with the bug)`);
    for (const [, icao, name] of AIRPORTS) check(!!out[icao], `enumerate includes ${name}`);
  }

  console.log(`\n### 3. a production-sized batch still returns full history\n`);
  const batch = AIRPORTS.map(([r]) => r);
  const { out: b, err: berr } = await fetchDecode("avia_paoa",
    { unit: "PAS", tra_meas: "PAS_CRD", ...ES_PINS, sinceTimePeriod: "2015-01" }, batch);
  if (berr) check(false, `batch ${berr}`);
  else for (const [, icao, name] of AIRPORTS) {
    const n = b[icao] ? Object.keys(b[icao].monthly).length : 0;
    check(n >= MIN_EXPECTED, `batch of ${batch.length}: ${name.padEnd(10)} ${String(n).padStart(3)} months`);
  }

  console.log(`\n### 4. esDecode refuses to guess when a dimension is left open\n`);
  const res = await fetch(url("avia_paoa", { unit: "PAS", tra_meas: "PAS_CRD", sinceTimePeriod: "2015-01" }, ["DE_EDDF"]), { headers: UA });
  const js = await res.json();
  let threw = false;
  try { esDecode(js, "avia_paoa"); } catch { threw = true; }
  check(threw, "unpinned query throws instead of decoding category 0");

  console.log(`\n${failures ? `### ${failures} CHECK(S) FAILED` : "### all checks passed"}\n`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error("probe failed:", e); process.exit(1); });

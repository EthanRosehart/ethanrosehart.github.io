#!/usr/bin/env node
/* ============================================================
 * fetch-bts.mjs — US monthly activity via BTS T-100 (Socrata)
 *
 * Dataset r495-tyji = "T-100 Segment Summary By Origin Airport"
 * (data.bts.gov, monthly, since 1990). Pre-aggregated by origin
 * airport, so we sum across carriers/destinations per month.
 * Merges US airports into data/activity.json (written by
 * fetch-activity.mjs first). Best-effort; logs columns + reasons.
 * ============================================================ */
import { writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data", "activity.json");
const DATASET = "r495-tyji";
const BASE = `https://data.bts.gov/resource/${DATASET}.json`;
const US = ["BUR", "PVU", "PSP", "BZN"];
const UA = { "User-Agent": "glidepath-data-bot" };
const LB_TO_T = 0.000453592;   // T-100 freight is in pounds

async function discoverColumns() {
  const res = await fetch(`${BASE}?$limit=1`, { headers: UA });
  if (!res.ok) throw new Error(`sample HTTP ${res.status}`);
  const rows = await res.json();
  const keys = Object.keys(rows[0] || {});
  console.log("  [bts] columns:", keys.join(", "));
  const find = (re) => keys.find((k) => re.test(k));
  const c = {
    origin: find(/^origin$/i) || find(/origin.*(air|code)/i) || find(/^orig/i),
    pax: find(/passenger/i),
    freight: find(/freight/i),
    flights: find(/depart/i) || find(/^flights?$/i),
    year: find(/^year$/i) || find(/^data.?year$/i) || find(/year/i),
    month: find(/^month$/i) || find(/month/i),
  };
  console.log("  [bts] mapped:", JSON.stringify(c));
  return c;
}

async function seriesFor(c, code) {
  const sel = [c.year, c.month,
    c.pax ? `sum(${c.pax}) as pax` : null,
    c.freight ? `sum(${c.freight}) as freight` : null,
    c.flights ? `sum(${c.flights}) as flights` : null].filter(Boolean).join(",");
  const url = `${BASE}?$select=${sel}&$where=${c.origin}='${code}'&$group=${c.year},${c.month}&$limit=5000`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) { let b = ""; try { b = (await res.text()).slice(0, 160); } catch {} throw new Error(`HTTP ${res.status} ${b}`); }
  const rows = await res.json();
  const pax = {}, atm = {}, cargo = {};
  for (const r of rows) {
    const y = +r[c.year], m = +r[c.month];
    if (!y || !m) continue;
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (r.pax != null) pax[key] = Math.round(+r.pax);
    if (r.flights != null) atm[key] = Math.round(+r.flights);
    if (r.freight != null) cargo[key] = Math.round(+r.freight * LB_TO_T);
  }
  return { pax, atm, cargo };
}

async function main() {
  let data; try { data = JSON.parse(await readFile(OUT, "utf8")); } catch { data = { airports: {} }; }
  data.airports = data.airports || {};

  let c;
  try { c = await discoverColumns(); } catch (e) { console.error("BTS columns failed:", e.message); return; }
  if (!c.origin || !c.pax || !c.year || !c.month) { console.error("BTS: could not map required columns; aborting (US absent)"); return; }

  for (const code of US) {
    try {
      const s = await seriesFor(c, code);
      const series = {};
      for (const m of ["pax", "atm", "cargo"]) if (Object.keys(s[m]).length >= 12) series[m] = s[m];
      if (series.pax) {
        const pk = Object.keys(series.pax).sort();
        data.airports[code] = { observed: true, source: "bts", rep_airp: code, months: pk.length, latest: pk[pk.length - 1], series, monthly: series.pax };
        console.log(`  ${code}  bts  pax ${pk.length}mo (latest ${pk[pk.length - 1]}) atm ${Object.keys(series.atm || {}).length} cargo ${Object.keys(series.cargo || {}).length}`);
      } else {
        console.warn(`  ${code}  bts  insufficient pax (${Object.keys(s.pax).length}mo) — skipped`);
        delete data.airports[code];
      }
    } catch (e) { console.warn(`  ${code}  bts failed (${e.message})`); }
  }

  await writeFile(OUT, JSON.stringify(data) + "\n", "utf8");
  console.log("BTS merge done.");
}

main().catch((e) => { console.error("BTS failed:", e.message); process.exit(1); });

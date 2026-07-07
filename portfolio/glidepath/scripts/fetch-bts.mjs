#!/usr/bin/env node
/* ============================================================
 * fetch-bts.mjs — US monthly activity via BTS T-100 (Socrata)
 *
 * Discovers a MONTHLY T-100 segment dataset on data.bts.gov (the
 * "summary by origin airport" table r495-tyji is annual only), then
 * aggregates passengers / freight / departures by month for each US
 * airport. Runs after fetch-activity.mjs and shares its split layout:
 * updates this script's own entries in data/activity-index.json and
 * writes data/series/<IATA>.json per US airport, leaving the
 * eurostat/statcan entries fetch-activity.mjs owns untouched.
 * Best-effort + verbose.
 * ============================================================ */
import { writeFile, readFile, mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lastFullYearTotal, metricsIn } from "./_util.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, "..", "data");
const OUT = resolve(DATA, "activity-index.json");
const SERIES_DIR = resolve(DATA, "series");
const US = ["BUR", "PVU", "PSP", "BZN"];
const UA = { "User-Agent": "glidepath-data-bot" };
const LB_TO_T = 0.000453592;

async function jget(url) { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }

async function discover() {
  // constrain to the BTS domain (the catalog federates across all Socrata
  // domains otherwise, returning unrelated datasets)
  const cat = `https://data.bts.gov/api/catalog/v1?domains=data.bts.gov&search_context=data.bts.gov&only=dataset&limit=100&q=${encodeURIComponent("T-100")}`;
  let results = [];
  try { results = (await jget(cat)).results || []; console.log(`  [bts] catalog returned ${results.length} datasets`); }
  catch (e) { console.warn("  [bts] catalog failed:", e.message); }
  const all = results.map((x) => ({ id: x.resource?.id, name: x.resource?.name || "" })).filter((c) => c.id);
  all.slice(0, 20).forEach((c) => console.log(`  [bts] ds ${c.id} "${c.name}"`));
  // probe order: known ids first, then anything that looks like T-100/segment, then the rest
  const known = ["3xj5-daif", "ar8a-asfm", "9eyi-a9zk"];
  const looks = all.filter((c) => /t-?100|segment|carrier|traffic/i.test(c.name));
  const seen = new Set();
  const ordered = [...known.map((id) => ({ id, name: "(known)" })), ...looks, ...all]
    .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  return ordered;
}

export function mapCols(keys) {
  const find = (re) => keys.find((k) => re.test(k));
  return {
    origin: find(/origin.*code/i) || find(/^origin$/i) || find(/^orig.*airport$/i),
    month: find(/^month$/i),
    year: find(/^year$/i),
    pax: find(/^passengers$/i) || find(/passenger/i),
    freight: find(/^freight$/i) || find(/freight.*lb|total_freight/i),
    flights: find(/depart/i) || find(/^flights?$/i),
  };
}

async function pickDataset(cands) {
  for (const c of cands.slice(0, 25)) {
    let keys = [];
    try { const rows = await jget(`https://data.bts.gov/resource/${c.id}.json?$limit=1`); keys = Object.keys(rows[0] || {}); }
    catch { continue; }
    const m = mapCols(keys);
    console.log(`  [bts] ${c.id} cols→ ${JSON.stringify(m)}`);
    if (m.origin && m.month && m.year && m.pax) return { id: c.id, m };
  }
  return null;
}

async function seriesFor(id, m, code) {
  const sel = [m.year, m.month, `sum(${m.pax}) as pax`,
    m.freight ? `sum(${m.freight}) as freight` : null,
    m.flights ? `sum(${m.flights}) as flights` : null].filter(Boolean).join(",");
  const url = `https://data.bts.gov/resource/${id}.json?$select=${sel}&$where=${m.origin}='${code}'&$group=${m.year},${m.month}&$limit=5000`;
  const rows = await jget(url);
  const pax = {}, atm = {}, cargo = {};
  for (const r of rows) {
    const y = +r[m.year], mo = +r[m.month]; if (!y || !mo) continue;
    const key = `${y}-${String(mo).padStart(2, "0")}`;
    if (r.pax != null) pax[key] = Math.round(+r.pax);
    if (r.flights != null) atm[key] = Math.round(+r.flights);
    if (r.freight != null) cargo[key] = Math.round(+r.freight * LB_TO_T);
  }
  return { pax, atm, cargo };
}

async function loadJSON(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }

async function main() {
  const indexDoc = await loadJSON(OUT);
  const airports = indexDoc?.airports || {};

  const cands = await discover();
  const picked = await pickDataset(cands);
  if (!picked) { console.error("  [bts] no monthly T-100 dataset with origin/month/pax found — US absent"); return; }
  console.log(`  [bts] using dataset ${picked.id}`);

  await mkdir(SERIES_DIR, { recursive: true });
  let live = 0;
  for (const code of US) {
    try {
      const s = await seriesFor(picked.id, picked.m, code);
      const series = {};
      for (const k of ["pax", "atm", "cargo"]) if (Object.keys(s[k]).length >= 12) series[k] = s[k];
      if (series.pax) {
        const pk = Object.keys(series.pax).sort();
        airports[code] = {
          observed: true, source: "bts", rep_airp: code,
          months: pk.length, latest: pk[pk.length - 1],
          metrics: metricsIn(series), hasPaxSeg: false,
          annualPax: lastFullYearTotal(series.pax),
        };
        await writeFile(resolve(SERIES_DIR, `${code}.json`), JSON.stringify({ series }) + "\n", "utf8");
        live++;
        console.log(`  ${code}  bts  pax ${pk.length}mo (latest ${pk[pk.length - 1]}) atm ${Object.keys(series.atm || {}).length} cargo ${Object.keys(series.cargo || {}).length}`);
      } else {
        console.warn(`  ${code}  bts  insufficient pax (${Object.keys(s.pax).length}mo)`);
        delete airports[code];
        await unlink(resolve(SERIES_DIR, `${code}.json`)).catch(() => {});
      }
    } catch (e) { console.warn(`  ${code}  bts failed (${e.message})`); }
  }

  if (!indexDoc) { console.warn("  [bts] no existing activity-index.json to update — skipping index write"); return; }
  indexDoc.airports = airports;
  await writeFile(OUT, JSON.stringify(indexDoc) + "\n", "utf8");
  console.log(`BTS merge done — ${live} US airports live.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("BTS failed:", e.message); process.exit(1); });
}

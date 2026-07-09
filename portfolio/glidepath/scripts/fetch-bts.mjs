#!/usr/bin/env node
/* ============================================================
 * fetch-bts.mjs — US monthly activity via BTS T-100 (Socrata SODA)
 *
 * Discovers a MONTHLY T-100 segment dataset across the DOT Socrata
 * domains and aggregates passengers / freight / departures by month for
 * the major US airports below. Historical note: this fetcher previously
 * searched ONLY data.bts.gov and never found a monthly table — DOT's
 * T-100 datasets are published on data.transportation.gov, so that
 * domain is now searched first.
 *
 * Pipeline position: runs AFTER fetch-openflights.mjs (it needs the
 * still-untrimmed airport reference for names/coords) and BEFORE
 * fetch-activity.mjs (which carries this script's index entries forward
 * untouched and trims the reference to the union of both catalogues).
 *
 * Contract (same as every fetcher — see CONTRIBUTING.md): own only your
 * airports, never clobber another source's, keep last-good series on
 * failure, exit non-zero on total failure, no synthetic data. Snapshot
 * validation (validate-data.mjs) gates the nightly commit, so a wrong
 * guess here can fail loudly but can never ship garbage.
 *
 * Run locally:  node scripts/fetch-bts.mjs
 * ============================================================ */
import { writeFile, readFile, mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lastFullYearTotal, metricsIn } from "./_util.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, "..", "data");
const OUT = resolve(DATA, "activity-index.json");
const SERIES_DIR = resolve(DATA, "series");
const REF = resolve(DATA, "airports.json");
const UA = { "User-Agent": "glidepath-data-bot" };
const LB_TO_T = 0.000453592;   // T-100 freight is reported in pounds
const MIN_MONTHS = 24;         // same floor as the Eurostat/StatCan catalogue

/* the major US gateways to carry (top ~35 by enplanements — bounded so
   the nightly Prophet build stays affordable, same idea as EU_CAP) */
export const US = [
  "ATL","DFW","DEN","ORD","LAX","CLT","LAS","PHX","MCO","SEA",
  "MIA","IAH","JFK","EWR","FLL","MSP","SFO","DTW","BOS","PHL",
  "LGA","IAD","BWI","TPA","SAN","AUS","BNA","MDW","HNL","DAL",
  "PDX","STL","SLC","DCA","MSY",
];

/* DOT Socrata domains, in probe order — data.transportation.gov is where
   the T-100 tables actually live; data.bts.gov kept as a fallback. */
const DOMAINS = ["data.transportation.gov", "data.bts.gov"];

async function jget(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* map a dataset's column names to the roles we need — exported for the
   fixture tests; T-100 tables name these slightly differently per vintage */
export function mapCols(keys) {
  const find = (re) => keys.find((k) => re.test(k));
  return {
    origin: find(/^origin$/i) || find(/origin.*(code|airport)/i) || find(/^orig/i),
    month: find(/^month$/i),
    year: find(/^year$/i),
    pax: find(/^passengers?$/i) || find(/passenger/i),
    freight: find(/^freight$/i) || find(/freight/i),
    flights: find(/^departures_performed$/i) || find(/depart.*perform/i) || find(/depart/i) || find(/^flights?$/i),
  };
}

/* SODA aggregate rows -> { pax, atm, cargo } monthly series. Pure and
   exported for the fixture tests: numbers arrive as strings, freight is
   pounds (converted to tonnes), rows without a sane year/month drop. */
export function decodeRows(rows) {
  const pax = {}, atm = {}, cargo = {};
  for (const r of rows || []) {
    const y = Math.round(+r.year), mo = Math.round(+r.month);
    if (!Number.isFinite(y) || y < 1980 || y > 2100 || !(mo >= 1 && mo <= 12)) continue;
    const key = `${y}-${String(mo).padStart(2, "0")}`;
    if (r.pax != null && Number.isFinite(+r.pax)) pax[key] = Math.round(+r.pax);
    if (r.flights != null && Number.isFinite(+r.flights)) atm[key] = Math.round(+r.flights);
    if (r.freight != null && Number.isFinite(+r.freight)) cargo[key] = Math.round(+r.freight * LB_TO_T);
  }
  return { pax, atm, cargo };
}

/* enumerate candidate datasets on one domain, best-looking first —
   exported for the fixture tests */
export function orderCandidates(results) {
  const all = (results || [])
    .map((x) => ({ id: x.resource?.id, name: x.resource?.name || "" }))
    .filter((c) => c.id);
  const score = (c) => (/t-?100/i.test(c.name) ? 2 : 0) + (/segment/i.test(c.name) ? 1 : 0);
  return all.sort((a, b) => score(b) - score(a));
}

async function discover(domain) {
  const cat = `https://${domain}/api/catalog/v1?domains=${domain}&search_context=${domain}&only=dataset&limit=100&q=${encodeURIComponent("T-100 segment")}`;
  try {
    const results = (await jget(cat)).results || [];
    console.log(`  [bts] ${domain}: catalog returned ${results.length} datasets`);
    return orderCandidates(results);
  } catch (e) {
    console.warn(`  [bts] ${domain}: catalog failed (${e.message})`);
    return [];
  }
}

async function pickDataset() {
  for (const domain of DOMAINS) {
    const cands = await discover(domain);
    for (const c of cands.slice(0, 25)) {
      let keys = [];
      try {
        const rows = await jget(`https://${domain}/resource/${c.id}.json?$limit=1`);
        keys = Object.keys(rows[0] || {});
      } catch { continue; }
      const m = mapCols(keys);
      console.log(`  [bts] ${domain}/${c.id} "${c.name}" cols-> origin:${m.origin} y:${m.year} m:${m.month} pax:${m.pax}`);
      if (m.origin && m.month && m.year && m.pax) return { domain, id: c.id, name: c.name, m };
    }
  }
  return null;
}

async function seriesFor(ds, code) {
  const { domain, id, m } = ds;
  const sel = [m.year, m.month, `sum(${m.pax}) as pax`,
    m.freight ? `sum(${m.freight}) as freight` : null,
    m.flights ? `sum(${m.flights}) as flights` : null].filter(Boolean).join(",");
  const url = `https://${domain}/resource/${id}.json?$select=${encodeURIComponent(sel)}` +
    `&$where=${encodeURIComponent(`${m.origin}='${code}'`)}` +
    `&$group=${encodeURIComponent(`${m.year},${m.month}`)}&$limit=5000`;
  return decodeRows(await jget(url));
}

async function loadJSON(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }

/* previous committed series for an airport — last-good fallback, same
   pattern as fetch-activity.mjs */
async function prevSeries(iata) {
  const doc = await loadJSON(resolve(SERIES_DIR, `${iata}.json`));
  return doc?.series || null;
}

export async function main() {
  const indexDoc = (await loadJSON(OUT)) || {
    generatedAt: new Date().toISOString(),
    note: "Seeded by fetch-bts.mjs — fetch-activity.mjs writes the authoritative index.",
    airports: {},
  };
  const airports = indexDoc.airports = indexDoc.airports || {};
  const ref = (await loadJSON(REF))?.airports || {};

  const picked = await pickDataset();
  if (!picked) {
    console.error("  [bts] no monthly T-100 dataset with origin/month/year/pax found on any DOT domain — US airports keep last-good data");
    process.exit(1);   // loud: the health step reports this
  }
  console.log(`  [bts] using ${picked.domain}/${picked.id} "${picked.name}"`);

  await mkdir(SERIES_DIR, { recursive: true });
  let live = 0, kept = 0;
  for (const code of US) {
    let series = null;
    try {
      const s = await seriesFor(picked, code);
      const candidate = {};
      for (const k of ["pax", "atm", "cargo"]) if (Object.keys(s[k]).length >= 12) candidate[k] = s[k];
      if (candidate.pax && Object.keys(candidate.pax).length >= MIN_MONTHS) { series = candidate; live++; }
      else console.warn(`  ${code}  bts: insufficient pax (${Object.keys(s.pax).length}mo)`);
    } catch (e) {
      console.warn(`  ${code}  bts failed (${e.message})`);
    }
    if (!series) {
      const prev = await prevSeries(code);
      if (prev?.pax && Object.keys(prev.pax).length >= MIN_MONTHS && airports[code]?.source === "bts") {
        kept++;
        continue;   // keep last-good series + existing index entry untouched
      }
      // never shipped (or unusable) — make sure no stale stub lingers
      if (airports[code]?.source === "bts") delete airports[code];
      await unlink(resolve(SERIES_DIR, `${code}.json`)).catch(() => {});
      continue;
    }
    const r = ref[code] || {};
    const pk = Object.keys(series.pax).sort();
    // full metadata, same shape fetch-activity.mjs writes — cc/countryName/
    // region are what the app's screens key macro + grouping off; a bare
    // entry without them would crash Overview's MACRO lookup
    airports[code] = {
      observed: true, source: "bts", rep_airp: code,
      country: "US", cc: "USA", countryName: "United States", region: "North America",
      name: r.name || code, city: r.city || "United States", icao: r.icao || null,
      lat: r.lat ?? null, lon: r.lon ?? null,
      months: pk.length, latest: pk[pk.length - 1],
      metrics: metricsIn(series), hasPaxSeg: false,
      annualPax: lastFullYearTotal(series.pax),
    };
    await writeFile(resolve(SERIES_DIR, `${code}.json`), JSON.stringify({ series }) + "\n", "utf8");
    console.log(`  ${code}  bts  pax ${pk.length}mo (latest ${pk[pk.length - 1]}) atm ${Object.keys(series.atm || {}).length} cargo ${Object.keys(series.cargo || {}).length}`);
  }

  await writeFile(OUT, JSON.stringify(indexDoc) + "\n", "utf8");
  console.log(`BTS merge done — ${live} US airports refreshed, ${kept} kept last-good.`);
  if (!live && !kept) {
    console.error("  [bts] dataset found but no US airport produced a usable series — check the column mapping above");
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("BTS failed:", e.message); process.exit(1); });
}

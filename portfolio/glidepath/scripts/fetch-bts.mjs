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
import zlib from "node:zlib";
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

/* enumerate candidate datasets, best-looking first, deduped by id —
   exported for the fixture tests */
export function orderCandidates(results) {
  const byId = new Map();
  for (const x of results || []) {
    const id = x.resource?.id;
    if (id && !byId.has(id)) byId.set(id, { id, name: x.resource?.name || "" });
  }
  const score = (c) => (/t-?100/i.test(c.name) ? 4 : 0) + (/segment/i.test(c.name) ? 2 : 0)
    + (/domestic/i.test(c.name) ? 1 : 0) + (/passenger/i.test(c.name) ? 1 : 0);
  return [...byId.values()].sort((a, b) => score(b) - score(a));
}

/* Socrata catalog discovery by FULL ENUMERATION, not keyword search.
   Live-run findings (Actions runs 29029212909 / 29031604896): multi-word
   q returns zero (terms are ANDed against sparse metadata), and even
   single-word queries miss real tables — a monthly airport-level dataset
   ("International_Passengers_Freight_All_Types", udzf-9fvh) matched none
   of "T-100"/"t100"/"air carrier". DOT domains carry a few hundred
   datasets, so paging through all of them and ranking locally is cheap
   and can't be defeated by bad upstream metadata. */
async function listAllDatasets(domain) {
  const out = [];
  for (let offset = 0; offset < 3000; offset += 100) {
    let results;
    try {
      results = (await jget(`https://${domain}/api/catalog/v1?domains=${domain}&search_context=${domain}&only=dataset&limit=100&offset=${offset}`)).results || [];
    } catch (e) {
      console.warn(`  [bts] ${domain} enumeration failed at offset ${offset} (${e.message})`);
      break;
    }
    out.push(...results);
    if (results.length < 100) break;
  }
  return out;
}
async function discover(domain) {
  const all = await listAllDatasets(domain);
  const aviation = all.filter((x) => /t-?100|segment|passenger|freight|air.?carrier|airport|aviation/i.test(x.resource?.name || ""));
  console.log(`  [bts] ${domain}: enumerated ${all.length} datasets, ${aviation.length} aviation-ish:`);
  for (const x of aviation.slice(0, 40)) console.log(`  [bts]     ${x.resource.id} "${x.resource.name}"`);
  return orderCandidates(aviation);
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
      // near-miss diagnostics: a monthly table whose airport/pax columns our
      // mapper didn't recognize is a mapping bug we can fix from the log —
      // dump its full schema + a sample row so the next iteration doesn't guess
      if (m.month && m.year) {
        console.log(`  [bts]   near-miss full columns: ${keys.join(", ")}`);
        try { console.log(`  [bts]   near-miss sample row: ${JSON.stringify((await jget(`https://${domain}/resource/${c.id}.json?$limit=1`))[0]).slice(0, 500)}`); } catch {}
      }
    }
  }
  return null;
}

/* ============================================================
   TranStats PREZIP path — the one that actually carries the data.
   Live-run findings (Actions runs 29029212909 → 29032448512): DOT's
   Socrata catalogs, fully enumerated, hold only ANNUAL T-100 summaries;
   the monthly airport-level table lives on transtats.bts.gov/PREZIP/ as
   bulk zips whose names carry a rotating numeric prefix
   (e.g. 896816367_T_T100_SEGMENT_ALL_CARRIER.zip) — which is why every
   guessed static filename 404'd. The directory listing is enabled
   (HTTP 200, ~940 zips), so the real filenames are read from it, newest
   prefix first, and each zip's single CSV is aggregated by origin
   airport × month. All helpers are pure and fixture-tested.
   ============================================================ */
const T100_START_YEAR = 2015;   // history depth target (matches Eurostat's sinceTimePeriod)
const MAX_ZIPS = 14;            // download budget per run
const MAX_ZIP_BYTES = 250e6;    // a per-year file is ~15-40MB; refuse surprises

/* quote-aware CSV field split (same approach as fetch-openflights) */
export function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/* T-100 segment zips from the PREZIP directory listing, in fetch order:
   the combined table (domestic + international, all carriers) is the whole
   truth in one family; D/I pairs interleaved newest-first only if the
   combined family is absent. Numeric prefix descending ≈ newest data. */
export function pickT100Zips(listingHtml) {
  const found = [...new Set(String(listingHtml).match(/(?:\d+_)?T_T100\w*?\.zip/g) || [])];
  const groups = { combined: [], domestic: [], international: [] };
  for (const n of found) {
    if (/(?:^|_)T_T100_SEGMENT_ALL_CARRIER\.zip$/i.test(n)) groups.combined.push(n);
    else if (/(?:^|_)T_T100D_SEGMENT_ALL_CARRIER\.zip$/i.test(n)) groups.domestic.push(n);
    else if (/(?:^|_)T_T100I_SEGMENT_ALL_CARRIER\.zip$/i.test(n)) groups.international.push(n);
  }
  // numeric request-id prefix descending ≈ newest cached extract first;
  // an unprefixed (official) name has no id — sort it first
  const byIdDesc = (a, b) => (Number.isNaN(parseInt(b)) ? -1 : Number.isNaN(parseInt(a)) ? 1 : parseInt(b) - parseInt(a));
  for (const k of Object.keys(groups)) groups[k].sort(byIdDesc);
  if (groups.combined.length) return groups.combined;
  const inter = [];
  for (let i = 0; i < Math.max(groups.domestic.length, groups.international.length); i++) {
    if (groups.domestic[i]) inter.push(groups.domestic[i]);
    if (groups.international[i]) inter.push(groups.international[i]);
  }
  return inter;
}

/* minimal ZIP reader (central directory + inflateRaw) — enough for
   TranStats' one-CSV-per-zip files, no dependency needed */
export function unzipFirstCsv(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("latin1", off + 46, off + 46 + nameLen);
    if (/\.csv$/i.test(name)) {
      const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const data = buf.subarray(dataStart, dataStart + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`unsupported zip compression method ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("no .csv entry in zip");
}

/* aggregate one T-100 CSV into acc: iata -> {pax, atm, cargo} monthly.
   Freight arrives in POUNDS and is accumulated in tonnes (rounded once at
   the very end, across all files). Returns the years this file covered. */
export function aggregateT100Csv(csv, usSet, acc = {}) {
  const lines = String(csv).replace(/^﻿/, "").split(/\r?\n/);
  const header = parseCsvLine(lines[0] || "").map((h) => h.trim().toUpperCase());
  const iY = header.indexOf("YEAR") >= 0 ? header.indexOf("YEAR") : header.indexOf("DATA_YEAR");
  const iM = header.indexOf("MONTH"), iO = header.indexOf("ORIGIN");
  const iP = header.indexOf("PASSENGERS"), iF = header.indexOf("FREIGHT"), iD = header.indexOf("DEPARTURES_PERFORMED");
  if (iY < 0 || iM < 0 || iO < 0 || iP < 0) {
    // full header, deliberately — run 29033499468 truncated this and cost an iteration
    throw new Error("T-100 csv missing YEAR/MONTH/ORIGIN/PASSENGERS — full header: " + header.join(","));
  }
  const years = new Set();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = parseCsvLine(lines[i]);
    const o = (c[iO] || "").trim();
    if (!usSet.has(o)) continue;
    const y = +c[iY], m = +c[iM];
    if (!(y >= 1980 && y <= 2100) || !(m >= 1 && m <= 12)) continue;
    years.add(y);
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const a = acc[o] || (acc[o] = { pax: {}, atm: {}, cargo: {} });
    a.pax[ym] = (a.pax[ym] || 0) + (+c[iP] || 0);
    if (iD >= 0) a.atm[ym] = (a.atm[ym] || 0) + (+c[iD] || 0);
    if (iF >= 0) a.cargo[ym] = (a.cargo[ym] || 0) + (+c[iF] || 0) * LB_TO_T;
  }
  return { acc, years: [...years].sort((a, b) => a - b) };
}

/* month-level first-wins merge — PREZIP files are cached USER extracts
   (run 29033499468: rotating request ids, arbitrary field subsets and
   possibly overlapping year windows), so blind accumulation across files
   would double-count. First file to provide an airport+metric+month wins. */
export function mergeSeriesFirstWins(target, add) {
  for (const code of Object.keys(add || {})) {
    const t = target[code] || (target[code] = { pax: {}, atm: {}, cargo: {} });
    for (const k of ["pax", "atm", "cargo"]) {
      for (const ym of Object.keys(add[code][k] || {})) {
        if (t[k][ym] == null) t[k][ym] = add[code][k][ym];
      }
    }
  }
  return target;
}

function roundAcc(acc) {
  for (const code of Object.keys(acc)) {
    for (const k of ["pax", "atm", "cargo"]) {
      for (const ym of Object.keys(acc[code][k])) acc[code][k][ym] = Math.round(acc[code][k][ym]);
    }
  }
  return acc;
}

/* The deterministic TranStats route: DownLoad_Table.asp is the endpoint
   the site's own "Download" button posts to — we request exactly the six
   columns we need from T_T100_SEGMENT_ALL_CARRIER, one year per request,
   so scope is consistent (all carriers, domestic + international) and
   years are disjoint by construction. Response is a zip with one CSV.

   Run 29042555380 answered with bare "HTTP 500" twice and we had not
   logged the response body — TranStats returns descriptive ASP error
   pages, so this version (a) logs the body of every failure, (b) sends
   browser-shaped headers (the old glidepath-data-bot UA is a plausible
   500 trigger on IIS), (c) carries the full set of form fields the real
   download page posts, and (d) tries both hosts. The first variant that
   yields a usable CSV is locked in for the remaining years. */
const TT_UA = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "*/*",
};
const DT_HOSTS = ["https://www.transtats.bts.gov", "https://transtats.bts.gov"];

function downloadTableBody(y) {
  const sql = `SELECT YEAR,MONTH,ORIGIN,PASSENGERS,FREIGHT,DEPARTURES_PERFORMED FROM T_T100_SEGMENT_ALL_CARRIER WHERE YEAR=${y}`;
  return new URLSearchParams({
    UserTableName: "T_100_Segment_All_Carrier",
    DBShortName: "Air_Carriers",
    RawDataTable: "T_T100_SEGMENT_ALL_CARRIER",
    sqlstr: " " + sql,
    varlist: "YEAR,MONTH,ORIGIN,PASSENGERS,FREIGHT,DEPARTURES_PERFORMED",
    grouplist: "", suml: "", sumRegion: "", filter1: "title=", filter2: "title=",
    geo: "All ", time: "All Months", timename: "Month",
    GEOGRAPHY: "All", XYEAR: String(y), FREQUENCY: "All",
  }).toString();
}

async function tryDownloadTable(host, y) {
  const r = await fetch(`${host}/DownLoad_Table.asp?Table_ID=293&Has_Group=3&Is_Zipped=0`, {
    method: "POST",
    headers: {
      ...TT_UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${host}/DL_SelectFields.aspx?Table_ID=293`,
      Origin: host,
    },
    body: downloadTableBody(y),
  });
  const ct = r.headers.get("content-type") || "?";
  if (!r.ok) {
    let snippet = "";
    try { snippet = (await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300); } catch {}
    throw new Error(`HTTP ${r.status} (${ct}) body: ${JSON.stringify(snippet)}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  const csv = isZip ? unzipFirstCsv(buf).toString("utf8") : buf.toString("utf8");
  if (!/^"?(YEAR|DATA_YEAR)"?,/i.test(csv.slice(0, 24))) {
    throw new Error(`unexpected response (${ct}, ${buf.length}b, zip:${isZip}): ${JSON.stringify(csv.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300))}`);
  }
  return { csv, bytes: buf.length, isZip };
}

async function fetchViaDownloadTable() {
  console.log("  [bts] trying TranStats DownLoad_Table.asp (deterministic per-year extracts)");
  const usSet = new Set(US);
  const acc = {};
  const thisYear = new Date().getFullYear();
  let ok = 0, consecFail = 0, lockedHost = null;
  for (let y = thisYear; y >= T100_START_YEAR && consecFail < 2; y--) {
    const hosts = lockedHost ? [lockedHost] : DT_HOSTS;
    let got = null;
    for (const host of hosts) {
      try { got = await tryDownloadTable(host, y); lockedHost = host; break; }
      catch (e) { console.warn(`  [bts]   ${y} ${host.replace("https://", "")}: ${e.message}`); }
    }
    if (!got) { consecFail++; continue; }
    try {
      const { years } = aggregateT100Csv(got.csv, usSet, acc);
      ok++; consecFail = 0;
      console.log(`  [bts]   ${y}: ${(got.bytes / 1e6).toFixed(1)}MB (zip:${got.isZip}), years ${years.join("/") || "?"}`);
    } catch (e) { console.warn(`  [bts]   ${y}: ${e.message}`); consecFail++; }
  }
  if (!ok || !Object.keys(acc).length) return null;
  console.log(`  [bts] DownLoad_Table done — ${Object.keys(acc).length} airports over ${ok} year files`);
  return roundAcc(acc);
}

async function fetchViaTranstats() {
  console.log("  [bts] using TranStats PREZIP bulk files (cached extracts — merged month-first-wins)");
  let host = null, names = [];
  for (const base of ["https://transtats.bts.gov/PREZIP/", "https://www.transtats.bts.gov/PREZIP/"]) {
    try {
      const r = await fetch(base, { headers: UA });
      if (!r.ok) { console.warn(`  [bts] ${base} listing HTTP ${r.status}`); continue; }
      const html = await r.text();
      // diagnostic: every distinct T100-ish family in the listing (prefix
      // stripped) — run 29042555380 matched a single zip and we couldn't
      // tell whether better-named families were sitting right next to it
      const fams = [...new Set((html.match(/[\w.-]*T100[\w.-]*\.zip/gi) || []).map((n) => n.replace(/^\d+_/, "")))].sort();
      console.log(`  [bts] ${base} T100-ish zip families: ${fams.join(", ") || "none"}`);
      names = pickT100Zips(html);
      if (names.length) { host = base; break; }
      console.warn(`  [bts] ${base} listing readable but no T-100 segment zips in it`);
    } catch (e) { console.warn(`  [bts] ${base} listing failed (${e.message})`); }
  }
  if (!host) return null;
  console.log(`  [bts] ${host}: ${names.length} T-100 segment zips, newest first (target history back to ${T100_START_YEAR})`);

  const usSet = new Set(US);
  const merged = {};
  let minYear = Infinity, parsed = 0;
  for (const name of names.slice(0, MAX_ZIPS)) {
    try {
      const r = await fetch(host + name, { headers: UA });
      if (!r.ok) { console.warn(`  [bts]   ${name}: HTTP ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_ZIP_BYTES) { console.warn(`  [bts]   ${name}: ${(buf.length/1e6).toFixed(0)}MB — larger than expected for a per-period file, skipping`); continue; }
      const csv = unzipFirstCsv(buf).toString("utf8");
      // aggregate each file in isolation, then merge month-first-wins —
      // cached user extracts can overlap in coverage
      const { acc, years } = aggregateT100Csv(csv, usSet, {});
      mergeSeriesFirstWins(merged, acc);
      parsed++;
      if (years.length) minYear = Math.min(minYear, years[0]);
      console.log(`  [bts]   ${name}: ${(buf.length/1e6).toFixed(1)}MB zip, years ${years[0] ?? "?"}–${years[years.length-1] ?? "?"}`);
      if (minYear <= T100_START_YEAR) break;   // enough history — stop downloading
    } catch (e) {
      console.warn(`  [bts]   ${name}: ${e.message}`);
    }
  }
  if (!parsed || !Object.keys(merged).length) return null;
  console.log(`  [bts] PREZIP aggregation done — ${Object.keys(merged).length} airports, ${parsed} files, history back to ${minYear === Infinity ? "?" : minYear}`);
  return roundAcc(merged);
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

/* the Socrata route, kept as the cheap first try — if DOT ever publishes a
   monthly airport-level table there, it wins automatically */
async function fetchViaSocrata() {
  const picked = await pickDataset();
  if (!picked) return null;
  console.log(`  [bts] using ${picked.domain}/${picked.id} "${picked.name}"`);
  const out = {};
  for (const code of US) {
    try { out[code] = await seriesFor(picked, code); }
    catch (e) { console.warn(`  ${code}  bts socrata failed (${e.message})`); }
  }
  return Object.keys(out).length ? out : null;
}

export async function main() {
  const indexDoc = (await loadJSON(OUT)) || {
    generatedAt: new Date().toISOString(),
    note: "Seeded by fetch-bts.mjs — fetch-activity.mjs writes the authoritative index.",
    airports: {},
  };
  const airports = indexDoc.airports = indexDoc.airports || {};
  const ref = (await loadJSON(REF))?.airports || {};

  const seriesByCode = (await fetchViaSocrata()) || (await fetchViaDownloadTable()) || (await fetchViaTranstats());
  if (!seriesByCode) {
    console.error("  [bts] no monthly T-100 source produced data (Socrata + DownLoad_Table + PREZIP all failed) — US airports keep last-good data");
    process.exit(1);   // loud: the health step reports this
  }

  await mkdir(SERIES_DIR, { recursive: true });
  let live = 0, kept = 0;
  for (const code of US) {
    let series = null;
    const s = seriesByCode[code];
    if (s) {
      const candidate = {};
      for (const k of ["pax", "atm", "cargo"]) if (s[k] && Object.keys(s[k]).length >= 12) candidate[k] = s[k];
      if (candidate.pax && Object.keys(candidate.pax).length >= MIN_MONTHS) { series = candidate; live++; }
      else console.warn(`  ${code}  bts: insufficient pax (${Object.keys(s.pax || {}).length}mo)`);
    } else {
      console.warn(`  ${code}  bts: no rows in source`);
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

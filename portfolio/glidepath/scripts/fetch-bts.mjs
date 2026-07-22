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
    dest: find(/^dest$/i) || find(/dest.*(code|airport)/i) || find(/^dest/i),
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
      console.log(`  [bts] ${domain}/${c.id} "${c.name}" cols-> origin:${m.origin} dest:${m.dest} y:${m.year} m:${m.month} pax:${m.pax}`);
      // dest is required: an origin-only table could only yield enplanements,
      // which would silently break the catalogue's total-passengers convention
      if (m.origin && m.dest && m.month && m.year && m.pax) return { domain, id: c.id, name: c.name, m };
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

/* minimal ZIP reader (central directory + inflateRaw) — no dependency
   needed. TranStats download zips can carry MORE than one CSV (run
   29066554350: the field-description file SYS_FIELD_NAME,FIELD_DESC sat
   first and got picked over the data), so entries are enumerated and the
   caller chooses. */
export function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("latin1", off + 46, off + 46 + nameLen);
    out.push({ name, method, csize, lho });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function unzipEntry(buf, e) {
  const dataStart = e.lho + 30 + buf.readUInt16LE(e.lho + 26) + buf.readUInt16LE(e.lho + 28);
  const data = buf.subarray(dataStart, dataStart + e.csize);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported zip compression method ${e.method}`);
}

export function unzipFirstCsv(buf) {
  const e = zipEntries(buf).find((x) => /\.csv$/i.test(x.name));
  if (!e) throw new Error("no .csv entry in zip");
  return unzipEntry(buf, e);
}

/* the DATA csv out of a TranStats zip: csv entries largest-first, first
   one whose header row carries the columns we asked for wins; throws with
   the full entry listing so a surprise names itself in the run log */
export function unzipDataCsv(buf) {
  const entries = zipEntries(buf);
  const csvs = entries.filter((e) => /\.csv$/i.test(e.name)).sort((a, b) => b.csize - a.csize);
  for (const e of csvs) {
    const text = unzipEntry(buf, e).toString("utf8");
    const header = (text.slice(0, 400).split(/\r?\n/)[0] || "").toUpperCase();
    if (header.includes("ORIGIN") && (header.includes("YEAR") || header.includes("MONTH"))) {
      return { text, name: e.name };
    }
  }
  throw new Error(`no data csv in zip — entries: ${entries.map((e) => `${e.name}(${e.csize}b)`).join(", ") || "none"}`);
}

/* aggregate one T-100 CSV into acc: iata -> {pax, atm, cargo} monthly.
   Freight arrives in POUNDS and is accumulated in tonnes (rounded once at
   the very end, across all files). Returns the years this file covered. */
export function aggregateT100Csv(csv, usSet, acc = {}) {
  const lines = String(csv).replace(/^﻿/, "").split(/\r?\n/);
  const header = parseCsvLine(lines[0] || "").map((h) => h.trim().toUpperCase());
  const iY = header.indexOf("YEAR") >= 0 ? header.indexOf("YEAR") : header.indexOf("DATA_YEAR");
  const iM = header.indexOf("MONTH"), iO = header.indexOf("ORIGIN"), iDst = header.indexOf("DEST");
  const iP = header.indexOf("PASSENGERS"), iF = header.indexOf("FREIGHT"), iD = header.indexOf("DEPARTURES_PERFORMED");
  if (iY < 0 || iM < 0 || iO < 0 || iP < 0 || iDst < 0) {
    // full header, deliberately — run 29033499468 truncated this and cost an
    // iteration. DEST is required: origin-only aggregation yields
    // ENPLANEMENTS, not the total-passengers convention the rest of the
    // catalogue uses (see the both-sides note below).
    throw new Error("T-100 csv missing YEAR/MONTH/ORIGIN/DEST/PASSENGERS — full header: " + header.join(","));
  }
  const years = new Set();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = parseCsvLine(lines[i]);
    const o = (c[iO] || "").trim(), d = (c[iDst] || "").trim();
    const oIn = usSet.has(o), dIn = usSet.has(d);
    if (!oIn && !dIn) continue;
    const y = +c[iY], m = +c[iM];
    if (!(y >= 1980 && y <= 2100) || !(m >= 1 && m <= 12)) continue;
    years.add(y);
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const pax = +c[iP] || 0;
    const dep = iD >= 0 ? +c[iD] || 0 : null;
    const frt = iF >= 0 ? (+c[iF] || 0) * LB_TO_T : null;
    // both sides of every segment, so the measures match the rest of the
    // catalogue (Eurostat PAS_CRD / CAF_PAS / FRM_LD_NLD conventions):
    //   pax    = enplaned at ORIGIN + deplaned at DEST  (total passengers)
    //   atm    = departures at ORIGIN + arrivals at DEST (total movements)
    //   cargo  = tonnes loaded at ORIGIN + unloaded at DEST (handled freight)
    // Origin-only sums are ENPLANEMENTS — half an airport's published total.
    for (const [code, hit] of [[o, oIn], [d, dIn]]) {
      if (!hit) continue;
      const a = acc[code] || (acc[code] = { pax: {}, atm: {}, cargo: {} });
      a.pax[ym] = (a.pax[ym] || 0) + pax;
      if (dep != null) a.atm[ym] = (a.atm[ym] || 0) + dep;
      if (frt != null) a.cargo[ym] = (a.cargo[ym] || 0) + frt;
    }
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

/* The deterministic TranStats route, post-redesign edition.

   Run 29065871267 proved the classic endpoint is DEAD: DownLoad_Table.asp
   returns the generic ASP crash page ("An error occurred on the server
   when processing the URL") on both hosts regardless of headers or form
   body. The modern site serves downloads from DL_SelectFields.aspx — an
   ASP.NET WebForms page — and the working exchange is: GET the table's
   download page, harvest its hidden form state (__VIEWSTATE /
   __EVENTVALIDATION / friends) plus cookies, then POST the OLD-style
   query fields (RawDataTable, sqlstr, varlist, …) together with that
   hidden state back to the same .aspx URL. Response is a zip with one
   CSV.

   The download page's URL carries obfuscated query params, so it is not
   hardcoded: the Form 41 Traffic database index (Tables.asp?DB_ID=111)
   lists every T-100 table with human-readable anchor text, and the
   "T-100 Segment (All Carriers)" href is taken from there. Every step
   logs what it saw, so an upstream change costs one readable run. */
const TT_UA = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "*/*",
};
const DT_HOSTS = ["https://www.transtats.bts.gov", "https://transtats.bts.gov"];

/* tiny cookie jar — WebForms wants the ASP.NET session cookie back */
function takeCookies(r, jar) {
  const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of set) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
  return jar;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

/* hidden <input> fields (VIEWSTATE and friends) — exported for tests */
export function parseHiddenInputs(html) {
  const out = {};
  const re = /<input[^>]*type=["']?hidden["']?[^>]*>/gi;
  for (const tag of String(html).match(re) || []) {
    const name = /name=["']?([^"'\s>]+)/i.exec(tag)?.[1];
    const value = /value=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    if (name) out[name] = value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  }
  return out;
}

/* the T-100 Segment (All Carriers) download-page href from the database
   index — anchor text is readable even though hrefs are obfuscated.
   Run 29066103806 matched nothing because anchors nest markup inside;
   the inner HTML is captured lazily and stripped of tags before testing. */
export function findSegmentAllCarriersHref(html) {
  const anchors = [...String(html).matchAll(/<a\s[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]{0,400}?)<\/a>/gi)]
    .map(([, href, inner]) => [href, inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()]);
  const t100 = anchors.filter(([, text]) => /T-?\s?100/i.test(text));
  const hit = t100.find(([, text]) => /Segment/i.test(text) && /All\s*Carriers/i.test(text) && !/U\.?S\.?\s*Carriers/i.test(text));
  return { href: hit ? hit[0].replace(/&amp;/g, "&") : null, seen: t100.map(([href, text]) => `${text} -> ${href.slice(0, 80)}`) };
}

/* deterministic fallback if index discovery fails: TranStats obfuscates
   query params with ROT13 for letters and chr(68+d) for digits, so
   Table_ID 293 encodes as "FMG" and "Air Carriers" as "Nv4 Pn44vr45"
   (r→4, s→5 ride along in the letter map). Verified against circulating
   TranStats deep links. */
const DL_PAGE_FALLBACK = "/DL_SelectFields.aspx?gnoyr_VQ=FMG&QO_fu146_anzr=Nv4%20Pn44vr45";

function dlQueryFields(y) {
  const sql = `SELECT YEAR,MONTH,ORIGIN,DEST,PASSENGERS,FREIGHT,DEPARTURES_PERFORMED FROM T_T100_SEGMENT_ALL_CARRIER WHERE YEAR=${y}`;
  return {
    UserTableName: "T_100_Segment_All_Carrier",
    DBShortName: "Air_Carriers",
    RawDataTable: "T_T100_SEGMENT_ALL_CARRIER",
    sqlstr: " " + sql,
    varlist: "YEAR,MONTH,ORIGIN,DEST,PASSENGERS,FREIGHT,DEPARTURES_PERFORMED",
    grouplist: "", suml: "", sumRegion: "", filter1: "title=", filter2: "title=",
    geo: "All ", time: "All Months", timename: "Month",
    GEOGRAPHY: "All", XYEAR: String(y), FREQUENCY: "All",
  };
}

/* named form controls + download-related JS from the download page —
   run 29066216819 got the page but every POST just re-rendered it, so
   the exact control names / postback contract must be read off the page
   itself. Exported for tests. */
export function formIntel(html) {
  const s = String(html);
  const controls = [...s.matchAll(/<(input|select|button)\b[^>]*>/gi)]
    .map(([tag]) => {
      const type = /type=["']?(\w+)/i.exec(tag)?.[1]?.toLowerCase() || "";
      const name = /name=["']?([^"'\s>]+)/i.exec(tag)?.[1] || /id=["']?([^"'\s>]+)/i.exec(tag)?.[1] || "";
      const value = /value=["']([^"']{0,40})/i.exec(tag)?.[1] || "";
      const onclick = /onclick=["']([^"']{0,80})/i.exec(tag)?.[1] || "";
      return { type: type || tag[1], name, value, onclick };
    })
    .filter((c) => c.name && !c.name.startsWith("__"));
  const postbacks = [...new Set([...s.matchAll(/__doPostBack\('([^']+)'/g)].map((m) => m[1]))];
  const downloadish = controls.filter((c) => /download|dl_|btn/i.test(c.name + c.onclick + c.value));
  const jsLines = [...new Set((s.match(/[^\n{;]{0,90}(?:[Dd]ownload_?Table|\.asp\b|submit\(\))[^\n};]{0,90}/g) || []).map((l) => l.replace(/\s+/g, " ").trim()))];
  // each <select>'s option values — cboYear/cboPeriod/cboGeography drive the
  // extract window and EVENTVALIDATION rejects values it never registered
  const selects = {};
  for (const m of s.matchAll(/<select\b[^>]*name=["']?([^"'\s>]+)[^>]*>([\s\S]*?)<\/select>/gi)) {
    // a value-less <option> submits its text — capture whichever exists
    selects[m[1]] = [...m[2].matchAll(/<option\b([^>]*)>([^<]*)/gi)]
      .map((o) => /value=["']?([^"'>]*)/i.exec(o[1])?.[1] ?? o[2].trim());
  }
  return { controls, postbacks, downloadish, jsLines, selects };
}

async function fetchViaDlSelectFields() {
  console.log("  [bts] trying TranStats DL_SelectFields.aspx (WebForms download, per-year extracts)");
  for (const host of DT_HOSTS) {
    try {
      const jar = {};
      // 1) locate the download page from the database index; if the index
      // yields nothing (run 29066103806: 0 anchors matched), fall back to
      // the decoded deep link — FMG == Table_ID 293, see DL_PAGE_FALLBACK
      let href = null;
      try {
        const ir = await fetch(`${host}/Tables.asp?DB_ID=111`, { headers: TT_UA });
        takeCookies(ir, jar);
        if (!ir.ok) console.warn(`  [bts]   ${host.replace("https://", "")} Tables.asp?DB_ID=111: HTTP ${ir.status}`);
        else {
          const ihtml = await ir.text();
          const found = findSegmentAllCarriersHref(ihtml);
          href = found.href;
          const ititle = /<title>([^<]*)<\/title>/i.exec(ihtml)?.[1]?.trim() || "?";
          console.log(`  [bts]   index "${ititle}" (${(ihtml.length / 1e3).toFixed(0)}kB) lists ${found.seen.length} T-100 links${href ? "" : `: ${found.seen.slice(0, 12).join(" | ") || "none"}`}`);
        }
      } catch (e) { console.warn(`  [bts]   index fetch failed: ${e.message}`); }
      if (!href) { href = DL_PAGE_FALLBACK; console.log("  [bts]   falling back to the decoded deep link (Table_ID 293)"); }
      const pageUrl = new URL(href, host + "/").toString();
      console.log(`  [bts]   download page: ${pageUrl}`);

      // 2) GET the page — hidden WebForms state + session cookie — and read
      // the form contract off it
      const pr = await fetch(pageUrl, { headers: { ...TT_UA, Cookie: cookieHeader(jar) } });
      takeCookies(pr, jar);
      if (!pr.ok) { console.warn(`  [bts]   download page: HTTP ${pr.status}`); continue; }
      const pageHtml = await pr.text();
      const hidden = parseHiddenInputs(pageHtml);
      const title = /<title>([^<]*)<\/title>/i.exec(pageHtml)?.[1]?.trim() || "?";
      console.log(`  [bts]   page "${title}" — ${Object.keys(hidden).length} hidden fields (${Object.keys(hidden).filter((k) => k.startsWith("__")).join(", ") || "no __ fields"})`);
      const intel = formIntel(pageHtml);
      console.log(`  [bts]   controls (${intel.controls.length}): ${intel.controls.slice(0, 60).map((c) => `${c.type}:${c.name}`).join(", ")}`);
      if (intel.postbacks.length) console.log(`  [bts]   __doPostBack targets: ${intel.postbacks.slice(0, 12).join(", ")}`);
      for (const sel of ["cboGeography", "cboYear", "cboPeriod"]) {
        const opts = intel.selects[sel];
        if (opts) console.log(`  [bts]   ${sel} options (${opts.length}): ${opts.slice(0, 18).join(", ")}${opts.length > 18 ? ", …" : ""}`);
      }

      // 3) the form takes REAL controls (run 29066354287): per-column
      // checkboxes named exactly like the fields, cboGeography/cboYear/
      // cboPeriod selects, chkDownloadZip, and the btnDownload submit —
      // the legacy sqlstr/varlist fields are ignored, which is why earlier
      // posts just re-rendered the page. Option values come off the page
      // so EVENTVALIDATION sees only values it registered.
      const geoVal = intel.selects.cboGeography?.find((v) => /all/i.test(v)) ?? "All";
      const periodVal = intel.selects.cboPeriod?.find((v) => /all/i.test(v)) ?? "All Months";
      const yearOk = (y) => !intel.selects.cboYear || intel.selects.cboYear.includes(String(y));
      const formFields = (y) => ({
        ...hidden,
        cboGeography: geoVal, cboYear: String(y), cboPeriod: periodVal,
        chkDownloadZip: "on",
        YEAR: "on", MONTH: "on", ORIGIN: "on", DEST: "on", PASSENGERS: "on", FREIGHT: "on", DEPARTURES_PERFORMED: "on",
        btnDownload: "Download",
      });
      const strategies = [
        { tag: "form", fields: formFields },
        // belt-and-suspenders: same controls plus the legacy fields, in
        // case the server still reads sqlstr for the actual query
        { tag: "form+legacy", fields: (y) => ({ ...formFields(y), ...dlQueryFields(y) }) },
      ];
      const post = async (st, y) => {
        const r = await fetch(pageUrl, {
          method: "POST",
          headers: { ...TT_UA, "Content-Type": "application/x-www-form-urlencoded", Referer: pageUrl, Origin: host, Cookie: cookieHeader(jar) },
          body: new URLSearchParams(st.fields(y)).toString(),
        });
        const ct = r.headers.get("content-type") || "?";
        const buf = Buffer.from(await r.arrayBuffer());
        const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
        const asText = isZip ? "" : buf.toString("utf8", 0, 4000);
        const isCsv = !isZip && /^"?(YEAR|DATA_YEAR)"?,/i.test(asText.slice(0, 24));
        if (!r.ok || (!isZip && !isCsv)) {
          const snippet = asText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
          throw new Error(`HTTP ${r.status} (${ct}, ${buf.length}b, zip:${isZip}) body: ${JSON.stringify(snippet)}`);
        }
        return { buf, isZip };
      };

      const usSet = new Set(US);
      const acc = {};
      const thisYear = new Date().getFullYear();
      let winner = null, ok = 0, consecFail = 0;
      for (let y = thisYear; y >= T100_START_YEAR && consecFail < 2; y--) {
        if (!yearOk(y)) { console.log(`  [bts]   ${y}: not offered by cboYear — stopping`); break; }
        let got = null;
        for (const st of winner ? [winner] : strategies) {
          try { got = await post(st, y); winner = st; break; }
          catch (e) { console.warn(`  [bts]   ${y} [${st.tag}]: ${e.message}`); }
        }
        if (!got) { consecFail++; continue; }
        try {
          const { text: csv, name } = got.isZip ? unzipDataCsv(got.buf) : { text: got.buf.toString("utf8"), name: "(bare csv)" };
          const { years } = aggregateT100Csv(csv, usSet, acc);
          ok++; consecFail = 0;
          console.log(`  [bts]   ${y} [${winner.tag}]: ${(got.buf.length / 1e6).toFixed(1)}MB, ${name}, years ${years.join("/") || "?"}`);
        } catch (e) { console.warn(`  [bts]   ${y}: ${e.message}`); consecFail++; }
      }
      if (ok && Object.keys(acc).length) {
        console.log(`  [bts] DL_SelectFields done — ${Object.keys(acc).length} airports over ${ok} year files`);
        return roundAcc(acc);
      }
    } catch (e) { console.warn(`  [bts]   ${host.replace("https://", "")}: ${e.message}`); }
  }
  return null;
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
  const side = async (col) => {
    const url = `https://${domain}/resource/${id}.json?$select=${encodeURIComponent(sel)}` +
      `&$where=${encodeURIComponent(`${col}='${code}'`)}` +
      `&$group=${encodeURIComponent(`${m.year},${m.month}`)}&$limit=5000`;
    return decodeRows(await jget(url));
  };
  // both directions, same convention as the DL_SelectFields route: totals
  // (enplaned+deplaned / dep+arr / loaded+unloaded), not enplanements
  const dep = await side(m.origin);
  if (!m.dest) return dep;
  const arr = await side(m.dest);
  for (const k of ["pax", "atm", "cargo"]) {
    for (const ym of Object.keys(arr[k])) dep[k][ym] = (dep[k][ym] || 0) + arr[k][ym];
  }
  return dep;
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

  const seriesByCode = (await fetchViaSocrata()) || (await fetchViaDlSelectFields()) || (await fetchViaTranstats());
  if (!seriesByCode) {
    console.error("  [bts] no monthly T-100 source produced data (Socrata + DL_SelectFields + PREZIP all failed) — US airports keep last-good data");
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
      // stamped only on a LIVE refresh (kept-last-good entries retain their
      // previous stamp, carried forward untouched by fetch-activity.mjs) — this
      // is the per-source freshness signal check-snapshots.mjs watches, since
      // BTS's series files aren't covered by the index-level generatedAt check.
      refreshedAt: new Date().toISOString(),
    };
    await writeFile(resolve(SERIES_DIR, `${code}.json`), JSON.stringify({ series }) + "\n", "utf8");
    // annual total in the log on purpose: total passengers (arr+dep) vs
    // enplanements is a factor-of-2 error that months-counts can't catch
    const ap = airports[code].annualPax;
    console.log(`  ${code}  bts  pax ${pk.length}mo (latest ${pk[pk.length - 1]}${ap ? `, last full year ${(ap / 1e6).toFixed(1)}M total` : ""}) atm ${Object.keys(series.atm || {}).length} cargo ${Object.keys(series.cargo || {}).length}`);
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

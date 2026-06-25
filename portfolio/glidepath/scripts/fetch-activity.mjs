#!/usr/bin/env node
/* ============================================================
 * fetch-activity.mjs — Glidepath monthly activity snapshot
 *
 * Pulls EVERY airport our public sources expose monthly data for —
 * no hand-curated airport list. Writes the per-metric shape into
 * data/activity.json:
 *   airports[IATA] = { observed, source, rep_airp, country(ISO2),
 *                      cc(ISO3), countryName, region, name, city,
 *                      icao, lat, lon, months, latest,
 *                      series:{ pax:{"YYYY-MM":n}, atm:{...}, cargo:{...} },
 *                      monthly:<alias of series.pax> }
 *
 *   • Europe → Eurostat avia_paoa (passengers + flights) and avia_gooa
 *              (freight, tonnes), pulled for ALL reporting airports in a
 *              single call per metric, then mapped ICAO→IATA via the
 *              OpenFlights reference (data/airports.json).
 *   • Canada → StatCan WDS 23-10-0312 (screened passengers, monthly) +
 *              23-10-0008 (aircraft movements), resolved by airport name.
 *   • US     → fetch-bts.mjs (separate), merged in.
 *
 * Best-effort + per-metric: a failure keeps the last good series and never
 * injects synthetic data. Airports are kept only when they carry enough
 * real monthly passenger history; the busiest are capped to keep the
 * nightly Prophet build bounded.
 *
 * Run locally:  node scripts/fetch-activity.mjs
 * ============================================================ */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, "..", "data");
const OUT = resolve(DATA, "activity.json");
const REF = resolve(DATA, "airports.json");
const UA = { "User-Agent": "glidepath-data-bot" };

const MIN_MONTHS = 24;   // need a couple of clean seasons to be worth showing
const EU_CAP = 70;       // keep the busiest N European airports (bounds CI)

/* Eurostat geo code → { iso2, iso3, name, region }. Eurostat uses EL for
   Greece and UK for the United Kingdom; everything else matches ISO 3166-1
   alpha-2. Covers the EU/EFTA/candidate countries that report to avia_paoa. */
const GEO = {
  AT:["AT","AUT","Austria"], BE:["BE","BEL","Belgium"], BG:["BG","BGR","Bulgaria"],
  HR:["HR","HRV","Croatia"], CY:["CY","CYP","Cyprus"], CZ:["CZ","CZE","Czechia"],
  DK:["DK","DNK","Denmark"], EE:["EE","EST","Estonia"], FI:["FI","FIN","Finland"],
  FR:["FR","FRA","France"], DE:["DE","DEU","Germany"], EL:["GR","GRC","Greece"],
  HU:["HU","HUN","Hungary"], IE:["IE","IRL","Ireland"], IT:["IT","ITA","Italy"],
  LV:["LV","LVA","Latvia"], LT:["LT","LTU","Lithuania"], LU:["LU","LUX","Luxembourg"],
  MT:["MT","MLT","Malta"], NL:["NL","NLD","Netherlands"], PL:["PL","POL","Poland"],
  PT:["PT","PRT","Portugal"], RO:["RO","ROU","Romania"], SK:["SK","SVK","Slovakia"],
  SI:["SI","SVN","Slovenia"], ES:["ES","ESP","Spain"], SE:["SE","SWE","Sweden"],
  NO:["NO","NOR","Norway"], CH:["CH","CHE","Switzerland"], IS:["IS","ISL","Iceland"],
  LI:["LI","LIE","Liechtenstein"], UK:["GB","GBR","United Kingdom"],
  TR:["TR","TUR","Türkiye"], ME:["ME","MNE","Montenegro"], MK:["MK","MKD","North Macedonia"],
  RS:["RS","SRB","Serbia"], BA:["BA","BIH","Bosnia and Herzegovina"], XK:["XK","XKX","Kosovo"],
  AL:["AL","ALB","Albania"], MD:["MD","MDA","Moldova"], UA:["UA","UKR","Ukraine"],
};

function normMonth(s) { return String(s).replace("M", "-").slice(0, 7); }

/* ============================================================
   EUROSTAT — JSON-stat, ALL airports in one call per metric.
   Omitting rep_airp returns every reporting airport; we decode
   the flattened value array via the (rep_airp, time) dimensions.
   ============================================================ */
async function eurostatAll(dataset, unit, traMeas) {
  const base = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";
  const url = `${base}/${dataset}?format=JSON&lang=EN&freq=M&unit=${unit}&tra_meas=${traMeas}&sinceTimePeriod=2015-01`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) {
    let body = ""; try { body = (await res.text()).slice(0, 200); } catch {}
    throw new Error(`${dataset} HTTP ${res.status} ${body}`);
  }
  const js = await res.json();
  const ids = js.id, size = js.size, value = js.value;
  if (!ids || !size || !value) throw new Error(`${dataset}: malformed JSON-stat`);

  // row-major strides for the flattened value array
  const stride = new Array(ids.length); let s = 1;
  for (let i = ids.length - 1; i >= 0; i--) { stride[i] = s; s *= size[i]; }
  const di = (name) => ids.indexOf(name);
  const repDim = di("rep_airp"), timeDim = di("time");
  if (repDim < 0 || timeDim < 0) throw new Error(`${dataset}: missing rep_airp/time dim`);

  const repIdx = js.dimension.rep_airp.category.index;        // "AT_LOWW" -> pos
  const timeEntries = Object.entries(js.dimension.time.category.index)
    .sort((a, b) => a[1] - b[1]);                             // [code,pos] sorted

  const getVal = (flat) => (Array.isArray(value) ? value[flat] : (value[flat] ?? value[String(flat)]));

  // by ICAO (rep_airp = "<geo>_<ICAO>")
  const out = {};   // icao -> { geo, monthly:{ "YYYY-MM": n } }
  for (const [code, rpos] of Object.entries(repIdx)) {
    const us = code.indexOf("_");
    if (us < 0) continue;
    const geo = code.slice(0, us), icao = code.slice(us + 1);
    if (icao.length !== 4) continue;
    const monthly = {};
    for (const [tcode, tpos] of timeEntries) {
      const flat = rpos * stride[repDim] + tpos * stride[timeDim];
      const v = getVal(flat);
      if (v != null) monthly[normMonth(tcode)] = Math.round(v);
    }
    if (Object.keys(monthly).length) out[icao] = { geo, monthly };
  }
  return out;
}

/* ============================================================
   STATISTICS CANADA — WDS REST. Resolve each airport member by
   name, pick the right characteristic per metric, build the full
   memberId coordinate. 23-10-0312 = screened passengers (monthly),
   23-10-0008 = aircraft movements (monthly).
   ============================================================ */
const STATCAN_PID = { pax: 23100312, atm: 23100008 };
// the screened-passenger cube covers Canada's eight CATSA Class-1 airports
const STATCAN = [
  ["YYZ", /pearson|toronto/i],   ["YVR", /vancouver/i],     ["YUL", /trudeau|montr/i],
  ["YYC", /calgary/i],           ["YEG", /edmonton/i],      ["YOW", /ottawa/i],
  ["YWG", /winnipeg/i],          ["YHZ", /halifax/i],
];
const STATCAN_CHAR = {
  pax: /screened|passenger|total/i,
  atm: /total itinerant|itinerant.*total|total movements|total/i,
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
  const dims = (obj.dimension || []).map((d) => ({
    name: d.dimensionNameEn || "",
    members: (d.member || []).map((m) => ({ id: m.memberId, name: m.memberNameEn || "" })),
  }));
  return (_meta[pid] = dims);
}
async function statcanCoord(pid, re, metric) {
  const dims = await statcanMeta(pid);
  let geoDim = -1, geoMember = null;
  dims.forEach((d, i) => { const hit = d.members.find((m) => re.test(m.name)); if (hit) { geoDim = i; geoMember = hit; } });
  if (!geoMember) throw new Error(`no airport member for ${re} in ${pid}`);
  const charRe = STATCAN_CHAR[metric];
  const parts = dims.map((d, i) => {
    if (i === geoDim) return geoMember.id;
    const pref = d.members.find((m) => charRe.test(m.name));
    return (pref || d.members[0]).id;
  });
  while (parts.length < 10) parts.push(0);
  return parts.join(".");
}
async function statcanSeries(pid, coord) {
  const res = await fetch("https://www150.statcan.gc.ca/t1/wds/rest/getDataFromCubePidCoordAndLatestNPeriods", {
    method: "POST", headers: { "Content-Type": "application/json", ...UA },
    body: JSON.stringify([{ productId: pid, coordinate: coord, latestN: 144 }]),
  });
  if (!res.ok) throw new Error(`data ${pid} HTTP ${res.status}`);
  const js = await res.json();
  const pts = js?.[0]?.object?.vectorDataPoint;
  if (!pts) throw new Error(`data ${pid}: ${js?.[0]?.status || "no points"}`);
  const monthly = {};
  for (const p of pts) if (p.value != null) monthly[normMonth(p.refPer)] = Math.round(p.value);
  return monthly;
}

/* ============================================================ */
async function loadJSON(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
function prevSeries(prev, iata, metric) {
  const a = prev?.airports?.[iata]; if (!a) return null;
  if (a.series?.[metric] && Object.keys(a.series[metric]).length) return a.series[metric];
  if (metric === "pax" && a.monthly && Object.keys(a.monthly).length) return a.monthly;
  return null;
}
const recent12 = (m) => Object.keys(m).sort().slice(-12).reduce((t, k) => t + (m[k] || 0), 0);

async function main() {
  const prev = await loadJSON(OUT);
  const refDoc = await loadJSON(REF);
  const ref = refDoc?.airports || {};
  const icaoToIata = {};
  for (const [iata, r] of Object.entries(ref)) if (r.icao) icaoToIata[r.icao] = iata;
  console.log(`Loaded ${Object.keys(ref).length} reference airports.`);

  const airports = {};
  let live = 0;

  /* ---------- Europe: all airports, one call per metric ---------- */
  const euData = {};   // metric -> { icao -> { geo, monthly } }
  for (const [metric, ds, unit, tm] of [
    ["pax", "avia_paoa", "PAS", "PAS_CRD"],
    ["atm", "avia_paoa", "FLIGHT", "CAF_PAS"],
    ["cargo", "avia_gooa", "T", "FRM_LD_NLD"],
  ]) {
    try { euData[metric] = await eurostatAll(ds, unit, tm); console.log(`  eurostat ${metric}: ${Object.keys(euData[metric]).length} airports`); }
    catch (e) { euData[metric] = {}; console.warn(`  eurostat ${metric} FAILED: ${e.message}`); }
  }

  // candidate ICAOs = anything with a passenger series we can map to IATA
  const euCandidates = [];
  for (const [icao, rec] of Object.entries(euData.pax)) {
    const iata = icaoToIata[icao];
    if (!iata) continue;
    if (Object.keys(rec.monthly).length < MIN_MONTHS) continue;
    euCandidates.push({ iata, icao, geo: rec.geo, vol: recent12(rec.monthly) });
  }
  euCandidates.sort((a, b) => b.vol - a.vol);
  const keep = euCandidates.slice(0, EU_CAP);
  console.log(`  eurostat: ${euCandidates.length} mappable airports, keeping busiest ${keep.length}`);

  for (const { iata, icao, geo } of keep) {
    const g = GEO[geo];
    if (!g) { console.warn(`  ${iata}: unknown Eurostat geo "${geo}" — skipped`); continue; }
    const [iso2, iso3, cname] = g;
    const series = {};
    for (const metric of ["pax", "atm", "cargo"]) {
      const m = euData[metric]?.[icao]?.monthly;
      if (m && Object.keys(m).length >= 12) { series[metric] = m; live++; }
      else { const kept = prevSeries(prev, iata, metric); if (kept) series[metric] = kept; }
    }
    if (!series.pax) continue;
    const r = ref[iata] || {};
    const paxKeys = Object.keys(series.pax);
    airports[iata] = {
      observed: true, source: "eurostat", rep_airp: `${geo}_${icao}`,
      country: iso2, cc: iso3, countryName: cname, region: "Europe",
      name: r.name || iata, city: r.city || cname, icao, lat: r.lat ?? null, lon: r.lon ?? null,
      months: paxKeys.length, latest: paxKeys.sort().pop(), series, monthly: series.pax,
    };
  }
  console.log(`  eurostat: wrote ${Object.keys(airports).length} airports`);

  /* ---------- Canada: StatCan screened airports ---------- */
  let caN = 0;
  for (const [iata, re] of STATCAN) {
    const series = {};
    for (const metric of ["pax", "atm"]) {
      try {
        const m = await statcanSeries(STATCAN_PID[metric], await statcanCoord(STATCAN_PID[metric], re, metric));
        if (Object.keys(m).length >= 12) { series[metric] = m; live++; }
        else throw new Error(`only ${Object.keys(m).length}mo`);
      } catch (e) {
        const kept = prevSeries(prev, iata, metric);
        if (kept) series[metric] = kept;
        console.warn(`  ${iata}/${metric} statcan failed (${e.message})${kept ? " — kept previous" : ""}`);
      }
    }
    if (!series.pax || Object.keys(series.pax).length < MIN_MONTHS) { console.warn(`  ${iata} statcan: insufficient pax — skipped`); continue; }
    const r = ref[iata] || {};
    const paxKeys = Object.keys(series.pax);
    airports[iata] = {
      observed: true, source: "statcan", rep_airp: r.icao || iata,
      country: "CA", cc: "CAN", countryName: "Canada", region: "North America",
      name: r.name || iata, city: r.city || "Canada", icao: r.icao || null, lat: r.lat ?? null, lon: r.lon ?? null,
      months: paxKeys.length, latest: paxKeys.sort().pop(), series, monthly: series.pax,
    };
    caN++;
    console.log(`  ${iata} statcan: pax ${paxKeys.length}mo atm ${Object.keys(series.atm || {}).length}mo`);
  }
  console.log(`  statcan: wrote ${caN} airports`);

  /* ---------- carry over US/BTS airports owned by fetch-bts.mjs ---------- */
  if (prev?.airports) for (const k of Object.keys(prev.airports)) {
    if (!airports[k] && prev.airports[k]?.source === "bts") airports[k] = prev.airports[k];
  }

  const out = {
    generatedAt: new Date().toISOString(),
    note: "Monthly activity (passengers / movements / cargo) by airport. Refreshed nightly; read same-origin by the browser. No synthetic data.",
    sources: {
      eurostat: "Eurostat avia_paoa (PAS_CRD pax, CAF_PAS flights) + avia_gooa (FRM_LD_NLD cargo, tonnes) — all reporting airports",
      statcan: "Statistics Canada WDS 23-10-0312 (screened pax), 23-10-0008 (movements)",
      bts: "US DOT BTS T-100 (fetch-bts.mjs)",
    },
    airports,
  };
  await mkdir(DATA, { recursive: true });
  await writeFile(OUT, JSON.stringify(out) + "\n", "utf8");

  /* trim airports.json to just the catalogue, so the browser load stays small */
  if (refDoc) {
    const trimmed = {};
    for (const iata of Object.keys(airports)) if (ref[iata]) trimmed[iata] = ref[iata];
    refDoc.airports = trimmed; refDoc.count = Object.keys(trimmed).length;
    refDoc.note = "Airport reference trimmed to the airports that carry data (full set is rebuilt nightly by fetch-openflights.mjs).";
    await writeFile(REF, JSON.stringify(refDoc) + "\n", "utf8");
  }

  console.log(`Wrote ${OUT} — ${Object.keys(airports).length} airports, ${live} live metric-series.`);
}

main().catch((err) => { console.error("Activity snapshot failed:", err.message); process.exit(1); });

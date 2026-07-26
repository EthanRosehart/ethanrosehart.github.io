#!/usr/bin/env node
/* ============================================================
 * fetch-activity.mjs — Glidepath monthly activity snapshot
 *
 * Pulls EVERY airport our public sources expose monthly data for — no
 * hand-curated airport list. Writes a SPLIT layout so the browser never
 * has to download every airport's numbers just to show the picker:
 *
 *   data/activity-index.json          — catalogue metadata, no series:
 *     airports[IATA] = { observed, source, rep_airp, country(ISO2),
 *                        cc(ISO3), countryName, region, name, city,
 *                        icao, lat, lon, months, latest,
 *                        metrics:["pax","atm","cargo"], hasPaxSeg,
 *                        annualPax (last full calendar year, for the
 *                        picker's "68.0M/yr" summary) }
 *   data/series/<IATA>.json           — one file per airport, fetched by
 *     the browser only once that gateway is selected:
 *       { series:{ pax:{"YYYY-MM":n}, atm:{...}, cargo:{...} }, paxSeg? }
 *
 *   • Europe → Eurostat avia_paoa (passengers + flights) and avia_gooa
 *              (freight, tonnes), pulled for ALL reporting airports in a
 *              single call per metric, then mapped ICAO→IATA via the
 *              OpenFlights reference (data/airports.json).
 *   • Canada → StatCan WDS 23-10-0312 (screened passengers, monthly) +
 *              23-10-0296 (aircraft movements; retired 23-10-0008 as
 *              fallback), resolved by airport name.
 *   • US     → fetch-bts.mjs (separate, runs BEFORE this script so it
 *              still sees the untrimmed reference), maintains its own
 *              entries in the same index + series directory; this script
 *              only touches the airports it computes (eurostat ∪ statcan)
 *              and carries BTS-sourced entries forward untouched.
 *
 * Best-effort + per-metric: a failure keeps the last good series (read
 * back from the previous data/series/<IATA>.json) and never injects
 * synthetic data. Airports are kept only when they carry enough real
 * monthly passenger history — every airport the feeds cover, with no cap
 * and no volume ranking, and once in the catalogue an airport stays until
 * its history goes genuinely stale (see STICKY_MAX_AGE_MONTHS).
 *
 * Run locally:  node scripts/fetch-activity.mjs
 * ============================================================ */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lastFullYearTotal, metricsIn, pruneDir, fetchWithRetry, chooseSeries, seriesAgeMonths } from "./_util.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, "..", "data");
const OUT = resolve(DATA, "activity-index.json");
const SERIES_DIR = resolve(DATA, "series");
const REF = resolve(DATA, "airports.json");
const UA = { "User-Agent": "glidepath-data-bot" };

const MIN_MONTHS = 24;   // need a couple of clean seasons to be worth showing
/* Once an airport is in the catalogue we keep carrying it on its committed
   history even on nights the feed doesn't mention it — see the sticky block
   in main(). This is the release valve: a feed that has published nothing
   new for this long is genuinely discontinued, not briefly down, and the
   airport is allowed to drop rather than sit on the site frozen forever. */
const STICKY_MAX_AGE_MONTHS = 18;

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

export function normMonth(s) { return String(s).replace("M", "-").slice(0, 7); }

/* ============================================================
   EUROSTAT — JSON-stat. A single all-airports pull is rejected
   with HTTP 413 (ASYNCHRONOUS_RESPONSE), so we (1) enumerate which
   airports report at all with a small "lastTimePeriod" call, then
   (2) pull full series for every one of them in batches of rep_airp
   codes, splitting any batch that still trips the 413 size guard.
   ============================================================ */
const ES_BASE = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";

function esUrl(dataset, q, reps) {
  const usp = new URLSearchParams({ format: "JSON", lang: "EN", freq: "M", ...q });
  let url = `${ES_BASE}/${dataset}?${usp.toString()}`;
  for (const r of reps || []) url += `&rep_airp=${encodeURIComponent(r)}`;
  return url;
}

// decode a JSON-stat payload to { icao: { geo, monthly:{ "YYYY-MM": n } } }
// (exported for test/pipeline.test.mjs, which feeds it a recorded fixture)
export function esDecode(js, dataset) {
  const ids = js.id, size = js.size, value = js.value;
  if (!ids || !size || !value) throw new Error(`${dataset}: malformed JSON-stat`);
  const stride = new Array(ids.length); let s = 1;
  for (let i = ids.length - 1; i >= 0; i--) { stride[i] = s; s *= size[i]; }
  const di = (n) => ids.indexOf(n);
  const repDim = di("rep_airp"), timeDim = di("time");
  if (repDim < 0 || timeDim < 0) throw new Error(`${dataset}: missing rep_airp/time dim`);
  const repIdx = js.dimension.rep_airp.category.index;
  const timeEntries = Object.entries(js.dimension.time.category.index).sort((a, b) => a[1] - b[1]);
  const getVal = (f) => (Array.isArray(value) ? value[f] : (value[f] ?? value[String(f)]));
  const out = {};
  for (const [code, rpos] of Object.entries(repIdx)) {
    const us = code.indexOf("_");
    if (us < 0) continue;
    const geo = code.slice(0, us), icao = code.slice(us + 1);
    if (icao.length !== 4) continue;
    const monthly = {};
    for (const [tcode, tpos] of timeEntries) {
      const v = getVal(rpos * stride[repDim] + tpos * stride[timeDim]);
      if (v != null) monthly[normMonth(tcode)] = Math.round(v);
    }
    if (Object.keys(monthly).length) out[icao] = { geo, monthly };
  }
  return out;
}

async function esGet(dataset, q, reps) {
  // retries network blips + 5xx; 413 comes back untouched because it's a
  // signal (ask for a smaller window), not a failure — see esEnumerate/esBatch
  const res = await fetchWithRetry(esUrl(dataset, q, reps), `eurostat ${dataset}`, { headers: UA });
  if (!res.ok) {
    let body = ""; try { body = (await res.text()).slice(0, 160); } catch {}
    const e = new Error(`${dataset} HTTP ${res.status} ${body}`); e.code = res.status; throw e;
  }
  return esDecode(await res.json(), dataset);
}

// enumerate all reporting airports + a recent-volume proxy; shrink the
// time window until Eurostat answers synchronously
async function esEnumerate() {
  for (const lastN of [12, 6, 3, 1]) {
    try { return await esGet("avia_paoa", { unit: "PAS", tra_meas: "PAS_CRD", lastTimePeriod: String(lastN) }); }
    catch (e) { if (e.code === 413) { console.warn(`  enumerate lastTimePeriod=${lastN} -> 413, shrinking`); continue; } throw e; }
  }
  return {};
}

// full series for a set of rep_airp codes, batched + 413-split
async function esBatch(dataset, q, reps) {
  const out = {};
  async function go(list) {
    if (!list.length) return;
    try { Object.assign(out, await esGet(dataset, q, list)); }
    catch (e) {
      if (e.code === 413 && list.length > 1) {
        const mid = list.length >> 1; await go(list.slice(0, mid)); await go(list.slice(mid));
      } else if (e.code === 413) {
        console.warn(`    ${dataset} ${list[0]}: 413 even single — skipped`);
      } else throw e;
    }
  }
  const CHUNK = 25;
  for (let i = 0; i < reps.length; i += CHUNK) await go(reps.slice(i, i + CHUNK));
  return out;
}

/* ============================================================
   STATISTICS CANADA — WDS REST. Resolve each airport member by
   name, pick the right characteristic per metric, build the full
   memberId coordinate. 23-10-0312 = screened passengers (monthly).

   Movements: 23-10-0296 ("Aircraft movements, by class of operation,
   airports with NAV CANADA services and other selected airports,
   monthly") is the live cube — StatCan stopped updating the older
   23-10-0008 after 2022-09 (program reorg), which is why movements
   used to flat-line two years behind passengers. We try the current
   cube first and keep the retired one as a fallback so a structural
   change at StatCan degrades to the last good series, never to a gap.
   ============================================================ */
const STATCAN_PID = { pax: 23100312, atm: 23100296 };
// movements cubes in priority order (current first, retired fallback)
const STATCAN_ATM_PIDS = [23100296, 23100008];
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
// passenger sectors published by the screened-pax cube (23-10-0312): used to
// populate the per-segment composition that drives the shape builder
const STATCAN_SEG = {
  domestic:      /^domestic$|domestic sector|domestic/i,
  transborder:   /transborder/i,
  international: /^international$|other international|international sector/i,
};
const _meta = {};
async function statcanMeta(pid) {
  if (_meta[pid]) return _meta[pid];
  const res = await fetchWithRetry("https://www150.statcan.gc.ca/t1/wds/rest/getCubeMetadata", `statcan meta ${pid}`, {
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
async function statcanCoord(pid, re, metric, charOverride) {
  const dims = await statcanMeta(pid);
  let geoDim = -1, geoMember = null;
  // The movements cube (23-10-0296) lists many airports, so a city-name match
  // can be ambiguous (e.g. "Calgary International" vs "Calgary/Springbank",
  // "Toronto/Pearson" vs "Billy Bishop Toronto City"). When several members
  // match, prefer the International/CATSA gateway we actually want. The pax
  // cube only carries the eight CATSA airports, so this never changes it.
  dims.forEach((d, i) => {
    const hits = d.members.filter((m) => re.test(m.name));
    if (hits.length) { geoDim = i; geoMember = hits.find((m) => /international/i.test(m.name)) || hits[0]; }
  });
  if (!geoMember) throw new Error(`no airport member for ${re} in ${pid}`);
  const charRe = charOverride || STATCAN_CHAR[metric];
  const parts = dims.map((d, i) => {
    if (i === geoDim) return geoMember.id;
    const pref = d.members.find((m) => charRe.test(m.name));
    return (pref || d.members[0]).id;
  });
  while (parts.length < 10) parts.push(0);
  return parts.join(".");
}
async function statcanSeries(pid, coord) {
  const res = await fetchWithRetry("https://www150.statcan.gc.ca/t1/wds/rest/getDataFromCubePidCoordAndLatestNPeriods", `statcan data ${pid}`, {
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

/* previous per-airport series, read from data/series/<IATA>.json (not the
   index, which no longer carries series) — cached per-iata since a couple
   of metrics may ask for the same airport's file */
const _prevSeriesCache = new Map();
async function prevAirportSeries(iata) {
  if (_prevSeriesCache.has(iata)) return _prevSeriesCache.get(iata);
  const doc = await loadJSON(resolve(SERIES_DIR, `${iata}.json`));
  const val = doc?.series || null;
  _prevSeriesCache.set(iata, val);
  return val;
}
async function prevSeries(iata, metric) {
  const s = await prevAirportSeries(iata);
  return (s && s[metric] && Object.keys(s[metric]).length) ? s[metric] : null;
}
/* last-good passenger-segment split — a failed seg sub-fetch must not
   silently strip paxSeg from an airport whose headline series was kept */
async function prevPaxSeg(iata) {
  const doc = await loadJSON(resolve(SERIES_DIR, `${iata}.json`));
  const seg = doc?.paxSeg;
  return (seg && Object.keys(seg).length >= 2) ? seg : null;
}

async function main() {
  const prev = await loadJSON(OUT);
  const refDoc = await loadJSON(REF);
  const ref = refDoc?.airports || {};
  const icaoToIata = {};
  for (const [iata, r] of Object.entries(ref)) if (r.icao) icaoToIata[r.icao] = iata;
  console.log(`Loaded ${Object.keys(ref).length} reference airports.`);

  const airports = {};
  let live = 0, notEligible = 0;
  const liveBy = { eurostat: 0, statcan: 0 };   // fresh series per source — the outage signal
  const runStamp = new Date().toISOString();
  let seeded = 0;
  /* refreshedAt for an airport: now if it actually took new data this run,
     otherwise whatever it was last stamped with.

     The third case matters. An airport that has never been stamped — every
     Eurostat/StatCan entry the first time this runs — would stay unstamped
     forever if the feed happened to be dark that night, and
     sourceStaleness() skips unstamped sources as "no signal yet". Downgrading
     the degraded-feed exit to a note while leaving that hole would recreate
     exactly the silent-failure class this whole guard exists to close. So an
     unstamped airport starts its clock at this run instead. That overstates
     freshness by however long the feed was already dark, which is why it errs
     toward alerting LATER rather than never — and it self-corrects the first
     time the feed actually delivers. */
  const stampFor = (iata, fresh) => {
    if (fresh) return runStamp;
    const prevStamp = prev?.airports?.[iata]?.refreshedAt;
    if (prevStamp) return prevStamp;
    seeded++;
    return runStamp;
  };

  /* ---------- Europe: enumerate + carry forward, then batch-fetch ---------- */
  let enumerated = {};
  try { enumerated = await esEnumerate(); console.log(`  eurostat: enumerated ${Object.keys(enumerated).length} reporting airports`); }
  catch (e) { console.warn(`  eurostat enumerate FAILED: ${e.message}`); }

  /* Every airport Eurostat reports tonight that we can map to an IATA code.
     There is deliberately no cap and no volume ranking here any more. The
     old code kept only the "busiest 70" by summing whatever months the
     enumerate call happened to return — which is not a size measure at all
     when the feed is degraded (2026-07-26: Eurostat returned 3-5 months for
     some countries and none for others, so a mid-size airport with 5 months
     outranked Paris CDG with zero, and CDG fell out of the catalogue). The
     cap only ever existed to bound the nightly Prophet build; that budget is
     cheap and not worth evicting real gateways over. */
  const keepBy = new Map();   // iata -> { iata, icao, geo }
  for (const [icao, rec] of Object.entries(enumerated)) {
    const iata = icaoToIata[icao];
    if (!iata || !GEO[rec.geo] || !Object.keys(rec.monthly).length) continue;
    keepBy.set(iata, { iata, icao, geo: rec.geo });
  }
  const reportingN = keepBy.size;

  /* STICKY MEMBERSHIP. Catalogue membership used to be re-derived from this
     one live call every night while the data itself lived on disk — so a
     feed that answered thinly, or not at all, silently evicted airports
     whose committed history was perfectly intact, and pruneDir() then
     deleted their series files. Anything we already carry with a usable,
     not-yet-ancient history stays a candidate whether or not tonight's
     enumerate mentions it; the per-metric chooseSeries() fallback below
     keeps it on last-good until the feed comes back. */
  let sticky = 0, retired = 0;
  for (const [iata, a] of Object.entries(prev?.airports || {})) {
    if (a?.source !== "eurostat" || keepBy.has(iata)) continue;
    const [geo, icao] = String(a.rep_airp || "").split("_");
    if (!geo || !icao || !GEO[geo]) continue;
    const kept = await prevSeries(iata, "pax");
    if (!kept || Object.keys(kept).length < MIN_MONTHS) continue;
    const age = seriesAgeMonths(kept);
    if (age > STICKY_MAX_AGE_MONTHS) {
      console.warn(`  ${iata} eurostat: no new data for ${age} months (limit ${STICKY_MAX_AGE_MONTHS}) — retiring from the catalogue`);
      retired++;
      continue;
    }
    keepBy.set(iata, { iata, icao, geo });
    sticky++;
  }
  const keep = [...keepBy.values()];
  console.log(`  eurostat: ${reportingN} reporting tonight + ${sticky} carried on committed history${retired ? ` (${retired} retired as stale)` : ""} = ${keep.length} airports, no cap`);

  const repCodes = keep.map((k) => `${k.geo}_${k.icao}`);
  const euData = {};   // metric -> { icao -> { geo, monthly } }
  for (const [metric, ds, unit, tm] of [
    ["pax", "avia_paoa", "PAS", "PAS_CRD"],
    ["atm", "avia_paoa", "FLIGHT", "CAF_PAS"],
    ["cargo", "avia_gooa", "T", "FRM_LD_NLD"],
  ]) {
    if (!repCodes.length) { euData[metric] = {}; continue; }
    try { euData[metric] = await esBatch(ds, { unit, tra_meas: tm, sinceTimePeriod: "2015-01" }, repCodes); console.log(`  eurostat ${metric}: ${Object.keys(euData[metric]).length} airports`); }
    catch (e) { euData[metric] = {}; console.warn(`  eurostat ${metric} FAILED: ${e.message}`); }
  }

  // passenger composition by transport coverage — NAT (domestic) / INTL
  // (international). The plain pax pull above leaves tra_cov at its default
  // (total) coverage; these two add the split that feeds the shape builder.
  const euSeg = {};   // segKey -> { icao -> { geo, monthly } }
  for (const [segKey, cov] of [["domestic", "NAT"], ["international", "INTL"]]) {
    if (!repCodes.length) { euSeg[segKey] = {}; continue; }
    try { euSeg[segKey] = await esBatch("avia_paoa", { unit: "PAS", tra_meas: "PAS_CRD", tra_cov: cov, sinceTimePeriod: "2015-01" }, repCodes); console.log(`  eurostat seg ${segKey}: ${Object.keys(euSeg[segKey]).length} airports`); }
    catch (e) { euSeg[segKey] = {}; console.warn(`  eurostat seg ${segKey} FAILED: ${e.message}`); }
  }

  for (const { iata, icao, geo } of keep) {
    const g = GEO[geo];
    if (!g) { console.warn(`  ${iata}: unknown Eurostat geo "${geo}" — skipped`); continue; }
    const [iso2, iso3, cname] = g;
    const series = {};
    let anyFresh = false;
    for (const metric of ["pax", "atm", "cargo"]) {
      // a thin reply must never overwrite a long committed history — see
      // chooseSeries() in _util.mjs for the night that made this necessary
      const pick = chooseSeries(euData[metric]?.[icao]?.monthly, await prevSeries(iata, metric));
      if (pick.kind === "fresh") { series[metric] = pick.series; live++; liveBy.eurostat++; anyFresh = true; }
      else if (pick.kind === "kept") {
        series[metric] = pick.series;
        if (pick.reason) console.warn(`  ${iata}/${metric} eurostat: ${pick.reason} — kept previous`);
      }
    }
    if (!series.pax || Object.keys(series.pax).length < MIN_MONTHS) {
      const had = !!prev?.airports?.[iata];
      const msg = `only ${Object.keys(series.pax || {}).length}mo of passengers (need ${MIN_MONTHS})`;
      // losing an airport we ALREADY carry is the loud case — it drops off the
      // site and its series file is pruned. An airport we never carried simply
      // isn't eligible yet; uncapping the catalogue made those the common case
      // (207 of them on 2026-07-26), so they must not read like data loss.
      if (had) console.warn(`  ${iata} eurostat: ${msg} — DROPPED from the catalogue`);
      else notEligible++;
      continue;
    }
    let paxSeg = {};
    for (const sk of ["domestic", "international"]) {
      const ms = euSeg[sk]?.[icao]?.monthly;
      if (ms && Object.keys(ms).length >= 12) paxSeg[sk] = ms;
    }
    if (Object.keys(paxSeg).length < 2) {
      const kept = await prevPaxSeg(iata);
      if (kept) { paxSeg = kept; console.warn(`  ${iata} eurostat: seg fetch thin — kept previous paxSeg`); }
    }
    const r = ref[iata] || {};
    const paxKeys = Object.keys(series.pax);
    airports[iata] = {
      observed: true, source: "eurostat", rep_airp: `${geo}_${icao}`,
      country: iso2, cc: iso3, countryName: cname, region: "Europe",
      name: r.name || iata, city: r.city || cname, icao, lat: r.lat ?? null, lon: r.lon ?? null,
      months: paxKeys.length, latest: paxKeys.sort().pop(), series, monthly: series.pax,
      ...(Object.keys(paxSeg).length >= 2 ? { paxSeg } : {}),
      // per-source freshness stamp, same contract as fetch-bts.mjs: set only
      // when this airport actually took new data, otherwise the previous
      // stamp rides along. check-snapshots' sourceStaleness() watches these,
      // which is what turns "Eurostat is answering but with nothing usable"
      // into a time-based escalation instead of a nightly page.
      ...(stampFor(iata, anyFresh) ? { refreshedAt: stampFor(iata, anyFresh) } : {}),
    };
  }
  console.log(`  eurostat: wrote ${Object.keys(airports).length} airports${notEligible ? `, ${notEligible} reporting airports not eligible yet (<${MIN_MONTHS}mo, never carried)` : ""}`);

  /* ---------- Canada: StatCan screened airports ---------- */
  let caN = 0;
  for (const [iata, re] of STATCAN) {
    const series = {};
    let caFresh = false;
    for (const metric of ["pax", "atm"]) {
      // movements fall through current → retired cube; pax has a single cube
      const pids = metric === "atm" ? STATCAN_ATM_PIDS : [STATCAN_PID[metric]];
      let got = null, lastErr = null;
      for (const pid of pids) {
        try {
          const m = await statcanSeries(pid, await statcanCoord(pid, re, metric));
          if (Object.keys(m).length >= 12) { got = m; if (pid !== pids[0]) console.warn(`  ${iata}/${metric} statcan: used fallback cube ${pid}`); break; }
          lastErr = new Error(`only ${Object.keys(m).length}mo`);
        } catch (e) { lastErr = e; }
      }
      // same guard as Eurostat: a short reply keeps the committed history
      const pick = chooseSeries(got, await prevSeries(iata, metric));
      if (pick.kind === "fresh") { series[metric] = pick.series; live++; liveBy.statcan++; caFresh = true; }
      else if (pick.kind === "kept") {
        series[metric] = pick.series;
        // when the cubes never produced anything, lastErr is the real story;
        // otherwise the reply came back but was too thin/short to trust
        console.warn(`  ${iata}/${metric} statcan: ${got ? pick.reason : (lastErr ? lastErr.message : "no data")} — kept previous`);
      } else {
        console.warn(`  ${iata}/${metric} statcan failed (${lastErr ? lastErr.message : "no data"}) — nothing on disk either`);
      }
    }
    if (!series.pax || Object.keys(series.pax).length < MIN_MONTHS) { console.warn(`  ${iata} statcan: insufficient pax — skipped`); continue; }

    // passenger composition by sector (domestic / transborder / international)
    let paxSeg = {};
    for (const [segKey, segRe] of Object.entries(STATCAN_SEG)) {
      try {
        const m = await statcanSeries(STATCAN_PID.pax, await statcanCoord(STATCAN_PID.pax, re, "pax", segRe));
        if (Object.keys(m).length >= 12) paxSeg[segKey] = m;
      } catch { /* sector absent for this airport — skip */ }
    }
    if (Object.keys(paxSeg).length < 2) {
      const kept = await prevPaxSeg(iata);
      if (kept) { paxSeg = kept; console.warn(`  ${iata} statcan: seg fetch thin — kept previous paxSeg`); }
    }

    const r = ref[iata] || {};
    const paxKeys = Object.keys(series.pax);
    airports[iata] = {
      observed: true, source: "statcan", rep_airp: r.icao || iata,
      country: "CA", cc: "CAN", countryName: "Canada", region: "North America",
      name: r.name || iata, city: r.city || "Canada", icao: r.icao || null, lat: r.lat ?? null, lon: r.lon ?? null,
      months: paxKeys.length, latest: paxKeys.sort().pop(), series, monthly: series.pax,
      ...(Object.keys(paxSeg).length >= 2 ? { paxSeg } : {}),
      ...(stampFor(iata, caFresh) ? { refreshedAt: stampFor(iata, caFresh) } : {}),
    };
    caN++;
    console.log(`  ${iata} statcan: pax ${paxKeys.length}mo atm ${Object.keys(series.atm || {}).length}mo seg ${Object.keys(paxSeg).join("/")||"none"}`);
  }
  console.log(`  statcan: wrote ${caN} airports`);

  /* ---------- split into index metadata + per-airport series files ----------
     This script owns the eurostat ∪ statcan airports; BTS-sourced entries
     (maintained independently by fetch-bts.mjs, which runs BEFORE this
     script in the workflow) are carried over from the index it wrote,
     untouched — so tonight's fresh US data survives this rewrite. */
  const btsCarry = {};
  if (prev?.airports) for (const [k, v] of Object.entries(prev.airports)) {
    if (v?.source === "bts") btsCarry[k] = v;
  }

  /* OUTAGE guard, keyed on FRESH data rather than on entries existing.
     Sticky membership means a dead feed no longer empties the catalogue —
     which is the whole point, but it also means "the index still has
     eurostat airports" has stopped being evidence that Eurostat answered.
     So the alert now fires when a source we carry delivered no live series
     at all tonight, however healthy the committed snapshot looks. Without
     this, going sticky would have quietly bought data safety at the cost of
     never hearing about an outage again.

     The carry-forward below is the last-resort net for a source that
     produced no ENTRIES either (e.g. the whole block threw): writing the
     index without them would let pruneDir() delete their series files. */
  let outage = false;
  const sourceCarry = {};
  for (const src of ["eurostat", "statcan"]) {
    const carriedNow = Object.values(airports).filter((a) => a.source === src).length;
    const prevOfSrc = Object.entries(prev?.airports || {}).filter(([, v]) => v?.source === src);
    if (!carriedNow && !prevOfSrc.length) continue;    // a source we've never carried
    if (liveBy[src] > 0) continue;                     // it delivered something real
    outage = true;
    console.error(`  ${src}: produced NO fresh series tonight — ${carriedNow || prevOfSrc.length} airports kept on committed history`);
    if (!carriedNow) for (const [k, v] of prevOfSrc) sourceCarry[k] = v;
  }

  await mkdir(DATA, { recursive: true });
  await mkdir(SERIES_DIR, { recursive: true });

  const indexAirports = { ...btsCarry, ...sourceCarry };
  for (const [iata, a] of Object.entries(airports)) {
    const { series, monthly, paxSeg, ...meta } = a;
    indexAirports[iata] = {
      ...meta,
      metrics: metricsIn(series),
      hasPaxSeg: !!(paxSeg && Object.keys(paxSeg).length >= 2),
      annualPax: lastFullYearTotal(series.pax),
    };
    await writeFile(
      resolve(SERIES_DIR, `${iata}.json`),
      JSON.stringify({ series, ...(paxSeg && Object.keys(paxSeg).length >= 2 ? { paxSeg } : {}) }) + "\n",
      "utf8"
    );
  }
  await pruneDir(SERIES_DIR, Object.keys(indexAirports));

  const out = {
    generatedAt: new Date().toISOString(),
    note: "Monthly activity (passengers / movements / cargo) catalogue by airport — metadata only. Per-airport series live in data/series/<IATA>.json, fetched by the browser once that gateway is selected. Refreshed nightly; read same-origin. No synthetic data.",
    sources: {
      eurostat: "Eurostat avia_paoa (PAS_CRD pax + NAT/INTL split, CAF_PAS flights) + avia_gooa (FRM_LD_NLD cargo, tonnes) — all reporting airports",
      statcan: "Statistics Canada WDS 23-10-0312 (screened pax, by domestic/transborder/international sector), 23-10-0296 (aircraft movements; 23-10-0008 fallback)",
      bts: "US DOT BTS T-100 (fetch-bts.mjs)",
    },
    airports: indexAirports,
  };
  await writeFile(OUT, JSON.stringify(out) + "\n", "utf8");

  /* trim airports.json to just the catalogue, so the browser load stays small */
  if (refDoc) {
    const trimmed = {};
    for (const iata of Object.keys(indexAirports)) if (ref[iata]) trimmed[iata] = ref[iata];
    refDoc.airports = trimmed; refDoc.count = Object.keys(trimmed).length;
    refDoc.note = "Airport reference trimmed to the airports that carry data (full set is rebuilt nightly by fetch-openflights.mjs).";
    await writeFile(REF, JSON.stringify(refDoc) + "\n", "utf8");
  }

  if (seeded) console.log(`  freshness clock started for ${seeded} airport-entries with no prior refreshedAt stamp (watch begins now, not backdated)`);
  console.log(`Wrote ${OUT} — ${Object.keys(indexAirports).length} airports (${Object.keys(airports).length} eurostat/statcan + ${Object.keys(btsCarry).length} carried BTS + ${Object.keys(sourceCarry).length} outage-carried), ${live} live metric-series.`);
  /* Exit 2, not 1. Both mean "the health step should hear about this", but
     they are different incidents and the workflow tiers them differently:
     2 = a feed answered with nothing usable and every airport was kept on
     committed history (the site is correct; escalation comes from the
     refreshedAt staleness net above), while a nonzero exit from the catch
     below means the script genuinely crashed. Reporting both as 1 is what
     made 2026-07-26 file an issue reading "down or crashed" for a run that
     completed cleanly and lost nothing. */
  if (outage) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error("Activity snapshot failed:", err.message); process.exit(1); });
}

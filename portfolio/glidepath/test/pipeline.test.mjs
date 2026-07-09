/* ============================================================
 * test/pipeline.test.mjs — the data pipeline's pure logic, exercised
 * against recorded/synthetic fixtures so parsing regressions surface in
 * PR CI instead of at 03:17 UTC. Covers:
 *   - fetch-activity's Eurostat JSON-stat decoder (recorded shape)
 *   - fetch-imf's per-capita derivation
 *   - fetch-bts's column-role mapper
 *   - validate-data's structural checkers (good + bad shapes)
 *   - check-snapshots' staleness/anomaly helpers
 * Run:  node --test test/
 * ============================================================ */
import test from "node:test";
import assert from "node:assert/strict";

import { esDecode, normMonth } from "../scripts/fetch-activity.mjs";
import { perCapitaRates } from "../scripts/fetch-imf.mjs";
import { mapCols, decodeRows, orderCandidates, US } from "../scripts/fetch-bts.mjs";
import { lastFullYearTotal, metricsIn } from "../scripts/_util.mjs";
import { checkSeriesDoc, checkActivityIndex, checkForecastDoc } from "../scripts/validate-data.mjs";
import { staleSnapshots, droppedAirports, seriesAnomalies, ageDays } from "../scripts/check-snapshots.mjs";

/* ---- fetch-activity: Eurostat JSON-stat ----------------------- */

/* a minimal but structurally faithful avia_paoa response: 5 dims, two
   reporting airports, three months, one null observation */
const JSONSTAT_FIXTURE = {
  id: ["freq", "unit", "tra_meas", "rep_airp", "time"],
  size: [1, 1, 1, 2, 3],
  value: [100, 200, null, 50, 60, 70],
  dimension: {
    rep_airp: { category: { index: { ES_LEMD: 0, AT_LOWW: 1 } } },
    time: { category: { index: { "2024M01": 0, "2024M02": 1, "2024M03": 2 } } },
  },
};

test("esDecode: decodes a JSON-stat payload to icao -> monthly, dropping nulls", () => {
  const out = esDecode(JSONSTAT_FIXTURE, "avia_paoa");
  assert.deepEqual(Object.keys(out).sort(), ["LEMD", "LOWW"]);
  assert.equal(out.LEMD.geo, "ES");
  assert.deepEqual(out.LEMD.monthly, { "2024-01": 100, "2024-02": 200 }); // null 2024-03 dropped
  assert.deepEqual(out.LOWW.monthly, { "2024-01": 50, "2024-02": 60, "2024-03": 70 });
});

test("esDecode: sparse object-form values (Eurostat omits nulls) decode identically", () => {
  const sparse = { ...JSONSTAT_FIXTURE, value: { 0: 100, 1: 200, 3: 50, 4: 60, 5: 70 } };
  const out = esDecode(sparse, "avia_paoa");
  assert.deepEqual(out.LEMD.monthly, { "2024-01": 100, "2024-02": 200 });
});

test("esDecode: malformed payload throws instead of returning junk", () => {
  assert.throws(() => esDecode({ id: ["time"], size: [1] }, "avia_paoa"));
});

test("normMonth: Eurostat 2024M03 and plain 2024-03 both normalize", () => {
  assert.equal(normMonth("2024M03"), "2024-03");
  assert.equal(normMonth("2024-03"), "2024-03");
});

/* ---- fetch-imf: per-capita derivation -------------------------- */

test("perCapitaRates: derives per-capita growth from aggregate growth + population levels", () => {
  const now = new Date().getFullYear();
  const gdp = { [now]: 2.0, [now + 1]: 3.0 };
  const pop = { [now - 1]: 100, [now]: 101, [now + 1]: 102.01 };
  const out = perCapitaRates(gdp, pop);
  assert.equal(out.length, 2);
  // (1.02 / 1.01 - 1) * 100 ≈ 0.99 -> rounded to 1.0
  assert.equal(out[0].year, now);
  assert.equal(out[0].pct, 1.0);
  assert.equal(out[1].year, now + 1);
  assert.equal(out[1].pct, 2.0);
});

test("perCapitaRates: a year missing gdp or population is dropped, not guessed", () => {
  const now = new Date().getFullYear();
  const out = perCapitaRates({ [now]: 2.0 }, { [now]: 101 }); // no prior-year population
  assert.equal(out.length, 0);
});

/* ---- fetch-bts: column mapping + row decoding + discovery ------- */

test("mapCols: recognizes a T-100-shaped header row", () => {
  const m = mapCols(["origin_airport_code", "year", "month", "passengers", "freight", "departures_performed"]);
  assert.equal(m.origin, "origin_airport_code");
  assert.equal(m.pax, "passengers");
  assert.equal(m.flights, "departures_performed");
});

test("mapCols: bare T-100 field names (the DOT vintage) map too", () => {
  const m = mapCols(["origin", "year", "month", "passengers", "freight", "departures_performed", "distance"]);
  assert.equal(m.origin, "origin");
  assert.equal(m.year, "year");
  assert.equal(m.month, "month");
  assert.equal(m.freight, "freight");
});

test("decodeRows: SODA aggregate rows -> monthly series, pounds to tonnes, junk dropped", () => {
  // SODA returns aggregate values as STRINGS — exactly this shape
  const rows = [
    { year: "2024", month: "1", pax: "412345", freight: "2204624", flights: "3120" },  // 2,204,624 lb ≈ 1,000 t
    { year: "2024", month: "2", pax: "398000", flights: "3001" },                       // no freight column that month
    { year: "0",    month: "1", pax: "999" },        // junk year -> dropped
    { year: "2024", month: "13", pax: "999" },       // junk month -> dropped
    { year: "2024", month: "3", pax: "not-a-number" },
  ];
  const s = decodeRows(rows);
  assert.deepEqual(Object.keys(s.pax).sort(), ["2024-01", "2024-02"]);
  assert.equal(s.pax["2024-01"], 412345);
  assert.equal(s.atm["2024-01"], 3120);
  assert.equal(s.cargo["2024-01"], 1000, "freight arrives in pounds and must land in tonnes");
  assert.ok(!("2024-02" in s.cargo));
  assert.deepEqual(decodeRows(null), { pax: {}, atm: {}, cargo: {} });
});

test("orderCandidates: T-100 segment datasets probe first, merged queries dedupe by id", () => {
  const ordered = orderCandidates([
    { resource: { id: "aaaa-1111", name: "Bridge Conditions" } },
    { resource: { id: "bbbb-2222", name: "Air Carriers: T-100 Domestic Segment (All Carriers)" } },
    { resource: { id: "cccc-3333", name: "T-100 Market (All Carriers)" } },
    { resource: { id: "bbbb-2222", name: "Air Carriers: T-100 Domestic Segment (All Carriers)" } }, // dupe from a second query
    { resource: {} },   // no id -> dropped
  ]);
  assert.equal(ordered[0].id, "bbbb-2222", "T-100 + segment outranks everything");
  assert.equal(ordered[1].id, "cccc-3333");
  assert.equal(ordered.length, 3, "results merged across queries dedupe by id");
});

test("US airport list: unique, IATA-shaped, bounded like the EU cap", () => {
  assert.ok(US.length >= 30 && US.length <= 40, "bounded so the nightly Prophet build stays affordable");
  assert.equal(new Set(US).size, US.length, "no duplicates");
  assert.ok(US.every((c) => /^[A-Z]{3}$/.test(c)));
  for (const major of ["ATL", "ORD", "JFK", "LAX", "DEN"]) assert.ok(US.includes(major), major + " missing");
});

/* ---- _util ------------------------------------------------------ */

test("lastFullYearTotal: only complete calendar years count", () => {
  const monthly = {};
  for (let m = 1; m <= 12; m++) monthly[`2024-${String(m).padStart(2, "0")}`] = 10;
  monthly["2025-01"] = 99;
  assert.equal(lastFullYearTotal(monthly), 120);
  assert.equal(lastFullYearTotal({ "2025-01": 5 }), null);
});

test("metricsIn: reports only metrics that actually carry data", () => {
  assert.deepEqual(metricsIn({ pax: { "2024-01": 1 }, atm: {}, cargo: null }), ["pax"]);
});

/* ---- validate-data ---------------------------------------------- */

test("checkSeriesDoc: accepts a valid doc, rejects the failure modes", () => {
  let errs = [];
  checkSeriesDoc({ series: { pax: { "2024-01": 100 } } }, "s", errs);
  assert.deepEqual(errs, []);

  errs = [];
  checkSeriesDoc({ series: { pax: { "2024-1": 100 } } }, "s", errs); // bad month key
  assert.ok(errs.some((e) => e.includes("bad month key")));

  errs = [];
  checkSeriesDoc({ series: { pax: { "2024-01": "lots" } } }, "s", errs); // non-numeric
  assert.ok(errs.some((e) => e.includes("finite number")));

  errs = [];
  checkSeriesDoc({ series: { atm: { "2024-01": 5 } } }, "s", errs); // no pax at all
  assert.ok(errs.some((e) => e.includes("no pax series")));
});

test("checkActivityIndex: index entries must be metadata-only and observed", () => {
  let errs = [];
  checkActivityIndex({
    generatedAt: new Date().toISOString(),
    airports: { MAD: { observed: true, source: "eurostat", metrics: ["pax"], months: 100, latest: "2026-05", annualPax: 1 } },
  }, errs);
  assert.deepEqual(errs, []);

  errs = [];
  checkActivityIndex({
    generatedAt: new Date().toISOString(),
    airports: { MAD: { observed: true, source: "eurostat", metrics: ["pax"], months: 100, series: { pax: {} } } },
  }, errs);
  assert.ok(errs.some((e) => e.includes("must not carry series")), "split layout: series data in the index is a regression");
});

test("checkForecastDoc: forecast rows need date + v/lo/hi, lo<=hi, non-negative", () => {
  let errs = [];
  checkForecastDoc({ pax: { mape: 4.2, forecast: [{ date: "2026-08", v: 10, lo: 8, hi: 12 }] } }, "f", errs);
  assert.deepEqual(errs, []);

  errs = [];
  checkForecastDoc({ pax: { forecast: [{ date: "2026-08", v: 10, lo: 14, hi: 12 }] } }, "f", errs);
  assert.ok(errs.some((e) => e.includes("lo > hi")));
});

/* ---- check-snapshots --------------------------------------------- */

test("staleSnapshots: flags old and missing snapshots, passes fresh ones", () => {
  const now = Date.now();
  const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
  const out = staleSnapshots({
    "fresh.json": { generatedAt: iso(1) },
    "old.json": { generatedAt: iso(15) },
    "missing.json": null,
  }, now);
  assert.deepEqual(out.map((s) => s.file).sort(), ["missing.json", "old.json"]);
  assert.equal(ageDays("not a date"), Infinity);
});

test("droppedAirports + seriesAnomalies: catches vanished gateways, shrunk history, level shifts", () => {
  assert.deepEqual(
    droppedAirports({ airports: { MAD: {}, VIE: {} } }, { airports: { MAD: {} } }),
    ["VIE"]);

  const prev = { pax: {} };
  for (let m = 1; m <= 12; m++) prev.pax[`2024-${String(m).padStart(2, "0")}`] = 1000;

  // identical -> clean
  assert.deepEqual(seriesAnomalies("TST", prev, { pax: { ...prev.pax } }), []);

  // vanished
  assert.ok(seriesAnomalies("TST", prev, {})[0].includes("vanished"));

  // shrunk by 3 months
  const shrunk = { pax: { ...prev.pax } };
  delete shrunk.pax["2024-10"]; delete shrunk.pax["2024-11"]; delete shrunk.pax["2024-12"];
  assert.ok(seriesAnomalies("TST", prev, shrunk).some((w) => w.includes("shrank")));

  // wholesale level shift (unit change)
  const shifted = { pax: Object.fromEntries(Object.entries(prev.pax).map(([k, v]) => [k, v * 2])) };
  assert.ok(seriesAnomalies("TST", prev, shifted).some((w) => w.includes("restatement")));
});

/* ---- fetch-bts TranStats path: listing pick, zip reading, CSV aggregation ---- */

import zlib from "node:zlib";
import { parseCsvLine, pickT100Zips, unzipFirstCsv, aggregateT100Csv } from "../scripts/fetch-bts.mjs";

test("parseCsvLine: quoted fields with embedded commas survive", () => {
  assert.deepEqual(parseCsvLine('2024,1,"ATL","Atlanta, GA",50000'), ["2024", "1", "ATL", "Atlanta, GA", "50000"]);
});

test("pickT100Zips: prefers the combined all-carrier segment family, newest prefix first", () => {
  // shaped like the real listing (run 29032448512): rotating numeric prefixes
  const listing = `
    <a href="896813517_T_T100D_MARKET_US_CARRIER_ONLY.zip">..</a>
    <a href="896816367_T_T100_SEGMENT_ALL_CARRIER.zip">..</a>
    <a href="896816158_T_T100_SEGMENT_ALL_CARRIER.zip">..</a>
    <a href="896816999_T_T100_SEGMENT_ALL_CARRIER.zip">..</a>
    <a href="896816367_T_T100_MARKET_ALL_CARRIER.zip">..</a>
    <a href="896812000_T_T100D_SEGMENT_ALL_CARRIER.zip">..</a>`;
  const picked = pickT100Zips(listing);
  assert.deepEqual(picked, [
    "896816999_T_T100_SEGMENT_ALL_CARRIER.zip",
    "896816367_T_T100_SEGMENT_ALL_CARRIER.zip",
    "896816158_T_T100_SEGMENT_ALL_CARRIER.zip",
  ], "combined family only, sorted by numeric prefix descending; MARKET files excluded");

  // no combined family -> interleave D/I newest-first so periods arrive whole
  const di = pickT100Zips(`
    <a href="100_T_T100D_SEGMENT_ALL_CARRIER.zip">..</a>
    <a href="200_T_T100D_SEGMENT_ALL_CARRIER.zip">..</a>
    <a href="150_T_T100I_SEGMENT_ALL_CARRIER.zip">..</a>`);
  assert.deepEqual(di, [
    "200_T_T100D_SEGMENT_ALL_CARRIER.zip",
    "150_T_T100I_SEGMENT_ALL_CARRIER.zip",
    "100_T_T100D_SEGMENT_ALL_CARRIER.zip",
  ]);
  assert.deepEqual(pickT100Zips("<html>nothing here</html>"), []);
});

/** build a minimal real zip (deflated entries) so unzipFirstCsv is tested
 *  against the actual container format, not a mock */
function buildZip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameB = Buffer.from(name), data = zlib.deflateRawSync(Buffer.from(content));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);            // sig, method=deflate
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10);                 // sig, method
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(nameB.length, 28); cd.writeUInt32LE(offset, 42);         // nameLen, local offset
    parts.push(local, nameB, data);
    central.push(Buffer.concat([cd, nameB]));
    offset += local.length + nameB.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

test("unzipFirstCsv: extracts the CSV entry from a real zip container, skipping non-CSV entries", () => {
  const csv = "YEAR,MONTH,ORIGIN\n2024,1,ATL\n";
  const zip = buildZip([["readme.html", "<p>hi</p>"], ["T_T100_SEGMENT_ALL_CARRIER.csv", csv]]);
  assert.equal(unzipFirstCsv(zip).toString("utf8"), csv);
  assert.throws(() => unzipFirstCsv(Buffer.from("not a zip at all, definitely")), /end-of-central-directory/);
});

test("aggregateT100Csv: sums by origin airport x month, converts freight lbs->tonnes, skips non-targets", () => {
  const csv = [
    '"YEAR","MONTH","ORIGIN","DEST","PASSENGERS","FREIGHT","DEPARTURES_PERFORMED","ORIGIN_CITY_NAME"',
    '2024,1,"ATL","JFK",50000,2204624,400,"Atlanta, GA"',      // 2,204,624 lb ~ 1000 t
    '2024,1,"ATL","LAX",30000,0,200,"Atlanta, GA"',
    '2024,1,"XXX","ATL",99999,0,50,"Not a target"',
    '2024,2,"JFK","ATL",10000,0,100,"New York, NY"',
    '1901,1,"ATL","JFK",5,0,1,"junk year dropped"',
    "",
  ].join("\n");
  const { acc, years } = aggregateT100Csv(csv, new Set(["ATL", "JFK"]));
  assert.equal(acc.ATL.pax["2024-01"], 80000, "two ATL segment rows sum");
  assert.equal(acc.ATL.atm["2024-01"], 600);
  assert.equal(Math.round(acc.ATL.cargo["2024-01"]), 1000, "freight lands in tonnes");
  assert.equal(acc.JFK.pax["2024-02"], 10000);
  assert.ok(!acc.XXX, "non-target origins skipped");
  assert.deepEqual(years, [2024]);
  // accumulation across files: a second file's rows add into the same acc
  aggregateT100Csv('"YEAR","MONTH","ORIGIN","PASSENGERS"\n2023,12,"ATL",70000\n', new Set(["ATL"]), acc);
  assert.equal(acc.ATL.pax["2023-12"], 70000);
  assert.equal(acc.ATL.pax["2024-01"], 80000, "earlier months untouched");
  assert.throws(() => aggregateT100Csv("A,B\n1,2\n", new Set(["ATL"])), /missing YEAR/);
});

test("mergeSeriesFirstWins: overlapping cached extracts can't double-count — first file wins per month", async () => {
  const { mergeSeriesFirstWins } = await import("../scripts/fetch-bts.mjs");
  const target = {};
  mergeSeriesFirstWins(target, { ATL: { pax: { "2024-01": 100 }, atm: {}, cargo: {} } });
  // a second overlapping extract must NOT add on top, only fill gaps
  mergeSeriesFirstWins(target, { ATL: { pax: { "2024-01": 999, "2024-02": 50 }, atm: { "2024-01": 7 }, cargo: {} } });
  assert.equal(target.ATL.pax["2024-01"], 100, "first file wins for a month it already covered");
  assert.equal(target.ATL.pax["2024-02"], 50, "gaps fill from later files");
  assert.equal(target.ATL.atm["2024-01"], 7, "per-metric independence");
});

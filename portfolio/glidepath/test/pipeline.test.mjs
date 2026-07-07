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
import { mapCols } from "../scripts/fetch-bts.mjs";
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

/* ---- fetch-bts: column mapping --------------------------------- */

test("mapCols: recognizes a T-100-shaped header row", () => {
  const m = mapCols(["origin_airport_code", "year", "month", "passengers", "freight", "departures_performed"]);
  assert.equal(m.origin, "origin_airport_code");
  assert.equal(m.pax, "passengers");
  assert.equal(m.flights, "departures_performed");
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

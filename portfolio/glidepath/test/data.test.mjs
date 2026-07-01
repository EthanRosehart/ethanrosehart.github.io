/* ============================================================
 * test/data.test.mjs — tests for the forecasting math in data.jsx
 *
 * data.jsx is plain JS (no JSX) that attaches its public API to
 * `window` — see the Object.assign(window, {...}) at its bottom. It's
 * loaded here with node:vm into a minimal sandbox (no DOM, no fetch —
 * data.jsx doesn't touch either) so these tests exercise the REAL
 * source file, through its real public API, exactly as app.jsx and the
 * screens do. No test framework beyond Node's built-in runner.
 *
 * Run:  node --test test/
 * ============================================================ */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, "..", "data.jsx"), "utf8");

/** Fresh sandbox per test so state (AIRPORTS, MACRO, OBSERVED, ...) never
 *  leaks between tests. */
function loadDataModule() {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "data.jsx" });
  return sandbox;
}

/** {"YYYY-MM": value} for `count` consecutive months starting fromYear/fromMonth. */
function monthlySeries(fromYear, fromMonth, count, value) {
  const out = {};
  let y = fromYear, m = fromMonth;
  for (let i = 0; i < count; i++) {
    out[`${y}-${String(m).padStart(2, "0")}`] = typeof value === "function" ? value(i, y, m) : value;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Registers a synthetic airport through the real public API (catalogue
 *  index + per-airport series), exactly the two calls app.jsx makes. */
function setupAirport(win, { iata = "TST", cc = "ZZZ", series, meta = {} } = {}) {
  win.GP_setActivityIndex({
    airports: {
      [iata]: {
        observed: true, source: "test", cc, countryName: "Testland", region: "Test",
        name: "Test Intl", city: "Testville", icao: "ZZZZ", lat: 0, lon: 0,
        months: Object.keys(series.pax || {}).length, latest: "2025-12",
        metrics: Object.keys(series).filter((k) => series[k] && Object.keys(series[k]).length),
        hasPaxSeg: false, annualPax: null,
        ...meta,
      },
    },
  });
  win.GP_setAirportSeries(iata, { series });
  return iata;
}

test("annualize + fullYears: sums monthly values per year, keeps only complete (12-month) years", () => {
  const win = loadDataModule();
  const history = [
    ...Object.entries(monthlySeries(2024, 1, 12, 100)).map(([date, v]) => ({ y: +date.slice(0, 4), m: +date.slice(5, 7) - 1, pax: v })),
    ...Object.entries(monthlySeries(2025, 1, 6, 200)).map(([date, v]) => ({ y: +date.slice(0, 4), m: +date.slice(5, 7) - 1, pax: v })), // partial year
  ];
  const annual = win.GP_annualize(history, "pax");
  assert.equal(annual.find((r) => r.y === 2024).v, 1200);
  assert.equal(annual.find((r) => r.y === 2024).n, 12);
  assert.equal(annual.find((r) => r.y === 2025).v, 1200);
  assert.equal(annual.find((r) => r.y === 2025).n, 6);

  // arrays/objects returned from the vm sandbox live in a different realm than
  // this test file, so compare by primitive value (length + membership), not
  // deepEqual/deepStrictEqual — those also check constructor identity, which
  // differs across realms even for structurally identical arrays.
  const full = win.GP_fullYears(history, "pax");
  assert.equal(full.length, 1);
  assert.equal(full[0].y, 2024); // 2025 dropped — only 6 of 12 months
});

test("longTermForecast: base year matches the observed annual total exactly", () => {
  const win = loadDataModule();
  const iata = setupAirport(win, { series: { pax: monthlySeries(2024, 1, 24, 1000) } });
  const history = win.GP_buildHistory(iata);
  const scenario = win.GP_defaultScenario(iata);
  const lt = win.GP_longTerm(iata, history, scenario);

  assert.ok(lt, "expected a forecast for 24 months of clean history");
  assert.equal(lt.baseYear, 2025); // last full calendar year in the fixture
  assert.equal(lt.rows[0].pax, 12000); // 1000/mo * 12, unmodified
  assert.equal(lt.rows[0].y, 2025);
  assert.equal(lt.endYear, 2025 + scenario.horizon);
});

test("longTermForecast: zero net demand growth holds passengers flat over the horizon", () => {
  const win = loadDataModule();
  const iata = setupAirport(win, { series: { pax: monthlySeries(2024, 1, 24, 1000) } });
  const history = win.GP_buildHistory(iata);
  const scenario = { ...win.GP_defaultScenario(iata), gdp: 0, pop: 0, tourism: 0, fuel: 0, lcc: 0, horizon: 10 };
  const lt = win.GP_longTerm(iata, history, scenario);

  assert.equal(lt.gDemand, 0);
  const end = lt.rows[lt.rows.length - 1];
  assert.ok(Math.abs(end.pax - lt.rows[0].pax) <= 1, `expected flat trajectory, got ${lt.rows[0].pax} -> ${end.pax}`);
  assert.ok(Math.abs(lt.cagr) < 0.01);
});

test("longTermForecast: positive demand growth compounds — CAGR converges to the modeled growth rate", () => {
  const win = loadDataModule();
  const iata = setupAirport(win, { series: { pax: monthlySeries(2024, 1, 24, 1000) } });
  const history = win.GP_buildHistory(iata);
  // horizon=50: pax compounds monthly (Math.pow(1+gDemand, k/12)) but the annual
  // total for a year is a SUM of 12 of those points, while the base year is the
  // raw uncompounded observed total — so CAGR (base -> end, both annual sums)
  // isn't exactly gDemand for any finite horizon, it converges to it as the
  // horizon grows (verified empirically: ~1.6pp off at horizon=1, ~0.03pp off
  // at horizon=50). A long horizon keeps this a meaningful regression check
  // without hard-coding the exact convergence curve.
  const scenario = { ...win.GP_defaultScenario(iata), gdp: 2, elasticity: 1.5, pop: 0.5, tourism: 0, fuel: 0, lcc: 0, horizon: 50 };
  const lt = win.GP_longTerm(iata, history, scenario);

  const expectedG = (2 * 1.5 + 0.5) / 100; // gIncome + gPop, tourism/lcc/fuel are 0
  assert.ok(Math.abs(lt.gDemand / 100 - expectedG) < 1e-9);
  assert.ok(lt.rows[lt.rows.length - 1].pax > lt.rows[0].pax, "passengers should grow");
  assert.ok(Math.abs(lt.cagr - lt.gDemand) < 0.1, `cagr ${lt.cagr} should track gDemand ${lt.gDemand}`);
});

test("longTermForecast: a permanent negative event leaves the horizon lower than the no-event baseline", () => {
  const win = loadDataModule();
  const iata = setupAirport(win, { series: { pax: monthlySeries(2024, 1, 24, 1000) } });
  const history = win.GP_buildHistory(iata);
  const base = { ...win.GP_defaultScenario(iata), horizon: 10 };
  const withEvent = { ...base, events: [{ start: "2026-01", peak: -50, length: 6, recovery: 0, permanent: true, target: "all" }] };

  const ltBase = win.GP_longTerm(iata, history, base);
  const ltShock = win.GP_longTerm(iata, history, withEvent);
  const endBase = ltBase.rows[ltBase.rows.length - 1].pax;
  const endShock = ltShock.rows[ltShock.rows.length - 1].pax;
  assert.ok(endShock < endBase, `permanent -50% shock should leave fewer passengers (${endShock} vs ${endBase})`);
});

test("longTermForecast: passenger segments reconcile to the headline total in the base year", () => {
  const win = loadDataModule();
  const pax = monthlySeries(2024, 1, 24, 1000);
  const domestic = monthlySeries(2024, 1, 24, 600);
  const international = monthlySeries(2024, 1, 24, 400); // 600+400 = 1000 = pax, already reconciled
  const iata = setupAirport(win, { series: { pax, atm: {}, cargo: {} }, meta: { hasPaxSeg: true } });
  win.GP_setAirportSeries(iata, { series: { pax }, paxSeg: { domestic, international } });

  const history = win.GP_buildHistory(iata);
  const scenario = win.GP_defaultScenario(iata);
  const lt = win.GP_longTerm(iata, history, scenario);

  assert.ok(lt.hasSeg, "expected segment composition to be detected");
  assert.equal(lt.segKeys.length, 2);
  assert.ok(lt.segKeys.includes("domestic") && lt.segKeys.includes("international"));
  const segSum = lt.segKeys.reduce((t, k) => t + lt.rows[0].seg[k], 0);
  assert.equal(segSum, lt.rows[0].pax, "segments should sum to the headline base-year total");
});

test("longTermForecast: insufficient history (< 12 clean months) returns null rather than a bad forecast", () => {
  const win = loadDataModule();
  const iata = setupAirport(win, { series: { pax: monthlySeries(2025, 1, 6, 1000) } });
  const history = win.GP_buildHistory(iata);
  const scenario = win.GP_defaultScenario(iata);
  assert.equal(win.GP_longTerm(iata, history, scenario), null);
});

test("GP_fmt: number formatting helpers", () => {
  const win = loadDataModule();
  assert.equal(win.GP_fmt.k1(68043437), "68.0M");
  assert.equal(win.GP_fmt.k1(950), "950");
  assert.equal(win.GP_fmt.pct(2.4), "+2.4%");
  assert.equal(win.GP_fmt.pct(-1.1), "-1.1%");
  assert.equal(win.GP_fmt.int(1234.6), "1,235");
});

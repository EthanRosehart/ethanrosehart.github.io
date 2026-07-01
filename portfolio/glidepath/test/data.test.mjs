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

test("GP_observedSeasonality: recovers a known monthly shape from two complete years", () => {
  const win = loadDataModule();
  // a clean seasonal pattern: January = 50, ramping up to July = 400, back down —
  // identical in both years, so the index should reproduce it exactly and
  // average out to 1.0 (no growth trend to confound it).
  const shape = [50, 100, 150, 200, 300, 350, 400, 350, 300, 200, 150, 100];
  const history = [];
  [2024, 2025].forEach(y => shape.forEach((v, m) => history.push({ y, m, pax: v })));

  const idx = win.GP_observedSeasonality(history, "pax");
  assert.ok(idx, "expected an index from two complete calendar years");
  assert.equal(idx.length, 12);
  const overallAvg = shape.reduce((a, b) => a + b, 0) / 12;
  shape.forEach((v, m) => {
    assert.ok(Math.abs(idx[m] - v / overallAvg) < 1e-9, `month ${m} index should match the known shape`);
  });
  assert.equal(idx.indexOf(Math.max(...idx)), 6, "July (index 6) should be the peak");

  assert.equal(win.GP_observedSeasonality([{ y:2024, m:0, pax:100 }], "pax"), null, "a single month can't produce a seasonal index");
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

test("GP_parseMonthKey: recognizes the date formats the upload wizard is likely to see", () => {
  const win = loadDataModule();
  const cases = [
    ["2024-01", "2024-01"], ["2024-01-15", "2024-01"], ["01/2024", "2024-01"],
    ["1/2024", "2024-01"], ["3/15/2024", "2024-03"], ["Jan-24", "2024-01"], ["Jan-2024", "2024-01"],
    ["", null], ["not a date", null], [null, null],
  ];
  for (const [input, expected] of cases) assert.equal(win.GP_parseMonthKey(input), expected, `parseMonthKey(${JSON.stringify(input)})`);
  const d = win.GP_parseMonthKey(new Date(2024, 2, 1)); // a real Date object, as SheetJS's cellDates:true produces
  assert.equal(d, "2024-03");
});

test("GP_guessColumnRole: maps common spreadsheet headers to a role", () => {
  const win = loadDataModule();
  assert.equal(win.GP_guessColumnRole("Month"), "date");
  assert.equal(win.GP_guessColumnRole("Date"), "date");
  assert.equal(win.GP_guessColumnRole("Passengers"), "pax");
  assert.equal(win.GP_guessColumnRole("PAX"), "pax");
  assert.equal(win.GP_guessColumnRole("Movements"), "atm");
  assert.equal(win.GP_guessColumnRole("Flights"), "atm");
  assert.equal(win.GP_guessColumnRole("Cargo (t)"), "cargo");
  assert.equal(win.GP_guessColumnRole("Notes"), "ignore");
});

test("GP_guessColumnRoles: a lone unrecognized column next to a date column is assumed to be passengers", () => {
  const win = loadDataModule();
  const roles = win.GP_guessColumnRoles(["Month", "Count"]);
  assert.equal(roles[0], "date");
  assert.equal(roles[1], "pax", "a lone unrecognized column should default to passengers, not stay ignored");
});

test("GP_guessColumnRoles: stays conservative when more than one column is ambiguous", () => {
  const win = loadDataModule();
  const roles = win.GP_guessColumnRoles(["Month", "Foo", "Bar"]);
  assert.equal(roles[0], "date");
  assert.equal(roles[1], "ignore", "genuine ambiguity (two unrecognized columns) should be left for the user, not guessed");
  assert.equal(roles[2], "ignore");
});

test("GP_guessColumnRoles: doesn't override a column that's already clearly recognized", () => {
  const win = loadDataModule();
  const roles = win.GP_guessColumnRoles(["Month", "Passengers", "Notes"]);
  assert.equal(roles[0], "date");
  assert.equal(roles[1], "pax");
  assert.equal(roles[2], "ignore", "the fallback only applies when nothing matched pax by name");
});

test("GP_registerCustomAirport: a user-uploaded gateway drives the same long-term model as a catalogue airport, with no Prophet forecast", () => {
  const win = loadDataModule();
  win.GP_setActivityIndex({ airports: {} }); // simulate the real catalogue not carrying this gateway
  const pax = monthlySeries(2022, 1, 36, (i, y, m) => 50000 + m * 100);
  win.GP_registerCustomAirport("C-MYAP", { name:"My Airport", cc:"USA", countryName:"United States", region:"Your data", city:"", icao:"", lat:null, lon:null }, { pax });

  const a = win.AIRPORTS.find(x => x.iata === "C-MYAP");
  assert.ok(a, "custom airport should be findable in the catalogue like any other");
  assert.ok(a.annualPax > 0, "annualPax should be computed from the uploaded series");
  assert.equal(a.custom, true, "the AIRPORTS entry itself must carry `custom` — the UI branches on airport.custom directly, not on a lookup");
  assert.ok(win.GP_liveAirports().some(x => x.iata === "C-MYAP"), "should show up in the picker's live-airport list");

  const history = win.GP_buildHistory("C-MYAP");
  const scenario = win.GP_defaultScenario("C-MYAP");
  const lt = win.GP_longTerm("C-MYAP", history, scenario);
  assert.ok(lt, "the elasticity model should run on uploaded data exactly like a real airport");
  assert.equal(lt.rows[0].pax, a.annualPax);

  assert.equal(win.GP_hasForecast("C-MYAP", "pax"), false, "a custom airport should never have a Prophet forecast");
  assert.equal(win.GP_activityFor("C-MYAP").source, "custom");
});

test("GP_registerCustomAirport: survives a later GP_setActivityIndex call — the reload-restore race", () => {
  // On a page reload, the custom-airport restore runs synchronously on mount
  // (localStorage, no network needed), while the REAL catalogue fetch
  // (data/activity-index.json) always resolves afterward, however briefly.
  // A naive `ACTIVITY_META = json` reassignment in setActivityIndex would
  // silently drop the just-restored custom airport from the catalogue.
  const win = loadDataModule();
  const pax = monthlySeries(2022, 1, 36, 50000);
  win.GP_registerCustomAirport("C-MYAP", { name:"My Airport", cc:"USA", countryName:"United States", region:"Your data", city:"", icao:"", lat:null, lon:null }, { pax });
  assert.ok(win.AIRPORTS.find(x => x.iata === "C-MYAP"), "sanity check: registered before the real fetch resolves");

  // simulate the real data/activity-index.json fetch resolving afterward,
  // with a completely unrelated set of catalogue airports
  win.GP_setActivityIndex({ airports: { MAD: { observed:true, source:"eurostat", cc:"ESP", countryName:"Spain", region:"Europe", name:"Madrid", metrics:["pax"], annualPax:1000000 } } });

  const a = win.AIRPORTS.find(x => x.iata === "C-MYAP");
  assert.ok(a, "custom airport must survive a subsequent real-catalogue load");
  assert.equal(a.custom, true);
  assert.ok(win.AIRPORTS.find(x => x.iata === "MAD"), "the real catalogue airport should still load normally alongside it");

  // and the forecast must still actually compute — this is what a visitor
  // would notice: "Not enough complete years of data" after a reload
  const history = win.GP_buildHistory("C-MYAP");
  const lt = win.GP_longTerm("C-MYAP", history, win.GP_defaultScenario("C-MYAP"));
  assert.ok(lt, "the long-term model must still run on the restored custom airport's data");
});

test("GP_removeCustomAirport: a reset app doesn't leave a ghost gateway behind", () => {
  // liveAirports() (the app's "Select airport" search list) matches on
  // availableMetrics(), which a stale custom entry would still satisfy —
  // so the app-wide Reset action has to fully unregister it, not just
  // clear React state, or the "deleted" gateway would keep showing up.
  const win = loadDataModule();
  const pax = monthlySeries(2022, 1, 36, 50000);
  win.GP_registerCustomAirport("C-GHOST", { name:"Ghost Gateway", cc:"USA", countryName:"United States", region:"Your data", city:"", icao:"", lat:null, lon:null }, { pax });
  assert.ok(win.GP_liveAirports().find(x => x.iata === "C-GHOST"), "sanity check: it's registered and live");

  win.GP_removeCustomAirport("C-GHOST");

  assert.ok(!win.AIRPORTS.find(x => x.iata === "C-GHOST"), "removed airport must be gone from the catalogue array");
  assert.ok(!win.GP_liveAirports().find(x => x.iata === "C-GHOST"), "removed airport must no longer be searchable");
  assert.equal(win.GP_buildHistory("C-GHOST").length, 0, "its series data must be gone too, not just the catalogue entry");
});

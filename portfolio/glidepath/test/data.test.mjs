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
  // the share-link codec uses these platform globals (present in every
  // browser and in Node, but not inside a bare vm context)
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  sandbox.atob = atob;
  sandbox.btoa = btoa;
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

test("GP_observedSeasonality: a real zero-passenger month (e.g. a lockdown) produces an exact 0, not NaN", () => {
  // a plausible real case for uploaded data: one calendar month genuinely
  // had zero traffic in every complete year on file. The index itself
  // should still compute cleanly — it's the UI's peak/quietest *ratio*
  // display that has to guard against dividing by that 0, not this function.
  const win = loadDataModule();
  const history = [];
  [2024, 2025].forEach(y => {
    for (let m = 0; m < 12; m++) history.push({ y, m, pax: m === 3 ? 0 : 100 });
  });
  const idx = win.GP_observedSeasonality(history, "pax");
  assert.ok(idx, "a single zero month shouldn't null out the whole index");
  assert.equal(idx[3], 0, "the zeroed month should be an exact 0 in the index");
  assert.ok(idx.every(v => Number.isFinite(v)), "every index value must be a finite number, never NaN/Infinity");
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

test("GP_forecastFor: passes gdpRegressor through so the model card can disclose it", () => {
  const win = loadDataModule();
  win.GP_setAirportForecast("TST", { pax: { mape: 3.1, forecast: [], gdpRegressor: true } });
  win.GP_setAirportForecast("OTH", { pax: { mape: 3.1, forecast: [] } }); // no field at all — older/simpler fixture
  assert.equal(win.GP_forecastFor("TST", "pax").gdpRegressor, true);
  assert.equal(win.GP_forecastFor("OTH", "pax").gdpRegressor, false, "missing gdpRegressor must coerce to false, not undefined");
  assert.equal(win.GP_forecastFor("TST", "atm"), null, "a metric this airport has no forecast for is null, not a crash");
});

test("GP_csvCell: escapes quotes/commas and neutralizes spreadsheet formula injection", () => {
  const win = loadDataModule();
  assert.equal(win.GP_csvCell("plain"), "plain");
  assert.equal(win.GP_csvCell('He said "hi", ok'), '"He said ""hi"", ok"');
  assert.equal(win.GP_csvCell("line\nbreak"), '"line\nbreak"');
  // a leading =, +, -, @ or tab would execute as a formula when Excel opens
  // the CSV — the guard prefixes an apostrophe so it stays inert text
  assert.equal(win.GP_csvCell("=CMD|' /C calc'!A0"), "'=CMD|' /C calc'!A0");
  assert.equal(win.GP_csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(win.GP_csvCell("+1"), "'+1");
  assert.equal(win.GP_csvCell(null), "");
  assert.equal(win.GP_csvCell(42), "42");
});

test("GP_escapeHtml: entity-escapes everything the DOCX brief interpolates", () => {
  const win = loadDataModule();
  assert.equal(win.GP_escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(win.GP_escapeHtml("Tom & Jerry's"), "Tom &amp; Jerry&#39;s");
  assert.equal(win.GP_escapeHtml(null), "");
  assert.equal(win.GP_escapeHtml("plain text"), "plain text");
});

test("GP_forecastFor: passes gdpForecast through — the model card can't tell a real IMF forecast from mere extrapolation without it", () => {
  const win = loadDataModule();
  win.GP_setAirportForecast("IMF", { pax: { mape: 3.1, forecast: [], gdpRegressor: true, gdpForecast: true } });
  win.GP_setAirportForecast("EXT", { pax: { mape: 3.1, forecast: [], gdpRegressor: true, gdpForecast: false } });
  assert.equal(win.GP_forecastFor("IMF", "pax").gdpForecast, true, "a real IMF-driven forecast must say so, not silently read as extrapolation-only");
  assert.equal(win.GP_forecastFor("EXT", "pax").gdpForecast, false);
});

/* ---- Phase 1-3 additions: ETS, capacity, design day, share links ---- */

test("GP_etsForecast: recovers a clean seasonal pattern and reports an honest backtest", () => {
  const win = loadDataModule();
  // 5 years of multiplicative seasonality (summer peak) with mild growth
  const pax = {};
  for (let i = 0; i < 60; i++) {
    const y = 2021 + Math.floor(i / 12), m = i % 12;
    const seasonal = m >= 5 && m <= 7 ? 1.4 : m <= 1 ? 0.7 : 1.0;
    pax[`${y}-${String(m + 1).padStart(2, "0")}`] = Math.round(100000 * Math.pow(1.003, i) * seasonal);
  }
  const history = Object.entries(pax).map(([date, v]) => ({ y: +date.slice(0, 4), m: +date.slice(5, 7) - 1, date, pax: v }));
  const st = win.GP_etsForecast(history, "pax", 24);
  assert.ok(st, "expected a forecast from 60 clean months");
  assert.equal(st.method, "ets");
  assert.equal(st.forecast.length, 24);
  assert.ok(st.mape != null && st.mape < 8, `holdout MAPE should be small on a clean pattern, got ${st.mape}`);
  assert.equal(st.backtest.length, 12, "the held-out predicted-vs-actual disclosure must ship");
  assert.ok(st.backtest.every(r => r.lo <= r.v && r.v <= r.hi && r.actual > 0));
  // the forecast has to keep the seasonal shape: July >> January in the same year
  const y1 = st.forecast.slice(0, 12);
  const jul = y1.find(r => r.m === 6), jan = y1.find(r => r.m === 0);
  assert.ok(jul.v > jan.v * 1.5, `summer peak should survive into the forecast (Jul ${jul.v} vs Jan ${jan.v})`);
  assert.equal(st.seasIdx.length, 12);
  assert.ok(st.forecast.every(r => r.lo <= r.v && r.v <= r.hi && r.lo >= 0));
});

test("GP_etsForecast: refuses to model < 24 contiguous months instead of guessing", () => {
  const win = loadDataModule();
  const short = [];
  for (let m = 0; m < 18; m++) short.push({ y: 2024 + Math.floor(m / 12), m: m % 12, pax: 1000 });
  assert.equal(win.GP_etsForecast(short, "pax", 12), null);

  // 30 months but with a hole 12 months from the end -> contiguous tail is
  // only 11 months, which must also refuse
  const gappy = [];
  for (let i = 0; i < 30; i++) {
    if (i === 18) continue;
    gappy.push({ y: 2022 + Math.floor(i / 12), m: i % 12, pax: 1000 });
  }
  assert.equal(win.GP_etsForecast(gappy, "pax", 12), null);
});

test("GP_tacticalForecast: prefers the nightly Prophet output, falls back to ETS", () => {
  const win = loadDataModule();
  const pax = monthlySeries(2021, 1, 60, (i) => 50000 + (i % 12) * 1000);
  const iata = setupAirport(win, { series: { pax } });
  const history = win.GP_buildHistory(iata);

  const ets = win.GP_tacticalForecast(iata, "pax", history);
  assert.equal(ets.method, "ets", "no Prophet file on record -> in-browser ETS");

  win.GP_setAirportForecast(iata, { pax: { mape: 3.0, forecast: [{ date: "2026-01", y: 2026, m: 0, v: 1, lo: 1, hi: 1 }] } });
  const pro = win.GP_tacticalForecast(iata, "pax", history);
  assert.equal(pro.method, "prophet", "a nightly Prophet forecast must win over ETS");
});

test("longTermForecast: an annual passenger cap constrains the trajectory and reports spill", () => {
  const win = loadDataModule();
  const iata = setupAirport(win, { series: { pax: monthlySeries(2024, 1, 24, 1000) } });
  const history = win.GP_buildHistory(iata);
  // ~3.4%/yr growth from 12,000/yr; cap at 13,000 -> binds within a few years
  const scenario = { ...win.GP_defaultScenario(iata), gdp: 2, elasticity: 1.5, pop: 0.4, horizon: 10, paxCap: 13000 };
  const lt = win.GP_longTerm(iata, history, scenario);

  assert.ok(lt.hasCap);
  const end = lt.rows[lt.rows.length - 1];
  assert.ok(end.pax > 13000, "unconstrained demand must keep growing past the cap");
  assert.equal(end.paxC, 13000, "constrained throughput must sit exactly at the cap");
  assert.equal(end.spill, end.pax - 13000, "spill = demand the infrastructure can't serve");
  // capped year's months must sum (±rounding) to the cap
  const cappedMonths = lt.months.filter(r => r.y === end.y);
  const mSum = cappedMonths.reduce((t, r) => t + r.paxC, 0);
  assert.ok(Math.abs(mSum - 13000) <= 12, `capped months should sum to the cap, got ${mSum}`);
  // an early year under the cap is untouched
  const early = lt.rows[1];
  assert.equal(early.paxC, early.pax);
  assert.equal(early.spill, 0);
});

test("longTermForecast: no cap set -> no constrained fields at all", () => {
  const win = loadDataModule();
  const iata = setupAirport(win, { series: { pax: monthlySeries(2024, 1, 24, 1000) } });
  const lt = win.GP_longTerm(iata, win.GP_buildHistory(iata), { ...win.GP_defaultScenario(iata), horizon: 5 });
  assert.equal(lt.hasCap, false);
  assert.ok(!("paxC" in lt.rows[lt.rows.length - 1]));
});

test("GP_designDay: derives peak-month, busy-day and peak-hour with the disclosed heuristics", () => {
  const win = loadDataModule();
  const seasIdx = [0.7, 0.7, 0.9, 1.0, 1.1, 1.3, 1.5, 1.4, 1.1, 0.9, 0.7, 0.7];
  const dd = win.GP_designDay(12_000_000, seasIdx);
  assert.equal(dd.peakMonth, 6, "July (index 6) is the peak");
  assert.ok(Math.abs(dd.peakMonthPax - 12_000_000 / 12 * 1.5) < 1);
  assert.ok(Math.abs(dd.busyDay - dd.peakMonthPax / 30.4 * 1.1) < 1);
  assert.equal(dd.peakHourShare, 0.08, ">=10M annual pax -> 8% peak-hour share");
  assert.equal(win.GP_designDay(500_000, seasIdx).peakHourShare, 0.12);
  assert.equal(win.GP_designDay(0, seasIdx), null);
  assert.equal(win.GP_designDay(1000, [1, 2]), null);
});

test("share links: a scenario round-trips, and a hostile payload is stripped to known fields", () => {
  const win = loadDataModule();
  const scenario = { gdp: 2.5, elasticity: 1.6, horizon: 15, paxCap: 20000000,
    events: [{ id: 7, label: "Fuel spike", start: "2027-03", peak: -20, length: 6, recovery: 12, permanent: false, target: "all" }] };
  const decoded = win.GP_decodeShare(win.GP_encodeShare("AMS", scenario));
  assert.equal(decoded.iata, "AMS");
  assert.equal(decoded.scenario.gdp, 2.5);
  assert.equal(decoded.scenario.paxCap, 20000000);
  assert.equal(decoded.scenario.events.length, 1);
  assert.equal(decoded.scenario.events[0].label, "Fuel spike");

  // hostile: junk keys, non-numeric levers, malformed + oversized events
  const evil = win.GP_encodeShare("MAD", {
    gdp: "DROP TABLE", __proto__x: 1, extra: { a: 1 }, elasticity: 1.9,
    events: [{ label: "<img onerror=x>".repeat(20), start: "not-a-month", peak: 1 },
             { label: "ok", start: "2027-01", peak: "NaNny", target: "everything" }],
  });
  const d2 = win.GP_decodeShare(evil);
  assert.equal(d2.iata, "MAD");
  assert.ok(!("gdp" in d2.scenario), "non-numeric lever values must be dropped");
  assert.ok(!("extra" in d2.scenario), "unknown keys must not survive");
  assert.equal(d2.scenario.elasticity, 1.9);
  assert.equal(d2.scenario.events.length, 1, "an event without a valid start month is dropped");
  assert.equal(d2.scenario.events[0].peak, 0, "non-numeric peak coerces to 0");
  assert.equal(d2.scenario.events[0].target, "all", "unknown targets fall back to 'all'");
  assert.ok(d2.scenario.events[0].label.length <= 80);

  assert.equal(win.GP_decodeShare("not-base64!!"), null);
  assert.equal(win.GP_decodeShare(win.GP_encodeShare("../../etc", {})), null, "junk iata shapes are rejected");
});

test("GP_dataAgeDays: parses ISO timestamps into an age, null on junk", () => {
  const win = loadDataModule();
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
  const age = win.GP_dataAgeDays(twoDaysAgo);
  assert.ok(Math.abs(age - 2) < 0.01);
  assert.equal(win.GP_dataAgeDays("garbage"), null);
});

/* ---- coupled capacity model: caps propagate across metrics ---- */

test("capacity coupling: a movements cap squeezes passengers, but bounded up-gauging lifts them above the naive flight-implied level", () => {
  const win = loadDataModule();
  // clean base: 100,000 pax/mo over 1,000 movements/mo -> 100 pax per movement
  const iata = setupAirport(win, { series: {
    pax: monthlySeries(2024, 1, 24, 100000),
    atm: monthlySeries(2024, 1, 24, 1000),
  } });
  const history = win.GP_buildHistory(iata);
  // ~3.4%/yr demand growth; slots capped just above the base year's 12,000
  const scenario = { ...win.GP_defaultScenario(iata), gdp: 2, elasticity: 1.5, pop: 0.4,
    tourism: 0, fuel: 0, lcc: 0, gauge: 0, horizon: 20,
    atmCap: 12600, paxCap: null, capGauge: 2, capGaugeMax: 10 };
  const lt = win.GP_longTerm(iata, history, scenario);
  const end = lt.rows[lt.rows.length - 1];
  const ratioBase = lt.rows[0].pax / lt.rows[0].atm;   // ≈ 100

  assert.ok(lt.hasCap);
  assert.equal(end.atmC, 12600, "movements must sit exactly at the slot cap");
  assert.ok(end.pax > end.paxC, "passenger demand keeps growing past what the airport can serve");
  // the two claims that make this a model, not a clamp:
  assert.ok(end.paxC > 12600 * ratioBase * 1.02,
    `up-gauging must lift pax above the naive flights×base-ratio level (${end.paxC} vs ${Math.round(12600*ratioBase)})`);
  assert.ok(end.paxC <= 12600 * ratioBase * 1.10 * 1.005,
    `...but never past the ${scenario.capGaugeMax}% gauge ceiling (${end.paxC} vs ${Math.round(12600*ratioBase*1.1)})`);
  assert.equal(end.spill, end.pax - end.paxC);
});

test("capacity coupling: with zero up-gauging headroom, a movements cap pins passengers to flights × base ratio", () => {
  const win = loadDataModule();
  const iata = setupAirport(win, { series: {
    pax: monthlySeries(2024, 1, 24, 100000),
    atm: monthlySeries(2024, 1, 24, 1000),
  } });
  const history = win.GP_buildHistory(iata);
  const scenario = { ...win.GP_defaultScenario(iata), gdp: 2, elasticity: 1.5, pop: 0.4,
    tourism: 0, fuel: 0, lcc: 0, gauge: 0, horizon: 15,
    atmCap: 12600, capGauge: 0, capGaugeMax: 0 };
  const lt = win.GP_longTerm(iata, history, scenario);
  const end = lt.rows[lt.rows.length - 1];
  const ratioBase = lt.rows[0].pax / lt.rows[0].atm;
  assert.ok(Math.abs(end.paxC - 12600 * ratioBase) / (12600 * ratioBase) < 0.01,
    `no headroom -> pax ≈ capped flights × base ratio (${end.paxC} vs ${Math.round(12600*ratioBase)})`);
});

test("capacity coupling: a terminal (pax) cap pulls movements down and belly cargo with it", () => {
  const win = loadDataModule();
  const iata = setupAirport(win, { series: {
    pax: monthlySeries(2024, 1, 24, 100000),
    atm: monthlySeries(2024, 1, 24, 1000),
    cargo: monthlySeries(2024, 1, 24, 500),
  } });
  const history = win.GP_buildHistory(iata);
  const scenario = { ...win.GP_defaultScenario(iata), gdp: 2, elasticity: 1.5, pop: 0.4,
    tourism: 0, fuel: 0, lcc: 0, gauge: 0, cargo: 0, horizon: 15,
    paxCap: 1300000, atmCap: null, bellyShare: 50 };
  const lt = win.GP_longTerm(iata, history, scenario);
  const end = lt.rows[lt.rows.length - 1];

  assert.equal(end.paxC, 1300000, "terminal cap binds passengers");
  // movements: airlines fly only what constrained pax need, at the year's ratio
  const expectedAtm = Math.round(end.paxC / (end.pax / end.atm));
  assert.ok(Math.abs(end.atmC - expectedAtm) <= 1,
    `movements must follow constrained pax down (${end.atmC} vs expected ${expectedAtm})`);
  assert.ok(end.atmC < end.atm, "movements below unconstrained demand");
  // cargo: only the bellyhold share shrinks with constrained pax activity
  const paxFactor = end.paxC / end.pax;
  const expectedCargo = Math.round(end.cargo * (1 - 0.5 * (1 - paxFactor)));
  assert.ok(Math.abs(end.cargoC - expectedCargo) <= 1,
    `belly share of cargo scales with pax (${end.cargoC} vs expected ${expectedCargo})`);
  assert.ok(end.cargoC < end.cargo && end.cargoC > end.cargo * 0.5,
    "cargo constrained, but freighter share survives");
});

test("capacity coupling: bellyShare 0 leaves cargo untouched; 100 scales it fully with pax", () => {
  const win = loadDataModule();
  const series = {
    pax: monthlySeries(2024, 1, 24, 100000),
    cargo: monthlySeries(2024, 1, 24, 500),
  };
  const mk = (belly) => {
    const iata = setupAirport(win, { series });
    const history = win.GP_buildHistory(iata);
    return win.GP_longTerm(iata, history, { ...win.GP_defaultScenario(iata),
      gdp: 2, elasticity: 1.5, pop: 0.4, tourism: 0, fuel: 0, lcc: 0, cargo: 0,
      horizon: 15, paxCap: 1300000, bellyShare: belly });
  };
  const freighterOnly = mk(0), bellyOnly = mk(100);
  const endF = freighterOnly.rows[freighterOnly.rows.length - 1];
  const endB = bellyOnly.rows[bellyOnly.rows.length - 1];
  assert.equal(endF.cargoC, endF.cargo, "all-freighter cargo ignores the pax cap");
  const expected = Math.round(endB.cargo * (endB.paxC / endB.pax));
  assert.ok(Math.abs(endB.cargoC - expected) <= 1, "all-belly cargo scales 1:1 with constrained pax");
});

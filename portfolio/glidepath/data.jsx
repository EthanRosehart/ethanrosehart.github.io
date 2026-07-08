/* ============================================================
   data.jsx — real datasets + forecast access
   No synthetic series. Monthly activity (passengers / movements /
   cargo) comes from public sources via the nightly pipeline. The
   catalogue loads from a small index (data/activity-index.json,
   metadata only); each airport's actual monthly series
   (data/series/<IATA>.json) and short-term Prophet forecast
   (data/forecasts/<IATA>.json) are fetched lazily, once that gateway
   is selected — see app.jsx. The long-term strategic model compounds
   the real base year with public macro drivers. Everything here is
   exposed on window for the other script files in the bundle.
   ============================================================ */

/* ---- airport catalogue (built at runtime, not hand-curated) ---
   AIRPORTS is filled from data/activity-index.json — every airport our
   public feeds actually carry monthly data for — and enriched with
   the OpenFlights reference (data/airports.json). It stays the same
   array object (mutated in place) so the other script files that
   captured it lexically keep seeing the live list.                 */
const AIRPORTS = [];
let REFERENCE = {};                       // iata -> OpenFlights record

/* ---- macro baselines (World Bank / IMF style) --------------- */
/* trend real GDP growth, GDP/cap, income (PAX) elasticity by mkt;
   live World Bank figures merged over these at runtime. Countries
   not listed here get MACRO_DEFAULT, filled in as airports load.   */
const MACRO = {
  CAN: { gdp:1.9, gdpcap:1.0, pop:1.1, elasticity:1.7, tourism:1.2, label:"Canada" },
  USA: { gdp:2.1, gdpcap:1.4, pop:0.6, elasticity:1.5, tourism:1.0, label:"United States" },
  GBR: { gdp:1.4, gdpcap:1.0, pop:0.4, elasticity:1.6, tourism:1.3, label:"United Kingdom" },
  NLD: { gdp:1.5, gdpcap:1.1, pop:0.5, elasticity:1.6, tourism:1.4, label:"Netherlands" },
  DEU: { gdp:1.2, gdpcap:0.9, pop:0.2, elasticity:1.5, tourism:1.1, label:"Germany" },
  DNK: { gdp:1.6, gdpcap:1.2, pop:0.4, elasticity:1.6, tourism:1.2, label:"Denmark" },
  AUT: { gdp:1.5, gdpcap:1.1, pop:0.5, elasticity:1.7, tourism:2.0, label:"Austria" },
  ITA: { gdp:0.9, gdpcap:0.8, pop:-0.1, elasticity:1.8, tourism:2.4, label:"Italy" },
  POL: { gdp:3.1, gdpcap:3.0, pop:-0.2, elasticity:1.9, tourism:1.8, label:"Poland" },
};
const MACRO_DEFAULT = { gdp:1.6, gdpcap:1.2, pop:0.4, elasticity:1.6, tourism:1.4 };
function ensureMacro(cc, label){
  if (cc && !MACRO[cc]) MACRO[cc] = { ...MACRO_DEFAULT, label: label || cc };
  return MACRO[cc];
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const METRIC_KEYS = ["pax","atm","cargo"];

/* ============================================================
   OBSERVED ACTIVITY
   data/activity-index.json — catalogue metadata only (no series), loaded
   once on app mount. data/series/<IATA>.json — the actual monthly numbers
   for one airport, iata -> { pax:{ "YYYY-MM":n }, atm:{...}, cargo:{...} },
   fetched lazily once that gateway is selected (see app.jsx).
   ============================================================ */
const OBSERVED = {};
/* optional passenger composition by travel segment, iata -> { domestic:{"YYYY-MM":n},
   transborder:{...}, international:{...} }. Eurostat (national / international) and
   StatCan (domestic / transborder / international) both publish this split; the
   pipeline fills paxSeg when available. Absent → the model runs on totals only. */
const SEGMENTS = {};
const PAX_SEGMENTS = [
  { k:"domestic",     label:"Domestic",      color:"var(--cyan)" },
  { k:"transborder",  label:"Transborder",   color:"var(--lime)" },
  { k:"international", label:"International",  color:"var(--violet)" },
];
let ACTIVITY_META = null;
/* the catalogue index — metadata for every airport, no series. Safe to call
   again (e.g. a re-fetch) since it doesn't touch already-loaded OBSERVED. */
function setActivityIndex(json){
  // preserve any custom (user-uploaded) airport already registered — the
  // real catalogue fetch has no idea it exists, and on a page reload it
  // resolves AFTER the synchronous localStorage restore (see app.jsx),
  // so a plain reassignment here would silently wipe it out from under
  // the running session even though its series survives fine in OBSERVED
  const customEntries = {};
  if (ACTIVITY_META && ACTIVITY_META.airports) {
    for (const iata in ACTIVITY_META.airports) {
      const a = ACTIVITY_META.airports[iata];
      if (a && a.custom) customEntries[iata] = a;
    }
  }
  ACTIVITY_META = json;
  if (ACTIVITY_META && ACTIVITY_META.airports) Object.assign(ACTIVITY_META.airports, customEntries);
  window.GP_ACTIVITY_META = ACTIVITY_META;
  rebuildAirports();
}
/* one airport's real monthly series, fetched lazily once selected. */
function setAirportSeries(iata, json){
  if (json && json.series && typeof json.series === "object") OBSERVED[iata] = json.series;
  if (json && json.paxSeg && typeof json.paxSeg === "object") SEGMENTS[iata] = json.paxSeg;
  else delete SEGMENTS[iata];
}
function hasAirportSeries(iata){ return !!OBSERVED[iata]; }
function getObservedSeries(iata){ return OBSERVED[iata] || null; }
function getActivityMeta(iata){ return (ACTIVITY_META && ACTIVITY_META.airports && ACTIVITY_META.airports[iata]) || null; }

/* ============================================================
   CUSTOM (user-uploaded) AIRPORTS
   Lets a visitor bring their own monthly history instead of picking a
   catalogue gateway. Registered through the exact same machinery the real
   nightly pipeline uses (ACTIVITY_META.airports[iata] + rebuildAirports()),
   so every existing screen — Overview, long-term, scenario levers, event
   simulator, export — just works unchanged. The one thing that's never
   populated is FORECASTS[iata]: Prophet is fit server-side, nightly, only
   for the committed public feeds, and every screen that reads a forecast
   already treats "no forecast" as a normal, handled state rather than an
   error, so a custom airport degrades gracefully with zero extra plumbing
   there — see app.jsx / DataCaveat for the one place that explains why.
   ============================================================ */
function registerCustomAirport(iata, meta, series){
  if (!ACTIVITY_META || !ACTIVITY_META.airports) ACTIVITY_META = { airports:{} };
  OBSERVED[iata] = series;
  delete SEGMENTS[iata]; // custom uploads don't support the segment split
  const paxKeys = Object.keys(series.pax || {});
  // register metadata (incl. `metrics`) BEFORE computing annualPax — buildHistory()
  // reads availableMetrics(), which reads this same metadata, so annualPax's
  // buildHistory()/fullYears() call has to run after this object exists, not before.
  ACTIVITY_META.airports[iata] = {
    ...meta,
    observed: true, source: "custom", custom: true,
    metrics: METRIC_KEYS.filter(m => series[m] && Object.keys(series[m]).length),
    hasPaxSeg: false,
    months: paxKeys.length,
    latest: paxKeys.sort().pop() || null,
    annualPax: null,
  };
  const paxYears = fullYears(buildHistory(iata), "pax");
  ACTIVITY_META.airports[iata].annualPax = paxYears.length ? paxYears[paxYears.length - 1].v : null;
  rebuildAirports();
}

/* undo registerCustomAirport — used by the app-wide Reset action so a
   cleared session doesn't leave a ghost gateway still matching in
   liveAirports() (it filters on availableMetrics(), which a stale custom
   entry would still satisfy). */
function removeCustomAirport(iata){
  delete OBSERVED[iata];
  delete SEGMENTS[iata];
  if (ACTIVITY_META && ACTIVITY_META.airports) delete ACTIVITY_META.airports[iata];
  rebuildAirports();
}

/* "YYYY-MM" from a variety of raw date-ish spreadsheet cell values. Returns
   null if nothing sensible can be parsed — the upload UI flags those rows
   rather than silently dropping or misreading them. */
function parseMonthKey(raw){
  if (raw == null || raw === "") return null;
  if (raw instanceof Date && !isNaN(raw)) return `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, "0")}`;
  const s = String(raw).trim();
  let m;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})/))) return `${m[1]}-${String(+m[2]).padStart(2, "0")}`;              // YYYY-MM(-DD)
  if ((m = s.match(/^(\d{1,2})[-/](\d{4})$/))) return `${m[2]}-${String(+m[1]).padStart(2, "0")}`;              // MM/YYYY
  if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) return `${m[3]}-${String(+m[1]).padStart(2, "0")}`; // MM/DD/YYYY
  const MON = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  if ((m = s.toLowerCase().match(/^([a-z]{3,})[-\s](\d{2,4})$/)) && MON[m[1].slice(0, 3)]) {
    const y = m[2].length === 2 ? 2000 + (+m[2]) : +m[2];
    return `${y}-${String(MON[m[1].slice(0, 3)]).padStart(2, "0")}`;
  }
  const d = new Date(s);
  if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return null;
}

/* best-effort column-role guess from a spreadsheet header cell, for the
   upload wizard's default mapping — the user can always override it. */
function guessColumnRole(header){
  const h = String(header || "").toLowerCase();
  if (/date|month|period/.test(h)) return "date";
  if (/pax|passenger/.test(h)) return "pax";
  if (/atm|movement|flight|depart/.test(h)) return "atm";
  if (/cargo|freight/.test(h)) return "cargo";
  return "ignore";
}
/* guesses roles for a full header row at once — if nothing matched "pax" by
   name but exactly one column is otherwise unclassified, assume that's
   passengers. Passengers is the one metric every upload needs, and a lone
   generically-named numeric column ("Count", "Total", "Volume", ...) next to
   a date column is overwhelmingly likely to be it. Stays conservative when
   there's more than one unclassified column — genuine ambiguity is left for
   the user to resolve in the mapping dropdowns rather than guessed at. */
function guessColumnRoles(headers){
  const roles = headers.map(guessColumnRole);
  if (!roles.includes("pax")) {
    const unclassified = roles.map((r,i)=> r==="ignore" ? i : -1).filter(i=>i>=0);
    if (unclassified.length === 1) roles[unclassified[0]] = "pax";
  }
  return roles;
}

/* segment keys that actually carry monthly data for an airport, in canonical
   order. Used to drive the shape-builder levers and segment view. */
function segmentsFor(iata){
  const s = SEGMENTS[iata]; if (!s) return [];
  return PAX_SEGMENTS.filter(seg => s[seg.k] && Object.keys(s[seg.k]).length);
}

/* OpenFlights reference (data/airports.json) — optional enrichment of the
   catalogue with authoritative identifiers/coords/timezone. */
function setReference(json){
  REFERENCE = (json && json.airports) || {};
  rebuildAirports();
}

/* Rebuild AIRPORTS from the activity snapshot (the airports that carry real
   data), enriched by the OpenFlights reference. Mutates the array in place. */
function rebuildAirports(){
  const meta = ACTIVITY_META && ACTIVITY_META.airports;
  if (!meta) return;
  AIRPORTS.length = 0;
  Object.keys(meta).forEach(iata => {
    const a = meta[iata];
    if (!a || !a.observed) return;
    const r = REFERENCE[iata] || {};
    const cc = a.cc || r.cc || "";
    ensureMacro(cc, a.countryName || r.country);
    AIRPORTS.push({
      iata,
      icao: a.icao || r.icao || "",
      name: a.name || r.name || iata,
      city: a.city || r.city || "",
      country: a.countryName || r.country || "",
      cc,
      lat: (a.lat != null ? a.lat : (r.lat != null ? r.lat : null)),
      lon: (a.lon != null ? a.lon : (r.lon != null ? r.lon : null)),
      elev: (r.elev_ft != null ? r.elev_ft : null),
      tz: r.tz || null,
      region: a.region || "—",
      // metadata-only fields from the index — available immediately, before
      // this airport's own series/forecast has been fetched
      metrics: a.metrics || [],
      hasPaxSeg: !!a.hasPaxSeg,
      annualPax: a.annualPax ?? null,
      custom: !!a.custom,
    });
  });
  AIRPORTS.sort((x, y) => (x.region === y.region ? x.name.localeCompare(y.name) : x.region.localeCompare(y.region)));
  window.GP_AIRPORTS = AIRPORTS;
}
/* which metrics (pax/atm/cargo) a gateway carries — from the index, so this
   is known immediately, before its series has been fetched. */
function availableMetrics(iata){
  const a = ACTIVITY_META && ACTIVITY_META.airports ? ACTIVITY_META.airports[iata] : null;
  return (a && a.metrics) || [];
}
function activityFor(iata){
  const a = ACTIVITY_META && ACTIVITY_META.airports ? ACTIVITY_META.airports[iata] : null;
  if (!a || !a.observed) return { observed:false, source:"none", months:0, metrics:[] };
  return { observed:true, source:a.source, rep:a.rep_airp,
    months: a.months || 0,
    latest: a.latest || null,
    metrics: availableMetrics(iata) };
}
/* airports we can actually show — real passenger data present */
function liveAirports(){ return AIRPORTS.filter(a => availableMetrics(a.iata).includes("pax")); }

/* human-readable name for a raw activity source key (e.g. "statcan") */
function sourceLabel(src){
  const k = (src||"").split(":")[0].toLowerCase();
  return ({ eurostat:"Eurostat", statcan:"Statistics Canada", bts:"US BTS", custom:"your uploaded data" })[k]
    || (k ? k[0].toUpperCase()+k.slice(1) : "public");
}
/* short badge code for a source — drives the connect-step source icon */
function sourceBadge(src){
  const k = (src||"").split(":")[0].toLowerCase();
  return ({ eurostat:"AVIA", statcan:"CAN", bts:"BTS" })[k] || "AVIA";
}

/* ============================================================
   PROPHET FORECASTS, precomputed nightly.
   data/forecast-meta.json — shared model metadata (generatedAt, interval,
   horizon), loaded once on mount. data/forecasts/<IATA>.json — one
   airport's forecast per metric, fetched lazily once selected:
   iata -> metric -> { mape, seasonal12, holidays, forecast[] }
   ============================================================ */
const FORECASTS = {};
let FORECAST_META = null;
function setForecastMeta(json){
  FORECAST_META = json;
  window.GP_FORECAST_META = json;
}
function setAirportForecast(iata, json){
  FORECASTS[iata] = json || {};
}
function hasForecast(iata, key){
  const a = FORECASTS[iata];
  return key ? !!(a && a[key]) : !!(a && Object.keys(a).length);
}
function forecastFor(iata, key){
  const m = FORECASTS[iata] && FORECASTS[iata][key];
  if (!m) return null;
  const forecast = (m.forecast || []).map(r => ({ ...r, label:`${MONTHS[r.m]} ${String(r.y).slice(2)}` }));
  return { forecast, method:"prophet",
    mape:m.mape, mapeFolds:m.mape_folds || [],
    naiveMape:m.naive_mape ?? null, skill:m.skill ?? null, coverage:m.coverage ?? null,
    backtest:m.backtest || [],
    seasIdx:m.seasonal12 || Array(12).fill(1),
    holidays:m.holidays || [], holidaysTotal:m.holidays_total || 0,
    latest:m.latest, monthsHistory:m.months_history,
    gdpRegressor:!!m.gdpRegressor, gdpForecast:!!m.gdpForecast };
}

/* ============================================================
   ETS (Holt-Winters) — the in-browser tactical model.
   Prophet is fit server-side, nightly, only for the committed public
   feeds; an uploaded gateway (or a real one Prophet hasn't cleared its
   history minimum for) used to simply have no short-term forecast.
   Holt-Winters with additive trend + multiplicative monthly seasonality
   is small enough to fit right here (a coarse grid over the three
   smoothing constants, one-step-error scored), so those gateways get a
   tactical view too — with the same holdout-backtest honesty as
   Prophet, and a model card that says exactly what it is.
   ============================================================ */
function etsFit(pts, key, alpha, beta, gamma){
  const P = 12;
  // init: seasonal indices from the first two years (ratio to their mean),
  // level from year 1, trend from the year-1 -> year-2 step
  const first = pts.slice(0, 2*P);
  const overall = first.reduce((s,r)=>s+r[key],0) / first.length;
  const seas = Array(P).fill(0), cnt = Array(P).fill(0);
  first.forEach(r => { seas[r.m] += r[key] / (overall || 1); cnt[r.m]++; });
  for (let i=0;i<P;i++) seas[i] = cnt[i] ? seas[i]/cnt[i] : 1;
  const sm = seas.reduce((a,b)=>a+b,0) / P;
  for (let i=0;i<P;i++) seas[i] /= (sm || 1);
  const y1 = pts.slice(0,P).reduce((s,r)=>s+r[key],0) / P;
  const y2 = pts.slice(P,2*P).reduce((s,r)=>s+r[key],0) / P;
  let level = y1, trend = (y2-y1) / P;
  const resid = []; let sse = 0, n = 0;
  pts.forEach((r,t)=>{
    const mi = r.m, f = (level + trend) * (seas[mi] || 1);
    if (t >= P){ const e = r[key] - f; sse += e*e; n++; if (f > 0) resid.push(r[key]/f - 1); }
    const prev = level;
    level = alpha * (r[key] / (seas[mi] || 1e-9)) + (1-alpha) * (level + trend);
    trend = beta * (level - prev) + (1-beta) * trend;
    seas[mi] = gamma * (r[key] / (level || 1e-9)) + (1-gamma) * seas[mi];
  });
  return { level, trend, seas, resid, mse: n ? sse/n : Infinity };
}
function etsBestFit(pts, key){
  let best = null;
  for (const a of [0.1,0.2,0.3,0.5]) for (const b of [0.01,0.05,0.1]) for (const g of [0.05,0.1,0.2,0.3]){
    const f = etsFit(pts, key, a, b, g);
    if (!best || f.mse < best.mse) best = f;
  }
  return best;
}
/* project `horizon` months past (lastY, lastM). The 80% band grows with
   the horizon from the relative one-step residuals — an approximation
   (disclosed on the model card), not Prophet's posterior. */
function etsProject(fit, lastY, lastM, horizon){
  const rr = fit.resid.slice(-36);
  const sd = rr.length ? Math.sqrt(rr.reduce((s,x)=>s+x*x,0) / rr.length) : 0.08;
  const Z = 1.2816;                        // 80% two-sided
  const out = [];
  let y = lastY, m = lastM;
  for (let h=1; h<=horizon; h++){
    m++; if (m>11){ m=0; y++; }
    const v = Math.max(0, (fit.level + h*fit.trend)) * (fit.seas[m] || 1);
    const w = Z * sd * Math.sqrt(h);
    out.push({ date:`${y}-${String(m+1).padStart(2,"0")}`, y, m,
      label:`${MONTHS[m]} ${String(y).slice(2)}`,
      v:Math.max(0,Math.round(v)), lo:Math.max(0,Math.round(v*(1-w))), hi:Math.max(0,Math.round(v*(1+w))) });
  }
  return out;
}
/* history -> the same result shape forecastFor() returns (method:"ets").
   Needs >= 24 contiguous months; the holdout backtest needs >= 36. */
function etsForecast(history, key, horizon = 24){
  const all = (history || []).filter(r => r[key] != null);
  if (!all.length) return null;
  // longest contiguous monthly tail — ETS state updates assume no gaps
  let start = all.length - 1;
  while (start > 0){
    const a = all[start-1], b = all[start];
    if ((b.y*12 + b.m) - (a.y*12 + a.m) !== 1) break;
    start--;
  }
  const pts = all.slice(start);
  if (pts.length < 24) return null;

  let mape = null, naiveMape = null, skill = null, coverage = null, backtest = [];
  if (pts.length >= 36){
    const H = 12, train = pts.slice(0, -H), test = pts.slice(-H);
    const bf = etsBestFit(train, key), lastT = train[train.length-1];
    const preds = etsProject(bf, lastT.y, lastT.m, H);
    backtest = preds.map((p,i)=>({ date:p.date, v:p.v, lo:p.lo, hi:p.hi, actual:test[i][key] }));
    const pairs = backtest.filter(r => r.actual);
    if (pairs.length){
      mape = Math.round(pairs.reduce((s,r)=>s+Math.abs(r.v-r.actual)/r.actual,0) / pairs.length * 1000) / 10;
      coverage = Math.round(pairs.filter(r => r.lo <= r.actual && r.actual <= r.hi).length / pairs.length * 100);
    }
    const byYM = {}; train.forEach(r => byYM[r.y+"-"+r.m] = r[key]);
    const np = test.map(r => ({ p:byYM[(r.y-1)+"-"+r.m], a:r[key] })).filter(x => x.p != null && x.a);
    if (np.length){
      naiveMape = Math.round(np.reduce((s,x)=>s+Math.abs(x.p-x.a)/x.a,0) / np.length * 1000) / 10;
      if (mape != null && naiveMape > 0) skill = Math.round((1 - mape/naiveMape) * 100) / 100;
    }
  }
  const fit = etsBestFit(pts, key);
  const last = pts[pts.length-1];
  return { method:"ets", forecast:etsProject(fit, last.y, last.m, horizon),
    mape, mapeFolds:(mape != null ? [mape] : []), naiveMape, skill, coverage, backtest,
    seasIdx:fit.seas.map(v => Math.round(v*1e4)/1e4),
    holidays:[], holidaysTotal:0,
    latest:last.date, monthsHistory:pts.length,
    gdpRegressor:false, gdpForecast:false };
}

/* the one entry point the screens use for a short-term forecast:
   the nightly Prophet output when this gateway has one, otherwise an
   ETS model fit right here on the observed history. */
function tacticalForecast(iata, key, history){
  const p = forecastFor(iata, key);
  if (p) return p;
  if (!availableMetrics(iata).includes(key)) return null;
  return etsForecast(history, key, 24);
}

/* ============================================================
   HISTORY  (real monthly records, no synthesis)
   ============================================================ */
function buildHistory(iata){
  const s = OBSERVED[iata];
  if (!s || !s.pax) return [];
  const keys = availableMetrics(iata);
  const monthSet = new Set();
  keys.forEach(k => Object.keys(s[k]).forEach(ms => monthSet.add(ms)));
  return [...monthSet].sort().map(ms => {
    const y = +ms.slice(0,4), m = +ms.slice(5,7) - 1;
    const rec = { y, m, date:ms, label:`${MONTHS[m]} ${String(y).slice(2)}`, observed:true };
    keys.forEach(k => { if (s[k][ms] != null) rec[k] = s[k][ms]; });
    return rec;
  });
}

/* annual roll-up — n = months present that year (callers can require 12) */
function annualize(history, key){
  const by = {}, cnt = {};
  history.forEach(r => { if (r[key] == null) return; by[r.y] = (by[r.y]||0) + r[key]; cnt[r.y] = (cnt[r.y]||0) + 1; });
  return Object.keys(by).map(y => ({ y:+y, v:Math.round(by[y]), n:cnt[+y] }));
}
function fullYears(history, key){ return annualize(history, key).filter(r => r.n === 12); }

/* a Prophet-free seasonal index, read straight off the observed months —
   each calendar month's average share of an average month, across every
   complete calendar year present. Prophet only fits nightly for the
   committed public feeds, so a custom/uploaded gateway (and any real one
   Prophet hasn't fit yet) has no `seasonal12`; this gives the "Demand
   seasonality" chart something real to show instead of hiding the panel.
   Same 1.0-centered shape as Prophet's fitted seasonal12, just averaged
   from the raw data rather than modeled. */
function observedSeasonality(history, key){
  const completeYears = new Set(fullYears(history, key).map(r => r.y));
  if (!completeYears.size) return null;
  const sums = Array(12).fill(0), counts = Array(12).fill(0);
  history.forEach(r => {
    if (r[key] == null || !completeYears.has(r.y)) return;
    sums[r.m] += r[key]; counts[r.m] += 1;
  });
  const monthAvg = sums.map((s, i) => s / counts[i]);
  const overall = monthAvg.reduce((a, b) => a + b, 0) / 12;
  if (!overall) return null;
  return monthAvg.map(v => v / overall);
}

/* ============================================================
   LONG-TERM STRATEGIC MODEL  (elasticity, monthly, real base)
   demand growth gₜ = gdpPerCap·ε + pop + tourism·τ + lcc − yieldDrag
   PAX compounds at the monthly-equivalent of gₜ riding the real
   base-year seasonal shape. Movements are held proportional to
   passengers at the latest observed ratio; cargo compounds on its
   own elasticity. Only metrics with real data are projected.
   ============================================================ */
function defaultScenario(iata){
  const a = AIRPORTS.find(x=>x.iata===iata);
  const m = (a && MACRO[a.cc]) || MACRO_DEFAULT;
  return {
    gdp: (m.gdpcapProj != null ? m.gdpcapProj : m.gdpcap),
    elasticity: m.elasticity,
    pop: m.pop,
    tourism: 0,
    fuel: 0,
    lcc: 0,
    cargo: 0,    // freight-specific growth shift (on top of the pax-linked trend)
    gauge: 0,    // aircraft up-gauging — movements grow slower than passengers
    seg_domestic: 0,      // per-segment demand shift (%/yr), only bite when the
    seg_transborder: 0,   // gateway publishes that passenger segment
    seg_international: 0,
    events: [],           // discrete time-bound shocks (e.g. a pandemic)
    paxCap: null,         // annual passenger capacity (null/0 = unconstrained)
    atmCap: null,         // annual movements capacity (null/0 = unconstrained)
    capGauge: 1.5,        // extra up-gauging %/yr once the movements cap binds
    capGaugeMax: 25,      // ceiling on total pax-per-movement growth vs base year (%)
    bellyShare: 50,       // share of cargo riding passenger-aircraft bellyhold (%)
    horizon: 25,
  };
}

function longTermForecast(iata, history, scenario){
  const s = scenario;
  const paxYears = fullYears(history, "pax");
  if (!paxYears.length) return null;
  const baseYear = paxYears[paxYears.length-1].y;
  const annualPax = paxYears[paxYears.length-1].v;
  const baseMonths = history.filter(r => r.y===baseYear && r.pax!=null).sort((a,b)=>a.m-b.m);
  if (baseMonths.length < 12) return null;

  const atmYears = fullYears(history, "atm");
  const cargoYears = fullYears(history, "cargo");
  const annualAtm = atmYears.length ? atmYears[atmYears.length-1].v : null;
  const annualCargo = cargoYears.length ? cargoYears[cargoYears.length-1].v : null;
  const hasAtm = annualAtm != null && baseMonths.every(r => r.atm != null);
  const hasCargo = annualCargo != null;

  const gIncome  = s.gdp * s.elasticity;
  const gPop     = s.pop;
  const gTourism = s.tourism * 0.5;
  const gLCC     = s.lcc;
  const yieldDrag = -s.fuel * 0.18;
  const gDemand = (gIncome + gPop + gTourism + gLCC + yieldDrag) / 100;
  // cargo rides the demand trend at a damped beta, plus a freight-specific shift
  const gCargo  = gDemand * 0.6 + 0.005 + (s.cargo || 0) / 100;
  // movements track passengers, less an up-gauging drag (bigger/fuller aircraft
  // carry the same passengers in fewer flights). gauge=0 ⇒ proportional to pax.
  const gMovements = gDemand - (s.gauge || 0) / 100;

  const basePax = {}, baseCargo = {}, baseAtm = {};
  baseMonths.forEach(r => { basePax[r.m] = r.pax; if (r.cargo != null) baseCargo[r.m] = r.cargo; if (r.atm != null) baseAtm[r.m] = r.atm; });
  const cargoMonthAvg = hasCargo ? annualCargo / 12 : null;
  const atmMonthAvg   = hasAtm   ? annualAtm / 12   : null;

  /* ---- optional passenger segment composition ----
     If the gateway publishes domestic/transborder/international splits with a
     complete base year, project each segment on its own shift and let the total
     fall out as their sum. Segments are scaled to the observed total each base
     month so the baseline reconciles exactly with the headline pax series. */
  const segStore = SEGMENTS[iata];
  let segKeys = [];
  const segBase = {};               // k -> { mm: scaled base-year monthly }
  if (segStore) {
    for (const seg of PAX_SEGMENTS) {
      const ser = segStore[seg.k]; if (!ser) continue;
      const mvals = {}; let ok = true;
      for (let mm=0; mm<12; mm++){
        const key = `${baseYear}-${String(mm+1).padStart(2,"0")}`;
        if (ser[key] == null) { ok = false; break; }
        mvals[mm] = ser[key];
      }
      if (ok) { segKeys.push(seg.k); segBase[seg.k] = mvals; }
    }
    if (segKeys.length < 2) segKeys = [];   // need a real split to be worth it
  }
  const hasSeg = segKeys.length > 0;
  if (hasSeg) {
    for (let mm=0; mm<12; mm++){
      const sum = segKeys.reduce((t,k)=>t+(segBase[k][mm]||0),0);
      const factor = (sum>0 && basePax[mm]!=null) ? basePax[mm]/sum : 1;
      segKeys.forEach(k => segBase[k][mm] *= factor);
    }
  }
  const gSeg = {};
  segKeys.forEach(k => gSeg[k] = gDemand + (s["seg_"+k] || 0) / 100);

  /* ---- discrete shock events (e.g. a pandemic, a route collapse) ----
     Each event applies a multiplicative shock over a window: peak impact held
     for `length` months, then either a linear glide back to baseline over
     `recovery` months (full recovery) or — if `permanent` — the shifted level
     persists and the rest of the forecast re-baselines off it. An event can hit
     all traffic (`target:"all"`) or a single passenger segment, which reshapes
     the mix. Overlapping events compound. */
  const events = Array.isArray(s.events) ? s.events.filter(e => e && e.start) : [];
  function eventFactor(ev, y, m){
    const p = String(ev.start).split("-"); const sy = +p[0], sm = +(p[1]||1);
    const d = (y*12 + m) - (sy*12 + (sm-1));
    if (d < 0) return 1;
    const peak = (+ev.peak||0)/100;
    const len = Math.max(0, Math.round(+(ev.length != null ? ev.length : ev.hold) || 0));
    if (d < len) return 1 + peak;
    if (ev.permanent) return 1 + peak;
    const rec = Math.max(0, Math.round(+ev.recovery || 0));
    if (rec > 0 && d < len + rec) return 1 + peak * (1 - (d - len + 1) / rec);
    return 1;
  }

  const months = [];
  let yy = baseYear, mm = 11;
  const total = s.horizon * 12;
  for (let k=1; k<=total; k++){
    mm++; if (mm>11){ mm=0; yy++; }
    const yf = k/12;
    let pax, segRec = null;
    if (hasSeg){
      segRec = {}; pax = 0;
      for (const sk of segKeys){ const v = (segBase[sk][mm]||0) * Math.pow(1+gSeg[sk], yf); segRec[sk] = Math.round(v); pax += v; }
    } else {
      pax = (basePax[mm] != null ? basePax[mm] : annualPax/12) * Math.pow(1+gDemand, yf);
    }
    const rec = { y:yy, m:mm, date:`${yy}-${String(mm+1).padStart(2,"0")}`,
      label:`${MONTHS[mm]} ${String(yy).slice(2)}`, pax:Math.round(pax) };
    if (segRec)   rec.seg   = segRec;
    if (hasAtm)   rec.atm   = Math.round((baseAtm[mm]   != null ? baseAtm[mm]   : atmMonthAvg)   * Math.pow(1+gMovements, yf));
    if (hasCargo) rec.cargo = Math.round((baseCargo[mm] != null ? baseCargo[mm] : cargoMonthAvg) * Math.pow(1+gCargo, yf));
    if (events.length){
      let touched = false;
      for (const ev of events){
        const f = eventFactor(ev, yy, mm); if (f === 1) continue;
        touched = true;
        const tgt = ev.target || "all";
        if (rec.seg && tgt !== "all" && rec.seg[tgt] != null){ rec.seg[tgt] *= f; }   // reshape one segment
        else {                                                                         // all traffic
          if (rec.seg) for (const k in rec.seg) rec.seg[k] *= f; else rec.pax *= f;
          if (rec.atm   != null) rec.atm   *= f;
          if (rec.cargo != null) rec.cargo *= f;
        }
      }
      if (touched){
        if (rec.seg){ for (const k in rec.seg) rec.seg[k] = Math.round(rec.seg[k]); rec.pax = Object.values(rec.seg).reduce((t,v)=>t+v,0); }
        else rec.pax = Math.round(rec.pax);
        if (rec.atm   != null) rec.atm   = Math.round(rec.atm);
        if (rec.cargo != null) rec.cargo = Math.round(rec.cargo);
      }
    }
    months.push(rec);
  }

  const segAnnual = (ms) => { const o = {}; segKeys.forEach(k => o[k] = ms.reduce((t,r)=>t+((r.seg&&r.seg[k])||0),0)); return o; };
  const rows = [{ y:baseYear, pax:annualPax, base:true,
    ...(hasAtm?{atm:annualAtm}:{}), ...(hasCargo?{cargo:annualCargo}:{}),
    ...(hasSeg?{seg: (()=>{ const o={}; segKeys.forEach(k=>o[k]=Math.round(Object.values(segBase[k]).reduce((t,v)=>t+v,0))); return o; })()}:{}) }];
  for (let i=1; i<=s.horizon; i++){
    const yr = baseYear+i, ms = months.filter(r => r.y===yr);
    const row = { y:yr, pax: ms.reduce((t,r)=>t+r.pax,0) };
    if (hasAtm)   row.atm   = ms.reduce((t,r)=>t+(r.atm||0),0);
    if (hasCargo) row.cargo = ms.reduce((t,r)=>t+(r.cargo||0),0);
    if (hasSeg)   row.seg   = segAnnual(ms);
    rows.push(row);
  }
  /* ---- capacity constraints (a coupled system, not independent clamps) ----
     Unconstrained demand above is what the market *wants*; capacity is what
     the infrastructure can *serve* — and the metrics are physically linked,
     so one binding cap propagates to all of them:

       · A MOVEMENTS cap (slots/runway) doesn't freeze passengers at the
         flight-implied level: airlines respond by up-gauging — bigger
         aircraft, denser layouts, higher load factors. That response is
         `capGauge` extra %/yr on passengers-per-movement, accruing only
         while the cap actually binds, and it runs out: total pax-per-
         movement growth is ceilinged at `capGaugeMax` % above the observed
         base year (stand sizes, runway mix and the fleet only stretch so
         far). Constrained pax = capped flights × that bounded ratio.
       · A PASSENGER cap (terminal) pulls movements down with it — airlines
         don't fly the schedule demand can't fill. Constrained movements =
         the flights constrained passengers actually need at the year's
         unconstrained pax-per-movement ratio (never above the slot cap).
       · CARGO rides along: `bellyShare` % of tonnage travels in passenger-
         aircraft bellies, so that share scales with constrained passenger
         activity (up-gauged aircraft bring more belly space, which the
         pax ratio already reflects). Freighters — the rest — are assumed
         unconstrained (they can shift off-peak); a freighter-specific cap
         is a future refinement, not modeled.

     Each capped year's months are scaled proportionally per metric (a
     disclosed simplification; real spill concentrates in peak months).
     The unconstrained series is left untouched so the two can be charted
     against each other, and `spill` = demand the infrastructure can't
     serve. All three response assumptions are levers on the Baseline
     assumptions screen. */
  const paxCap = (+s.paxCap > 0) ? +s.paxCap : null;
  const atmCap = (hasAtm && +s.atmCap > 0) ? +s.atmCap : null;
  const hasCap = !!(paxCap || atmCap);
  let capAssumptions = null;
  if (hasCap){
    const capGauge = Math.max(0, +s.capGauge || 0) / 100;
    const capGaugeMax = Math.max(0, +s.capGaugeMax || 0) / 100;
    const bellyShare = Math.min(1, Math.max(0, (s.bellyShare == null ? 50 : +s.bellyShare) / 100));
    capAssumptions = { capGauge: capGauge*100, capGaugeMax: capGaugeMax*100, bellyShare: bellyShare*100 };
    const ratioBase = (hasAtm && annualAtm > 0) ? annualPax / annualAtm : null;
    const ratioCeil = ratioBase != null ? ratioBase * (1 + capGaugeMax) : null;
    const monthsByYear = {};
    months.forEach(r => { (monthsByYear[r.y] = monthsByYear[r.y] || []).push(r); });
    let gaugeYears = 0;   // years the movements cap has been binding
    rows.forEach(row => {
      if (row.base){
        // observed year — carries its own values so the chart lines connect
        row.paxC = row.pax; row.spill = 0;
        if (row.atm != null) row.atmC = row.atm;
        if (row.cargo != null) row.cargoC = row.cargo;
        return;
      }
      const ms = monthsByYear[row.y] || [];
      const paxU = row.pax, atmU = row.atm, cargoU = row.cargo;

      // 1. slots: capped flights, and the bounded-up-gauging pax ceiling
      let atmC = (atmU != null && atmCap) ? Math.min(atmU, atmCap) : atmU;
      let paxFromAtm = Infinity;
      if (atmCap && atmU != null && atmU > atmCap && ratioBase != null && atmU > 0){
        gaugeYears++;
        const ratioU = paxU / atmU;
        // extra gauge compounds only over binding years, on top of whatever
        // ratio drift the baseline gauge lever already produced — and never
        // past the physical ceiling (if baseline drift already exceeds the
        // ceiling, there's simply no response headroom left)
        const ratioEff = ratioU >= ratioCeil ? ratioU
          : Math.min(ratioU * Math.pow(1 + capGauge, gaugeYears), ratioCeil);
        paxFromAtm = atmCap * ratioEff;
      }

      // 2. passengers: demand vs terminal cap vs slot-implied capacity
      const paxC = Math.min(paxU, paxCap || Infinity, paxFromAtm);

      // 3. movements follow constrained passengers (never above the slot cap)
      if (atmU != null && atmU > 0){
        const flightsNeeded = paxC / (paxU / atmU);
        atmC = Math.min(atmC, Math.max(flightsNeeded, 0));
      }

      // 4. bellyhold cargo scales with constrained passenger activity
      let cargoC = cargoU;
      if (cargoU != null && paxU > 0){
        cargoC = cargoU * (1 - bellyShare * (1 - paxC / paxU));
      }

      row.paxC = Math.round(paxC);
      row.spill = Math.round(paxU - paxC);
      if (atmU != null)   row.atmC   = Math.round(atmC);
      if (cargoU != null) row.cargoC = Math.round(cargoC);
      const fPax = paxU > 0 ? paxC/paxU : 1;
      const fAtm = (atmU != null && atmU > 0) ? atmC/atmU : 1;
      const fCargo = (cargoU != null && cargoU > 0) ? cargoC/cargoU : 1;
      ms.forEach(r => {
        r.paxC = Math.round(r.pax * fPax);
        if (r.atm != null)   r.atmC   = Math.round(r.atm * fAtm);
        if (r.cargo != null) r.cargoC = Math.round(r.cargo * fCargo);
      });
    });
  }

  const cagr = Math.pow(rows[rows.length-1].pax/annualPax, 1/s.horizon) - 1;
  return { rows, months, baseYear, endYear:baseYear+s.horizon, hasAtm, hasCargo,
    hasCap, paxCap, atmCap, capAssumptions,
    hasSeg, segKeys, segLabels: segKeys.map(k => (PAX_SEGMENTS.find(p=>p.k===k)||{}).label || k),
    segColors: segKeys.map(k => (PAX_SEGMENTS.find(p=>p.k===k)||{}).color || "var(--cyan)"),
    gDemand:gDemand*100, cagr:cagr*100,
    breakdown:[
      { k:"Income × elasticity", v:gIncome, c:"var(--pink)" },
      { k:"Catchment population", v:gPop, c:"var(--cyan)" },
      { k:"Tourism shift", v:gTourism, c:"var(--lime)" },
      { k:"LCC / route stimulation", v:gLCC, c:"var(--violet)" },
      { k:"Yield / fuel drag", v:yieldDrag, c:"var(--bad)" },
    ] };
}

/* metric display metadata (data-driven toggles) */
const METRIC_META = {
  pax:   { key:"pax",   label:"Passengers", unit:"" },
  atm:   { key:"atm",   label:"Movements",  unit:"" },
  cargo: { key:"cargo", label:"Cargo",      unit:"t" },
};

/* ---- design-day / peak-hour derivation ----
   Terminal and runway planning happens at design-day and peak-hour
   granularity, not annual. Without daily/hourly data these are derived
   from the monthly seasonal shape with disclosed heuristics:
   busy day = average day of the peak month × 1.10 (a stand-in for the
   ~90th-percentile day), and the peak hour takes a share of the busy day
   that shrinks as airports grow (traffic spreads out): 12% under 1M
   annual pax, 10% to 10M, 8% above. Every consumer of these numbers
   shows the assumptions next to them. */
function designDay(annualPax, seasIdx){
  if (!(annualPax > 0) || !Array.isArray(seasIdx) || seasIdx.length !== 12) return null;
  const peakMonth = seasIdx.indexOf(Math.max(...seasIdx));
  const peakMonthPax = annualPax/12 * seasIdx[peakMonth];
  const avgDay = peakMonthPax / 30.4;
  const busyDay = avgDay * 1.10;
  const peakHourShare = annualPax >= 10e6 ? 0.08 : annualPax >= 1e6 ? 0.10 : 0.12;
  return { peakMonth, peakMonthPax, avgDay, busyDay, peakHour: busyDay*peakHourShare, peakHourShare };
}

/* ---- share links ----
   A scenario for a CATALOGUE gateway fits in a URL: #s=<base64url JSON>
   carrying the iata + every lever/event. The receiving app re-fetches the
   real data from the live pipeline, so nothing but assumptions travels.
   (An uploaded gateway's data lives only in that visitor's browser — it
   round-trips via Export ▸ Save session instead.) Decoding treats the
   payload as hostile: only known numeric levers survive, events are
   whitelisted field-by-field and length-capped. */
const SHARE_KIND = "gp1";
function b64urlEncode(str){
  const bytes = new TextEncoder().encode(str);
  let bin = ""; for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function b64urlDecode(s){
  let b = String(s).replace(/-/g,"+").replace(/_/g,"/");
  while (b.length % 4) b += "=";
  const bin = atob(b); const bytes = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
const SHARE_NUM_KEYS = ["gdp","elasticity","pop","tourism","fuel","lcc","cargo","gauge",
  "seg_domestic","seg_transborder","seg_international","horizon",
  "paxCap","atmCap","capGauge","capGaugeMax","bellyShare"];
function sanitizeSharedScenario(sc){
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) return null;
  const out = {};
  for (const k of SHARE_NUM_KEYS){
    const v = sc[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  if (Array.isArray(sc.events)){
    out.events = sc.events.slice(0, 20).map(e => {
      if (!e || typeof e !== "object" || !/^\d{4}-\d{2}$/.test(String(e.start))) return null;
      return {
        id: (typeof e.id === "number" && Number.isFinite(e.id)) ? e.id : Math.floor(Math.random()*1e9),
        label: String(e.label || "Event").slice(0, 80),
        start: String(e.start),
        peak: (typeof e.peak === "number" && Number.isFinite(e.peak)) ? e.peak : 0,
        length: Math.max(0, Math.round(+e.length || 0)),
        recovery: Math.max(0, Math.round(+e.recovery || 0)),
        permanent: !!e.permanent,
        target: ["all","domestic","transborder","international"].includes(e.target) ? e.target : "all",
      };
    }).filter(Boolean);
  }
  return out;
}
function encodeShare(iata, scenario){
  return b64urlEncode(JSON.stringify({ k:SHARE_KIND, iata, scenario }));
}
function decodeShare(s){
  try {
    const p = JSON.parse(b64urlDecode(s));
    if (!p || p.k !== SHARE_KIND || typeof p.iata !== "string" || !/^[A-Za-z0-9-]{3,12}$/.test(p.iata)) return null;
    return { iata: p.iata.toUpperCase(), scenario: sanitizeSharedScenario(p.scenario) };
  } catch(e){ return null; }
}

/* age of a snapshot in days (fractional) — drives the staleness banner
   when the nightly refresh has quietly stopped landing. */
function dataAgeDays(iso, now){
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  return ((now != null ? now : Date.now()) - t) / 86400000;
}

/* ---- export sanitizers ----
   Strings that end up inside a generated file can come from outside the
   app's own code: an uploaded gateway name, an event label typed by the
   visitor (or read back from an imported session file), or an airport
   name from the OpenFlights feed. React escapes them on screen, but the
   export generators build raw CSV / HTML, so they escape here. */

/* one CSV cell: quote/escape when needed, and neutralize spreadsheet
   formula injection (a leading =, +, -, @ or tab would otherwise execute
   as a formula when the CSV is opened in Excel). */
function csvCell(v){
  let s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* minimal HTML entity escape for the DOCX (HTML) brief generator. */
function escapeHtml(v){
  return String(v == null ? "" : v).replace(/[&<>"']/g,
    c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

const fmt = {
  int:  n => Math.round(n).toLocaleString("en-US"),
  k:    n => n>=1e6 ? (n/1e6).toFixed(2)+"M" : n>=1e3 ? (n/1e3).toFixed(0)+"K" : Math.round(n).toString(),
  k1:   n => n>=1e6 ? (n/1e6).toFixed(1)+"M" : n>=1e3 ? Math.round(n/1e3)+"K" : Math.round(n).toString(),
  pct:  (n,d=1) => (n>=0?"+":"")+n.toFixed(d)+"%",
  pct0: (n,d=1) => n.toFixed(d)+"%",
  t:    n => n>=1e3 ? (n/1e3).toFixed(1)+"k t" : Math.round(n)+" t",
};

Object.assign(window, {
  AIRPORTS, MACRO, MONTHS, METRIC_META,
  GP_buildHistory:buildHistory, GP_annualize:annualize, GP_fullYears:fullYears,
  GP_observedSeasonality:observedSeasonality,
  GP_longTerm:longTermForecast, GP_defaultScenario:defaultScenario,
  GP_forecastFor:forecastFor, GP_hasForecast:hasForecast,
  GP_availableMetrics:availableMetrics, GP_liveAirports:liveAirports,
  GP_sourceLabel:sourceLabel, GP_sourceBadge:sourceBadge,
  GP_segmentsFor:segmentsFor, GP_PAX_SEGMENTS:PAX_SEGMENTS,
  GP_fmt:fmt, GP_activityFor:activityFor,
  GP_setActivityIndex:setActivityIndex, GP_setAirportSeries:setAirportSeries, GP_hasAirportSeries:hasAirportSeries,
  GP_getObservedSeries:getObservedSeries, GP_getActivityMeta:getActivityMeta,
  GP_setForecastMeta:setForecastMeta, GP_setAirportForecast:setAirportForecast,
  GP_setReference:setReference, GP_rebuildAirports:rebuildAirports, GP_ensureMacro:ensureMacro,
  GP_registerCustomAirport:registerCustomAirport, GP_removeCustomAirport:removeCustomAirport, GP_parseMonthKey:parseMonthKey,
  GP_guessColumnRole:guessColumnRole, GP_guessColumnRoles:guessColumnRoles,
  GP_csvCell:csvCell, GP_escapeHtml:escapeHtml,
  GP_tacticalForecast:tacticalForecast, GP_etsForecast:etsForecast,
  GP_designDay:designDay, GP_dataAgeDays:dataAgeDays,
  GP_encodeShare:encodeShare, GP_decodeShare:decodeShare,
});

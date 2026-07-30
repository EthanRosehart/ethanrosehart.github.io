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
function getSegments(iata){ return SEGMENTS[iata] || null; }
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
function registerCustomAirport(iata, meta, series, paxSeg){
  if (!ACTIVITY_META || !ACTIVITY_META.airports) ACTIVITY_META = { airports:{} };
  OBSERVED[iata] = series;
  // optional sector split (domestic / transborder / international) from the
  // upload — kept only when at least two sectors actually carry data (one
  // sector isn't a split). Runs through the exact same SEGMENTS store the
  // pipeline feeds, so the mix donut, per-sector levers and sector-targeted
  // events all work for uploaded gateways too.
  const segKeys = paxSeg ? PAX_SEGMENTS.map(s=>s.k).filter(k => paxSeg[k] && Object.keys(paxSeg[k]).length) : [];
  if (segKeys.length >= 2) {
    SEGMENTS[iata] = {};
    segKeys.forEach(k => { SEGMENTS[iata][k] = paxSeg[k]; });
  } else {
    delete SEGMENTS[iata];
  }
  const paxKeys = Object.keys(series.pax || {});
  // register metadata (incl. `metrics`) BEFORE computing annualPax — buildHistory()
  // reads availableMetrics(), which reads this same metadata, so annualPax's
  // buildHistory()/fullYears() call has to run after this object exists, not before.
  ACTIVITY_META.airports[iata] = {
    ...meta,
    observed: true, source: "custom", custom: true,
    metrics: METRIC_KEYS.filter(m => series[m] && Object.keys(series[m]).length),
    hasPaxSeg: segKeys.length >= 2,
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
   upload wizard's default mapping — the user can always override it.
   Sector columns are tested BEFORE the plain pax pattern so a header like
   "Domestic passengers" maps to the domestic sector, not to the headline. */
function guessColumnRole(header){
  const h = String(header || "").toLowerCase();
  if (/date|month|period/.test(h)) return "date";
  if (/domestic|^dom\b|^dom[. ]/.test(h)) return "seg_domestic";
  if (/transborder|trans-border|transb/.test(h)) return "seg_transborder";
  if (/internat|intl|int'l/.test(h)) return "seg_international";
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
   SHORT-TERM FORECASTS, precomputed nightly.
   data/forecast-meta.json — shared model metadata (generatedAt, interval,
   horizon), loaded once on mount. data/forecasts/<IATA>.json — one
   airport's forecast per metric, fetched lazily once selected:
   iata -> metric -> { chosen, candidates{}, mase, mape, seasonal12,
                       holidays, forecast[], backtest[] }

   The nightly fits THREE candidates per series (seasonal naive, damped
   Holt-Winters, Prophet), scores them on identical rolling-origin folds and
   publishes whichever won on MASE — see scripts/build-forecast.py for why
   MASE and not MAPE. The winner's arrays sit at the TOP LEVEL of the metric;
   `candidates` carries every candidate's scores plus the ALTERNATIVES'
   forecasts, which is what the model toggle on the tactical screen switches
   to. Nothing is fit in the browser for a catalogue gateway.
   ============================================================ */
/* the candidate models, ordered simplest-first to match build-forecast.py's
   CANDIDATES — the toggle renders in this order. `browser` marks the one that
   can also be fit client-side, for gateways with no nightly output at all. */
const MODEL_META = {
  snaive:  { key:"snaive",  label:"Seasonal naive", short:"Naive",   browser:false,
             blurb:"Each month repeats the most recent observed value for that calendar month." },
  ets:     { key:"ets",     label:"Holt-Winters",   short:"ETS",     browser:true,
             blurb:"Exponential smoothing — damped trend plus multiplicative monthly seasonality." },
  prophet: { key:"prophet", label:"Meta Prophet",   short:"Prophet", browser:false,
             blurb:"Additive trend, yearly Fourier seasonality, country holidays and COVID events." },
};
const MODEL_KEYS = ["snaive", "ets", "prophet"];

const FORECASTS = {};
let FORECAST_META = null;
/* bumped whenever a nightly payload lands, so the long-term model's base-year
   memo (see baseYearFor) can't keep serving a base it built before the forecast
   for this gateway had arrived */
let FORECAST_VERSION = 0;
function setForecastMeta(json){
  FORECAST_META = json;
  window.GP_FORECAST_META = json;
}
function setAirportForecast(iata, json){
  FORECASTS[iata] = json || {};
  FORECAST_VERSION++;
}
function hasForecast(iata, key){
  const a = FORECASTS[iata];
  return key ? !!(a && a[key]) : !!(a && Object.keys(a).length);
}
/* which model the nightly published for this series. A snapshot written before
   candidate selection existed has no `chosen` — it was Prophet by definition. */
function chosenModel(m){
  return (m && m.candidates && m.chosen && m.candidates[m.chosen]) ? m.chosen : "prophet";
}
/* every model available for one series, in simplest-first order, with the
   scores each earned on the SAME folds — the data behind the model toggle.
   Empty when this gateway has no nightly output (nothing to choose between). */
function forecastModels(iata, key){
  const m = FORECASTS[iata] && FORECASTS[iata][key];
  if (!m) return [];
  const chosen = chosenModel(m);
  const cands = m.candidates || { prophet:{ mase:m.mase, mape:m.mape, coverage:m.coverage } };
  return MODEL_KEYS.filter(k => cands[k]).map(k => ({
    ...MODEL_META[k],
    mase: cands[k].mase ?? null,
    mape: cands[k].mape ?? null,
    coverage: cands[k].coverage ?? null,
    chosen: k === chosen,
  }));
}
/* one metric's nightly forecast, as one of the candidate models it published.
   `prefer` names a model; omitted — or naming one this series doesn't carry —
   falls back to the model the nightly chose by MASE. */
function forecastFor(iata, key, prefer){
  const m = FORECASTS[iata] && FORECASTS[iata][key];
  if (!m) return null;
  const chosen = chosenModel(m);
  const cands = m.candidates || null;
  const want = (prefer && cands && cands[prefer]) ? prefer : chosen;
  const c = (cands && cands[want]) || {};
  // the chosen model's arrays live at the top level, never duplicated inside
  // `candidates` (see build-forecast.py) — so read them from whichever place
  // the requested model keeps them
  const isChosen = want === chosen;
  const src = isChosen ? m : c;                 // where this model's own values live
  const rows = (isChosen ? m.forecast : c.forecast) || [];
  const forecast = rows.map(r => ({ ...r, label:`${MONTHS[r.m]} ${String(r.y).slice(2)}` }));
  const mape = src.mape ?? null;
  // the seasonal-naive benchmark is a sibling candidate now, so it's scored on
  // exactly the folds every other model was
  const naiveMape = (cands && cands.snaive ? cands.snaive.mape : m.naive_mape) ?? null;
  return { forecast, method:want, source:"nightly",
    chosen, chosenReason:m.chosen_reason || null,
    mase:src.mase ?? null, maseFolds:src.mase_folds || [],
    // unscaled MAE — only meaningful when MASE came back null, which happens on
    // a series with no year-over-year variation to scale by (the nightly ranks
    // on MAE there; see build-forecast.py's choose_model)
    mae:src.mae ?? null,
    mape, mapeFolds:src.mape_folds || [],
    naiveMape,
    naiveMase:(cands && cands.snaive ? cands.snaive.mase : m.naive_mase) ?? null,
    // recomputed per model rather than read off the payload, so switching the
    // toggle reports the skill of the model you're actually looking at
    skill:(mape != null && naiveMape) ? Math.round((1 - mape/naiveMape) * 100) / 100 : null,
    // `coverage` is the RAW band's measured coverage — honestly out-of-sample.
    // `bandScale`/`coverageCal` describe the band actually plotted, which was
    // stretched to hit the nominal interval; that factor was fitted on these
    // same held-out months, so its coverage is in-sample and says so.
    coverage:src.coverage ?? null,
    bandScale:src.band_scale ?? null, coverageCal:src.coverage_cal ?? null,
    backtest:(isChosen ? m.backtest : c.backtest) || [],
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
  const floor = Math.max(1e-9, 1e-6 * (pts.reduce((t,r)=>t+r[key],0) / pts.length));
  const resid = []; let sse = 0, n = 0;
  pts.forEach((r,t)=>{
    const mi = r.m, f = (level + trend) * (seas[mi] || 1);
    if (t >= P){ const e = r[key] - f; sse += e*e; n++; if (f > 0) resid.push(r[key]/f - 1); }
    const prev = level;
    // a multiplicative seasonal model has no meaning at or below zero: on a
    // collapsing series the level crosses zero, r[key]/level flips sign, and the
    // seasonal index goes negative — which makes the point forecast negative and
    // inverts the band around it. Floor both, scaled to the series.
    level = Math.max(floor, alpha * (r[key] / (seas[mi] || floor)) + (1-alpha) * (level + trend));
    trend = beta * (level - prev) + (1-beta) * trend;
    seas[mi] = Math.max(floor, gamma * (r[key] / (level || floor)) + (1-gamma) * seas[mi]);
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
    // clamp the product, not just the level — a negative seasonal factor would
    // otherwise turn a clamped-positive level into a negative forecast
    const v = Math.max(0, (fit.level + h*fit.trend) * (fit.seas[m] || 1));
    const w = Z * sd * Math.sqrt(h);
    const lo = Math.max(0, Math.round(v*(1-w))), hi = Math.max(0, Math.round(v*(1+w))), vr = Math.max(0, Math.round(v));
    out.push({ date:`${y}-${String(m+1).padStart(2,"0")}`, y, m,
      label:`${MONTHS[m]} ${String(y).slice(2)}`,
      v:vr, lo:Math.min(lo, vr, hi), hi:Math.max(lo, vr, hi) });
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

  let mape = null, mase = null, naiveMape = null, naiveMase = null, skill = null,
      coverage = null, bandScale = null, coverageCal = null, backtest = [];
  if (pts.length >= 36){
    const H = 12, train = pts.slice(0, -H), test = pts.slice(-H);
    const bf = etsBestFit(train, key), lastT = train[train.length-1];
    const preds = etsProject(bf, lastT.y, lastT.m, H);
    backtest = preds.map((p,i)=>({ date:p.date, v:p.v, lo:p.lo, hi:p.hi, actual:test[i][key] }));
    const byYM = {}; train.forEach(r => byYM[r.y+"-"+r.m] = r[key]);
    // MASE's denominator: mean |yₜ − yₜ₋₁₂| over the TRAINING months only, so
    // the scale can't leak the holdout it normalises. Same definition the
    // nightly uses (build-forecast.py) — the two have to agree or the numbers
    // on the model card aren't comparable across gateways.
    const steps = train.map(r => (byYM[(r.y-1)+"-"+r.m] != null ? Math.abs(r[key] - byYM[(r.y-1)+"-"+r.m]) : null)).filter(v => v != null);
    const scale = steps.length ? steps.reduce((a,b)=>a+b,0) / steps.length : null;
    if (backtest.length && scale > 0){
      mase = Math.round(backtest.reduce((s,r)=>s+Math.abs(r.v-r.actual),0) / backtest.length / scale * 1000) / 1000;
    }
    const pairs = backtest.filter(r => r.actual);
    if (pairs.length){
      mape = Math.round(pairs.reduce((s,r)=>s+Math.abs(r.v-r.actual)/r.actual,0) / pairs.length * 1000) / 10;
      coverage = Math.round(pairs.filter(r => r.lo <= r.actual && r.actual <= r.hi).length / pairs.length * 100);
    }
    const np = test.map(r => ({ p:byYM[(r.y-1)+"-"+r.m], a:r[key] })).filter(x => x.p != null);
    if (np.length && scale > 0){
      naiveMase = Math.round(np.reduce((s,x)=>s+Math.abs(x.p-x.a),0) / np.length / scale * 1000) / 1000;
    }
    const npNz = np.filter(x => x.a);
    if (npNz.length){
      naiveMape = Math.round(npNz.reduce((s,x)=>s+Math.abs(x.p-x.a)/x.a,0) / npNz.length * 1000) / 10;
      if (mape != null && naiveMape > 0) skill = Math.round((1 - mape/naiveMape) * 100) / 100;
    }
    /* Band calibration, the same measure the nightly applies (band_scale_of in
       build-forecast.py): each held-out month's error in units of its own
       one-sided band, then the 80th percentile of that. The raw ETS band grows
       from in-sample residuals and systematically over-covers, so an
       uncalibrated "80% interval" is mislabeled here exactly as it was
       server-side. One 12-month holdout is a thin sample, hence the same clamp
       and a floor on how few points will be trusted at all. */
    const zs = backtest.map(r => {
      const half = r.actual > r.v ? (r.hi - r.v) : (r.v - r.lo);
      return half > 0 ? Math.abs(r.actual - r.v) / half : null;
    }).filter(z => z != null).sort((a,b)=>a-b);
    if (zs.length >= 8){
      const pos = 0.8 * (zs.length - 1), i = Math.floor(pos);
      const q = zs[i] + (zs[Math.min(i+1, zs.length-1)] - zs[i]) * (pos - i);
      if (q > 0){
        bandScale = Math.round(Math.min(4, Math.max(0.25, q)) * 1000) / 1000;
        coverageCal = Math.round(zs.filter(z => z <= bandScale).length / zs.length * 100);
      }
    }
  }
  const fit = etsBestFit(pts, key);
  const last = pts[pts.length-1];
  // the forward band is calibrated; `backtest` above deliberately keeps its raw
  // band, since the factor was fitted on exactly those months
  const forecast = etsProject(fit, last.y, last.m, horizon).map(r => bandScale ? {
    ...r, lo:Math.max(0, Math.round(r.v - (r.v - r.lo) * bandScale)),
    hi:Math.max(0, Math.round(r.v + (r.hi - r.v) * bandScale)),
  } : r);
  return { method:"ets", source:"browser", chosen:"ets", chosenReason:null, forecast,
    mape, mapeFolds:(mape != null ? [mape] : []),
    mase, maseFolds:(mase != null ? [mase] : []),
    naiveMape, naiveMase, skill, coverage, bandScale, coverageCal, backtest,
    seasIdx:fit.seas.map(v => Math.round(v*1e4)/1e4),
    holidays:[], holidaysTotal:0,
    latest:last.date, monthsHistory:pts.length,
    gdpRegressor:false, gdpForecast:false };
}

/* the one entry point the screens use for a short-term forecast: the nightly
   output when this gateway has one — as `model`, or as whichever candidate the
   nightly chose when `model` is omitted or unavailable — otherwise an ETS model
   fit right here on the observed history (an uploaded gateway, or a real one
   the nightly hasn't cleared its history minimum for). */
function tacticalForecast(iata, key, history, model){
  const p = forecastFor(iata, key, model);
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
    capSteps: [],         // phased capacity: [{year, paxCap?, atmCap?}] — a capital project
    capGauge: 1.5,        // extra up-gauging %/yr once the movements cap binds
    capGaugeMax: 25,      // ceiling on total pax-per-movement growth vs base year (%)
    bellyShare: 50,       // share of cargo riding passenger-aircraft bellyhold (%)
    bellyBeta: 40,        // % of up-gauged capacity that returns as usable belly space
    horizon: 25,
  };
}

/* ---- which year the strategic curve compounds off ----
   The long-term model raises ONE base year to the power of 25, so the choice of
   base year moves the endpoint more than any single lever does. Two modes, and
   the difference is the link between the two forecasts:

     "forecast" (default) — the CURRENT calendar year, its not-yet-observed
       months filled in by the short-term tactical model. The strategic curve
       then starts from where the tactical model says this year actually lands,
       which is the point of fitting a tactical model at all. It also removes a
       real hazard of the observed-only base: a gateway whose latest complete
       year was unusual compounds that anomaly for 25 years (AJI's 2025 came in
       at 64% of its 2024, and every projected year inherited that).
     "observed" — the last COMPLETE observed calendar year, nothing modeled.
       What the model did before this was linked, kept as a true revert: a
       forecast-completed base inherits the tactical model's error into every
       year downstream, and that trade is the user's to make, not ours.

   Both builders return the same shape, plus a disclosure of which months were
   modeled and by which model, so every screen can say so. */
/* Assemble one base year's twelve months for every metric, from a single
   cascade: the published observation → (forecast mode only) that metric's own
   tactical forecast → the prior year's same month. A metric that still can't be
   resolved is dropped, and reported as dropped.

   There is deliberately NO flat-annual-average rung. The observed-mode builder
   used to fall back to `annualCargo/12` for any base month cargo was missing,
   taking that level from cargo's *own* last complete year — which needn't be the
   base year — and flattening the metric's entire seasonal shape, with nothing on
   screen to say so. Cargo is published monthly; there is no reason to project it
   off an annual average. Unreachable on today's feeds (0 of 438 cargo gateways),
   but only by luck of their publishing lag, and silent if it ever fired. */
function buildBase(iata, history, baseYear, useModel, model){
  const obs = {}, prior = {};
  METRIC_KEYS.forEach(k => { obs[k] = {}; prior[k] = {}; });
  history.forEach(r => {
    const into = r.y === baseYear ? obs : (r.y === baseYear-1 ? prior : null);
    if (into) METRIC_KEYS.forEach(k => { if (r[k] != null) into[k][r.m] = r[k]; });
  });

  const completion = {}, gapsOf = {};
  const fill = (k) => {
    const out = { ...obs[k] };
    if (!Object.keys(out).length) return null;
    /* THIS metric's own gaps — never passengers'. The feeds don't move in
       lockstep: YYZ publishes passengers through May but movements only through
       April, so filling the pax-shaped gap set left movements holed at May and
       dropped the metric out of the strategic view entirely (8 gateways). */
    const gaps = [];
    for (let m=0; m<12; m++) if (out[m] == null) gaps.push(m);
    gapsOf[k] = gaps;
    if (!gaps.length) return out;            // already whole — nothing modeled
    const st = useModel ? tacticalForecast(iata, k, history, model) : null;
    const byM = {};
    if (st) st.forecast.forEach(r => { if (r.y === baseYear) byM[r.m] = r.v; });
    let usedModel = false, usedCarry = false;
    for (const m of gaps){
      if (byM[m] != null){ out[m] = byM[m]; usedModel = true; }
      else if (prior[k][m] != null){ out[m] = prior[k][m]; usedCarry = true; }
      else return null;                      // this metric can't be completed
    }
    completion[k] = usedModel ? ((st ? st.method : "model") + (usedCarry ? "+carry" : "")) : "carry";
    return out;
  };

  const basePax = fill("pax");
  if (!basePax) return null;
  const baseCargo = fill("cargo");

  /* ---- movements, deliberately NOT completed by their own model ----
     The long-term model's central assumption is that movements track passengers
     (gauge=0 ⇒ strictly proportional), so the base year's pax-per-movement ratio
     has to mean something. It IS `ratioBase` in the capacity block, which sets
     `ratioCeil` — the up-gauging ceiling the whole coupled constraint pivots on —
     and it compounds into every projected year.

     Completing passengers and movements from INDEPENDENTLY selected models broke
     that. BTS came out at 174 passengers per movement against an observed 104
     (+67%) purely because passengers won on ETS and movements on a seasonal
     naive: two unrelated model choices, and nothing holding their ratio to
     anything. A 67% one-year shift in aircraft gauge is not a real operational
     change, and it would have silently inflated BTS's modelled slot capacity.

     So a missing movements month is derived from that month's passengers —
     observed or modeled — at the ratio the two metrics actually exhibit where
     both are published. Movements' own forecast still drives the tactical
     screen, which is where a pure movements prediction belongs; here, the
     model's own proportionality is the better estimator and the coherent one. */
  let baseAtm = null;
  if (Object.keys(obs.atm).length){
    const gaps = [];
    for (let m=0; m<12; m++) if (obs.atm[m] == null) gaps.push(m);
    gapsOf.atm = gaps;
    baseAtm = { ...obs.atm };
    if (gaps.length){
      const both = history.filter(r => r.pax != null && r.atm != null).slice(-12);
      const paxSum = both.reduce((t,r)=>t+r.pax, 0), atmSum = both.reduce((t,r)=>t+r.atm, 0);
      const ratio = (both.length >= 6 && atmSum > 0 && paxSum > 0) ? paxSum/atmSum : null;
      let usedRatio = false, usedCarry = false;
      for (const m of gaps){
        if (ratio && basePax[m] != null){ baseAtm[m] = Math.round(basePax[m] / ratio); usedRatio = true; }
        else if (prior.atm[m] != null){ baseAtm[m] = prior.atm[m]; usedCarry = true; }
        else { baseAtm = null; break; }
      }
      if (baseAtm) completion.atm = usedRatio ? ("pax-implied" + (usedCarry ? "+carry" : "")) : "carry";
    }
  }

  const sum = (o) => Math.round(Object.keys(o).reduce((t,m)=>t+o[m], 0));
  return { baseYear,
    // every annual total is now the base year's OWN twelve months, so the base
    // row can't disagree with the monthly shape it's charted against
    annualPax: sum(basePax),
    annualAtm: baseAtm ? sum(baseAtm) : null,
    annualCargo: baseCargo ? sum(baseCargo) : null,
    hasAtm: !!baseAtm, hasCargo: !!baseCargo,
    basePax, baseAtm: baseAtm || {}, baseCargo: baseCargo || {},
    forecastMonths: gapsOf.pax || [], completion, model: completion.pax || null,
    // per metric, since the feeds publish at different lags — the disclosure
    // would otherwise report passengers' count for movements too
    modeledMonths: { pax:(gapsOf.pax||[]).length,
      ...(baseAtm ? { atm:(gapsOf.atm||[]).length } : {}),
      ...(baseCargo ? { cargo:(gapsOf.cargo||[]).length } : {}) },
    gaps: gapsOf };
}

function observedBase(history){
  const paxYears = fullYears(history, "pax");
  if (!paxYears.length) return null;
  // the last COMPLETE pax year, and no model is consulted — so passengers are
  // never modeled on this path, whatever the other metrics need
  const base = buildBase(null, history, paxYears[paxYears.length-1].y, false, null);
  return base ? { ...base, mode:"observed" } : null;
}

function forecastBase(iata, history, model){
  const paxRows = history.filter(r => r.pax != null);
  if (!paxRows.length) return null;
  const baseYear = paxRows[paxRows.length-1].y;
  // a whole latest year needs no completing — that IS observedBase's job
  if (history.filter(r => r.y===baseYear && r.pax!=null).length >= 12) return null;
  const base = buildBase(iata, history, baseYear, true, model);
  return base ? { ...base, mode:"forecast" } : null;
}

/* The base year depends on the history, the mode and the chosen model — never on
   the scenario — but longTermForecast() re-runs on every lever drag. Without a
   memo an uploaded gateway re-fits its in-browser ETS once per metric on every
   slider move (measured: 7.7ms a call against 1.3ms for the pure-arithmetic
   observed path). Keyed on the history array's identity, so the entry drops as
   soon as app.jsx rebuilds it, plus a counter for a nightly payload landing
   after the history was built. Nothing downstream mutates the returned object,
   so sharing one instance across calls is safe. */
const BASE_CACHE = new WeakMap();
function baseYearFor(iata, history, mode, model){
  const build = () => (mode === "observed") ? observedBase(history)
    : (forecastBase(iata, history, model) || observedBase(history));
  if (!history || typeof history !== "object") return build();
  const key = `${iata}|${mode}|${model || ""}|${FORECAST_VERSION}`;
  let entries = BASE_CACHE.get(history);
  if (entries && key in entries) return entries[key];
  const base = build();
  if (!entries){ entries = {}; BASE_CACHE.set(history, entries); }
  entries[key] = base;
  return base;
}

function longTermForecast(iata, history, scenario, opts){
  const s = scenario;
  const o = opts || {};
  const base = baseYearFor(iata, history, o.baseMode || "forecast", o.model);
  if (!base) return null;
  const { baseYear, annualPax, annualAtm, annualCargo, hasAtm, hasCargo,
    basePax, baseAtm, baseCargo } = base;

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
        const mk = String(mm+1).padStart(2,"0");
        if (ser[`${baseYear}-${mk}`] != null) { mvals[mm] = ser[`${baseYear}-${mk}`]; continue; }
        // a base month completed by the tactical model has no published sector
        // split — carry the prior year's same month as the SHAPE and let the
        // per-month rescale below reconcile it to the (modeled) total, so a
        // forecast-completed base year keeps its passenger mix instead of
        // silently losing the segment view
        const carry = ser[`${baseYear-1}-${mk}`];
        if (carry == null) { ok = false; break; }
        mvals[mm] = carry;
      }
      if (ok) { segKeys.push(seg.k); segBase[seg.k] = mvals; }
    }
    if (segKeys.length < 2) segKeys = [];   // need a real split to be worth it
  }
  if (segKeys.length) {
    /* A month whose split sums to ZERO can't be scaled to that month's
       passengers — there's no shape to scale. Left alone, the month's traffic
       silently disappeared from the sector mix while still counting in the
       headline, so the donut didn't add up to the total (PED: three such
       months, 8,937 passengers; WRO likewise). Those months take the shape
       implied by the months that DO carry a split, and are then rescaled to
       their own passengers like every other month. */
    const totals = {};
    let grand = 0;
    segKeys.forEach(k => totals[k] = 0);
    for (let mm=0; mm<12; mm++) segKeys.forEach(k => { const v = segBase[k][mm]||0; totals[k] += v; grand += v; });
    if (grand <= 0) segKeys = [];        // no split anywhere — don't invent one
    for (let mm=0; mm<12; mm++){
      let sum = segKeys.reduce((t,k)=>t+(segBase[k][mm]||0),0);
      if (sum <= 0 && grand > 0){ segKeys.forEach(k => segBase[k][mm] = totals[k]); sum = grand; }
      const factor = (sum>0 && basePax[mm]!=null) ? basePax[mm]/sum : 1;
      segKeys.forEach(k => segBase[k][mm] *= factor);
    }
  }
  const hasSeg = segKeys.length > 0;
  const gSeg = {};
  segKeys.forEach(k => gSeg[k] = gDemand + (s["seg_"+k] || 0) / 100);

  /* ---- discrete shock events (e.g. a pandemic, a route collapse) ----
     Each event applies a multiplicative shock over a window: peak impact held
     for `length` months, then either a linear glide back to baseline over
     `recovery` months (full recovery) or — if `permanent` — the shifted level
     persists and the rest of the forecast re-baselines off it. An event can hit
     all traffic (`target:"all"`) or a single passenger segment, which reshapes
     the mix. Overlapping events compound. Movements always ride the TOTAL
     passenger factor the stacked events produce — a single-segment collapse
     grounds flights just like an all-traffic one (movements ∝ pax); cargo
     moves only with all-traffic events (a sector passenger shock isn't a
     freight shock). */
  const events = Array.isArray(s.events) ? s.events.filter(e => e && e.start) : [];
  function eventFactor(ev, y, m){
    const p = String(ev.start).split("-"); const sy = +p[0], sm = +(p[1]||1);
    const d = (y*12 + m) - (sy*12 + (sm-1));
    if (d < 0) return 1;
    const peak = (+ev.peak||0)/100;
    const len = Math.max(0, Math.round(+(ev.length != null ? ev.length : ev.hold) || 0));
    if (d < len) return 1 + peak;
    if (ev.permanent) return 1 + peak;
    // linear glide with rec genuinely-recovering months, back at baseline the
    // month AFTER the window ends. (Dividing by rec instead would land the
    // glide exactly on baseline in its last month, making recovery:1
    // indistinguishable from recovery:0.)
    const rec = Math.max(0, Math.round(+ev.recovery || 0));
    if (rec > 0 && d < len + rec) return 1 + peak * (1 - (d - len + 1) / (rec + 1));
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
    // buildBase resolves all twelve months for any metric it reports, so these
    // are always the metric's own real (or disclosed-modeled) month
    if (hasAtm)   rec.atm   = Math.round(baseAtm[mm]   * Math.pow(1+gMovements, yf));
    if (hasCargo) rec.cargo = Math.round(baseCargo[mm] * Math.pow(1+gCargo, yf));
    if (events.length){
      let touched = false;
      const paxBefore = rec.pax;   // pre-shock total, drives the movements coupling below
      for (const ev of events){
        const f = eventFactor(ev, yy, mm); if (f === 1) continue;
        touched = true;
        const tgt = ev.target || "all";
        if (rec.seg && tgt !== "all" && rec.seg[tgt] != null){ rec.seg[tgt] *= f; }   // reshape one segment
        else {                                                                         // all traffic
          if (rec.seg) for (const k in rec.seg) rec.seg[k] *= f; else rec.pax *= f;
          if (rec.cargo != null) rec.cargo *= f;
        }
      }
      if (touched){
        if (rec.seg){ for (const k in rec.seg) rec.seg[k] = Math.round(rec.seg[k]); rec.pax = Object.values(rec.seg).reduce((t,v)=>t+v,0); }
        else rec.pax = Math.round(rec.pax);
        // movements ∝ pax: however the stacked events reshaped the total —
        // all-traffic hit, one segment collapsing, or both — flights fall
        // (or rise) in proportion to the passengers actually left
        if (rec.atm != null && paxBefore > 0) rec.atm = Math.round(rec.atm * (rec.pax / paxBefore));
        if (rec.cargo != null) rec.cargo = Math.round(rec.cargo);
      }
    }
    months.push(rec);
  }

  /* ---- the base year's own twelve months ----
     `months` above starts in January of baseYear+1, so on a forecast-completed
     base year the base year's modeled months exist in the model but appear
     nowhere: the monthly chart drew the last observed month adjacent to January
     of the following year, skipping 8-10 months and implying they were
     consecutive. These are emitted separately rather than prepended to `months`
     because the event simulator indexes into `months` positionally and the
     capacity block scales it per year — both would silently shift.
     `modeled[metric]` is per metric, since the feeds run at different lags. */
  const baseGaps = base.gaps || {};
  const baseMonthly = [];
  for (let mm=0; mm<12; mm++){
    const rec = { y:baseYear, m:mm, date:`${baseYear}-${String(mm+1).padStart(2,"0")}`,
      label:`${MONTHS[mm]} ${String(baseYear).slice(2)}`, modeled:{} };
    if (basePax[mm] != null){ rec.pax = Math.round(basePax[mm]); rec.modeled.pax = (baseGaps.pax||[]).includes(mm); }
    if (hasAtm && baseAtm[mm] != null){ rec.atm = Math.round(baseAtm[mm]); rec.modeled.atm = (baseGaps.atm||[]).includes(mm); }
    if (hasCargo && baseCargo[mm] != null){ rec.cargo = Math.round(baseCargo[mm]); rec.modeled.cargo = (baseGaps.cargo||[]).includes(mm); }
    baseMonthly.push(rec);
  }

  const segAnnual = (ms) => { const o = {}; segKeys.forEach(k => o[k] = ms.reduce((t,r)=>t+((r.seg&&r.seg[k])||0),0)); return o; };
  const rows = [{ y:baseYear, pax:annualPax, base:true,
    ...(base.forecastMonths.length ? { partial:true } : {}),
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
       · CARGO is tied to FLIGHTS on both halves of `bellyShare`:
         — Bellyhold (bellyShare %): belly capacity = passenger flights
           flown × belly space per flight. Fewer flights under a slot cap
           means less belly, and up-gauged aircraft recover only part of
           it — `bellyBeta` says how much of the extra passengers-per-
           movement comes back as usable belly (bigger airframes add belly
           volume, but denser cabins and fuller passenger loads eat it
           with bags). Below 100% this is the classic slot-scarcity
           trade-off: squeezing more passengers through capped movements
           costs cargo per passenger.
         — Freighters (the rest): squeezed by slot scarcity right along
           with passenger flights when the MOVEMENTS cap binds (ad-hoc
           freighter capacity competes for the same runway), but untouched
           by a purely terminal (passenger) cap.
       · Caps can CHANGE over the horizon — `capSteps` models a capital
         project: [{year, paxCap?, atmCap?}], each step overriding the
         caps (field by field, cumulatively) from its year onward. The
         up-gauging clock only ticks in years the slot cap actually binds,
         so an expansion that un-binds it freezes further response.

     Bounds that keep the classic ratios sane by construction: pax-per-
     movement never exceeds the base year's ratio × (1 + capGaugeMax);
     constrained values never exceed unconstrained demand; belly-per-
     flight growth is capped at gaugeLift^bellyBeta ≤ gaugeLift.

     Each capped year's months are scaled proportionally per metric (a
     disclosed simplification; real spill concentrates in peak months).
     The unconstrained series is left untouched so the two can be charted
     against each other, and `spill` = demand the infrastructure can't
     serve. All response assumptions are levers on the Baseline
     assumptions screen. */
  const paxCapBase = (+s.paxCap > 0) ? +s.paxCap : null;
  const atmCapBase = (hasAtm && +s.atmCap > 0) ? +s.atmCap : null;
  const capSteps = (Array.isArray(s.capSteps) ? s.capSteps : [])
    .filter(st => st && Number.isFinite(+st.year))
    .map(st => ({ year: Math.round(+st.year),
      ...(+st.paxCap > 0 ? { paxCap: Math.round(+st.paxCap) } : {}),
      ...(hasAtm && +st.atmCap > 0 ? { atmCap: Math.round(+st.atmCap) } : {}) }))
    .filter(st => st.paxCap || st.atmCap)
    .sort((a, b) => a.year - b.year);
  const capsFor = (y)=>{
    let p = paxCapBase, a = atmCapBase;
    for (const st of capSteps){
      if (st.year > y) break;
      if (st.paxCap) p = st.paxCap;
      if (st.atmCap) a = st.atmCap;
    }
    return { paxCap: p, atmCap: a };
  };
  const endCaps = capsFor(baseYear + s.horizon);
  const hasCap = !!(paxCapBase || atmCapBase || capSteps.length);
  let capAssumptions = null;
  if (hasCap){
    const capGauge = Math.max(0, +s.capGauge || 0) / 100;
    const capGaugeMax = Math.max(0, +s.capGaugeMax || 0) / 100;
    const bellyShare = Math.min(1, Math.max(0, (s.bellyShare == null ? 50 : +s.bellyShare) / 100));
    const bellyBeta = Math.min(1, Math.max(0, (s.bellyBeta == null ? 40 : +s.bellyBeta) / 100));
    capAssumptions = { capGauge: capGauge*100, capGaugeMax: capGaugeMax*100,
      bellyShare: bellyShare*100, bellyBeta: bellyBeta*100 };
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
      const { paxCap, atmCap } = capsFor(row.y);   // this year's effective caps
      const ms = monthsByYear[row.y] || [];
      const paxU = row.pax, atmU = row.atm, cargoU = row.cargo;

      // 1. slots: capped flights, and the bounded-up-gauging pax ceiling
      let atmC = (atmU != null && atmCap) ? Math.min(atmU, atmCap) : atmU;
      const slotBound = !!(atmCap && atmU != null && atmU > atmCap);
      let paxFromAtm = Infinity;
      if (slotBound && ratioBase != null && atmU > 0){
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

      // 4. cargo — both halves ride the flights actually flown
      let cargoC = cargoU;
      if (cargoU != null && paxU > 0){
        const flightFactor = (atmU != null && atmU > 0) ? Math.min(1, atmC/atmU) : Math.min(1, paxC/paxU);
        // how much extra gauge the constraint forced (1 = none) — belly
        // space recovers only bellyBeta of it
        let gaugeLift = 1;
        if (atmU != null && atmU > 0 && atmC > 0){
          gaugeLift = Math.max(1, (paxC/atmC) / (paxU/atmU));
        }
        const bellyFactor = Math.min(1, flightFactor * Math.pow(gaugeLift, bellyBeta));
        const freighterFactor = slotBound ? flightFactor : 1;
        cargoC = cargoU * (bellyShare*bellyFactor + (1-bellyShare)*freighterFactor);
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
  return { rows, months, baseMonthly, baseYear, endYear:baseYear+s.horizon, hasAtm, hasCargo,
    /* how the base year was assembled — every screen that shows a base-year
       number is expected to disclose this, because a modeled base propagates
       into all 25 projected years */
    baseMode: base.mode, baseForecastMonths: base.forecastMonths,
    baseObservedMonths: 12 - base.forecastMonths.length,
    baseCompletion: base.completion, baseModel: base.model,
    baseModeledMonths: base.modeledMonths,
    hasCap, paxCap: paxCapBase, atmCap: atmCapBase,
    paxCapEnd: endCaps.paxCap, atmCapEnd: endCaps.atmCap, capSteps, capAssumptions,
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
/* every shareable numeric lever with the [min,max] it's clamped to. A
   finite-number check alone isn't enough: `horizon` sizes the monthly
   projection loop (horizon × 12 records, each charted and tabled), so a
   link carrying horizon:1e9 would hang the tab of whoever opened it. The
   bounds match the widest the UI itself can produce. */
const SHARE_NUM_KEYS = {
  gdp:[-20,20], elasticity:[0,5], pop:[-10,10], tourism:[-20,20], fuel:[-50,200],
  lcc:[-20,20], cargo:[-20,20], gauge:[-20,20],
  seg_domestic:[-20,20], seg_transborder:[-20,20], seg_international:[-20,20],
  horizon:[1,50],
  paxCap:[0,1e10], atmCap:[0,1e9],
  capGauge:[0,20], capGaugeMax:[0,200], bellyShare:[0,100], bellyBeta:[0,100],
};
function sanitizeSharedScenario(sc){
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) return null;
  const out = {};
  for (const k in SHARE_NUM_KEYS){
    const v = sc[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const [lo, hi] = SHARE_NUM_KEYS[k];
    out[k] = Math.min(hi, Math.max(lo, v));
  }
  if (out.horizon != null) out.horizon = Math.round(out.horizon);
  if (Array.isArray(sc.capSteps)){
    out.capSteps = sc.capSteps.slice(0, 10).map(st => {
      if (!st || typeof st !== "object") return null;
      const year = Math.round(+st.year);
      if (!Number.isFinite(year) || year < 2000 || year > 2100) return null;
      const o = { year };
      if (typeof st.paxCap === "number" && Number.isFinite(st.paxCap) && st.paxCap > 0) o.paxCap = Math.round(st.paxCap);
      if (typeof st.atmCap === "number" && Number.isFinite(st.atmCap) && st.atmCap > 0) o.atmCap = Math.round(st.atmCap);
      return (o.paxCap || o.atmCap) ? o : null;
    }).filter(Boolean);
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
  // axis tick labels — at most ~5 characters so they fit the charts' left
  // gutter even for annual totals in the hundreds of millions
  axis: n => {
    if (n >= 1e6){ const s = n/1e6; return (s >= 100 ? Math.round(s) : Math.round(s*10)/10)+"M"; }
    if (n >= 1e3){ const s = n/1e3; return (s >= 100 ? Math.round(s) : Math.round(s*10)/10)+"K"; }
    return String(Math.round(n));
  },
  pct:  (n,d=1) => (n>=0?"+":"")+n.toFixed(d)+"%",
  pct0: (n,d=1) => n.toFixed(d)+"%",
  t:    n => n>=1e3 ? (n/1e3).toFixed(1)+"k t" : Math.round(n)+" t",
};

Object.assign(window, {
  AIRPORTS, MACRO, MONTHS, METRIC_META, MODEL_META, MODEL_KEYS,
  GP_MODEL_META:MODEL_META, GP_MODEL_KEYS:MODEL_KEYS, GP_forecastModels:forecastModels,
  GP_buildHistory:buildHistory, GP_annualize:annualize, GP_fullYears:fullYears,
  GP_observedSeasonality:observedSeasonality,
  GP_longTerm:longTermForecast, GP_defaultScenario:defaultScenario,
  GP_forecastFor:forecastFor, GP_hasForecast:hasForecast,
  GP_availableMetrics:availableMetrics, GP_liveAirports:liveAirports,
  GP_sourceLabel:sourceLabel, GP_sourceBadge:sourceBadge,
  GP_segmentsFor:segmentsFor, GP_PAX_SEGMENTS:PAX_SEGMENTS,
  GP_fmt:fmt, GP_activityFor:activityFor,
  GP_setActivityIndex:setActivityIndex, GP_setAirportSeries:setAirportSeries, GP_hasAirportSeries:hasAirportSeries,
  GP_getObservedSeries:getObservedSeries, GP_getActivityMeta:getActivityMeta, GP_getSegments:getSegments,
  GP_setForecastMeta:setForecastMeta, GP_setAirportForecast:setAirportForecast,
  GP_setReference:setReference, GP_rebuildAirports:rebuildAirports, GP_ensureMacro:ensureMacro,
  GP_registerCustomAirport:registerCustomAirport, GP_removeCustomAirport:removeCustomAirport, GP_parseMonthKey:parseMonthKey,
  GP_guessColumnRole:guessColumnRole, GP_guessColumnRoles:guessColumnRoles,
  GP_csvCell:csvCell, GP_escapeHtml:escapeHtml,
  GP_tacticalForecast:tacticalForecast, GP_etsForecast:etsForecast,
  GP_designDay:designDay, GP_dataAgeDays:dataAgeDays,
  GP_encodeShare:encodeShare, GP_decodeShare:decodeShare,
});

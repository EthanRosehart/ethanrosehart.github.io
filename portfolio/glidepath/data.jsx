/* ============================================================
   data.jsx — real datasets + forecast access
   No synthetic series. Monthly activity (passengers / movements /
   cargo) comes from public sources via the nightly pipeline
   (data/activity.json); the short-term forecast is Meta Prophet,
   precomputed server-side (data/forecast.json). The long-term
   strategic model compounds the real base year with public macro
   drivers. Everything here is exposed on window for the other
   babel modules.
   ============================================================ */

/* ---- airport catalogue (built at runtime, not hand-curated) ---
   AIRPORTS is filled from data/activity.json — every airport our
   public feeds actually carry monthly data for — and enriched with
   the OpenFlights reference (data/airports.json). It stays the same
   array object (mutated in place) so the other babel modules that
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
   OBSERVED ACTIVITY  (data/activity.json, real, same-origin)
   iata -> { pax:{ "YYYY-MM":n }, atm:{...}, cargo:{...} }
   Supports the new per-metric "series" shape and the legacy
   passengers-only "monthly" shape.
   ============================================================ */
const OBSERVED = {};
let ACTIVITY_META = null;
function setActivity(json){
  for (const k in OBSERVED) delete OBSERVED[k];
  if (!json || !json.airports) return;
  Object.keys(json.airports).forEach(iata => {
    const a = json.airports[iata];
    if (!a || !a.observed) return;
    if (a.series && typeof a.series === "object") OBSERVED[iata] = a.series;
    else if (a.monthly) OBSERVED[iata] = { pax: a.monthly };
  });
  ACTIVITY_META = json;
  window.GP_ACTIVITY_META = json;
  rebuildAirports();
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
    });
  });
  AIRPORTS.sort((x, y) => (x.region === y.region ? x.name.localeCompare(y.name) : x.region.localeCompare(y.region)));
  window.GP_AIRPORTS = AIRPORTS;
}
function availableMetrics(iata){
  const s = OBSERVED[iata]; if (!s) return [];
  return METRIC_KEYS.filter(m => s[m] && Object.keys(s[m]).length);
}
function activityFor(iata){
  const a = ACTIVITY_META && ACTIVITY_META.airports ? ACTIVITY_META.airports[iata] : null;
  const s = OBSERVED[iata];
  if (!a || !s || !s.pax) return { observed:false, source:"none", months:0, metrics:[] };
  const paxKeys = Object.keys(s.pax);
  return { observed:!!a.observed, source:a.source, rep:a.rep_airp,
    months: a.months || paxKeys.length,
    latest: paxKeys.sort().pop() || null,
    metrics: availableMetrics(iata) };
}
/* airports we can actually show — real passenger data present */
function liveAirports(){ return AIRPORTS.filter(a => availableMetrics(a.iata).includes("pax")); }

/* human-readable name for a raw activity source key (e.g. "statcan") */
function sourceLabel(src){
  const k = (src||"").split(":")[0].toLowerCase();
  return ({ eurostat:"Eurostat", statcan:"Statistics Canada", bts:"US BTS" })[k]
    || (k ? k[0].toUpperCase()+k.slice(1) : "public");
}
/* short badge code for a source — drives the connect-step source icon */
function sourceBadge(src){
  const k = (src||"").split(":")[0].toLowerCase();
  return ({ eurostat:"AVIA", statcan:"CAN", bts:"BTS" })[k] || "AVIA";
}

/* ============================================================
   PROPHET FORECASTS  (data/forecast.json, precomputed nightly)
   iata -> metric -> { mape, seasonal12, holidays, forecast[] }
   ============================================================ */
const FORECASTS = {};
let FORECAST_META = null;
function setForecast(json){
  for (const k in FORECASTS) delete FORECASTS[k];
  if (!json || !json.airports) return;
  Object.keys(json.airports).forEach(iata => { FORECASTS[iata] = json.airports[iata].metrics || {}; });
  FORECAST_META = json;
  window.GP_FORECAST_META = json;
}
function hasForecast(iata, key){
  const a = FORECASTS[iata];
  return key ? !!(a && a[key]) : !!(a && Object.keys(a).length);
}
function forecastFor(iata, key){
  const m = FORECASTS[iata] && FORECASTS[iata][key];
  if (!m) return null;
  const forecast = (m.forecast || []).map(r => ({ ...r, label:`${MONTHS[r.m]} ${String(r.y).slice(2)}` }));
  return { forecast, mape:m.mape, seasIdx:m.seasonal12 || Array(12).fill(1),
    holidays:m.holidays || [], holidaysTotal:m.holidays_total || 0,
    latest:m.latest, monthsHistory:m.months_history };
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
    horizon: 10,
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

  const months = [];
  let yy = baseYear, mm = 11;
  const total = s.horizon * 12;
  for (let k=1; k<=total; k++){
    mm++; if (mm>11){ mm=0; yy++; }
    const yf = k/12;
    const pax = (basePax[mm] != null ? basePax[mm] : annualPax/12) * Math.pow(1+gDemand, yf);
    const rec = { y:yy, m:mm, date:`${yy}-${String(mm+1).padStart(2,"0")}`,
      label:`${MONTHS[mm]} ${String(yy).slice(2)}`, pax:Math.round(pax) };
    if (hasAtm)   rec.atm   = Math.round((baseAtm[mm]   != null ? baseAtm[mm]   : atmMonthAvg)   * Math.pow(1+gMovements, yf));
    if (hasCargo) rec.cargo = Math.round((baseCargo[mm] != null ? baseCargo[mm] : cargoMonthAvg) * Math.pow(1+gCargo, yf));
    months.push(rec);
  }

  const rows = [{ y:baseYear, pax:annualPax, base:true,
    ...(hasAtm?{atm:annualAtm}:{}), ...(hasCargo?{cargo:annualCargo}:{}) }];
  for (let i=1; i<=s.horizon; i++){
    const yr = baseYear+i, ms = months.filter(r => r.y===yr);
    const row = { y:yr, pax: ms.reduce((t,r)=>t+r.pax,0) };
    if (hasAtm)   row.atm   = ms.reduce((t,r)=>t+(r.atm||0),0);
    if (hasCargo) row.cargo = ms.reduce((t,r)=>t+(r.cargo||0),0);
    rows.push(row);
  }
  const cagr = Math.pow(rows[rows.length-1].pax/annualPax, 1/s.horizon) - 1;
  return { rows, months, baseYear, endYear:baseYear+s.horizon, hasAtm, hasCargo,
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
  GP_longTerm:longTermForecast, GP_defaultScenario:defaultScenario,
  GP_forecastFor:forecastFor, GP_hasForecast:hasForecast,
  GP_availableMetrics:availableMetrics, GP_liveAirports:liveAirports,
  GP_sourceLabel:sourceLabel, GP_sourceBadge:sourceBadge,
  GP_fmt:fmt, GP_setActivity:setActivity, GP_activityFor:activityFor, GP_setForecast:setForecast,
  GP_setReference:setReference, GP_rebuildAirports:rebuildAirports, GP_ensureMacro:ensureMacro,
});

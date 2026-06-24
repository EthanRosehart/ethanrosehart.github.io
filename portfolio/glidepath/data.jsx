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

/* ---- curated airport reference (OpenFlights schema) -------- */
/* fields mirror the OpenFlights airports.dat columns; enriched at
   runtime from data/airports.json (authoritative identifiers).    */
const AIRPORTS = [
  { iata:"YYZ", icao:"CYYZ", name:"Toronto Pearson Intl", city:"Toronto", country:"Canada", cc:"CAN", lat:43.6772, lon:-79.6306, elev:569, tz:"America/Toronto", runwayM:3368, gates:120, region:"North America" },
  { iata:"YTZ", icao:"CYTZ", name:"Billy Bishop Toronto City", city:"Toronto", country:"Canada", cc:"CAN", lat:43.6275, lon:-79.3962, elev:252, tz:"America/Toronto", runwayM:1216, gates:11, region:"North America" },
  { iata:"YOW", icao:"CYOW", name:"Ottawa Macdonald–Cartier Intl", city:"Ottawa", country:"Canada", cc:"CAN", lat:45.3225, lon:-75.6692, elev:374, tz:"America/Toronto", runwayM:3048, gates:24, region:"North America" },
  { iata:"YHM", icao:"CYHM", name:"John C. Munro Hamilton Intl", city:"Hamilton", country:"Canada", cc:"CAN", lat:43.1736, lon:-79.9350, elev:780, tz:"America/Toronto", runwayM:3048, gates:6, region:"North America" },
  { iata:"YQB", icao:"CYQB", name:"Québec City Jean Lesage Intl", city:"Québec", country:"Canada", cc:"CAN", lat:46.7911, lon:-71.3933, elev:244, tz:"America/Toronto", runwayM:2743, gates:14, region:"North America" },
  { iata:"YHZ", icao:"CYHZ", name:"Halifax Stanfield Intl", city:"Halifax", country:"Canada", cc:"CAN", lat:44.8808, lon:-63.5086, elev:477, tz:"America/Halifax", runwayM:3200, gates:25, region:"North America" },
  { iata:"YKF", icao:"CYKF", name:"Region of Waterloo Intl", city:"Kitchener", country:"Canada", cc:"CAN", lat:43.4608, lon:-80.3786, elev:1055, tz:"America/Toronto", runwayM:2149, gates:3, region:"North America" },
  { iata:"BUR", icao:"KBUR", name:"Hollywood Burbank", city:"Burbank", country:"United States", cc:"USA", lat:34.2007, lon:-118.3590, elev:778, tz:"America/Los_Angeles", runwayM:1965, gates:14, region:"North America" },
  { iata:"PVU", icao:"KPVU", name:"Provo Municipal", city:"Provo", country:"United States", cc:"USA", lat:40.2192, lon:-111.7233, elev:4497, tz:"America/Denver", runwayM:2591, gates:8, region:"North America" },
  { iata:"PSP", icao:"KPSP", name:"Palm Springs Intl", city:"Palm Springs", country:"United States", cc:"USA", lat:33.8297, lon:-116.5067, elev:477, tz:"America/Los_Angeles", runwayM:3045, gates:18, region:"North America" },
  { iata:"BZN", icao:"KBZN", name:"Bozeman Yellowstone Intl", city:"Bozeman", country:"United States", cc:"USA", lat:45.7775, lon:-111.1531, elev:4473, tz:"America/Denver", runwayM:2743, gates:10, region:"North America" },
  { iata:"EXT", icao:"EGTE", name:"Exeter", city:"Exeter", country:"United Kingdom", cc:"GBR", lat:50.7344, lon:-3.4139, elev:102, tz:"Europe/London", runwayM:2083, gates:6, region:"Europe" },
  { iata:"NQY", icao:"EGHQ", name:"Cornwall Newquay", city:"Newquay", country:"United Kingdom", cc:"GBR", lat:50.4406, lon:-4.9954, elev:390, tz:"Europe/London", runwayM:2744, gates:4, region:"Europe" },
  { iata:"INV", icao:"EGPE", name:"Inverness", city:"Inverness", country:"United Kingdom", cc:"GBR", lat:57.5425, lon:-4.0475, elev:31, tz:"Europe/London", runwayM:1885, gates:5, region:"Europe" },
  { iata:"RTM", icao:"EHRD", name:"Rotterdam The Hague", city:"Rotterdam", country:"Netherlands", cc:"NLD", lat:51.9569, lon:4.4372, elev:-15, tz:"Europe/Amsterdam", runwayM:2200, gates:7, region:"Europe" },
  { iata:"FMM", icao:"EDJA", name:"Memmingen", city:"Memmingen", country:"Germany", cc:"DEU", lat:47.9888, lon:10.2395, elev:2077, tz:"Europe/Berlin", runwayM:2980, gates:6, region:"Europe" },
  { iata:"AAR", icao:"EKAH", name:"Aarhus", city:"Aarhus", country:"Denmark", cc:"DNK", lat:56.3000, lon:10.6190, elev:82, tz:"Europe/Copenhagen", runwayM:2776, gates:4, region:"Europe" },
  { iata:"GRZ", icao:"LOWG", name:"Graz", city:"Graz", country:"Austria", cc:"AUT", lat:46.9911, lon:15.4396, elev:1115, tz:"Europe/Vienna", runwayM:3000, gates:7, region:"Europe" },
  { iata:"KLU", icao:"LOWK", name:"Klagenfurt", city:"Klagenfurt", country:"Austria", cc:"AUT", lat:46.6425, lon:14.3377, elev:1470, tz:"Europe/Vienna", runwayM:2720, gates:5, region:"Europe" },
  { iata:"SZG", icao:"LOWS", name:"Salzburg W.A. Mozart", city:"Salzburg", country:"Austria", cc:"AUT", lat:47.7933, lon:13.0043, elev:1411, tz:"Europe/Vienna", runwayM:2750, gates:9, region:"Europe" },
  { iata:"NAP", icao:"LIRN", name:"Naples Intl", city:"Naples", country:"Italy", cc:"ITA", lat:40.8860, lon:14.2908, elev:294, tz:"Europe/Rome", runwayM:2628, gates:12, region:"Europe" },
  { iata:"WRO", icao:"EPWR", name:"Wrocław Copernicus", city:"Wrocław", country:"Poland", cc:"POL", lat:51.1027, lon:16.8858, elev:404, tz:"Europe/Warsaw", runwayM:2520, gates:8, region:"Europe" },
];

/* ---- macro baselines (OECD / IMF / World Bank style) -------- */
/* trend real GDP growth, GDP/cap, income (PAX) elasticity by mkt;
   live World Bank / OECD figures merged over these at runtime.     */
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
  const m = MACRO[AIRPORTS.find(x=>x.iata===iata).cc];
  return {
    gdp: (m.gdpcapProj != null ? m.gdpcapProj : m.gdpcap),
    elasticity: m.elasticity,
    pop: m.pop,
    tourism: 0,
    fuel: 0,
    lcc: 0,
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
  const atmPerPax = hasAtm ? annualAtm / annualPax : null;

  const gIncome  = s.gdp * s.elasticity;
  const gPop     = s.pop;
  const gTourism = s.tourism * 0.5;
  const gLCC     = s.lcc;
  const yieldDrag = -s.fuel * 0.18;
  const gDemand = (gIncome + gPop + gTourism + gLCC + yieldDrag) / 100;
  const gCargo  = gDemand * 0.6 + 0.005;

  const basePax = {}, baseCargo = {};
  baseMonths.forEach(r => { basePax[r.m] = r.pax; if (r.cargo != null) baseCargo[r.m] = r.cargo; });
  const cargoMonthAvg = hasCargo ? annualCargo / 12 : null;

  const months = [];
  let yy = baseYear, mm = 11;
  const total = s.horizon * 12;
  for (let k=1; k<=total; k++){
    mm++; if (mm>11){ mm=0; yy++; }
    const yf = k/12;
    const pax = (basePax[mm] != null ? basePax[mm] : annualPax/12) * Math.pow(1+gDemand, yf);
    const rec = { y:yy, m:mm, date:`${yy}-${String(mm+1).padStart(2,"0")}`,
      label:`${MONTHS[mm]} ${String(yy).slice(2)}`, pax:Math.round(pax) };
    if (hasAtm)   rec.atm   = Math.round(pax * atmPerPax);
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
  GP_fmt:fmt, GP_setActivity:setActivity, GP_activityFor:activityFor, GP_setForecast:setForecast,
});

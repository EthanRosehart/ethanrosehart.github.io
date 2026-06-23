/* ============================================================
   data.jsx — datasets + forecasting engine
   Curated real airports (OpenFlights-style schema), synthetic-
   but-plausible aero history, and the two forecast models:
   short-term ML (tactical) + long-term elasticity (strategic).
   Exposed on window for the other babel modules.
   ============================================================ */

/* ---- curated airport reference (OpenFlights schema) -------- */
/* fields mirror the OpenFlights airports.dat columns           */
const AIRPORTS = [
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
/* trend real GDP growth, GDP/cap, income (PAX) elasticity by mkt */
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

/* per-airport "today" anchors (annualised, latest full year)   */
/* tuned to be plausible for each gateway's size & gauge        */
const ANCHOR = {
  YTZ: { pax:2720000, atm:112400, cargoT:410,  seats:3315000, basedAircraft:34, carriers:2,  topRoute:"Montréal YUL", capATM:202000, noiseCapped:true },
  YOW: { pax:5100000, atm:131000, cargoT:2900, seats:6200000, basedAircraft:22, carriers:9,  topRoute:"Toronto YYZ", capATM:230000, noiseCapped:false },
  YHM: { pax:920000,  atm:42000,  cargoT:95000,seats:1180000, basedAircraft:9,  carriers:3,  topRoute:"Calgary YYC", capATM:160000, noiseCapped:false },
  YQB: { pax:1700000, atm:64000,  cargoT:1600, seats:2150000, basedAircraft:11, carriers:7,  topRoute:"Montréal YUL", capATM:140000, noiseCapped:false },
  YHZ: { pax:4200000, atm:88000,  cargoT:30000,seats:5050000, basedAircraft:14, carriers:11, topRoute:"Toronto YYZ", capATM:170000, noiseCapped:false },
  YKF: { pax:280000,  atm:19000,  cargoT:40,   seats:360000,  basedAircraft:6,  carriers:1,  topRoute:"Calgary YYC", capATM:90000,  noiseCapped:false },
  BUR: { pax:5900000, atm:135000, cargoT:54000,seats:7100000, basedAircraft:18, carriers:8,  topRoute:"Las Vegas LAS",capATM:200000, noiseCapped:true },
  PVU: { pax:740000,  atm:24000,  cargoT:120,  seats:920000,  basedAircraft:5,  carriers:3,  topRoute:"Denver DEN",  capATM:110000, noiseCapped:false },
  PSP: { pax:3000000, atm:62000,  cargoT:1100, seats:3650000, basedAircraft:7,  carriers:13, topRoute:"Seattle SEA", capATM:150000, noiseCapped:false },
  BZN: { pax:2400000, atm:55000,  cargoT:3400, seats:2900000, basedAircraft:8,  carriers:9,  topRoute:"Denver DEN",  capATM:140000, noiseCapped:false },
  EXT: { pax:980000,  atm:32000,  cargoT:600,  seats:1240000, basedAircraft:6,  carriers:5,  topRoute:"Dublin DUB",  capATM:120000, noiseCapped:false },
  NQY: { pax:460000,  atm:17000,  cargoT:30,   seats:580000,  basedAircraft:3,  carriers:4,  topRoute:"London LGW",  capATM:90000,  noiseCapped:false },
  INV: { pax:920000,  atm:34000,  cargoT:250,  seats:1160000, basedAircraft:5,  carriers:6,  topRoute:"London LGW",  capATM:120000, noiseCapped:false },
  RTM: { pax:2100000, atm:50000,  cargoT:900,  seats:2560000, basedAircraft:7,  carriers:14, topRoute:"London LCY", capATM:130000, noiseCapped:true },
  FMM: { pax:2300000, atm:38000,  cargoT:200,  seats:2780000, basedAircraft:6,  carriers:5,  topRoute:"Antalya AYT", capATM:120000, noiseCapped:false },
  AAR: { pax:330000,  atm:14000,  cargoT:60,   seats:420000,  basedAircraft:3,  carriers:3,  topRoute:"Copenhagen CPH",capATM:80000, noiseCapped:false },
  GRZ: { pax:880000,  atm:30000,  cargoT:1200, seats:1110000, basedAircraft:5,  carriers:7,  topRoute:"Vienna VIE",  capATM:110000, noiseCapped:false },
  KLU: { pax:210000,  atm:11000,  cargoT:30,   seats:270000,  basedAircraft:3,  carriers:3,  topRoute:"Vienna VIE",  capATM:70000,  noiseCapped:false },
  SZG: { pax:1600000, atm:42000,  cargoT:400,  seats:1980000, basedAircraft:6,  carriers:12, topRoute:"London LGW", capATM:130000, noiseCapped:true },
  NAP: { pax:10900000,atm:84000,  cargoT:6500, seats:13200000,basedAircraft:9,  carriers:30, topRoute:"Milan MXP",  capATM:150000, noiseCapped:false },
  WRO: { pax:4000000, atm:48000,  cargoT:1500, seats:4850000, basedAircraft:7,  carriers:18, topRoute:"Warsaw WAW",  capATM:140000, noiseCapped:false },
};

/* deterministic PRNG so a given airport always renders identically */
function rng(seed){ let s = seed % 2147483647; if (s<=0) s += 2147483646; return () => (s = s*16807 % 2147483647) / 2147483647; }
function hashCode(str){ let h=0; for (let i=0;i<str.length;i++){ h=(h*31 + str.charCodeAt(i))|0; } return Math.abs(h); }

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
/* seasonal shape — northern-hemisphere leisure/biz blend, sums ~12 */
const SEASON = [0.74,0.71,0.92,0.98,1.07,1.18,1.27,1.24,1.10,1.04,0.86,0.89];

/* observed monthly passengers, loaded from data/activity.json at runtime.
   iata -> { "YYYY-MM": pax }.  buildHistory prefers these over synthetic. */
const OBSERVED = {};
let ACTIVITY_META = null;
function setActivity(json){
  for (const k in OBSERVED) delete OBSERVED[k];
  if (!json || !json.airports) return;
  Object.keys(json.airports).forEach(iata => {
    const a = json.airports[iata];
    if (a && a.observed && a.monthly) OBSERVED[iata] = a.monthly;
  });
  ACTIVITY_META = json;
  window.GP_ACTIVITY_META = json;
}
function activityFor(iata){
  const a = ACTIVITY_META && ACTIVITY_META.airports ? ACTIVITY_META.airports[iata] : null;
  if (!a) return { observed:false, source:"modeled", months:0 };
  return { observed:!!a.observed, source:a.source, months:a.months||0, rep:a.rep_airp,
    latest: a.monthly ? Object.keys(a.monthly).sort().pop() : null };
}

/* Build 11 years of monthly history (2015-01 .. 2025-12) ----- */
function buildHistory(iata){
  const a = ANCHOR[iata];
  const rand = rng(hashCode(iata)+7);
  const startYear = 2015, endYear = 2025;
  // back-cast: assume the gateway grew ~3.6%/yr to the anchor, with a COVID crater
  const out = [];
  // index anchor at 2024 average month
  const anchorMonthlyPax = a.pax/12;
  const baseGrowth = 0.036 + (rand()-0.5)*0.01;
  for (let y=startYear; y<=endYear; y++){
    for (let m=0; m<12; m++){
      const yearsFrom2024 = y - 2024;
      let trend = Math.pow(1+baseGrowth, yearsFrom2024);
      // covid shock
      let covid = 1;
      if (y===2020){ const sev=[0.92,0.86,0.42,0.06,0.05,0.09,0.14,0.18,0.20,0.19,0.16,0.18]; covid = sev[m]; }
      if (y===2021){ const sev=[0.17,0.16,0.22,0.27,0.31,0.40,0.52,0.55,0.58,0.63,0.66,0.61]; covid = sev[m]; }
      if (y===2022){ const sev=[0.58,0.62,0.72,0.80,0.85,0.90,0.93,0.94,0.93,0.95,0.93,0.92]; covid = sev[m]; }
      if (y===2023){ covid = 0.95 + m*0.004; }
      const noise = 1 + (rand()-0.5)*0.045;
      let pax = anchorMonthlyPax * SEASON[m] * trend * covid * noise;
      // prefer the observed value from the committed activity snapshot, if present
      const obsKey = `${y}-${String(m+1).padStart(2,"0")}`;
      const obs = OBSERVED[iata] && OBSERVED[iata][obsKey];
      const observed = obs != null;
      if (observed) pax = obs;
      const lf = 0.80 + (SEASON[m]-1)*0.05 + (rand()-0.5)*0.03; // load factor moves with season
      const seats = pax / Math.min(0.93, Math.max(0.62, lf));
      // movements track seats via airport-specific gauge (seats per movement),
      // anchored so 2024 reproduces the published movement count; gauge creeps up over time
      const gaugeBase = a.seats / a.atm;
      const gauge = gaugeBase * Math.pow(1.011, y-2024);
      const atm = (seats / gauge) * (1 + (rand()-0.5)*0.04);
      const cargo = (a.cargoT/12) * SEASON[m] * trend * covid * (1+(rand()-0.5)*0.08);
      out.push({ y, m, date:`${y}-${String(m+1).padStart(2,"0")}`, label:`${MONTHS[m]} ${String(y).slice(2)}`,
        pax:Math.round(pax), seats:Math.round(seats), atm:Math.round(atm), cargo:Math.round(cargo*10)/10,
        lf:Math.round(Math.min(0.95,Math.max(0.60,lf))*1000)/10, observed });
    }
  }
  return out;
}

/* annual roll-up */
function annualize(history, key){
  const by = {};
  history.forEach(r => { by[r.y] = (by[r.y]||0) + r[key]; });
  return Object.keys(by).map(y => ({ y:+y, v: Math.round(by[y]) }));
}

/* ============================================================
   SHORT-TERM TACTICAL MODEL  (ML, monthly, ~24-mo horizon)
   Decomposition forecast: log-trend (Holt) × multiplicative
   seasonal index, with an expanding prediction interval.
   Reports an honest backtest MAPE on a held-out tail.
   ============================================================ */
function shortTermForecast(history, key, horizon=24){
  const series = history.map(r => r[key]);
  const n = series.length;
  // seasonal indices from last 3 clean years (2023-2025)
  const clean = history.filter(r => r.y>=2023);
  const seasAvg = Array(12).fill(0), seasCnt = Array(12).fill(0);
  const cleanMean = clean.reduce((s,r)=>s+r[key],0)/clean.length;
  clean.forEach(r => { seasAvg[r.m]+=r[key]; seasCnt[r.m]++; });
  const seasIdx = seasAvg.map((s,i)=> seasCnt[i] ? (s/seasCnt[i])/cleanMean : 1);
  // deseasonalize then fit log-linear trend on last 30 months (post-recovery)
  const fitWin = history.slice(-30);
  const xs=[], ys=[];
  fitWin.forEach((r,i)=>{ const d = r[key]/ (seasIdx[r.m]||1); if (d>0){ xs.push(i); ys.push(Math.log(d)); } });
  const mx = xs.reduce((a,b)=>a+b,0)/xs.length, my = ys.reduce((a,b)=>a+b,0)/ys.length;
  let num=0, den=0; xs.forEach((x,i)=>{ num+=(x-mx)*(ys[i]-my); den+=(x-mx)*(x-mx); });
  const slope = num/den, intercept = my - slope*mx;
  const baseIdx = fitWin.length - 1;
  // backtest: fit on all-but-last-12, predict the 12, compute MAPE
  let mape = 0, cnt=0;
  for (let h=1; h<=12; h++){
    const idx = baseIdx - 12 + h;
    const r = fitWin[fitWin.length-12-1+h];
    if (!r) continue;
    const pred = Math.exp(intercept + slope*(idx)) * (seasIdx[r.m]||1);
    mape += Math.abs(pred - r[key]) / r[key]; cnt++;
  }
  mape = cnt ? (mape/cnt)*100 : 6;
  // forward forecast
  const last = history[n-1];
  const fitted = history.map((r,i)=>{
    const localIdx = i - (n - fitWin.length);
    if (localIdx < 0) return null;
    return { date:r.date, label:r.label, v: Math.round(Math.exp(intercept + slope*localIdx)*(seasIdx[r.m]||1)) };
  });
  const fc = [];
  let yy = last.y, mm = last.m;
  for (let h=1; h<=horizon; h++){
    mm++; if (mm>11){ mm=0; yy++; }
    const idx = baseIdx + h;
    const mean = Math.exp(intercept + slope*idx) * (seasIdx[mm]||1);
    const sigma = (mape/100) * Math.sqrt(h/3) * 0.9; // widening band
    fc.push({ date:`${yy}-${String(mm+1).padStart(2,"0")}`, label:`${MONTHS[mm]} ${String(yy).slice(2)}`,
      v:Math.round(mean), lo:Math.round(mean*(1-1.28*sigma)), hi:Math.round(mean*(1+1.28*sigma)), y:yy, m:mm });
  }
  return { fitted, forecast:fc, mape:Math.round(mape*10)/10, slope, seasIdx };
}

/* ============================================================
   LONG-TERM STRATEGIC MODEL  (elasticity, 10yr, annual)
   demand growth gₜ = gdpPerCap·ε  +  pop  +  tourism·τ  −  yieldDrag
   PAX compounds at gₜ; ATM constrained by slot/noise capacity,
   residual demand absorbed by gauge (seats/movement) & load factor.
   ============================================================ */
function defaultScenario(iata){
  const a = ANCHOR[iata];
  const m = MACRO[AIRPORTS.find(x=>x.iata===iata).cc];
  return {
    gdp: (m.gdpcapProj != null ? m.gdpcapProj : m.gdpcap),  // OECD forward projection if present, else World Bank historical
    elasticity: m.elasticity,      // income elasticity of air travel
    pop: m.pop,                    // catchment population growth %
    tourism: 0,                    // tourism demand shift % (additive)
    fuel: 0,                       // jet-fuel / yield shock % (0 = neutral)
    lcc: 0,                        // new LCC / route stimulation % uplift
    horizon: 10,
  };
}

function longTermForecast(iata, history, scenario){
  const a = ANCHOR[iata];
  const annualPax = annualize(history.filter(r=>r.y===2025), "pax")[0].v;
  const annualAtm = annualize(history.filter(r=>r.y===2025), "atm")[0].v;
  const annualSeats = annualize(history.filter(r=>r.y===2025), "seats")[0].v;
  const annualCargo = annualize(history.filter(r=>r.y===2025), "cargo")[0].v;
  const s = scenario;
  // annual demand growth rate (%) decomposed
  const gIncome  = s.gdp * s.elasticity;
  const gPop     = s.pop;
  const gTourism = s.tourism * 0.5;
  const gLCC     = s.lcc;
  const yieldDrag = -s.fuel * 0.18;   // higher fuel/yield suppresses demand
  const gDemand = (gIncome + gPop + gTourism + gLCC + yieldDrag) / 100;

  const rows = [{ y:2025, pax:annualPax, atm:annualAtm, seats:annualSeats, cargo:annualCargo, gauge:annualSeats/annualAtm, lf:annualPax/annualSeats }];
  let pax=annualPax, atm=annualAtm, seats=annualSeats, cargo=annualCargo;
  let gauge = annualSeats/annualAtm, lf = annualPax/annualSeats;
  const atmCap = a.capATM;
  for (let i=1;i<=s.horizon;i++){
    pax = pax * (1+gDemand);
    cargo = cargo * (1 + gDemand*0.6 + 0.005);
    // gauge & load factor creep upward as constrained gateways densify
    gauge = gauge * (1 + 0.008 + (a.noiseCapped?0.004:0));
    lf = Math.min(0.90, lf * 1.004);
    seats = pax / lf;
    atm = seats / gauge;
    let constrained = false;
    if (atm > atmCap){ atm = atmCap; seats = atm*gauge; lf = Math.min(0.92, pax/seats); constrained = true;
      if (pax/seats > 0.92){ pax = seats*0.92; } }
    rows.push({ y:2025+i, pax:Math.round(pax), atm:Math.round(atm), seats:Math.round(seats),
      cargo:Math.round(cargo), gauge:Math.round(gauge*10)/10, lf:Math.round((pax/seats)*1000)/10, constrained });
  }
  const cagr = Math.pow(rows[rows.length-1].pax/annualPax, 1/s.horizon)-1;
  return { rows, gDemand:gDemand*100, cagr:cagr*100,
    breakdown:[
      { k:"Income × elasticity", v:gIncome, c:"var(--pink)" },
      { k:"Catchment population", v:gPop, c:"var(--cyan)" },
      { k:"Tourism shift", v:gTourism, c:"var(--lime)" },
      { k:"LCC / route stimulation", v:gLCC, c:"var(--violet)" },
      { k:"Yield / fuel drag", v:yieldDrag, c:"var(--bad)" },
    ],
    atmCap, constrainedFrom: rows.find(r=>r.constrained)?.y };
}

/* destination mix for the selected gateway (illustrative) ----- */
function routeMix(iata){
  const a = ANCHOR[iata];
  const rand = rng(hashCode(iata)+99);
  const pool = ["Montréal YUL","Ottawa YOW","Boston BOS","Chicago ORD","New York EWR","Washington IAD","Halifax YHZ","Québec YQB","Vancouver YVR","Calgary YYC","London LGW","Dublin DUB"];
  const n = 6;
  let shares = Array.from({length:n}, ()=> 0.4+rand());
  const sum = shares.reduce((x,y)=>x+y,0);
  shares = shares.map(x=> x/sum);
  shares.sort((x,y)=>y-x);
  return shares.map((sh,i)=> ({ name: i===0 ? a.topRoute : pool[(hashCode(iata)+i*3)%pool.length], share: Math.round(sh*1000)/10, pax: Math.round(a.pax*sh) }));
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
  AIRPORTS, MACRO, ANCHOR, MONTHS, GP_buildHistory:buildHistory, GP_annualize:annualize,
  GP_shortTerm:shortTermForecast, GP_longTerm:longTermForecast, GP_defaultScenario:defaultScenario,
  GP_routeMix:routeMix, GP_fmt:fmt, GP_setActivity:setActivity, GP_activityFor:activityFor,
});

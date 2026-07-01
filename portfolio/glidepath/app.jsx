/* ============================================================
   app.jsx — shell, navigation, state, persistence
   ============================================================ */
const { useState:useStateApp, useEffect:useEffectApp, useMemo:useMemoApp, useRef:useRefApp } = React;
const LS = "glidepath.v1";

const NAV = [
  { id:"select",   label:"Select airport", group:"Setup", step:1, icon:GP_Ico.pin },
  { id:"connect",  label:"Connect data",   group:"Setup", step:2, icon:GP_Ico.db },
  { id:"overview", label:"Overview",       group:"Forecast", icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg> },
  { id:"short",    label:"Short-term (Prophet)",group:"Forecast", icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 17l5-5 4 3 8-9"/><path d="M21 6v5h-5"/></svg> },
  { id:"long",     label:"Long-term",group:"Forecast", icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg> },
  { id:"scenario", label:"Baseline assumptions",group:"Forecast", icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="6" cy="8" r="2"/><path d="M6 10v6M6 4v2"/><circle cx="14" cy="14" r="2"/><path d="M14 4v8M14 16v4"/><circle cx="20" cy="7" r="0"/></svg> },
  { id:"events",   label:"Event simulator",group:"Forecast", icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg> },
  { id:"export",   label:"Export",         group:"Deliver", icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12m0-12l-4 4m4-4l4 4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg> },
];
const TITLES = {
  select:["Setup","Select your gateway"], connect:["Setup","Connect public data"],
  overview:["Forecast","Gateway overview"], short:["Forecast","Short-term tactical forecast"],
  long:["Forecast","Long-term strategic forecast"], scenario:["Forecast","Baseline assumptions"],
  events:["Forecast","Event simulator"],
  export:["Deliver","Export & report"],
};

function App(){
  const saved = useMemoApp(()=>{ try { return JSON.parse(localStorage.getItem(LS)||"{}"); } catch(e){ return {}; } },[]);
  const [screen, setScreen] = useStateApp(saved.screen || "select");
  const [airport, setAirport] = useStateApp(()=> saved.iata ? AIRPORTS.find(a=>a.iata===saved.iata) : null);
  const [connected, setConnected] = useStateApp(!!saved.connected);
  const [scenario, setScenario] = useStateApp(saved.scenario || (saved.iata ? GP_defaultScenario(saved.iata) : null));
  const [macroMeta, setMacroMeta] = useStateApp(window.GP_MACRO_META || null);
  const [actMeta, setActMeta] = useStateApp(window.GP_ACTIVITY_META || null);
  const [ofMeta, setOfMeta] = useStateApp(window.GP_OF_META || null);
  const [actVer, setActVer] = useStateApp(0);
  const [navOpen, setNavOpen] = useStateApp(false);   // mobile drawer

  // kept current via effects below so async callbacks (fetch .then) can read
  // live state instead of the value closed over when the effect first ran
  const airportRef = useRefApp(airport);
  const connectedRef = useRefApp(connected);
  useEffectApp(()=>{ airportRef.current = airport; },[airport]);
  useEffectApp(()=>{ connectedRef.current = connected; },[connected]);

  const history = useMemoApp(()=> airport ? GP_buildHistory(airport.iata) : null, [airport, actVer]);

  // OpenFlights reference (data/airports.json) — enrich the data-driven
  // catalogue with authoritative identifiers/coords. Same-origin, no CORS.
  useEffectApp(()=>{
    let alive = true;
    fetch("data/airports.json", { cache:"no-cache" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!alive || !j || !j.airports) return;
        GP_setReference(j);                 // rebuilds AIRPORTS with enrichment
        window.GP_OF_META = j; setOfMeta(j); setActVer(v=>v+1);
      })
      .catch(()=>{});
    return ()=>{ alive = false; };
  },[]);

  // OECD Economic Outlook removed: its SDMX endpoint returns HTTP 500 and the
  // GDP-growth lever default falls back to the real World Bank GDP/capita
  // figure (data/macro.json), so no projection layer is needed.

  // Load the airport catalogue index (data/activity-index.json) — metadata
  // for every gateway (no series; that's fetched lazily once selected, see
  // the effect below). Same-origin, no CORS.
  useEffectApp(()=>{
    let alive = true;
    fetch("data/activity-index.json", { cache:"no-cache" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!alive || !j) return;
        GP_setActivityIndex(j);  // (re)builds the AIRPORTS catalogue
        setActMeta(j);
        // restore a returning user's saved airport now the catalogue exists
        if (saved.iata && !airport) {
          const a = AIRPORTS.find(x => x.iata === saved.iata);
          if (a) setAirport(a);
        }
        setActVer(v => v + 1);   // force history to rebuild
      })
      .catch(()=>{});
    return ()=>{ alive = false; };
  },[]);

  // Meta Prophet's shared model metadata (data/forecast-meta.json) — small,
  // loaded once. Each airport's actual forecast is fetched lazily below.
  const [fcMeta, setFcMeta] = useStateApp(window.GP_FORECAST_META || null);
  useEffectApp(()=>{
    let alive = true;
    fetch("data/forecast-meta.json", { cache:"no-cache" })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (alive && j) { GP_setForecastMeta(j); setFcMeta(j); } })
      .catch(()=>{});
    return ()=>{ alive = false; };
  },[]);

  // Once a gateway is selected, fetch ITS OWN monthly series + forecast —
  // data/series/<IATA>.json and data/forecasts/<IATA>.json — rather than
  // downloading every airport's numbers up front. seriesStatus drives both
  // the real (non-simulated) progress on the Connect data screen and the
  // "Build forecast" gate, so a visitor can never reach a data screen before
  // this airport's real numbers are actually in memory.
  const [seriesStatus, setSeriesStatus] = useStateApp({ iata:null, loading:false, ready:false, error:false });
  useEffectApp(()=>{
    if (!airport) return;
    const iata = airport.iata;
    if (GP_hasAirportSeries(iata)) { setSeriesStatus({ iata, loading:false, ready:true, error:false }); return; }
    let alive = true;
    setSeriesStatus({ iata, loading:true, ready:false, error:false });
    fetch(`data/series/${iata}.json`, { cache:"no-cache" })
      .then(r => r.ok ? r.json() : Promise.reject(new Error("series HTTP "+r.status)))
      .then(seriesJson => {
        if (!alive) return null;
        GP_setAirportSeries(iata, seriesJson);
        // the forecast is best-effort — some gateways don't clear Prophet's
        // minimum history yet, and a missing one is already handled by the
        // screens ("No forecast available"), so a 404 here isn't fatal.
        return fetch(`data/forecasts/${iata}.json`, { cache:"no-cache" }).then(r => r.ok ? r.json() : null).catch(()=>null);
      })
      .then(forecastJson => {
        if (!alive) return;
        if (forecastJson) GP_setAirportForecast(iata, forecastJson);
        setActVer(v => v + 1);
        setSeriesStatus({ iata, loading:false, ready:true, error:false });
      })
      .catch(()=>{ if (alive) setSeriesStatus({ iata, loading:false, ready:false, error:true }); });
    return ()=>{ alive = false; };
  },[airport]);
  const dataReady = !!airport && seriesStatus.iata===airport.iata && seriesStatus.ready;

  // Load the committed macro snapshot (data/macro.json) and merge the real
  // World Bank figures over the embedded baselines. Same-origin fetch, so no
  // CORS; if it fails we silently keep the built-in defaults.
  useEffectApp(()=>{
    let alive = true;
    fetch("data/macro.json", { cache:"no-cache" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!alive || !j || !j.countries) return;
        Object.keys(j.countries).forEach(cc => {
          const c = j.countries[cc];
          GP_ensureMacro(cc, c.name);     // create defaults for new countries
          if (c.gdp != null)    MACRO[cc].gdp = c.gdp;
          if (c.gdpcap != null) MACRO[cc].gdpcap = c.gdpcap;
          if (c.pop != null)    MACRO[cc].pop = c.pop;
          MACRO[cc].live = true; MACRO[cc].year = c.year; MACRO[cc].popTotal = c.popTotal;
        });
        window.GP_MACRO_META = { ...j, live:true };
        setMacroMeta(window.GP_MACRO_META);
        // refresh the working scenario to the live baseline only while still in
        // setup — never clobber a returning user's saved what-if assumptions.
        // Reads the refs (not the closed-over state) since this callback can
        // resolve well after the effect first ran, once the user has moved on.
        if (!connectedRef.current && airportRef.current) setScenario(GP_defaultScenario(airportRef.current.iata));
      })
      .catch(()=>{});
    return ()=>{ alive = false; };
  },[]);

  useEffectApp(()=>{
    localStorage.setItem(LS, JSON.stringify({ screen, iata:airport?.iata, connected, scenario }));
  },[screen, airport, connected, scenario]);

  // ensure scenario resets to airport default when airport changes & none set
  useEffectApp(()=>{
    if (airport && !scenario) setScenario(GP_defaultScenario(airport.iata));
  },[airport]);

  const selectAirport = (a, proceed)=>{
    if (!airport || airport.iata!==a.iata){ setAirport(a); setScenario(GP_defaultScenario(a.iata)); setConnected(false); }
    if (proceed) setScreen("connect");
  };
  const finishConnect = ()=>{ setConnected(true); setScreen("overview"); };

  const reachable = (id)=>{
    if (id==="select") return true;
    if (id==="connect") return !!airport;
    return !!airport && connected;
  };
  const go = (id)=>{ if (reachable(id)){ setScreen(id); setNavOpen(false); } };

  const [t1,t2] = TITLES[screen] || ["",""];

  return (
    <div className="app">
      {navOpen && <div className="nav-overlay" onClick={()=>setNavOpen(false)}></div>}
      <aside className={"nav"+(navOpen?" open":"")}>
        <div className="brand">
          <div className="brand-mark"><svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L11 19v-5.5z"/></svg></div>
          <div className="brand-name">Glide<span>path</span></div>
        </div>

        {["Setup","Forecast","Deliver"].map(group=>(
          <div key={group}>
            <div className="nav-section">{group}</div>
            {NAV.filter(n=>n.group===group).map(n=>{
              const active = screen===n.id;
              const ok = reachable(n.id);
              const done = (n.id==="select"&&airport) || (n.id==="connect"&&connected);
              return (
                <div key={n.id} className={"nav-item"+(active?" active":"")+(done&&!active?" done":"")+(ok?"":" nav-disabled")} onClick={()=>go(n.id)}>
                  {n.step ? <span className="step-n">{done&&!active?"✓":n.step}</span> : <span style={{width:18,display:"grid",placeItems:"center"}}>{n.icon}</span>}
                  <span>{n.label}</span>
                </div>
              );
            })}
          </div>
        ))}

        <div className="nav-foot">
          {airport ? (
            <div className="nav-air">
              <span className="nav-air-code">{airport.iata}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",color:"var(--dim)"}}>{airport.city}</div>
                <div className="air-meta" style={{fontSize:10}}>{connected?<span style={{color:"var(--ok)"}}>● data live</span>:"not connected"}</div>
              </div>
              <button className="icon-btn" title="Change airport" onClick={()=>{ setScreen("select"); setNavOpen(false); }} style={{width:30,height:30}}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
              </button>
            </div>
          ) : (
            <div className="air-meta" style={{padding:"4px 8px"}}>No gateway selected</div>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div style={{display:"flex",alignItems:"center",gap:12,minWidth:0}}>
            <button className="icon-btn mobile-only" title="Menu" aria-label="Open navigation" onClick={()=>setNavOpen(true)} style={{flex:"none"}}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
            </button>
            <a className="btn btn-sm" href="/" title="Back to ethanrosehart.com" style={{textDecoration:"none",flex:"none"}}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>
              Back to site
            </a>
            <div className="topbar-title">
              <div className="eyebrow">{t1}</div>
              <h2>{t2}</h2>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span className="topbar-chips" style={{display:"flex",alignItems:"center",gap:12}}>
              {macroMeta && <span className="chip" title={"World Bank snapshot · "+(macroMeta.source||"")}><span className="dot dot-ok"></span>WB snapshot {new Date(macroMeta.generatedAt).toLocaleDateString("en-CA")}</span>}
              {airport && <span className="chip chip-pink"><span className="dot dot-pink"></span>{airport.iata} · {airport.icao}</span>}
              {connected && <span className="chip chip-ok"><span className="dot dot-ok"></span>3 sources live</span>}
            </span>
            {connected && screen!=="export" && <button className="btn btn-primary btn-sm" onClick={()=>{ setScreen("export"); setNavOpen(false); }}>Export</button>}
          </div>
        </div>

        {screen==="select"   && <Onboarding onSelect={selectAirport} selected={airport}/>}
        {screen==="connect"  && airport && <ConnectData airport={airport} onDone={finishConnect} alreadyDone={connected} macroMeta={macroMeta} actMeta={actMeta} ofMeta={ofMeta} seriesStatus={seriesStatus}/>}
        {screen!=="select" && screen!=="connect" && connected && airport && !dataReady && (
          <div className="content fade-in"><div className="panel panel-pad"><div className="air-meta">
            {seriesStatus.error ? `Couldn't load ${airport.iata}'s data — check your connection and reload.` : `Loading ${airport.iata} data…`}
          </div></div></div>
        )}
        {screen==="overview" && airport && connected && dataReady && scenario && <Overview airport={airport} history={history} scenario={scenario} go={go}/>}
        {screen==="short"    && airport && connected && dataReady && <ShortTerm airport={airport} history={history}/>}
        {screen==="long"     && airport && connected && dataReady && scenario && <LongTerm airport={airport} history={history} scenario={scenario} go={go}/>}
        {screen==="scenario" && airport && connected && dataReady && scenario && <Scenario airport={airport} history={history} scenario={scenario} setScenario={setScenario}/>}
        {screen==="events"   && airport && connected && dataReady && scenario && <EventSim airport={airport} history={history} scenario={scenario} setScenario={setScenario}/>}
        {screen==="export"   && airport && connected && dataReady && scenario && <ExportView airport={airport} history={history} scenario={scenario}/>}
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);

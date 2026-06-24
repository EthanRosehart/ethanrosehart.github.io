/* ============================================================
   app.jsx — shell, navigation, state, persistence
   ============================================================ */
const { useState:useStateApp, useEffect:useEffectApp, useMemo:useMemoApp } = React;
const LS = "glidepath.v1";

const NAV = [
  { id:"select",   label:"Select airport", group:"Setup", step:1, icon:GP_Ico.pin },
  { id:"connect",  label:"Connect data",   group:"Setup", step:2, icon:GP_Ico.db },
  { id:"overview", label:"Overview",       group:"Forecast", icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg> },
  { id:"short",    label:"Short-term (ML)",group:"Forecast", icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 17l5-5 4 3 8-9"/><path d="M21 6v5h-5"/></svg> },
  { id:"long",     label:"Long-term (10yr)",group:"Forecast", icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg> },
  { id:"scenario", label:"Scenario builder",group:"Forecast", icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="6" cy="8" r="2"/><path d="M6 10v6M6 4v2"/><circle cx="14" cy="14" r="2"/><path d="M14 4v8M14 16v4"/><circle cx="20" cy="7" r="0"/></svg> },
  { id:"export",   label:"Export",         group:"Deliver", icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12m0-12l-4 4m4-4l4 4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg> },
];
const TITLES = {
  select:["Setup","Select your gateway"], connect:["Setup","Connect public data"],
  overview:["Forecast","Gateway overview"], short:["Forecast","Short-term tactical forecast"],
  long:["Forecast","Long-term strategic forecast"], scenario:["Forecast","Scenario builder"],
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
  const [oecdMeta, setOecdMeta] = useStateApp(window.GP_OECD_META || null);
  const [ofMeta, setOfMeta] = useStateApp(window.GP_OF_META || null);
  const [actVer, setActVer] = useStateApp(0);

  const history = useMemoApp(()=> airport ? GP_buildHistory(airport.iata) : null, [airport, actVer]);

  // OpenFlights reference (data/airports.json) — enrich the airport catalogue
  // with authoritative identifiers/coords. Same-origin, no CORS.
  useEffectApp(()=>{
    let alive = true;
    fetch("data/airports.json", { cache:"no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!alive || !j || !j.airports) return;
        AIRPORTS.forEach(a => {
          const r = j.airports[a.iata];
          if (!r) return;
          if (r.icao) a.icao = r.icao;
          if (r.lat != null) a.lat = r.lat;
          if (r.lon != null) a.lon = r.lon;
          if (r.elev_ft != null) a.elev = r.elev_ft;
          if (r.tz) a.tz = r.tz;
          if (r.name) a.name = r.name;
          a.ofVerified = true;
        });
        window.GP_OF_META = j; setOfMeta(j); setActVer(v=>v+1);
      })
      .catch(()=>{});
    return ()=>{ alive = false; };
  },[]);

  // OECD Economic Outlook (data/oecd.json) — forward GDP-growth projections set
  // the GDP lever default (preferred over World Bank historical). No CORS.
  useEffectApp(()=>{
    let alive = true;
    fetch("data/oecd.json", { cache:"no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!alive || !j || !j.countries) return;
        Object.keys(j.countries).forEach(cc => {
          if (!MACRO[cc]) return;
          const c = j.countries[cc];
          if (c.gdpcapProj != null) MACRO[cc].gdpcapProj = c.gdpcapProj;
          if (c.gdpProj != null)    MACRO[cc].gdpProj = c.gdpProj;
          MACRO[cc].oecdHorizon = c.horizon;
        });
        window.GP_OECD_META = j; setOecdMeta(j);
        if (!connected && airport) setScenario(GP_defaultScenario(airport.iata));
      })
      .catch(()=>{});
    return ()=>{ alive = false; };
  },[]);

  // Load the committed monthly-passengers snapshot (data/activity.json) and let
  // buildHistory run the forecasts on the observed series. Same-origin, no CORS.
  useEffectApp(()=>{
    let alive = true;
    fetch("data/activity.json", { cache:"no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!alive || !j) return;
        GP_setActivity(j);
        setActMeta(j);
        setActVer(v => v + 1);   // force history (and every forecast) to rebuild
      })
      .catch(()=>{});
    return ()=>{ alive = false; };
  },[]);

  // Load the committed macro snapshot (data/macro.json) and merge the real
  // World Bank figures over the embedded baselines. Same-origin fetch, so no
  // CORS; if it fails we silently keep the built-in defaults.
  useEffectApp(()=>{
    let alive = true;
    fetch("data/macro.json", { cache:"no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!alive || !j || !j.countries) return;
        Object.keys(j.countries).forEach(cc => {
          if (!MACRO[cc]) return;
          const c = j.countries[cc];
          if (c.gdp != null)    MACRO[cc].gdp = c.gdp;
          if (c.gdpcap != null) MACRO[cc].gdpcap = c.gdpcap;
          if (c.pop != null)    MACRO[cc].pop = c.pop;
          MACRO[cc].live = true; MACRO[cc].year = c.year; MACRO[cc].popTotal = c.popTotal;
        });
        window.GP_MACRO_META = { ...j, live:true };
        setMacroMeta(window.GP_MACRO_META);
        // refresh the working scenario to the live baseline only while still in
        // setup — never clobber a returning user's saved what-if assumptions.
        if (!connected && airport) setScenario(GP_defaultScenario(airport.iata));
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
  const go = (id)=>{ if (reachable(id)) setScreen(id); };

  const [t1,t2] = TITLES[screen] || ["",""];

  return (
    <div className="app">
      <aside className="nav">
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
              <button className="icon-btn" title="Change airport" onClick={()=>setScreen("select")} style={{width:30,height:30}}>
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
          <div style={{display:"flex",alignItems:"center",gap:16,minWidth:0}}>
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
            {macroMeta && <span className="chip" title={"World Bank snapshot · "+(macroMeta.source||"")}><span className="dot dot-ok"></span>WB snapshot {new Date(macroMeta.generatedAt).toLocaleDateString("en-CA")}</span>}
            {airport && <span className="chip chip-pink"><span className="dot dot-pink"></span>{airport.iata} · {airport.icao}</span>}
            {connected && <span className="chip chip-ok"><span className="dot dot-ok"></span>4 sources live</span>}
            {connected && screen!=="export" && <button className="btn btn-primary btn-sm" onClick={()=>setScreen("export")}>Export</button>}
          </div>
        </div>

        {screen==="select"   && <Onboarding onSelect={selectAirport} selected={airport}/>}
        {screen==="connect"  && airport && <ConnectData airport={airport} onDone={finishConnect} alreadyDone={connected} macroMeta={macroMeta} actMeta={actMeta} oecdMeta={oecdMeta} ofMeta={ofMeta}/>}
        {screen==="overview" && airport && connected && scenario && <Overview airport={airport} history={history} scenario={scenario} go={go}/>}
        {screen==="short"    && airport && connected && <ShortTerm airport={airport} history={history}/>}
        {screen==="long"     && airport && connected && scenario && <LongTerm airport={airport} history={history} scenario={scenario} go={go}/>}
        {screen==="scenario" && airport && connected && scenario && <Scenario airport={airport} history={history} scenario={scenario} setScenario={setScenario}/>}
        {screen==="export"   && airport && connected && scenario && <ExportView airport={airport} history={history} scenario={scenario}/>}
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);

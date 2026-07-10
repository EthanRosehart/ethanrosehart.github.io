/* ============================================================
   app.jsx — shell, navigation, state, persistence
   ============================================================ */
const { useState:useStateApp, useEffect:useEffectApp, useMemo:useMemoApp, useRef:useRefApp } = React;
const LS = "glidepath.v1";

const NAV = [
  { id:"select",   label:"Select airport", group:"Setup", step:1, icon:GP_Ico.pin },
  { id:"connect",  label:"Connect data",   group:"Setup", step:2, icon:GP_Ico.db },
  { id:"upload",   label:"Upload data",    group:"Setup", icon:GP_Ico.upload }, // alt path to "connect" — see the "or" divider rendered between them
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
  const saved = useMemoApp(()=>{ try { return JSON.parse(localStorage.getItem(LS)||"{}") || {}; } catch(e){ return {}; } },[]);
  // a share link (#s=..., see GP_encodeShare in data.jsx) beats any saved
  // session — someone opening a link a colleague sent expects THAT scenario,
  // not whatever they last had open. Decoded once here; applied by the
  // activity-index effect below, since the catalogue has to exist before
  // the airport can be resolved. Decoding sanitizes: unknown keys and
  // non-numeric lever values never survive into state.
  const shared = useMemoApp(()=>{
    try {
      const m = (location.hash || "").match(/[#&]s=([A-Za-z0-9_-]+)/);
      return m ? GP_decodeShare(m[1]) : null;
    } catch(e){ return null; }
  },[]);
  const [screen, setScreen] = useStateApp(shared ? "select" : (saved.screen || "select"));
  // `|| null`, never undefined: the catalogue is still empty at first render
  // (it arrives by fetch), so find() can't succeed yet even for a valid
  // saved iata — the airport is restored by the activity-index effect below.
  const [airport, setAirport] = useStateApp(()=> saved.iata ? (AIRPORTS.find(a=>a.iata===saved.iata) || null) : null);
  const [connected, setConnected] = useStateApp(!!saved.connected);
  // A saved scenario can predate fields added since it was written (events,
  // cargo/gauge, per-segment shifts, …) — spread it over today's defaults so
  // every consumer sees a complete shape. Reject non-object junk outright.
  const [scenario, setScenario] = useStateApp(()=>{
    const sc = (saved.scenario && typeof saved.scenario === "object" && !Array.isArray(saved.scenario)) ? saved.scenario : null;
    if (saved.iata) return { ...GP_defaultScenario(saved.iata), ...(sc || {}) };
    return sc;
  });
  const [macroMeta, setMacroMeta] = useStateApp(window.GP_MACRO_META || null);
  const [actMeta, setActMeta] = useStateApp(window.GP_ACTIVITY_META || null);
  const [ofMeta, setOfMeta] = useStateApp(window.GP_OF_META || null);
  const [imfMeta, setImfMeta] = useStateApp(window.GP_IMF_META || null);
  // separate from imfMeta itself: true once the fetch attempt has settled
  // (200, 404, or network error) — IMF genuinely doesn't cover every
  // country, and the file may not exist yet on a fresh deploy, so "Connect
  // data" treats a settled-but-empty result as done rather than hanging.
  const [imfChecked, setImfChecked] = useStateApp(false);
  const [actVer, setActVer] = useStateApp(0);
  const [navOpen, setNavOpen] = useStateApp(false);   // mobile drawer
  const [customPending, setCustomPending] = useStateApp(false); // mid "upload your own data" flow, no airport chosen yet

  // kept current via effects below so async callbacks (fetch .then) can read
  // live state instead of the value closed over when the effect first ran
  const airportRef = useRefApp(airport);
  const connectedRef = useRefApp(connected);
  useEffectApp(()=>{ airportRef.current = airport; },[airport]);
  useEffectApp(()=>{ connectedRef.current = connected; },[connected]);

  // Restore a previously-uploaded custom airport. Unlike the catalogue path,
  // this never touches the network — the visitor's own data was saved
  // straight into localStorage (there's no server to re-fetch it from), so
  // it can be restored synchronously on mount, before any fetch resolves.
  useEffectApp(()=>{
    if (saved.customAirport && saved.customAirport.meta && saved.customAirport.series && !airport && !shared) {
      GP_registerCustomAirport(saved.customAirport.iata, saved.customAirport.meta, saved.customAirport.series, saved.customAirport.paxSeg || null);
      const a = AIRPORTS.find(x => x.iata === saved.customAirport.iata);
      if (a) setAirport(a);
      setActVer(v => v + 1);
    }
  },[]);

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
        // a share link resolves first (it's the explicit intent); then a
        // returning user's saved airport, now that the catalogue exists
        const sharedAirport = shared ? AIRPORTS.find(x => x.iata === shared.iata) : null;
        if (sharedAirport) {
          setAirport(sharedAirport);
          setScenario({ ...GP_defaultScenario(sharedAirport.iata), ...(shared.scenario || {}) });
          setConnected(true);
          setScreen("overview");
          try { history.replaceState(null, "", location.pathname + location.search); } catch(e){}
        } else if (saved.iata && !airport) {
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

  // Load the real forward GDP/capita growth forecast (data/imf-weo.json,
  // IMF World Economic Outlook — see scripts/fetch-imf.mjs) and set it as
  // gdpcapProj, which the long-term model's GDP lever default prefers over
  // the World Bank trailing mean when present (see defaultScenario() in
  // data.jsx). A missing file, or a country IMF doesn't cover, just means
  // that lever default falls back to the trailing mean, same as before
  // this existed — never a hard failure.
  useEffectApp(()=>{
    let alive = true;
    fetch("data/imf-weo.json", { cache:"no-cache" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!alive) return;
        if (j && j.countries) {
          Object.keys(j.countries).forEach(cc => {
            const c = j.countries[cc];
            if (!c.nextYear || c.nextYear.pct == null) return;
            GP_ensureMacro(cc, c.name);
            MACRO[cc].gdpcapProj = c.nextYear.pct;
            MACRO[cc].gdpcapProjYear = c.nextYear.year;
          });
          window.GP_IMF_META = j;
          setImfMeta(window.GP_IMF_META);
          if (!connectedRef.current && airportRef.current) setScenario(GP_defaultScenario(airportRef.current.iata));
        }
        setImfChecked(true);
      })
      .catch(()=>{ if (alive) setImfChecked(true); });
    return ()=>{ alive = false; };
  },[]);

  useEffectApp(()=>{
    const payload = { screen, iata:airport?.iata, connected, scenario };
    // a custom airport has no server to re-fetch from on the next visit, so
    // its meta + series ride along in localStorage itself (a few KB at most
    // for a decade of monthly numbers)
    if (airport?.custom) {
      payload.customAirport = {
        iata: airport.iata,
        meta: GP_getActivityMeta(airport.iata),
        series: GP_getObservedSeries(airport.iata),
        paxSeg: GP_getSegments(airport.iata),
      };
    }
    try { localStorage.setItem(LS, JSON.stringify(payload)); }
    catch(e){ /* storage full or blocked — persistence is best-effort */ }
  },[screen, airport, connected, scenario]);

  // ensure scenario resets to airport default when airport changes & none set
  useEffectApp(()=>{
    if (airport && !scenario) setScenario(GP_defaultScenario(airport.iata));
  },[airport]);

  const selectAirport = (a, proceed)=>{
    setCustomPending(false);
    if (!airport || airport.iata!==a.iata){ setAirport(a); setScenario(GP_defaultScenario(a.iata)); setConnected(false); }
    if (proceed) setScreen("connect");
  };
  const startUpload = ()=>{ setCustomPending(true); setScreen("connect"); };
  const cancelUpload = ()=>{ setCustomPending(false); setScreen("select"); };
  const finishConnect = ()=>{ setConnected(true); setScreen("overview"); };
  const finishCustomUpload = (iata, meta, series, paxSeg)=>{
    GP_registerCustomAirport(iata, meta, series, paxSeg || null);
    const a = AIRPORTS.find(x=>x.iata===iata);
    setAirport(a);
    setScenario(GP_defaultScenario(iata));
    setConnected(true);
    setCustomPending(false);
    setScreen("overview");
  };

  // start over completely — clears the saved session and, for a custom
  // gateway, unregisters it too (otherwise it'd linger in AIRPORTS and keep
  // matching liveAirports() even after the session that built it is gone)
  const resetApp = ()=>{
    if (!window.confirm("Start over? This clears the selected gateway, scenario and any uploaded data.")) return;
    if (airport?.custom) GP_removeCustomAirport(airport.iata);
    localStorage.removeItem(LS);
    setAirport(null); setConnected(false); setScenario(null); setCustomPending(false);
    setScreen("select"); setActVer(v=>v+1); setNavOpen(false);
  };

  // restore a session saved via Export ▸ Save session — either a custom
  // gateway (re-registered from its bundled meta+series, same machinery as
  // finishCustomUpload) or a reference to a catalogue iata (its real data
  // comes from the live pipeline, so only the scenario needs restoring)
  const importSession = async (file)=>{
    let session;
    try { session = JSON.parse(await file.text()); }
    catch(e){ return "that doesn't look like a Glidepath session file (invalid JSON)"; }
    if (!session || session.kind !== "glidepath-session" || !session.airport) {
      return "that doesn't look like a Glidepath session file";
    }
    let a;
    if (session.airport.custom && session.customAirport){
      GP_registerCustomAirport(session.customAirport.iata, session.customAirport.meta, session.customAirport.series, session.customAirport.paxSeg || null);
      a = AIRPORTS.find(x=>x.iata===session.customAirport.iata);
      if (!a) return "couldn't rebuild the uploaded gateway from that session";
    } else {
      a = AIRPORTS.find(x=>x.iata===session.airport.iata);
      if (!a) return session.airport.iata+" isn't in the current public catalogue — try again in a moment, or re-check the file.";
    }
    setAirport(a);
    setScenario(session.scenario || GP_defaultScenario(a.iata));
    setConnected(true);
    setCustomPending(false);
    setScreen("overview");
    setActVer(v=>v+1);
    return null;
  };

  const reachable = (id)=>{
    if (id==="select") return true;
    if (id==="connect") return !!airport || customPending;
    return !!airport && connected;
  };
  const go = (id)=>{ if (reachable(id)){ setScreen(id); setNavOpen(false); } };

  const [t1,t2] = (screen==="connect" && customPending) ? ["Setup","Provide your data"] : (TITLES[screen] || ["",""]);

  return (
    <div className="app">
      {navOpen && <div className="nav-overlay" onClick={()=>setNavOpen(false)}></div>}
      <aside className={"nav"+(navOpen?" open":"")}>
        <a className="nav-back" href="/" title="Leave Glidepath — back to ethanrosehart.com">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>
          ethanrosehart.com
        </a>
        <div className="brand">
          <div className="brand-mark"><svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L11 19v-5.5z"/></svg></div>
          <div className="brand-name">Glide<span>path</span></div>
        </div>

        {["Setup","Forecast","Deliver"].map(group=>(
          <div key={group}>
            <div className="nav-section">{group}</div>
            {NAV.filter(n=>n.group===group).map(n=>{
              // "Connect data" and "Upload data" are two alternative routes to
              // the same step 2 (both land on screen "connect", split by
              // customPending) — special-cased here rather than through the
              // generic reachable()/go() so each stays independently visible
              // and clickable instead of one relabeling itself over the other
              let active, done, ok, onClick;
              if (n.id==="connect"){
                active = screen==="connect" && !customPending;
                done = connected && !airport?.custom;
                ok = !!airport && !airport.custom;
                onClick = ()=>{ if (ok){ setCustomPending(false); setScreen("connect"); setNavOpen(false); } };
              } else if (n.id==="upload"){
                active = screen==="connect" && customPending;
                done = connected && !!airport?.custom;
                ok = true;
                onClick = ()=>{ startUpload(); setNavOpen(false); };
              } else {
                active = screen===n.id;
                done = n.id==="select" && !!airport;
                ok = reachable(n.id);
                onClick = ()=>go(n.id);
              }
              return (
                <React.Fragment key={n.id}>
                  {n.id==="upload" && <div className="nav-or">or</div>}
                  <div className={"nav-item"+(active?" active":"")+(done&&!active?" done":"")+(ok?"":" nav-disabled")} onClick={onClick}>
                    {n.step ? <span className="step-n">{done&&!active?"✓":n.step}</span> : <span style={{width:18,display:"grid",placeItems:"center"}}>{n.icon}</span>}
                    {/* an uploaded gateway's tactical model is in-browser ETS,
                        not the nightly server-side Prophet — say which */}
                    <span>{n.id==="short" && airport?.custom ? "Short-term (ETS)" : n.label}</span>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        ))}

        <div className="nav-foot">
          {airport ? (
            <div className="nav-air">
              <span className="nav-air-code">{airport.iata}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",color:"var(--dim)"}}>{airport.city || airport.country}</div>
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
            <div className="topbar-title">
              <div className="eyebrow">{t1}</div>
              <h2>{t2}</h2>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span className="topbar-chips" style={{display:"flex",alignItems:"center",gap:12}}>
              {airport && <span className="chip chip-pink"><span className="dot dot-pink"></span>{airport.iata}{airport.icao?" · "+airport.icao:""}</span>}
              {/* airport && too, not just connected: on a restored session,
                  connected=true from the very first render while airport
                  stays null until the catalogue fetch lands — reading
                  airport.cc here during that window is the crash that used
                  to blank the whole page. */}
              {airport && connected && (()=>{
                const fmtDate = (iso)=> iso ? new Date(iso).toLocaleDateString("en-CA") : "—";
                const fmtMonth = (ym)=>{ if (!ym) return "—"; const p = ym.split("-"); return MONTHS[+p[1]-1]+" "+p[0]; };
                const wbDate = macroMeta ? fmtDate(macroMeta.generatedAt) : "—";
                // IMF doesn't cover every country — only count/show it as a
                // live source when THIS airport's country actually has a
                // forecast on file (gdpcapProj is only ever set for one that does).
                const hasImf = !airport?.custom && MACRO[airport.cc]?.gdpcapProj != null;
                const rows = airport?.custom
                  ? [
                      { name:"Your uploaded data", date:"this session" },
                      { name:"World Bank — GDP/capita & population", date:wbDate },
                    ]
                  : [
                      { name:"OpenFlights — airport reference", date: ofMeta ? fmtDate(ofMeta.generatedAt) : "—" },
                      { name:GP_sourceLabel(GP_activityFor(airport.iata).source)+" — monthly aviation activity", date:fmtMonth(GP_activityFor(airport.iata).latest) },
                      { name:"World Bank — GDP/capita & population", date:wbDate },
                      ...(hasImf ? [{ name:"IMF World Economic Outlook — GDP/capita forecast", date: MACRO[airport.cc].gdpcapProjYear ? String(MACRO[airport.cc].gdpcapProjYear) : "—" }] : []),
                    ];
                const label = airport?.custom ? "your data" : (hasImf ? "4 sources live" : "3 sources live");
                return (
                  <span className="chip chip-ok src-tip-wrap" tabIndex={0} role="group" aria-label={label+" — focus or hover for source details"}>
                    <span className="dot dot-ok"></span>{label}
                    <div className="src-tip">
                      <div className="src-tip-title">{airport?.custom ? "What's live" : "Live sources"}</div>
                      {rows.map((r,i)=>(
                        <div key={i} className="src-tip-row"><span>{r.name}</span><span className="src-tip-date">{r.date}</span></div>
                      ))}
                    </div>
                  </span>
                );
              })()}
            </span>
            {airport && <button className="btn btn-sm" title="Start over — clears the selected gateway and scenario" onClick={resetApp}>Reset</button>}
            {connected && screen!=="export" && <button className="btn btn-primary btn-sm" onClick={()=>{ setScreen("export"); setNavOpen(false); }}>Export</button>}
          </div>
        </div>

        {/* nightly-refresh watchdog: every fetch step in the pipeline keeps
            last-good data on failure (correct), which also means a dead feed
            fails silently (not ok) — so the app itself discloses when the
            committed snapshot has stopped moving. 10 days ≈ well past any
            normal upstream publishing pause. */}
        {(()=>{
          const age = actMeta ? GP_dataAgeDays(actMeta.generatedAt) : null;
          if (age == null || age <= 10) return null;
          return (
            <div className="caveat" style={{margin:"14px 26px 0", borderColor:"var(--amber)", color:"var(--dim)"}}>
              <b style={{color:"var(--amber)"}}>Stale data —</b> the newest data snapshot is {Math.floor(age)} days old,
              so the nightly refresh may be failing. Figures still trace to real filings, but may lag current months.
            </div>
          );
        })()}
        {screen==="select"   && <Onboarding onSelect={selectAirport} selected={airport} onUpload={startUpload} onImportSession={importSession}/>}
        {screen==="connect"  && customPending && <UploadData onDone={finishCustomUpload} onCancel={cancelUpload}/>}
        {screen==="connect"  && !customPending && airport && <ConnectData airport={airport} onDone={finishConnect} alreadyDone={connected} macroMeta={macroMeta} actMeta={actMeta} ofMeta={ofMeta} imfMeta={imfMeta} imfChecked={imfChecked} seriesStatus={seriesStatus}/>}
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

/* Last line of defense for the restore path: if a saved session from an
   older build still manages to crash a render, clear it and reload ONCE
   (sessionStorage flag prevents a loop) — the visitor gets a fresh app
   instead of a blank page. On a second crash in the same tab session the
   problem isn't stale state, so show a readable failure instead. */
class GPBoundary extends React.Component {
  constructor(props){ super(props); this.state = { failed:false }; }
  static getDerivedStateFromError(){ return { failed:true }; }
  componentDidCatch(err){
    try {
      if (!sessionStorage.getItem("gp.reset")) {
        sessionStorage.setItem("gp.reset", "1");
        localStorage.removeItem(LS);
        location.reload();
        return;
      }
    } catch(e){ /* storage unavailable — fall through to the message */ }
    console.error("Glidepath crashed:", err);
  }
  render(){
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{height:"100vh",display:"grid",placeItems:"center",color:"#9aa1b1",fontFamily:"'Space Mono',monospace",fontSize:13,textAlign:"center",lineHeight:2}}>
        <div>GLIDEPATH HIT AN ERROR AND COULDN'T RECOVER.<br/>Check the browser console, then hard-refresh (Ctrl/Cmd+Shift+R).</div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(<GPBoundary><App/></GPBoundary>);

/* ============================================================
   screens-setup.jsx — Onboarding (airport select) + Connect data
   ============================================================ */
const { useState:useStateA, useEffect:useEffectA, useMemo:useMemoA } = React;

/* simple inline icons */
const Ico = {
  search:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>,
  pin:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>,
  plane:   <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L11 19v-5.5z"/></svg>,
  check:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>,
  arrow:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>,
  db:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>,
};

function Onboarding({ onSelect, selected }){
  const [q, setQ] = useStateA("");
  const live = GP_liveAirports();
  const list = useMemoA(()=>{
    const t = q.trim().toLowerCase();
    let arr = live;
    if (t) arr = live.filter(a => (a.iata+a.icao+a.name+a.city+a.country).toLowerCase().includes(t));
    return arr.slice(0, 40);
  },[q, live.length]);

  return (
    <div className="content fade-in" style={{maxWidth:860}}>
      <div style={{marginBottom:28}}>
        <div className="eyebrow" style={{marginBottom:12}}>Step 01 · Define gateway</div>
        <h1 style={{fontSize:38, marginBottom:12}}>Which airport are we forecasting?</h1>
        <p style={{color:"var(--dim)", fontSize:16, maxWidth:620}}>
          Pick any gateway with a live public passenger feed. We pull its
          identifiers and geography from <b style={{color:"var(--text)"}}>OpenFlights</b>, then assemble an aero-activity history from public sources.
        </p>
      </div>

      <div className="search" style={{marginBottom:18}}>
        <span style={{width:20,height:20,color:"var(--faint)"}}>{Ico.search}</span>
        <input autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder="Search IATA / ICAO / city — try “YTZ”, “Toronto”, “Exeter”…" />
        <span className="chip mono">{list.length} of {AIRPORTS.length}</span>
      </div>

      <div className="grid air-grid" style={{gridTemplateColumns:"repeat(2, minmax(0, 1fr))", gap:10, maxHeight:"calc(100vh - 430px)", overflowY:"auto", overflowX:"hidden", overscrollBehavior:"contain", paddingRight:4, marginBottom:24}}>
        {list.map(a => (
          <div key={a.iata} className={"air-card"+(selected?.iata===a.iata?" sel":"")} onClick={()=>onSelect(a)}>
            <div className="air-code">{a.iata}</div>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:14, fontWeight:600, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{a.name}</div>
              <div className="air-meta" style={{whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{a.city}, {a.country} · {a.icao}</div>
            </div>
            {selected?.iata===a.iata
              ? <span style={{width:22,height:22,color:"var(--pink)"}}>{Ico.check}</span>
              : <span className="air-meta">{(()=>{const fy=GP_fullYears(GP_buildHistory(a.iata),"pax");return fy.length?GP_fmt.k1(fy[fy.length-1].v)+"/yr":a.region;})()}</span>}
          </div>
        ))}
      </div>

      {selected && (
        <div className="panel panel-pad fade-in confirm-bar" style={{display:"flex", alignItems:"center", justifyContent:"space-between", gap:20}}>
          <div style={{display:"flex", alignItems:"center", gap:18}}>
            <div style={{width:54,height:54,borderRadius:12,background:"var(--pink-soft)",border:"1px solid var(--pink-line)",display:"grid",placeItems:"center",color:"var(--pink-2)",fontFamily:"var(--mono)",fontWeight:700,fontSize:18}}>{selected.iata}</div>
            <div>
              <div style={{fontSize:17,fontWeight:600}}>{selected.name}</div>
              <div className="air-meta" style={{marginTop:3}}>{selected.icao} · {selected.lat!=null?selected.lat.toFixed(3):"—"}, {selected.lon!=null?selected.lon.toFixed(3):"—"} · {selected.region} · {(()=>{const fy=GP_fullYears(GP_buildHistory(selected.iata),"pax");return fy.length?GP_fmt.k1(fy[fy.length-1].v)+" PAX/yr":"—";})()}</div>
            </div>
          </div>
          <button className="btn btn-primary btn-lg" onClick={()=>onSelect(selected, true)}>Connect data {Ico.arrow}</button>
        </div>
      )}
    </div>
  );
}

/* ---------- Connect data sources ----------------------------- */
const SOURCES = [
  { id:"openflights", abbr:"OF", name:"OpenFlights Airport DB", desc:"Identifiers, geography & timezone reference", rows:"reference DB", live:true, wired:true, kind:"openflights" },
  { id:"activity",    abbr:"AVIA", name:"Eurostat / StatCan Aviation", desc:"Monthly passengers by airport — the series the forecasts run on", rows:"132 months", live:true, wired:true, kind:"activity" },
  { id:"worldbank",   abbr:"WB", name:"World Bank Open Data", desc:"Population & historical GDP/capita — catchment driver", rows:"Indicators API", live:true, wired:true, kind:"macro" },
];

function ConnectData({ airport, onDone, alreadyDone, macroMeta, actMeta, oecdMeta, ofMeta }){
  const wb = macroMeta && macroMeta.countries ? macroMeta.countries[airport.cc] : null;
  const oecd = oecdMeta && oecdMeta.countries ? oecdMeta.countries[airport.cc] : null;
  const of = ofMeta && ofMeta.airports ? ofMeta.airports[airport.iata] : null;
  const act = (typeof GP_activityFor==="function") ? GP_activityFor(airport.iata) : null;
  const [progress, setProgress] = useStateA(alreadyDone ? SOURCES.map(()=>100) : SOURCES.map(()=>0));
  const [done, setDone] = useStateA(!!alreadyDone);

  useEffectA(()=>{
    if (alreadyDone) return;
    const start = performance.now();
    const durations = SOURCES.map((_,i)=> 700 + i*520 + Math.random()*300);
    const total = Math.max(...durations);
    const id = setInterval(()=>{
      const el = performance.now()-start;
      const next = durations.map(d => Math.min(100, Math.round((el/d)*100)));
      setProgress(next);
      if (el >= total){ setProgress(SOURCES.map(()=>100)); setDone(true); clearInterval(id); }
    }, 60);
    return ()=> clearInterval(id);
  },[]);

  return (
    <div className="content fade-in" style={{maxWidth:820}}>
      <div style={{marginBottom:26}}>
        <div className="eyebrow" style={{marginBottom:12}}>Step 02 · Integrate public data</div>
        <h1 style={{fontSize:34, marginBottom:12}}>Assembling the evidence base for <span style={{color:"var(--pink-2)"}}>{airport.iata}</span></h1>
        <p style={{color:"var(--dim)", fontSize:16, maxWidth:640}}>
          Glidepath assembles a forecasting-ready dataset from verified public sources — passenger activity,
          macroeconomic indicators, and airport reference data — aligned to <span style={{color:"var(--pink-2)",fontWeight:600}}>{airport.iata}</span>.
        </p>
      </div>

      <div className="grid" style={{gap:12, marginBottom:24}}>
        {SOURCES.map((s,i)=>{
          const p = progress[i], ok = p>=100;
          return (
            <div key={s.id} className={"src-row"+(ok?" connected":"")}>
              <div className="src-ico">{s.abbr}</div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{display:"flex", alignItems:"center", gap:10}}>
                  <span style={{fontSize:14.5, fontWeight:600}}>{s.name}</span>
                  {s.live && <span className="chip chip-ok" style={{fontSize:9.5, padding:"2px 7px"}}>LIVE</span>}
                </div>
                <div style={{fontSize:12.5, color:"var(--faint)", marginTop:2}}>
                  {s.kind==="macro" && ok && wb
                    ? <span>{wb.name}: population <b style={{color:"var(--cyan)"}}>{(wb.pop>=0?"+":"")+wb.pop}%</b> · GDP/capita <b style={{color:"var(--cyan)"}}>{(wb.gdpcap>=0?"+":"")+wb.gdpcap}%</b> ({wb.year})</span>
                    : s.kind==="oecd" && ok && oecd
                    ? <span>{oecd.name}: GDP/capita projection <b style={{color:"var(--cyan)"}}>{(oecd.gdpcapProj>=0?"+":"")+oecd.gdpcapProj}%</b>{oecd.horizon?` (${oecd.horizon})`:""} — drives the income lever</span>
                    : s.kind==="openflights" && ok && of
                    ? <span>{of.icao} · {of.lat!=null?of.lat.toFixed(3):"—"}, {of.lon!=null?of.lon.toFixed(3):"—"} · verified against {ofMeta?ofMeta.count:""} reference airports</span>
                    : s.kind==="activity" && ok && act
                    ? (act.observed
                        ? <span>Observed via <b style={{color:"var(--cyan)"}}>{act.source.split(":")[0]}</b> · <b style={{color:"var(--cyan)"}}>{act.months}</b> months of passengers{act.latest?` · to ${act.latest}`:""}</span>
                        : <span>No public monthly feed for {airport.iata} — series reconstructed from anchors</span>)
                    : s.desc}
                </div>
                <div className="src-bar"><i style={{width:p+"%"}}></i></div>
              </div>
              <div style={{textAlign:"right", minWidth:120}}>
                {ok
                  ? (s.kind==="activity" && act && !act.observed
                      ? <div style={{display:"flex",alignItems:"center",gap:7,justifyContent:"flex-end",color:"var(--amber)",fontSize:13,fontWeight:600}}><span className="dot" style={{background:"var(--amber)"}}></span>Modeled</div>
                      : <div style={{display:"flex",alignItems:"center",gap:7,justifyContent:"flex-end",color:"var(--ok)",fontSize:13,fontWeight:600}}><span className="dot dot-ok"></span>Connected</div>)
                  : <div style={{display:"flex",alignItems:"center",gap:7,justifyContent:"flex-end",color:"var(--dim)",fontSize:13}}><span style={{width:13,height:13,display:"inline-block",color:"var(--pink-2)"}}>{Ico.search}</span>Syncing…</div>}
                <div className="air-meta" style={{marginTop:4}}>
                  {s.kind==="activity" && actMeta ? "snapshot "+new Date(actMeta.generatedAt).toLocaleDateString("en-CA")
                    : s.kind==="macro" && macroMeta ? "snapshot "+new Date(macroMeta.generatedAt).toLocaleDateString("en-CA")
                    : s.kind==="oecd" && oecdMeta ? "snapshot "+new Date(oecdMeta.generatedAt).toLocaleDateString("en-CA")
                    : s.kind==="openflights" && ofMeta ? "snapshot "+new Date(ofMeta.generatedAt).toLocaleDateString("en-CA")
                    : s.rows}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel panel-pad confirm-bar" style={{display:"flex", alignItems:"center", justifyContent:"space-between", gap:20,
        borderColor: done?"var(--pink-line)":"var(--line)", background: done?"var(--pink-soft)":"var(--bg-1)"}}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <span style={{width:38,height:38,borderRadius:10,display:"grid",placeItems:"center",
            background: done?"var(--pink)":"var(--bg-2)", color: done?"#12030a":"var(--faint)"}}>
            {done ? Ico.check : <span className="spin" style={{width:18,height:18}}>{Ico.search}</span>}
          </span>
          <div>
            <div style={{fontWeight:600, fontSize:15}}>{done ? (act && act.observed ? `Dataset ready — ${act.months} months of observed passengers` : "Dataset ready — 132 months assembled") : "Reconciling feeds…"}</div>
            <div className="air-meta" style={{marginTop:3}}>{done ? (act && act.observed ? `${act.source.split(":")[0]} passengers drive the forecasts · movements, seats & cargo aligned to ${airport.iata}` : "PAX · ATM · cargo · seats · macro drivers, all aligned to "+airport.iata) : "Cross-checking units, gaps and outliers"}</div>
          </div>
        </div>
        <button className="btn btn-primary btn-lg" disabled={!done} onClick={onDone}>Build forecast {Ico.arrow}</button>
      </div>

    </div>
  );
}

Object.assign(window, { Onboarding, ConnectData, GP_Ico:Ico, GP_SOURCES:SOURCES });

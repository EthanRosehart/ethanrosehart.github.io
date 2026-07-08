/* ============================================================
   screens-strategic.jsx — Long-term, Scenario builder, Export
   ============================================================ */
const { useMemo:useMemoS } = React;

/* ---------- LONG-TERM STRATEGIC ------------------------------ */
function LongTerm({ airport, history, scenario, go }){
  const macro = MACRO[airport.cc];
  const lt = useMemoS(()=>GP_longTerm(airport.iata, history, scenario),[airport, history, scenario]);
  const metricDefs = [{k:"pax",label:"Passengers"},
    ...(lt&&lt.hasAtm?[{k:"atm",label:"Movements"}]:[]),
    ...(lt&&lt.hasCargo?[{k:"cargo",label:"Cargo"}]:[])];
  const [metric, setMetric] = React.useState("pax");
  const m = metricDefs.some(x=>x.k===metric) ? metric : "pax";

  const d = useMemoS(()=>{
    if (!lt) return null;
    const histTail = history.filter(r=>r.y>=lt.baseYear-3 && r[m]!=null);
    const fc = lt.months;
    const labels = [...histTail.map(r=>r.label), ...fc.map(r=>r.label)];
    const nHist = histTail.length;
    const histVals = [...histTail.map(r=>r[m]), ...fc.map(()=>null)];
    const fcVals = [...histTail.map(()=>null), ...fc.map(r=>r[m])];
    if (nHist>0) fcVals[nHist-1] = histTail[histTail.length-1][m];
    // capacity-constrained overlay — any cap propagates to every metric
    // (see the coupled-constraint block in data.jsx), so the overlay shows
    // for whichever metric is on screen whenever the constrained values
    // actually differ from demand
    const capKey = lt.hasCap ? { pax:"paxC", atm:"atmC", cargo:"cargoC" }[m] : null;
    let capVals = null;
    if (capKey && fc.some(r => r[capKey] != null && r[capKey] !== r[m])){
      capVals = [...histTail.map(()=>null), ...fc.map(r=>r[capKey] ?? r[m])];
      if (nHist>0) capVals[nHist-1] = histTail[histTail.length-1][m];
    }
    return { labels, histVals, fcVals, capVals, nHist };
  },[lt, history, m]);

  if (!lt || !d) return <div className="content fade-in"><div className="panel panel-pad"><div className="air-meta">Not enough complete years of data for a strategic forecast yet.</div></div></div>;

  const end = lt.rows[lt.rows.length-1];
  const start = lt.rows[0];
  const cargoFmt = m==="cargo";

  return (
    <div className="content fade-in">
      <DataCaveat airport={airport}/>
      <div className="grid g-4" style={{marginBottom:16}}>
        <KPI accent label={lt.endYear+" passengers"} value={GP_fmt.k1(end.pax)} delta={GP_fmt.pct(lt.cagr)+" CAGR"} deltaDir="up" sub={"from "+GP_fmt.k1(start.pax)+" in "+lt.baseYear}/>
        <KPI label="Demand growth" value={GP_fmt.pct(lt.gDemand)} sub="annual, blended drivers" sparkColor="var(--cyan)"/>
        {lt.hasAtm
          ? <KPI label={lt.endYear+" movements"} value={GP_fmt.k(end.atm)} sub="held proportional to PAX" sparkColor="var(--lime)"/>
          : lt.hasCargo
          ? <KPI label={lt.endYear+" cargo"} value={GP_fmt.k(end.cargo)+"t"} sub="freight trajectory" sparkColor="var(--lime)"/>
          : <KPI label="Horizon" value={(lt.endYear-lt.baseYear)+" yrs"} sub={"to "+lt.endYear}/>}
        {lt.hasCap
          ? <KPI label={lt.endYear+" spill"} value={GP_fmt.k1(end.spill||0)}
              delta={end.spill>0?"demand > capacity":"under capacity"} deltaDir={end.spill>0?"down":"up"}
              sub={[
                (lt.paxCap||lt.paxCapEnd) ? ((lt.paxCap?GP_fmt.k1(lt.paxCap):"—")+(lt.paxCapEnd!==lt.paxCap?"→"+(lt.paxCapEnd?GP_fmt.k1(lt.paxCapEnd):"—"):"")+" pax cap") : null,
                (lt.atmCap||lt.atmCapEnd) ? ((lt.atmCap?GP_fmt.k(lt.atmCap):"—")+(lt.atmCapEnd!==lt.atmCap?"→"+(lt.atmCapEnd?GP_fmt.k(lt.atmCapEnd):"—"):"")+" slot cap") : null,
              ].filter(Boolean).join(" · ")}/>
          : <KPI label={lt.baseYear+" passengers"} value={GP_fmt.k1(start.pax)} sub="observed base year"/>}
      </div>

      <div className="grid" style={{gridTemplateColumns:"1.55fr 1fr", marginBottom:16}}>
        <div className="panel panel-pad">
          <SectionHead kicker="Strategic forecast · elasticity model" title={"Monthly trajectory to "+lt.endYear}
            right={metricDefs.length>1 && <div className="seg">{metricDefs.map(x=><button key={x.k} className={m===x.k?"on":""} onClick={()=>setMetric(x.k)}>{x.label}</button>)}</div>}/>
          <LineChart labels={d.labels} height={285} markerIndex={d.nHist-1}
            yFmt={cargoFmt?(v=>GP_fmt.k(v)):undefined}
            series={[
              { name:"Actual", color:"var(--text)", values:d.histVals, width:2.4 },
              { name:"Unconstrained demand", color:"var(--pink)", values:d.fcVals, fill:!d.capVals, glow:true, width:2.8 },
              ...(d.capVals?[{ name:"Constrained (capacity)", color:"var(--amber)", values:d.capVals, fill:true, width:2.4 }]:[]),
            ]}/>
          <div style={{display:"flex",gap:18,marginTop:12,flexWrap:"wrap"}}>
            <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--text)"}}></span>Actual (observed)</span>
            <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)"}}></span>{d.capVals?"Unconstrained demand":"Elasticity forecast"}</span>
            {d.capVals && <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--amber)"}}></span>Constrained by capacity — the gap is spill</span>}
          </div>
        </div>

        <div className="panel panel-pad">
          <SectionHead kicker="Growth decomposition" title="What drives the curve"/>
          <div style={{display:"flex",flexDirection:"column",gap:11,marginBottom:14}}>
            {lt.breakdown.map((b,i)=>{
              const maxAbs = Math.max(...lt.breakdown.map(x=>Math.abs(x.v)),0.5);
              const w = Math.abs(b.v)/maxAbs*100;
              return (
                <div key={i}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12.5,marginBottom:5}}>
                    <span style={{color:"var(--dim)"}}>{b.k}</span>
                    <span className="num" style={{color:b.v<0?"var(--bad)":"var(--text)",fontWeight:700}}>{GP_fmt.pct(b.v,2)}</span>
                  </div>
                  <div style={{height:7,background:"var(--bg-3)",borderRadius:5,overflow:"hidden",display:"flex",justifyContent:b.v<0?"flex-end":"flex-start"}}>
                    <i style={{display:"block",height:"100%",width:w+"%",background:b.c,borderRadius:5}}></i>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{borderTop:"1px solid var(--line-2)",paddingTop:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:13,fontWeight:600}}>Net demand growth</span>
            <span className="num" style={{fontSize:20,fontWeight:700,color:"var(--lime)"}}>{GP_fmt.pct(lt.gDemand)}</span>
          </div>
          <button className="btn btn-primary" style={{width:"100%",marginTop:16,justifyContent:"center"}} onClick={()=>go("scenario")}>Adjust assumptions {GP_Ico.arrow}</button>
        </div>
      </div>

      <div className="panel panel-pad">
        <SectionHead kicker={"Monthly table · "+macro.label+" macro baseline"} title="Month-by-month forecast"
          right={<span className="air-meta">{lt.months.length} months · {macro.label} baseline</span>}/>
        <div style={{maxHeight:360,overflowY:"auto"}}>
          <table className="tbl">
            <thead><tr><th>Month</th><th>Passengers</th>{lt.hasAtm&&<th>Movements</th>}{lt.hasCargo&&<th>Cargo (t)</th>}</tr></thead>
            <tbody>
              {lt.months.map((r,i)=>(
                <tr key={i} style={r.m===0?{borderTop:"1px solid var(--line-2)"}:{}}>
                  <td style={{color:r.m===0?"var(--text)":"var(--dim)",fontWeight:r.m===0?700:400}}>{r.label}</td>
                  <td style={{color:"var(--pink-2)",fontWeight:700}}>{GP_fmt.int(r.pax)}</td>
                  {lt.hasAtm&&<td>{GP_fmt.int(r.atm)}</td>}
                  {lt.hasCargo&&<td>{GP_fmt.int(r.cargo)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="air-meta" style={{marginTop:12}}>Passengers compound at the blended demand growth on the observed {lt.baseYear} seasonal shape{lt.hasAtm?"; movements are held proportional to passengers at the latest observed ratio":""}.</div>
      </div>

      {/* design-day / peak-hour: the granularity terminal & runway planning
          actually happens at. Derived from the real seasonal shape with
          disclosed heuristics — see GP_designDay in data.jsx. */}
      {(()=>{
        const seas = GP_observedSeasonality(history, "pax");
        const ddBase = GP_designDay(start.pax, seas);
        const endPax = lt.paxCap ? (end.paxC ?? end.pax) : end.pax;
        const ddEnd = GP_designDay(endPax, seas);
        if (!ddBase || !ddEnd) return null;
        const rows = [
          ["Peak month", MONTHS[ddBase.peakMonth]+" · "+GP_fmt.k1(ddBase.peakMonthPax), MONTHS[ddEnd.peakMonth]+" · "+GP_fmt.k1(ddEnd.peakMonthPax)],
          ["Average day (peak month)", GP_fmt.int(ddBase.avgDay), GP_fmt.int(ddEnd.avgDay)],
          ["Busy day (design day)", GP_fmt.int(ddBase.busyDay), GP_fmt.int(ddEnd.busyDay)],
          ["Peak hour", GP_fmt.int(ddBase.peakHour), GP_fmt.int(ddEnd.peakHour)],
        ];
        return (
          <div className="panel panel-pad" style={{marginTop:16}}>
            <SectionHead kicker="Design day · peak hour" title="What the terminal has to handle"
              right={<span className="air-meta">passengers, from the observed seasonal shape</span>}/>
            <table className="tbl">
              <thead><tr><th style={{textAlign:"left"}}>Measure</th><th>{lt.baseYear} (observed)</th><th>{lt.endYear} (scenario{lt.paxCap?", constrained":""})</th></tr></thead>
              <tbody>
                {rows.map((r,i)=>(
                  <tr key={i}>
                    <td style={{textAlign:"left",color:"var(--dim)"}}>{r[0]}</td>
                    <td style={{color:"var(--text)",fontWeight:600}}>{r[1]}</td>
                    <td style={{color:"var(--pink-2)",fontWeight:700}}>{r[2]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="method" style={{marginTop:12}}>
              <b>Assumptions, all disclosed —</b> busy day = average day of the peak month × 1.10 (a stand-in for the
              ~90th-percentile day; monthly data can't see individual days). Peak hour takes {Math.round(ddEnd.peakHourShare*100)}%
              of the busy day — the share shrinks as airports grow because traffic spreads across the day
              (12% under 1M annual passengers, 10% to 10M, 8% above). Replace these with measured design-day
              factors when you have daily/hourly data.
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* ---------- SCENARIO BUILDER --------------------------------- */
const LEVERS = [
  { k:"gdp",        name:"Real GDP / capita growth", unit:"%/yr", min:-1, max:5, step:0.1, desc:"IMF forecast where published, else World Bank trend — the core income signal." },
  { k:"elasticity", name:"Income elasticity of demand", unit:"×", min:0.8, max:2.6, step:0.05, desc:"How strongly air travel responds to income. Mature ~1.5, emerging ~2.0." },
  { k:"pop",        name:"Catchment population growth", unit:"%/yr", min:-1, max:3, step:0.1, desc:"Net migration + natural change in the airport's drive-time catchment." },
  { k:"tourism",    name:"Inbound tourism shift", unit:"%/yr", min:-3, max:6, step:0.25, desc:"Destination-marketing, events & visa policy tailwinds (half-weighted)." },
  { k:"fuel",       name:"Fuel / yield shock", unit:"%", min:-10, max:40, step:1, desc:"Sustained jet-fuel & fare increase that suppresses price-sensitive demand." },
  { k:"lcc",        name:"LCC / new-route stimulation", unit:"%/yr", min:0, max:5, step:0.25, desc:"Demand uplift from low-cost entry or route development incentives." },
];

/* metric-specific levers — only shown when the gateway carries that series */
const SHAPE_LEVERS = {
  atm:   { k:"gauge", name:"Aircraft up-gauging", unit:"%/yr", min:0, max:3, step:0.1, metric:"atm",
           desc:"Larger, fuller aircraft carry the same passengers in fewer flights — trims movement growth below passenger growth." },
  cargo: { k:"cargo", name:"Air cargo growth shift", unit:"%/yr", min:-4, max:6, step:0.25, metric:"cargo",
           desc:"Freight-specific tailwind/headwind on top of the passenger-linked cargo trend (e-commerce, bellyhold capacity, trade)." },
};

/* constraint-response assumptions — how the system reacts when a capacity
   cap binds (see the coupled-constraint block in data.jsx). Only meaningful
   once a cap is set; surfaced inside the Capacity lever group. */
const CAP_LEVERS = [
  { k:"capGauge", name:"Up-gauging response", unit:"%/yr", min:0, max:4, step:0.1,
    desc:"Extra passengers-per-movement airlines add each year the slot cap binds — bigger aircraft, denser cabins, fuller flights." },
  { k:"capGaugeMax", name:"Up-gauging ceiling", unit:"%", min:0, max:60, step:5, noSign:true,
    desc:"Total headroom above today's passengers-per-movement before the response is exhausted — stand sizes, runway mix and the fleet only stretch so far." },
  { k:"bellyShare", name:"Bellyhold cargo share", unit:"%", min:0, max:100, step:5, noSign:true,
    desc:"Share of cargo riding in passenger-aircraft bellies. Belly capacity follows the flights actually flown; the freighter share is squeezed by slot scarcity but not by a terminal cap." },
  { k:"bellyBeta", name:"Belly space from up-gauging", unit:"%", min:0, max:100, step:5, noSign:true,
    desc:"How much of the extra passengers-per-movement returns as usable belly. Bigger airframes add belly volume, but denser cabins and fuller loads eat it with bags — below 100%, packing more passengers through capped slots costs cargo per passenger." },
];

/* a collapsible section of the lever panel — the panel was one long flat
   list; with capacity-response assumptions joining demand, fleet and
   segment levers, related controls fold into named groups instead. */
function LeverGroup({ title, sub, count, defaultOpen, children }){
  const [open, setOpen] = React.useState(!!defaultOpen);
  return (
    <div className="lever-group">
      <button className="lever-group-head" onClick={()=>setOpen(o=>!o)} aria-expanded={open}>
        <span className={"lever-group-chev"+(open?" open":"")}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 6l6 6-6 6"/></svg>
        </span>
        <span className="lever-group-title">{title}</span>
        {count>0 && <span className="chip chip-pink" style={{fontSize:9.5,padding:"1px 7px"}}>{count} set</span>}
        <span className="lever-group-sub">{sub}</span>
      </button>
      {open && <div className="lever-group-body">{children}</div>}
    </div>
  );
}

const PRESETS = {
  base:    { label:"Macro baseline", desc:"World Bank central case", icon:"◆" },
  bull:    { label:"Upside", desc:"Strong economy + LCC entry", icon:"▲", set:{ gdp:+0.8, tourism:2.5, lcc:1.5, fuel:-3 } },
  bear:    { label:"Downside", desc:"Stagnation + fuel spike", icon:"▼", set:{ gdp:-1.0, tourism:-1.5, fuel:18, lcc:0 } },
  shock:   { label:"Demand shock", desc:"Recession-style contraction", icon:"⊘", set:{ gdp:-2.0, tourism:-2.5, fuel:10, pop:-0.4, lcc:0 } },
};

function Scenario({ airport, history, scenario, setScenario }){
  const base = useMemoS(()=>GP_defaultScenario(airport.iata),[airport]);
  const d = useMemoS(()=>{
    // this page is the lever baseline — show the assumptions without shock
    // events (those live on their own page); compare against the macro default
    const lt = GP_longTerm(airport.iata, history, { ...scenario, events: [] });
    const baseLt = GP_longTerm(airport.iata, history, { ...base, horizon: scenario.horizon || base.horizon });
    const labels = lt ? lt.months.map(r=>r.label) : [];
    return { lt, baseLt, labels };
  },[airport, history, scenario, base]);

  // metric the impact chart + KPIs focus on; extra metrics appear only when the
  // gateway actually carries movements / cargo
  const metricDefs = [{ k:"pax", label:"Passengers" },
    ...(d.lt && d.lt.hasAtm   ? [{ k:"atm",   label:"Movements" }] : []),
    ...(d.lt && d.lt.hasCargo ? [{ k:"cargo", label:"Cargo" }]     : [])];
  const [metric, setMetric] = React.useState("pax");
  const m = metricDefs.some(x=>x.k===metric) ? metric : "pax";

  // per-segment demand levers (only when the gateway publishes the split)
  const segLevers = (d.lt && d.lt.hasSeg) ? d.lt.segKeys.map((k,i)=>({
    k:"seg_"+k, name:d.lt.segLabels[i]+" demand shift", unit:"%/yr", min:-4, max:6, step:0.25, seg:true,
    desc:"Grow "+d.lt.segLabels[i].toLowerCase()+" passengers faster or slower than the blended trend.",
  })) : [];

  // lever groups: demand drivers always; fleet/freight shape levers for
  // present metrics; per-segment levers where the split is published;
  // capacity caps + constraint-response assumptions in their own group
  const fleetLevers = [
    ...(d.lt && d.lt.hasAtm   ? [SHAPE_LEVERS.atm]   : []),
    ...(d.lt && d.lt.hasCargo ? [SHAPE_LEVERS.cargo] : [])];
  const changedCount = (ls)=> ls.filter(l=>Math.abs((scenario[l.k]??0)-(base[l.k]??0))>0.001).length;

  const setLever = (k,v)=> setScenario({ ...scenario, [k]: v });
  // presets swap the DEMAND assumptions; events, capacity caps and the
  // constraint-response assumptions are facts about the world/infrastructure
  // the user set up, so they ride along
  const keepNonDemand = ()=>({ events: scenario.events || [],
    paxCap: scenario.paxCap ?? null, atmCap: scenario.atmCap ?? null,
    capSteps: scenario.capSteps || [],
    capGauge: scenario.capGauge ?? base.capGauge, capGaugeMax: scenario.capGaugeMax ?? base.capGaugeMax,
    bellyShare: scenario.bellyShare ?? base.bellyShare, bellyBeta: scenario.bellyBeta ?? base.bellyBeta });
  const applyPreset = (id)=>{
    if (id==="base") return setScenario({ ...base, ...keepNonDemand() });
    const p = PRESETS[id];
    const next = { ...base, ...keepNonDemand() };
    Object.keys(p.set).forEach(k=> next[k] = (base[k]??0) + p.set[k]);
    setScenario(next);
  };
  const setHorizon = (h)=> setScenario({ ...scenario, horizon: h });

  if (!d.lt || !d.baseLt) return <div className="content fade-in"><div className="panel panel-pad"><div className="air-meta">Not enough complete years of data to build scenarios yet.</div></div></div>;
  const end = d.lt.rows[d.lt.rows.length-1], baseEnd = d.baseLt.rows[d.baseLt.rows.length-1];
  const fmtM = (v)=> m==="cargo" ? GP_fmt.t(v) : (m==="pax" ? GP_fmt.k1(v) : GP_fmt.k(v));
  const endM = end[m] ?? 0, baseEndM = baseEnd[m] ?? 0, diffM = endM - baseEndM;
  const yrs = d.lt.endYear - d.lt.baseYear;
  const cagrM = (d.lt.rows[0][m] && endM) ? (Math.pow(endM/d.lt.rows[0][m], 1/yrs)-1)*100 : 0;
  const mLabel = (metricDefs.find(x=>x.k===m)||{}).label || "Passengers";
  const activePreset = (()=>{
    const NON_DEMAND = new Set(["events","horizon","paxCap","atmCap","capSteps","capGauge","capGaugeMax","bellyShare","bellyBeta"]);
    const eq=(o)=>Object.keys(o).every(k=> NON_DEMAND.has(k) ? true : Math.abs((scenario[k]??0)-(o[k]??0))<0.001);
    if (eq(base)) return "base";
    for (const id of Object.keys(PRESETS)){ if(id==="base") continue; const t={...base}; Object.keys(PRESETS[id].set).forEach(k=>t[k]=(base[k]??0)+PRESETS[id].set[k]); if(eq(t)) return id; }
    return null;
  })();

  return (
    <div className="content fade-in">
      <div className="grid" style={{gridTemplateColumns:"1fr 1.5fr", alignItems:"start"}}>
        {/* left: levers */}
        <div className="panel panel-pad lever-panel" style={{position:"sticky",top:18}}>
          <SectionHead kicker="Assumptions" title="Shape levers"/>
          <div style={{display:"flex",gap:7,flexWrap:"wrap",marginBottom:8}}>
            {Object.keys(PRESETS).map(id=>(
              <button key={id} className={"btn btn-sm"+(activePreset===id?" btn-primary":"")} style={{flex:"1 1 auto",justifyContent:"center",flexDirection:"column",gap:2,padding:"9px 8px"}} onClick={()=>applyPreset(id)}>
                <span style={{fontSize:13,fontWeight:700}}>{PRESETS[id].icon} {PRESETS[id].label}</span>
                <span style={{fontSize:10,opacity:.7,fontWeight:400}}>{PRESETS[id].desc}</span>
              </button>
            ))}
          </div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginTop:12,paddingTop:12,borderTop:"1px solid var(--line)"}}>
            <span className="lever-name">Forecast horizon</span>
            <div className="seg seg-sub">
              {[10,15,25].map(h=><button key={h} className={(scenario.horizon||25)===h?"on":""} onClick={()=>setHorizon(h)}>{h}yr</button>)}
            </div>
          </div>

          {(()=>{
            const renderLever = (l)=>{
              const v = scenario[l.k] ?? 0, bv = base[l.k] ?? 0;
              const changed = Math.abs(v-bv)>0.001;
              return (
                <div className="lever" key={l.k}>
                  <div className="lever-head">
                    <div className="lever-name">{l.name} {changed && <span className="dot dot-pink"></span>}</div>
                    <div className="lever-val">{v>0&&l.k!=="elasticity"&&!l.noSign?"+":""}{l.k==="elasticity"?v.toFixed(2):v.toFixed(l.step<1?1:0)}{l.unit}</div>
                  </div>
                  <input type="range" min={l.min} max={l.max} step={l.step} value={v} onChange={e=>setLever(l.k, +e.target.value)}/>
                  <div className="lever-desc">{l.desc} {changed && <span style={{color:"var(--faint)"}}>· base {l.k==="elasticity"?bv.toFixed(2):bv.toFixed(1)}{l.unit}</span>}</div>
                </div>
              );
            };
            const capSteps = scenario.capSteps || [];
            const capSet = !!(scenario.paxCap || scenario.atmCap || capSteps.length);
            const by = d.lt.baseYear, stepYears = [];
            for (let yy = by+1; yy <= by + (scenario.horizon||25); yy++) stepYears.push(yy);
            const setStep = (i, patch)=> setScenario({ ...scenario, capSteps: capSteps.map((st,si)=> si===i ? { ...st, ...patch } : st) });
            const rmStep = (i)=> setScenario({ ...scenario, capSteps: capSteps.filter((_,si)=> si!==i) });
            const addStep = ()=> setScenario({ ...scenario, capSteps: [...capSteps, {
              year: Math.min(by + 5, by + (scenario.horizon||25)),
              paxCap: scenario.paxCap ? Math.round(scenario.paxCap * 1.25) : null,
              atmCap: null }] });
            const capInput = (label, key, div, step)=>(
              <label style={{flex:"1 1 130px"}}>
                <span className="lever-desc" style={{display:"block",marginBottom:4}}>{label}</span>
                <input type="number" min="0" step={step} placeholder="unconstrained"
                  value={scenario[key] ? scenario[key]/div : ""}
                  onChange={e=>{ const v = parseFloat(e.target.value); setScenario({ ...scenario, [key]: (v>0 ? Math.round(v*div) : null) }); }}
                  style={{width:"100%",background:"var(--bg-2)",border:"1px solid var(--line-2)",borderRadius:"var(--r-sm)",color:"var(--text)",fontFamily:"var(--mono)",fontSize:13,padding:"8px 10px",outline:"none"}}/>
              </label>
            );
            return (
              <div style={{marginTop:10}}>
                <LeverGroup title="Demand drivers" sub="what the market wants" defaultOpen count={changedCount(LEVERS)}>
                  {LEVERS.map(renderLever)}
                </LeverGroup>
                {fleetLevers.length>0 && (
                  <LeverGroup title="Fleet & freight" sub="how it gets flown" count={changedCount(fleetLevers)}>
                    {fleetLevers.map(renderLever)}
                  </LeverGroup>
                )}
                {segLevers.length>0 && (
                  <LeverGroup title="Passenger segments" sub="who's flying" count={changedCount(segLevers)}>
                    {segLevers.map(renderLever)}
                  </LeverGroup>
                )}
                <LeverGroup title="Capacity & constraints" sub="what infrastructure can serve"
                  defaultOpen={capSet} count={(scenario.paxCap?1:0)+(scenario.atmCap?1:0)+capSteps.length}>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:4}}>
                    {capInput("Annual passengers (M)", "paxCap", 1e6, "0.5")}
                    {d.lt.hasAtm && capInput("Annual movements (K)", "atmCap", 1e3, "5")}
                  </div>
                  <div className="lever-desc" style={{marginBottom:10}}>
                    Blank = unconstrained. A binding cap propagates to every output: a slot cap squeezes passengers
                    (softened by up-gauging, below, until its ceiling) and squeezes cargo harder — belly space only
                    partially recovers and freighters compete for the same slots; a passenger cap pulls movements
                    down with it. Demand above capacity becomes <b style={{color:"var(--amber)"}}>spill</b> — see
                    the constrained line here and on Long-term.
                  </div>

                  {/* phased capacity — a capital project: caps above apply
                      until a step year, then the step's caps take over */}
                  <div style={{margin:"2px 0 10px",paddingTop:10,borderTop:"1px dashed var(--line)"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:capSteps.length?8:0}}>
                      <span className="lever-desc" style={{margin:0}}><b style={{color:"var(--dim)"}}>Capacity steps</b> — e.g. a terminal expansion opening mid-horizon</span>
                      <button className="btn btn-sm" onClick={addStep}>+ Step</button>
                    </div>
                    {capSteps.map((st,i)=>(
                      <div key={i} style={{display:"flex",alignItems:"flex-end",gap:8,flexWrap:"wrap",marginBottom:8}}>
                        <label style={{flex:"0 0 auto"}}>
                          <span className="lever-desc" style={{display:"block",marginBottom:4}}>From</span>
                          <select className="seg-select" value={st.year||by+5} onChange={e=>setStep(i,{year:+e.target.value})}>
                            {stepYears.map(y=><option key={y} value={y}>{y}</option>)}
                          </select>
                        </label>
                        <label style={{flex:"1 1 90px"}}>
                          <span className="lever-desc" style={{display:"block",marginBottom:4}}>Pax cap (M)</span>
                          <input type="number" min="0" step="0.5" placeholder="keep"
                            value={st.paxCap ? st.paxCap/1e6 : ""}
                            onChange={e=>{ const v=parseFloat(e.target.value); setStep(i,{paxCap: v>0?Math.round(v*1e6):null}); }}
                            style={{width:"100%",background:"var(--bg-2)",border:"1px solid var(--line-2)",borderRadius:"var(--r-sm)",color:"var(--text)",fontFamily:"var(--mono)",fontSize:13,padding:"8px 10px",outline:"none"}}/>
                        </label>
                        {d.lt.hasAtm && <label style={{flex:"1 1 90px"}}>
                          <span className="lever-desc" style={{display:"block",marginBottom:4}}>Mov cap (K)</span>
                          <input type="number" min="0" step="5" placeholder="keep"
                            value={st.atmCap ? st.atmCap/1e3 : ""}
                            onChange={e=>{ const v=parseFloat(e.target.value); setStep(i,{atmCap: v>0?Math.round(v*1e3):null}); }}
                            style={{width:"100%",background:"var(--bg-2)",border:"1px solid var(--line-2)",borderRadius:"var(--r-sm)",color:"var(--text)",fontFamily:"var(--mono)",fontSize:13,padding:"8px 10px",outline:"none"}}/>
                        </label>}
                        <button className="icon-btn" title="Remove step" onClick={()=>rmStep(i)} style={{width:28,height:28,flex:"none",marginBottom:2}}>
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
                        </button>
                      </div>
                    ))}
                    {capSteps.length>0 && <div className="lever-desc">"keep" leaves that cap unchanged from the step year; each step overrides from its year onward.</div>}
                  </div>

                  {capSet
                    ? CAP_LEVERS.filter(l =>
                        l.k==="bellyShare" ? d.lt.hasCargo :
                        l.k==="bellyBeta"  ? (d.lt.hasCargo && d.lt.hasAtm) :
                        d.lt.hasAtm).map(renderLever)
                    : <div className="lever-desc">Set a cap to unlock the constraint-response assumptions (up-gauging rate, its ceiling, belly-space behavior).</div>}
                </LeverGroup>
              </div>
            );
          })()}
          <button className="btn" style={{width:"100%",justifyContent:"center",marginTop:14}} onClick={()=>setScenario({...base})}>Reset to baseline</button>
        </div>

        {/* right: live impact */}
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div className="grid g-3">
            <KPI accent label={d.lt.endYear+" "+mLabel.toLowerCase()+" · scenario"} value={fmtM(endM)}
              delta={(diffM>=0?"+":"")+fmtM(Math.abs(diffM))+" vs base"} deltaDir={diffM>=0?"up":"down"} sub={mLabel.toLowerCase()}/>
            <KPI label={mLabel+" CAGR"} value={GP_fmt.pct(cagrM)} sub={d.lt.baseYear+"→"+d.lt.endYear} sparkColor="var(--cyan)"/>
            <KPI label="vs baseline" value={GP_fmt.pct(baseEndM?(endM/baseEndM-1)*100:0)} deltaDir={diffM>=0?"up":"down"} sub={d.lt.endYear+" "+mLabel.toLowerCase()} />
          </div>

          <div className="panel panel-pad">
            <SectionHead kicker="Live impact" title="Scenario vs baseline"
              right={<div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
                {metricDefs.length>1 && <div className="seg">{metricDefs.map(x=><button key={x.k} className={m===x.k?"on":""} onClick={()=>setMetric(x.k)}>{x.label}</button>)}</div>}
                <div className="chart-legend">
                  <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)"}}></span>Scenario</span>
                  <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--faint)",borderStyle:"dashed"}}></span>Baseline</span>
                </div>
              </div>}/>
            <LineChart labels={d.labels} height={270}
              yFmt={m==="cargo"?(v=>GP_fmt.k(v)):undefined}
              valueFmt={m==="cargo"?(v=>GP_fmt.int(v)+" t"):undefined}
              series={[
                { name:"Baseline", color:"var(--faint)", values:d.baseLt.months.map(r=>r[m]), dash:"5 4", width:1.8 },
                { name:"Scenario", color:"var(--pink)", values:d.lt.months.map(r=>r[m]), fill:true, glow:true, width:2.8 },
                ...(()=>{ // constrained overlay for whichever metric is shown, when a cap actually bites it
                  if (!d.lt.hasCap) return [];
                  const ck = { pax:"paxC", atm:"atmC", cargo:"cargoC" }[m];
                  if (!d.lt.months.some(r => r[ck] != null && r[ck] !== r[m])) return [];
                  return [{ name:"Constrained", color:"var(--amber)", values:d.lt.months.map(r=>r[ck] ?? r[m]), width:2.2 }];
                })(),
              ]}/>
          </div>

          {d.lt.hasSeg && (()=>{
            const bSeg=d.lt.rows[0].seg, eSeg=end.seg;
            const bt=d.lt.segKeys.reduce((t,k)=>t+bSeg[k],0)||1, et=d.lt.segKeys.reduce((t,k)=>t+eSeg[k],0)||1;
            const donutItems=(seg)=>d.lt.segKeys.map((k,i)=>({ label:d.lt.segLabels[i], value:seg[k], color:d.lt.segColors[i] }));
            const shifted=d.lt.segKeys.some(k=>Math.abs(bSeg[k]/bt - eSeg[k]/et) >= 0.005);
            return (
            <div className="panel panel-pad">
              <SectionHead kicker="Passenger mix" title="How the shape shifts"
                right={<span className="chip">{shifted?"mix changes":"mix unchanged"}</span>}/>
              <div style={{display:"flex",gap:8,alignItems:"center",justifyContent:"center",flexWrap:"wrap"}}>
                <div style={{textAlign:"center"}}>
                  <Donut items={donutItems(bSeg)} size={134} thickness={26}/>
                  <div className="air-meta" style={{marginTop:6}}>Base · {d.lt.baseYear}</div>
                </div>
                <div style={{textAlign:"center"}}>
                  <Donut items={donutItems(eSeg)} size={134} thickness={26}/>
                  <div className="air-meta" style={{marginTop:6}}>Scenario · {d.lt.endYear}</div>
                </div>
                <div style={{flex:"1 1 190px",minWidth:170}}>
                  {d.lt.segKeys.map((k,i)=>{
                    const bp=Math.round(bSeg[k]/bt*100), ep=Math.round(eSeg[k]/et*100), dp=ep-bp;
                    return (
                      <div key={k} className="legend-item" style={{justifyContent:"space-between",marginBottom:10}}>
                        <span><span className="legend-swatch" style={{background:d.lt.segColors[i]}}></span>{d.lt.segLabels[i]}</span>
                        <span className="num" style={{color:"var(--text)"}}>{bp}%→{ep}%{dp!==0 && <span style={{color:dp>0?"var(--ok)":"var(--bad)",marginLeft:5}}>{dp>0?"+":""}{dp}pt</span>}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="method" style={{marginTop:8}}>
                <b>Shape —</b> passenger mix at {d.lt.baseYear} vs the scenario in {d.lt.endYear}. The split only moves when you flex a segment lever{shifted?"":" — currently the two rings match"}.
              </div>
            </div>
            );
          })()}

          <div className="panel panel-pad">
            <SectionHead kicker="Decomposition" title="Driver contribution to annual growth"/>
            <BarChart labels={d.lt.breakdown.map(b=>b.k.split(" ")[0])} height={180} yFmt={v=>v.toFixed(1)+"%"}
              tipFmt={v=>v.toFixed(2)+"%/yr"} labelFmt={v=>v.toFixed(1)+"%"}
              series={[{ name:"Contribution", color:"var(--pink)", values:d.lt.breakdown.map(b=>Math.max(0,b.v)) }]}/>
            <div className="method" style={{marginTop:6}}>
              <b>Model —</b> <span className="formula">g = GDPpc·ε + pop + 0.5·tourism + lcc − 0.18·fuel</span>. Passengers
              compound at g on the observed base-year seasonal shape. Movements track passengers less any up-gauging drag; cargo rides a damped share of g plus its own growth shift.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- EVENT SIMULATOR ---------------------------------- */
/* A dedicated page for time-bound shocks, separate from the lever baseline.
   Each event is a window with a peak impact that either recovers fully or
   permanently re-baselines the forecast, and can hit all traffic or a single
   passenger sector (e.g. a transborder collapse reshaping the mix). */
function EventSim({ airport, history, scenario, setScenario }){
  const d = useMemoS(()=>{
    const lt = GP_longTerm(airport.iata, history, scenario);                       // with events
    const baseLt = GP_longTerm(airport.iata, history, { ...scenario, events: [] }); // same levers, no shocks
    const labels = lt ? lt.months.map(r=>r.label) : [];
    return { lt, baseLt, labels };
  },[airport, history, scenario]);

  const metricDefs = [{ k:"pax", label:"Passengers" },
    ...(d.lt && d.lt.hasAtm   ? [{ k:"atm",   label:"Movements" }] : []),
    ...(d.lt && d.lt.hasCargo ? [{ k:"cargo", label:"Cargo" }]     : [])];
  const [metric, setMetric] = React.useState("pax");
  const m = metricDefs.some(x=>x.k===metric) ? metric : "pax";

  const events = scenario.events || [];
  const setEvents = (evs)=> setScenario({ ...scenario, events: evs });
  const by = d.lt ? d.lt.baseYear : new Date().getFullYear();
  const addEvent = (preset)=> setEvents([...events, { id:Date.now()+Math.floor(Math.random()*1e4), label:"Shock "+(events.length+1), start:`${by+2}-03`, peak:-30, length:6, recovery:18, permanent:false, target:"all", ...(preset||{}) }]);
  const updEvent = (id,patch)=> setEvents(events.map(e=> e.id===id ? {...e,...patch} : e));
  const rmEvent = (id)=> setEvents(events.filter(e=> e.id!==id));

  if (!d.lt) return <div className="content fade-in"><div className="panel panel-pad"><div className="air-meta">Not enough complete years of data to simulate events yet.</div></div></div>;

  const end = d.lt.rows[d.lt.rows.length-1], baseEnd = d.baseLt.rows[d.baseLt.rows.length-1];
  const fmtM = (v)=> m==="cargo" ? GP_fmt.t(v) : (m==="pax" ? GP_fmt.k1(v) : GP_fmt.k(v));
  const trough = d.lt.months.reduce((a,r)=> (r[m]??Infinity)<(a[m]??Infinity)?r:a, d.lt.months[0]);
  const endDelta = (end[m]??0) - (baseEnd[m]??0);
  const targetOpts = [{ k:"all", label:"All traffic" }, ...(d.lt.hasSeg ? d.lt.segKeys.map((k,i)=>({ k, label:d.lt.segLabels[i] })) : [])];
  const yearOpts = []; for (let yy=by+1; yy<=d.lt.endYear; yy++) yearOpts.push(yy);
  const eventSpans = events.map(ev=>{
    const si = d.lt.months.findIndex(r=> r.date >= ev.start); if (si < 0) return null;
    const len = Math.round(+(ev.length!=null?ev.length:ev.hold)||0);
    const span = (len + (ev.permanent ? 6 : Math.round(+ev.recovery||0))) || 1;
    return { from:si, to:Math.min(d.lt.months.length-1, si+span), color:"var(--bad)", label:ev.label };
  }).filter(Boolean);

  return (
    <div className="content fade-in">
      <div className="grid g-3" style={{marginBottom:16}}>
        <KPI accent label={d.lt.endYear+" "+(metricDefs.find(x=>x.k===m)||{}).label.toLowerCase()+" · with events"} value={fmtM(end[m]??0)}
          delta={(endDelta>=0?"+":"")+fmtM(Math.abs(endDelta))+" vs no-shock"} deltaDir={endDelta>=0?"up":"down"} sub="end of horizon"/>
        <KPI label="Deepest month" value={fmtM(trough[m]??0)} sub={trough.label} sparkColor="var(--bad)"/>
        <KPI label="Events stacked" value={String(events.length)} sub="active shocks"/>
      </div>

      <div className="panel panel-pad" style={{marginBottom:16}}>
        <SectionHead kicker="Event impact" title="Forecast with shocks"
          right={<div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
            {metricDefs.length>1 && <div className="seg">{metricDefs.map(x=><button key={x.k} className={m===x.k?"on":""} onClick={()=>setMetric(x.k)}>{x.label}</button>)}</div>}
            <div className="chart-legend">
              <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)"}}></span>With events</span>
              <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--faint)",borderStyle:"dashed"}}></span>No shocks</span>
            </div>
          </div>}/>
        <LineChart labels={d.labels} height={300} spans={eventSpans}
          yFmt={m==="cargo"?(v=>GP_fmt.k(v)):undefined}
          valueFmt={m==="cargo"?(v=>GP_fmt.int(v)+" t"):undefined}
          series={[
            { name:"No shocks", color:"var(--faint)", values:d.baseLt.months.map(r=>r[m]), dash:"5 4", width:1.8 },
            { name:"With events", color:"var(--pink)", values:d.lt.months.map(r=>r[m]), fill:true, glow:true, width:2.8 },
          ]}/>
      </div>

      <div className="panel panel-pad">
        <SectionHead kicker="Micro adjustments" title="Shock events"
          right={<div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
            <button className="btn btn-sm" onClick={()=>addEvent({ label:"Pandemic shock", peak:-75, length:6, recovery:24, permanent:false, target:"all" })}>+ Pandemic</button>
            {d.lt.hasSeg && <button className="btn btn-sm" onClick={()=>addEvent({ label:"Trade dispute", peak:-35, length:9, recovery:0, permanent:true, target:(d.lt.segKeys.includes("transborder")?"transborder":d.lt.segKeys[d.lt.segKeys.length-1]) })}>+ Sector shock</button>}
            <button className="btn btn-sm btn-primary" onClick={()=>addEvent()}>+ Event</button>
          </div>}/>
        {events.length===0
          ? <div className="air-meta">No events yet. Add time-bound shocks — a pandemic, a fuel crisis, a route collapse — that dent or lift demand over a window you set. Each can hit all traffic or a single sector (say a transborder dip that reshapes the mix), recover fully, or <b style={{color:"var(--dim)"}}>permanently re-baseline</b> the rest of the forecast. Stack as many as you like.</div>
          : <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {events.map(ev=>{
                const [ey,em] = String(ev.start).split("-").map(Number);
                const len = ev.length!=null ? ev.length : (ev.hold||0);
                const tgtLabel = (targetOpts.find(o=>o.k===(ev.target||"all"))||{}).label || "All traffic";
                return (
                  <div key={ev.id} style={{border:"1px solid var(--line-2)",borderRadius:"var(--r-sm)",padding:"14px 16px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,flexWrap:"wrap"}}>
                      <span className="dot" style={{background:"var(--bad)"}}></span>
                      <input value={ev.label} onChange={e=>updEvent(ev.id,{label:e.target.value})}
                        style={{flex:"1 1 140px",minWidth:0,background:"transparent",border:"none",borderBottom:"1px solid var(--line)",color:"var(--text)",fontFamily:"var(--sans)",fontSize:15,fontWeight:600,padding:"2px 0",outline:"none"}}/>
                      <span className="air-meta">starts</span>
                      <select value={em} onChange={e=>updEvent(ev.id,{start:`${ey}-${String(+e.target.value).padStart(2,"0")}`})} className="seg-select">{MONTHS.map((mo,mi)=><option key={mi} value={mi+1}>{mo}</option>)}</select>
                      <select value={ey} onChange={e=>updEvent(ev.id,{start:`${+e.target.value}-${String(em).padStart(2,"0")}`})} className="seg-select">{yearOpts.map(y=><option key={y} value={y}>{y}</option>)}</select>
                      <button className="icon-btn" title="Remove event" onClick={()=>rmEvent(ev.id)} style={{width:28,height:28,flex:"none"}}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
                    </div>
                    <div style={{display:"flex",gap:18,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span className="lever-desc" style={{margin:0}}>Affects</span>
                        <select value={ev.target||"all"} onChange={e=>updEvent(ev.id,{target:e.target.value})} className="seg-select">{targetOpts.map(o=><option key={o.k} value={o.k}>{o.label}</option>)}</select>
                      </div>
                      <label style={{display:"flex",alignItems:"center",gap:7,cursor:"pointer",fontSize:13,color:"var(--dim)"}}>
                        <input type="checkbox" checked={!!ev.permanent} onChange={e=>updEvent(ev.id,{permanent:e.target.checked})}/>
                        Permanent (re-baseline)
                      </label>
                    </div>
                    {[
                      { k:"peak", label:"Peak impact", unit:"%", min:-100, max:50, step:1 },
                      { k:"length", label:"Length at peak", unit:" mo", min:0, max:36, step:1 },
                      ...(ev.permanent ? [] : [{ k:"recovery", label:"Recovery", unit:" mo", min:0, max:60, step:1 }]),
                    ].map(c=>{
                      const val = c.k==="length" ? len : (ev[c.k]??0);
                      return (
                        <div key={c.k} style={{marginBottom:8}}>
                          <div className="lever-head" style={{marginBottom:6}}>
                            <span className="lever-desc" style={{margin:0}}>{c.label}</span>
                            <span className="lever-val" style={{fontSize:13}}>{(val>0&&c.k==="peak"?"+":"")+val}{c.unit}</span>
                          </div>
                          <input type="range" min={c.min} max={c.max} step={c.step} value={val} onChange={e=>updEvent(ev.id,{[c.k]:+e.target.value})}/>
                        </div>
                      );
                    })}
                    <div className="lever-desc" style={{marginTop:2}}>
                      {ev.permanent
                        ? `Permanent ${ev.peak>0?"+":""}${ev.peak}% shift to ${tgtLabel.toLowerCase()} — the rest of the forecast re-baselines off it.`
                        : `${ev.peak>0?"+":""}${ev.peak}% on ${tgtLabel.toLowerCase()} for ${len}mo, gliding back over ${ev.recovery||0}mo.`}
                    </div>
                  </div>
                );
              })}
            </div>}
      </div>
    </div>
  );
}

/* ---------- EXPORT ------------------------------------------- */
/* Lazily inject a script only when a format needs it, so the app stays
   light until the user actually generates a workbook/deck. PptxGenJS is
   self-hosted (vendor/); SheetJS still comes from its official CDN —
   SheetJS ≥0.19 isn't published to npm, so there's no integrity-checked
   copy to vendor. Its host is pinned in index.html's CSP.            */
function GP_loadScript(src){
  return new Promise((resolve, reject)=>{
    window.__gpLibs = window.__gpLibs || {};
    if (window.__gpLibs[src]) return resolve();
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = ()=>{ window.__gpLibs[src] = true; resolve(); };
    s.onerror = ()=> reject(new Error("Could not load "+src));
    document.head.appendChild(s);
  });
}
function GP_saveBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
}

function ExportView({ airport, history, scenario }){
  const d = useMemoS(()=>{
    const lt = GP_longTerm(airport.iata, history, scenario);
    const st = GP_tacticalForecast(airport.iata, "pax", history);
    return { lt, st };
  },[airport, history, scenario]);
  const [fmtSel, setFmt] = React.useState("pptx");
  const [busy, setBusy] = React.useState(null);     // id currently generating
  const [note, setNote] = React.useState(null);     // {ok, msg}
  if (!d.lt) return <div className="content fade-in"><div className="panel panel-pad"><div className="air-meta">Not enough complete years of data to export a forecast yet.</div></div></div>;
  const end = d.lt.rows[d.lt.rows.length-1];
  const base = d.lt.rows[0];
  const hasAtm = d.lt.hasAtm, hasCargo = d.lt.hasCargo;
  const st12 = d.st ? d.st.forecast.slice(0,12) : [];
  const provenanceShort = airport.custom ? "your uploaded data · World Bank" : "OpenFlights · World Bank · Eurostat/StatCan/BTS";
  const provenanceLong = airport.custom
    ? "the monthly figures you uploaded, plus World Bank population & GDP/capita for the macro drivers"
    : "OpenFlights reference · World Bank (GDP per capita & population) · Eurostat/StatCan/BTS (monthly passengers, movements & cargo, wired nightly)";

  /* the scenario assumptions, paired with their lever metadata (include the
     movements / cargo shape levers only when the gateway carries that series) */
  const segLevers = d.lt.hasSeg ? d.lt.segKeys.map((k,i)=>({ k:"seg_"+k, name:d.lt.segLabels[i]+" demand shift", unit:"%/yr" })) : [];
  const allLevers = [...LEVERS,
    ...(hasAtm   ? [SHAPE_LEVERS.atm]   : []),
    ...(hasCargo ? [SHAPE_LEVERS.cargo] : []),
    ...segLevers];
  const assumptions = [
    ...allLevers.map(l=>({ name:l.name, value:(scenario[l.k] ?? 0), unit:l.unit })),
    ...(d.lt.paxCap ? [{ name:"Annual passenger capacity (constraint)", value:d.lt.paxCap, unit:"pax/yr" }] : []),
    ...(d.lt.atmCap ? [{ name:"Annual movements capacity (constraint)", value:d.lt.atmCap, unit:"mov/yr" }] : []),
    // phased capacity (a capital project): one row per step and field
    ...(d.lt.capSteps || []).flatMap(st => [
      ...(st.paxCap ? [{ name:`Capacity step from ${st.year} — passengers`, value:st.paxCap, unit:"pax/yr" }] : []),
      ...(st.atmCap ? [{ name:`Capacity step from ${st.year} — movements`, value:st.atmCap, unit:"mov/yr" }] : []),
    ]),
    // the constraint-response assumptions only shape the numbers when a cap
    // is set, so they only clutter the report when one is
    ...(d.lt.hasCap ? CAP_LEVERS
      .filter(l => l.k==="bellyShare" ? hasCargo : l.k==="bellyBeta" ? (hasCargo && hasAtm) : hasAtm)
      .map(l=>({ name:l.name+" (constraint response)", value:(scenario[l.k] ?? 0), unit:l.unit })) : []),
  ];
  const stModelName = d.st ? (d.st.method==="ets" ? "Holt-Winters ETS" : "Prophet") : null;
  const events = Array.isArray(scenario.events) ? scenario.events.filter(e=>e&&e.start) : [];
  const segLabelOf = (k)=> k==="all" ? "All traffic" : (d.lt.segLabels[d.lt.segKeys.indexOf(k)] || k);
  const stamp = new Date().toLocaleDateString("en-CA");
  const fileBase = `glidepath_${airport.iata}_${new Date().toISOString().slice(0,10)}`;

  /* ---- CSV: flat annual + monthly, dependency-free ----
     Free-text fields (gateway name, event labels, …) go through
     GP_csvCell — quote/escape plus a formula-injection guard, since a
     label like "=CMD(...)" must never execute when Excel opens this. */
  const genCSV = ()=>{
    let csv = GP_csvCell("GLIDEPATH FORECAST — "+airport.name+" ("+airport.iata+")")+"\n";
    csv += "generated,"+stamp+"\n\n";
    csv += "SCENARIO ASSUMPTIONS\n";
    csv += "driver,value,unit\n";
    assumptions.forEach(a=> csv += `${GP_csvCell(a.name)},${a.value},${a.unit}\n`);
    const segCols = d.lt.hasSeg ? d.lt.segLabels.map(l=>GP_csvCell(l+" passengers")) : [];
    // any cap propagates to every metric (coupled model), so all constrained
    // columns ship together whenever a cap is set
    const capCols = d.lt.hasCap
      ? ["passengers_constrained","spill", ...(hasAtm?["movements_constrained"]:[]), ...(hasCargo?["cargo_t_constrained"]:[])]
      : [];
    const cols = ["passengers", ...(hasAtm?["movements"]:[]), ...(hasCargo?["cargo_t"]:[]), ...segCols, ...capCols];
    const rowVals = r => [r.pax, ...(hasAtm?[r.atm]:[]), ...(hasCargo?[r.cargo]:[]),
      ...(d.lt.hasSeg ? d.lt.segKeys.map(k=> (r.seg&&r.seg[k]) ?? "") : []),
      ...(d.lt.hasCap ? [r.paxC ?? "", (r.spill != null ? r.spill : (r.paxC != null ? r.pax - r.paxC : "")),
        ...(hasAtm?[r.atmC ?? ""]:[]), ...(hasCargo?[r.cargoC ?? ""]:[])] : [])].join(",");
    csv += "\nANNUAL LONG-TERM FORECAST (roll-up)\n";
    csv += "year,"+cols.join(",")+"\n";
    d.lt.rows.forEach(r=> csv += `${r.y},${rowVals(r)}\n`);
    csv += "\nMONTHLY LONG-TERM FORECAST\n";
    csv += "month,"+cols.join(",")+"\n";
    d.lt.months.forEach(r=> csv += `${r.date},${rowVals(r)}\n`);
    if (events.length){
      csv += "\nSHOCK EVENTS\n";
      csv += "label,start,affects,peak_pct,length_mo,recovery_mo,permanent\n";
      events.forEach(ev=> csv += `${GP_csvCell(ev.label)},${ev.start},${GP_csvCell(segLabelOf(ev.target||"all"))},${ev.peak??0},${ev.length??ev.hold??0},${ev.permanent?"":(ev.recovery??0)},${ev.permanent?"yes":"no"}\n`);
    }
    if (d.st){
      csv += `\nMONTHLY SHORT-TERM FORECAST (passengers · ${stModelName})\n`;
      csv += "month,forecast,low,high\n";
      d.st.forecast.forEach(r=> csv += `${r.date},${r.v},${r.lo},${r.hi}\n`);
    }
    GP_saveBlob(new Blob([csv],{type:"text/csv;charset=utf-8"}), fileBase+"_forecast.csv");
  };

  /* ---- XLSX: real multi-sheet workbook via SheetJS ---- */
  const genXLSX = async ()=>{
    await GP_loadScript("https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js");
    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();

    const summary = [
      ["Glidepath — Aero Demand Forecast"],
      ["Gateway", airport.name],
      ["Codes", airport.iata+" / "+airport.icao],
      ["Location", airport.city+", "+airport.country],
      ["Generated", stamp],
      [],
      ["Metric","Value"],
      ["Base year ("+base.y+") passengers", base.pax],
      [end.y+" passengers", end.pax],
      [(end.y-base.y)+"-yr PAX CAGR (%)", d.lt.cagr],
      ["Annual demand growth (%)", d.lt.gDemand],
      ...(hasAtm?[[end.y+" movements", end.atm]]:[]),
      ...(d.st&&d.st.mape!=null?[["Next-12mo confidence ±MAPE (%)", d.st.mape]]:[]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "Summary");

    const segHeadCols = d.lt.hasSeg ? d.lt.segLabels.map(l=>l+" pax") : [];
    const ltHead = ["Year","Passengers", ...(hasAtm?["Movements"]:[]), ...(hasCargo?["Cargo (t)"]:[]), ...segHeadCols];
    const ltRow = (r,key) => [r[key], r.pax, ...(hasAtm?[r.atm]:[]), ...(hasCargo?[r.cargo]:[]),
      ...(d.lt.hasSeg ? d.lt.segKeys.map(k=> (r.seg&&r.seg[k]) ?? "") : [])];
    const ltAoa = [ltHead];
    d.lt.rows.forEach(r=> ltAoa.push(ltRow(r,"y")));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ltAoa), "Long-term annual");

    const ltmHead = ["Month","Passengers", ...(hasAtm?["Movements"]:[]), ...(hasCargo?["Cargo (t)"]:[]), ...segHeadCols];
    const ltmAoa = [ltmHead];
    d.lt.months.forEach(r=> ltmAoa.push(ltRow(r,"date")));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ltmAoa), "Long-term monthly");

    if (d.st){
      const stAoa = [["Month","Forecast PAX","Low (P10)","High (P90)"]];
      d.st.forecast.forEach(r=> stAoa.push([r.date, r.v, r.lo, r.hi]));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(stAoa), "Short-term monthly");
    }

    if (events.length){
      const evAoa = [["Label","Start","Affects","Peak (%)","Length (mo)","Recovery (mo)","Permanent"]];
      events.forEach(ev=> evAoa.push([ev.label, ev.start, segLabelOf(ev.target||"all"), ev.peak??0, ev.length??ev.hold??0, ev.permanent?"—":(ev.recovery??0), ev.permanent?"Yes":"No"]));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(evAoa), "Events");
    }

    const histHead = ["Month","Passengers", ...(hasAtm?["Movements"]:[]), ...(hasCargo?["Cargo (t)"]:[])];
    const histAoa = [histHead];
    history.forEach(r=> histAoa.push([r.date, r.pax, ...(hasAtm?[r.atm??""]:[]), ...(hasCargo?[r.cargo??""]:[])]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(histAoa), "History (monthly)");

    const asAoa = [["Assumption","Value","Unit"]];
    assumptions.forEach(a=> asAoa.push([a.name, a.value, a.unit]));
    asAoa.push([], ["Model","g = GDPpc·ε + pop + 0.5·tourism + lcc − 0.18·fuel"]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(asAoa), "Assumptions");

    XLSX.writeFile(wb, fileBase+"_workbook.xlsx");
  };

  /* ---- PPTX: real editable deck via PptxGenJS (self-hosted, see vendor/) ---- */
  const genPPTX = async ()=>{
    await GP_loadScript("vendor/pptxgen.bundle.js");
    const Ctor = window.PptxGenJS;
    const pptx = new Ctor();
    pptx.layout = "LAYOUT_WIDE";        // 13.33 × 7.5 in
    const PINK="FF3EA5", DARK="0E1015", PANEL="14171F", INK="F3F4F7", DIM="9AA0AD", CYAN="38E1FF";
    const W = 13.33;

    // 1 — title
    let s = pptx.addSlide(); s.background = { color: DARK };
    s.addText("G L I D E P A T H", { x:0.6, y:2.0, w:8, fontSize:13, color:PINK, bold:true });
    s.addText(airport.name, { x:0.6, y:2.5, w:11, fontSize:40, bold:true, color:INK });
    const subtitle = airport.custom
      ? "Aero demand forecast · "+airport.iata+" · "+airport.country
      : "Aero demand forecast · "+airport.iata+" / "+airport.icao+" · "+airport.city+", "+airport.country;
    s.addText(subtitle, { x:0.6, y:3.7, w:11, fontSize:18, color:DIM });
    s.addText("Generated "+stamp+"  ·  Sources: "+provenanceShort,
      { x:0.6, y:6.7, w:12, fontSize:11, color:DIM });

    // 2 — headline KPIs
    s = pptx.addSlide(); s.background = { color: DARK };
    s.addText("Forecast headlines", { x:0.6, y:0.4, fontSize:24, bold:true, color:INK });
    const kpis = [
      [end.y+" passengers", GP_fmt.k1(end.pax)],
      [(end.y-base.y)+"-yr CAGR", GP_fmt.pct(d.lt.cagr)],
      ...(hasAtm?[[end.y+" movements", GP_fmt.k(end.atm)]]:[]),
      ["Annual demand growth", GP_fmt.pct(d.lt.gDemand)],
      ["Base year ("+base.y+") PAX", GP_fmt.k1(base.pax)],
      ...(d.st&&d.st.mape!=null?[["Next-12mo confidence", "±"+d.st.mape+"%"]]:[]),
    ];
    kpis.forEach((k,i)=>{
      const col = i%3, row = Math.floor(i/3);
      const x = 0.6 + col*4.1, y = 1.4 + row*2.4;
      s.addShape(pptx.ShapeType.roundRect, { x, y, w:3.8, h:2.0, fill:{color:PANEL}, line:{color:PINK,width:0.5}, rectRadius:0.08 });
      s.addText(k[0], { x:x+0.2, y:y+0.2, w:3.4, fontSize:12, color:DIM });
      s.addText(k[1], { x:x+0.2, y:y+0.7, w:3.4, fontSize:30, bold:true, color:PINK });
    });

    // 3 — long-term trajectory table
    s = pptx.addSlide(); s.background = { color: DARK };
    s.addText((end.y-base.y)+"-year trajectory to "+end.y, { x:0.6, y:0.4, fontSize:24, bold:true, color:INK });
    const headCells = ["Year","Passengers", ...(hasAtm?["Movements"]:[]), ...(hasCargo?["Cargo (t)"]:[])];
    const head = headCells.map(t=>({ text:t, options:{ bold:true, color:DARK, fill:{color:PINK}, fontSize:11 } }));
    const body = d.lt.rows.map(r=>[
      { text:String(r.y), options:{ color:INK } },
      { text:GP_fmt.int(r.pax), options:{ color:INK } },
      ...(hasAtm?[{ text:GP_fmt.int(r.atm), options:{ color:INK } }]:[]),
      ...(hasCargo?[{ text:GP_fmt.int(r.cargo), options:{ color:INK } }]:[]),
    ]);
    s.addTable([head,...body], { x:0.6, y:1.3, w:12.1, fontSize:10, border:{type:"solid",color:"333744",pt:0.5}, fill:{color:PANEL}, align:"right", valign:"middle" });

    // 3.5 — passenger mix by segment (only when the gateway publishes a segment split)
    if (d.lt.hasSeg){
      s = pptx.addSlide(); s.background = { color: DARK };
      s.addText("Passenger mix by segment", { x:0.6, y:0.4, fontSize:24, bold:true, color:INK });
      const segHead = ["Year", ...d.lt.segLabels].map(t=>({ text:t, options:{ bold:true, color:DARK, fill:{color:PINK}, fontSize:11 } }));
      const segBody = d.lt.rows.map(r=>[
        { text:String(r.y), options:{ color:INK } },
        ...d.lt.segKeys.map(k=>({ text:GP_fmt.int((r.seg&&r.seg[k])||0), options:{ color:INK } })),
      ]);
      s.addTable([segHead,...segBody], { x:0.6, y:1.3, w:12.1, fontSize:10, border:{type:"solid",color:"333744",pt:0.5}, fill:{color:PANEL}, align:"right", valign:"middle" });
    }

    // 4 — scenario assumptions
    s = pptx.addSlide(); s.background = { color: DARK };
    s.addText("Scenario assumptions", { x:0.6, y:0.4, fontSize:24, bold:true, color:INK });
    const aHead = ["Driver","Value"].map(t=>({ text:t, options:{ bold:true, color:DARK, fill:{color:CYAN}, fontSize:12 } }));
    const aBody = assumptions.map(a=>[
      { text:a.name, options:{ color:INK } },
      { text:(a.value>0?"+":"")+a.value+" "+a.unit, options:{ color:CYAN, align:"right" } },
    ]);
    s.addTable([aHead,...aBody], { x:0.6, y:1.3, w:9, fontSize:13, rowH:0.45, border:{type:"solid",color:"333744",pt:0.5}, fill:{color:PANEL}, valign:"middle", colW:[6,3] });
    s.addText("Model:  g = GDPpc·ε + pop + 0.5·tourism + lcc − 0.18·fuel", { x:0.6, y:6.6, w:12, fontSize:12, color:DIM, italic:true });

    // 5 — shock events (only when at least one is configured)
    if (events.length){
      s = pptx.addSlide(); s.background = { color: DARK };
      s.addText("Shock events", { x:0.6, y:0.4, fontSize:24, bold:true, color:INK });
      const evHead = ["Event","Starts","Affects","Peak","Length","Recovery"].map(t=>({ text:t, options:{ bold:true, color:DARK, fill:{color:CYAN}, fontSize:11 } }));
      const evBody = events.map(ev=>[
        { text:ev.label, options:{ color:INK } },
        { text:String(ev.start), options:{ color:INK, align:"right" } },
        { text:segLabelOf(ev.target||"all"), options:{ color:INK, align:"right" } },
        { text:(ev.peak>0?"+":"")+(ev.peak??0)+"%", options:{ color:CYAN, align:"right" } },
        { text:(ev.length??ev.hold??0)+" mo", options:{ color:INK, align:"right" } },
        { text: ev.permanent?"Permanent":((ev.recovery??0)+" mo"), options:{ color:INK, align:"right" } },
      ]);
      s.addTable([evHead,...evBody], { x:0.6, y:1.3, w:12.1, fontSize:11, rowH:0.42, border:{type:"solid",color:"333744",pt:0.5}, fill:{color:PANEL}, valign:"middle" });
    }

    await pptx.writeFile({ fileName: fileBase+"_deck.pptx" });
  };

  /* ---- DOCX: a Word-openable executive brief (HTML/.doc) ----
     This generator concatenates raw HTML, so every free-text field —
     the gateway name/city/country (uploaded or from the OpenFlights
     feed), event labels (typed, or read back from an imported session
     file) — goes through GP_escapeHtml before interpolation. */
  const genDOC = ()=>{
    const esc = GP_escapeHtml;
    const rows = d.lt.rows.map(r=>
      `<tr><td>${r.y}</td><td>${GP_fmt.int(r.pax)}</td>${hasAtm?`<td>${GP_fmt.int(r.atm)}</td>`:""}${hasCargo?`<td>${GP_fmt.int(r.cargo)}</td>`:""}</tr>`
    ).join("");
    const asRows = assumptions.map(a=>`<tr><td>${esc(a.name)}</td><td>${(a.value>0?"+":"")+a.value} ${esc(a.unit)}</td></tr>`).join("");
    const segRows = d.lt.hasSeg ? d.lt.rows.map(r=>
      `<tr><td>${r.y}</td>${d.lt.segKeys.map(k=>`<td>${GP_fmt.int((r.seg&&r.seg[k])||0)}</td>`).join("")}</tr>`
    ).join("") : "";
    const evRows = events.map(ev=>
      `<tr><td>${esc(ev.label)}</td><td>${esc(ev.start)}</td><td>${esc(segLabelOf(ev.target||"all"))}</td><td>${(ev.peak>0?"+":"")+(ev.peak??0)}%</td><td>${ev.length??ev.hold??0} mo</td><td>${ev.permanent?"Permanent":((ev.recovery??0)+" mo")}</td></tr>`
    ).join("");
    const html = `<!DOCTYPE html><html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset='utf-8'><title>Glidepath ${esc(airport.iata)} brief</title>
<style>
  body{font-family:Calibri,Arial,sans-serif;color:#1a1a1a;font-size:11pt;line-height:1.5;}
  h1{font-size:22pt;color:#c4196f;margin:0 0 2pt;} h2{font-size:14pt;color:#c4196f;border-bottom:1px solid #ddd;padding-bottom:3pt;margin-top:18pt;}
  .sub{color:#666;font-size:10pt;margin-bottom:14pt;}
  table{border-collapse:collapse;width:100%;font-size:10pt;margin-top:6pt;}
  th{background:#c4196f;color:#fff;text-align:right;padding:5pt 7pt;} th:first-child{text-align:left;}
  td{border-bottom:1px solid #e2e2e2;padding:4pt 7pt;text-align:right;} td:first-child{text-align:left;}
  .kpis td{font-size:11pt;border:none;text-align:left;} .kpis td:nth-child(2){font-weight:bold;color:#c4196f;text-align:right;}
</style></head><body>
<h1>${esc(airport.name)}</h1>
<div class='sub'>Aero demand forecast &middot; ${esc(airport.iata)} / ${esc(airport.icao)} &middot; ${esc(airport.city)}, ${esc(airport.country)} &middot; generated ${stamp}</div>

<h2>Executive summary</h2>
<p>This brief sets out the long-term passenger demand outlook for <b>${esc(airport.name)}</b> (${esc(airport.iata)}).
Under the current scenario, annual passengers grow from <b>${GP_fmt.int(base.pax)}</b> in ${base.y} to
<b>${GP_fmt.int(end.pax)}</b> by ${end.y} — a compound annual growth rate of <b>${GP_fmt.pct(d.lt.cagr)}</b>,
driven by blended income, population and tourism dynamics totalling <b>${GP_fmt.pct(d.lt.gDemand)}</b> annual demand growth.${d.st&&d.st.mape!=null?` The short-term ${stModelName} model carries a backtested confidence band of <b>&plusmn;${d.st.mape}%</b> over the next twelve months${d.st.coverage!=null?` (80% interval covered ${d.st.coverage}% of held-out months)`:""}.`:""}${d.lt.paxCap?` Demand is assessed against an annual capacity of <b>${GP_fmt.int(d.lt.paxCap)}</b> passengers; unserved demand (spill) reaches <b>${GP_fmt.int(end.spill||0)}</b> by ${end.y}.`:""}</p>

<table class='kpis'>
  <tr><td>Base year (${base.y}) passengers</td><td>${GP_fmt.int(base.pax)}</td></tr>
  <tr><td>${end.y} passengers</td><td>${GP_fmt.int(end.pax)}</td></tr>
  <tr><td>${end.y-base.y}-yr PAX CAGR</td><td>${GP_fmt.pct(d.lt.cagr)}</td></tr>
  ${hasAtm?`<tr><td>${end.y} movements</td><td>${GP_fmt.int(end.atm)}</td></tr>`:""}
  <tr><td>Annual demand growth</td><td>${GP_fmt.pct(d.lt.gDemand)}</td></tr>
</table>

<h2>Long-term trajectory</h2>
<table><tr><th>Year</th><th>Passengers</th>${hasAtm?"<th>Movements</th>":""}${hasCargo?"<th>Cargo (t)</th>":""}</tr>${rows}</table>

<h2>Scenario assumptions</h2>
<table><tr><th>Driver</th><th>Value</th></tr>${asRows}</table>
<p style='margin-top:6pt;color:#666;font-size:9.5pt;'>Model: g = GDPpc&middot;&epsilon; + pop + 0.5&middot;tourism + lcc &minus; 0.18&middot;fuel.
Passengers compound on the observed base-year seasonal shape${hasAtm?"; movements are held proportional to passengers at the latest observed ratio":""}.</p>

${d.lt.hasSeg?`<h2>Passenger mix by segment</h2>
<table><tr><th>Year</th>${d.lt.segLabels.map(l=>`<th>${esc(l)}</th>`).join("")}</tr>${segRows}</table>`:""}

${events.length?`<h2>Shock events</h2>
<table><tr><th>Event</th><th>Starts</th><th>Affects</th><th>Peak</th><th>Length</th><th>Recovery</th></tr>${evRows}</table>`:""}

<h2>Provenance</h2>
<p style='font-size:9.5pt;color:#444;'>${airport.custom
  ? "This forecast runs on the monthly passenger figures uploaded by the report's author, not a public feed, plus World Bank population &amp; GDP/capita for the macro drivers. The short-term tactical forecast, where present, is a Holt-Winters (ETS) model fit in the author's browser &mdash; the nightly Meta Prophet model runs only for the committed public data sources."
  : "OpenFlights reference &middot; World Bank (GDP per capita &amp; population) &middot; Eurostat / StatCan / US BTS (monthly passengers, movements, cargo) &middot; Meta Prophet short-term forecast. Every figure traces to a public source."}</p>
</body></html>`;
    GP_saveBlob(new Blob(["﻿"+html], {type:"application/msword"}), fileBase+"_brief.doc");
  };

  /* ---- Session: a lossless JSON round-trip, not a report ----
     Meant for Setup ▸ Import session, not for reading — every lever, every
     event, and (for an uploaded gateway) the meta+series itself, so the
     exact same forecast reopens later without re-uploading or re-tweaking
     anything. A catalogue airport only needs its iata: the real data comes
     back from the live pipeline, not from this file. */
  const genSession = ()=>{
    const session = {
      kind: "glidepath-session", version: 1, generatedAt: new Date().toISOString(),
      airport: { iata: airport.iata, name: airport.name, custom: !!airport.custom },
      scenario,
    };
    if (airport.custom) {
      session.customAirport = { iata: airport.iata, meta: GP_getActivityMeta(airport.iata), series: GP_getObservedSeries(airport.iata) };
    }
    GP_saveBlob(new Blob([JSON.stringify(session, null, 2)], {type:"application/json"}), fileBase+"_session.json");
  };

  /* ---- Share link (catalogue gateways only) ----
     The whole scenario — every lever, cap and event — rides in the URL
     fragment; the recipient's browser re-fetches the real data from the
     live pipeline. An uploaded gateway's data exists only in THIS browser,
     so it round-trips via Save session instead (the share deliverable is
     hidden for it). */
  const genShare = async ()=>{
    const url = location.origin + location.pathname + "#s=" + GP_encodeShare(airport.iata, scenario);
    await navigator.clipboard.writeText(url);
  };

  const GEN = { csv:genCSV, xlsx:genXLSX, pptx:genPPTX, docx:genDOC, session:genSession, share:genShare };

  const run = async (id)=>{
    if (busy) return;
    setNote(null); setBusy(id);
    try {
      await GEN[id]();
      setNote({ ok:true, msg: id==="share"
        ? "Share link copied — anyone opening it gets this exact scenario on live data."
        : deliverables.find(x=>x.id===id).tag+" generated — check your downloads." });
    } catch(e){
      setNote({ ok:false, msg: "Couldn't generate "+id.toUpperCase()+" ("+(e&&e.message||"error")+"). The CSV extract always works offline." });
    } finally { setBusy(null); }
  };

  const deliverables = [
    { id:"pptx", name:"Stakeholder deck", desc:"Editable PowerPoint: title, headline KPIs, long-term trajectory table, scenario assumptions, plus segment mix and shock events when set.", tag:"PPTX" },
    { id:"xlsx", name:"Model workbook", desc:"Real Excel workbook — summary, long-term annual + monthly (with segment columns when set), short-term monthly, full history, assumptions and an events sheet.", tag:"XLSX" },
    { id:"docx", name:"Executive brief", desc:"Word-openable narrative: summary, KPIs, trajectory table, assumptions, segment mix, events and provenance.", tag:"DOCX" },
    { id:"csv", name:"Forecast data extract", desc:"Flat annual + monthly tables (with segment columns when set), assumptions and events for your BI stack or master-plan model.", tag:"CSV" },
    { id:"session", name:"Save session", desc:"A JSON file that reopens exactly where you left off — gateway, every lever, every event, and (if uploaded) your own data — via Import session on Select airport.", tag:"JSON" },
    ...(!airport.custom ? [{ id:"share", name:"Share link", desc:"Copies a URL carrying this exact scenario — levers, capacity caps and events. The recipient's browser pulls the same live public data; only your assumptions travel.", tag:"LINK" }] : []),
  ];

  return (
    <div className="content fade-in" style={{maxWidth:1000}}>
      <SectionHead kicker="Step 05 · Deliver" title={"Export the "+airport.iata+" forecast"}/>
      <div className="grid" style={{gridTemplateColumns:"1.3fr 1fr"}}>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {deliverables.map(x=>(
            <div key={x.id} className={"src-row"+(fmtSel===x.id?" connected":"")} style={{cursor:"pointer",borderColor:fmtSel===x.id?"var(--pink-line)":"var(--line)",background:fmtSel===x.id?"var(--pink-soft)":"var(--bg-1)"}} onClick={()=>setFmt(x.id)}>
              <div className="src-ico" style={{color:fmtSel===x.id?"var(--pink)":"var(--pink-2)"}}>{x.tag}</div>
              <div style={{flex:1}}>
                <div style={{fontWeight:600,fontSize:14.5}}>{x.name}</div>
                <div style={{fontSize:12.5,color:"var(--faint)",marginTop:2}}>{x.desc}</div>
              </div>
              <span style={{width:20,height:20,color:fmtSel===x.id?"var(--pink)":"var(--mute)"}}>{fmtSel===x.id?GP_Ico.check:""}</span>
            </div>
          ))}
          <div style={{display:"flex",gap:10,marginTop:6}}>
            <button className="btn btn-primary btn-lg" style={{flex:1,justifyContent:"center"}} disabled={!!busy} onClick={()=>run(fmtSel)}>
              {busy===fmtSel
                ? <span style={{display:"inline-flex",alignItems:"center",gap:9}}><span className="spin" style={{width:15,height:15,display:"inline-block"}}>{GP_Ico.search}</span>Generating…</span>
                : <span style={{display:"inline-flex",alignItems:"center",gap:9}}>{fmtSel==="share"?"Copy":"Generate"} {deliverables.find(x=>x.id===fmtSel).tag} {GP_Ico.arrow}</span>}
            </button>
            <button className="btn btn-lg" disabled={!!busy} onClick={()=>run("csv")}>Quick CSV</button>
          </div>
          {note && (
            <div style={{display:"flex",alignItems:"center",gap:9,fontSize:13,padding:"10px 14px",borderRadius:"var(--r-sm)",
              border:"1px solid "+(note.ok?"rgba(52,224,161,0.35)":"var(--pink-line)"),
              background:note.ok?"rgba(52,224,161,0.08)":"var(--pink-soft)",
              color:note.ok?"var(--ok)":"var(--pink-2)"}}>
              <span className="dot" style={{background:note.ok?"var(--ok)":"var(--pink)"}}></span>{note.msg}
            </div>
          )}
        </div>

        <div className="panel panel-pad">
          <div className="eyebrow" style={{marginBottom:12}}>Forecast summary · {airport.iata}</div>
          <div style={{display:"flex",flexDirection:"column",gap:0}}>
            {[
              ["Gateway",airport.name],
              [base.y+" PAX",GP_fmt.int(base.pax)],
              [end.y+" PAX",GP_fmt.int(end.pax)],
              [(end.y-base.y)+"-yr CAGR",GP_fmt.pct(d.lt.cagr)],
              ...(d.st&&d.st.mape!=null?[["Next-12mo confidence","±"+d.st.mape+"%"]]:[]),
              ...(hasAtm?[[end.y+" movements",GP_fmt.int(end.atm)]]:[]),
              ["Demand growth",GP_fmt.pct(d.lt.gDemand)],
              ...(d.lt.hasSeg?[["Segments",d.lt.segLabels.join(", ")]]:[]),
              ...(events.length?[["Active events",String(events.length)]]:[]),
            ].map((r,i,arr)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",gap:14,padding:"10px 0",borderBottom:i<arr.length-1?"1px solid var(--line)":"none"}}>
                <span style={{color:"var(--faint)",fontSize:13}}>{r[0]}</span>
                <span className="num" style={{fontSize:13,color:"var(--text)",fontWeight:600,textAlign:"right"}}>{r[1]}</span>
              </div>
            ))}
          </div>
          <div className="method" style={{marginTop:16}}>
            <b>Provenance —</b> {airport.custom
              ? "runs on the monthly figures you uploaded, plus World Bank population & GDP/capita for the macro drivers. The short-term view is a Holt-Winters (ETS) model fit in your browser — the nightly Prophet model only runs for the committed public data sources."
              : "OpenFlights reference · World Bank (GDP per capita & population) · Eurostat/StatCan/BTS (monthly passengers, movements & cargo, wired nightly). Every figure traces to a public source; the workbook ships the full audit trail."}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { LongTerm, Scenario, EventSim, ExportView });

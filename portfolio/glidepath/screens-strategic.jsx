/* ============================================================
   screens-strategic.jsx — Long-term, Scenario builder, Export
   ============================================================ */
const { useMemo:useMemoS } = React;

/* ---------- LONG-TERM STRATEGIC ------------------------------ */
function LongTerm({ airport, history, scenario, ltOpts, baseMode, setBaseMode, go }){
  const macro = MACRO[airport.cc];
  const lt = useMemoS(()=>GP_longTerm(airport.iata, history, scenario, ltOpts),[airport, history, scenario, ltOpts]);
  const metricDefs = [{k:"pax",label:"Passengers"},
    ...(lt&&lt.hasAtm?[{k:"atm",label:"Movements"}]:[]),
    ...(lt&&lt.hasCargo?[{k:"cargo",label:"Cargo"}]:[])];
  const [metric, setMetric] = React.useState("pax");
  const m = metricDefs.some(x=>x.k===metric) ? metric : "pax";

  const d = useMemoS(()=>{
    if (!lt) return null;
    const histTail = history.filter(r=>r.y>=lt.baseYear-3 && r[m]!=null);
    // the base year's MODELED months belong to the forecast line, not the
    // actuals — without them the chart jumps from the last observed month
    // straight to January of the year after the base year (8-10 months on a
    // mid-year snapshot) and draws them as if adjacent
    const baseFc = lt.baseMonthly.filter(r=>r.modeled[m] && r[m]!=null);
    const fc = [...baseFc, ...lt.months];
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
  const modeled = lt.baseForecastMonths.length > 0;

  return (
    <div className="content fade-in">
      <DataCaveat airport={airport}/>
      <div className="grid g-4" style={{marginBottom:16}}>
        <KPI accent label={lt.endYear+" passengers"} value={GP_fmt.k1(end.pax)} delta={GP_fmt.pct(lt.cagr)+" CAGR"} deltaDir="up" sub={"from "+GP_fmt.k1(start.pax)+" in "+lt.baseYear}/>
        <KPI label="Demand growth" value={GP_fmt.pct(lt.gDemand)} sub="annual, blended drivers" sparkColor="var(--cyan)"/>
        {lt.hasAtm
          ? (lt.hasCap && end.atmC != null && end.atmC < end.atm
              ? <KPI label={lt.endYear+" movements"} value={GP_fmt.k(end.atmC)} sub={"at capacity · demand "+GP_fmt.k(end.atm)} sparkColor="var(--amber)"/>
              : <KPI label={lt.endYear+" movements"} value={GP_fmt.k(end.atm)} sub="held proportional to PAX" sparkColor="var(--lime)"/>)
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
          : <KPI label={lt.baseYear+" passengers"} value={GP_fmt.k1(start.pax)}
              sub={modeled ? `base year · ${lt.baseObservedMonths} observed + ${lt.baseForecastMonths.length} modeled months` : "observed base year"}/>}
      </div>

      {/* ---- base-year provenance ----
          The whole curve is this one number compounded, so how it was assembled
          belongs on the screen rather than in a footnote. It's also the switch:
          the tactical model that completes the base year is the one chosen (or
          overridden) on the short-term screen, so the two forecasts move
          together instead of disagreeing about the same year. */}
      <div className="panel panel-pad" style={{marginBottom:16}}>
        <SectionHead kicker="Base year" title={"Everything compounds off "+lt.baseYear}
          right={<div className="seg seg-sub">
            <button className={baseMode!=="observed"?"on":""} onClick={()=>setBaseMode("forecast")}>Forecast-completed</button>
            <button className={baseMode==="observed"?"on":""} onClick={()=>setBaseMode("observed")}>Last full year</button>
          </div>}/>
        <div className="method">
          {modeled ? <>
            <b>{lt.baseObservedMonths} observed + {lt.baseForecastMonths.length} modeled —</b> {lt.baseYear} isn&rsquo;t
            over, so {MONTHS[lt.baseForecastMonths[0]]}–{MONTHS[lt.baseForecastMonths[lt.baseForecastMonths.length-1]]} come
            from the short-term model{lt.baseModel && GP_MODEL_META[String(lt.baseModel).replace("+carry","")]
              ? <> ({GP_MODEL_META[String(lt.baseModel).replace("+carry","")].label})</> : null}, so {lt.endYear}
            starts from where {lt.baseYear} actually lands rather than a stale full year.
            {(lt.hasAtm || lt.hasCargo) && (()=>{
              // the feeds publish at different lags, so each metric has its own
              // count of modeled months — reporting passengers' for all of them
              // would be wrong (YYZ: pax through May, movements through April)
              const label = { atm:"movements", cargo:"cargo" };
              const others = ["atm","cargo"].filter(k => lt.baseModeledMonths[k] != null);
              const differing = others.filter(k => lt.baseModeledMonths[k] !== lt.baseForecastMonths.length);
              const carried = others.filter(k => lt.baseCompletion[k] === "carry").map(k=>label[k]);
              const implied = String(lt.baseCompletion.atm || "").startsWith("pax-implied");
              const ratio = (lt.rows[0].atm > 0) ? lt.rows[0].pax / lt.rows[0].atm : null;
              return (<>
                {differing.length ? <> {differing.map(k=>`${label[k]} lags (${lt.baseModeledMonths[k]} modeled)`).join(", ")}.</> : null}
                {implied ? <> Movements follow passengers at the observed ratio
                    {ratio ? <> (~{ratio.toFixed(0)} per flight)</> : null}, not their own forecast.</> : null}
                {carried.length ? <> {carried.join(" and ")} carr{carried.length>1?"y":"ies"} the prior year&rsquo;s
                    same month.</> : null}
              </>);
            })()}
            <br/><br/>
            <b>The trade —</b> a modeled base year carries the tactical model&rsquo;s error into all
            {" "}{lt.endYear-lt.baseYear} projected years; <em>Last full year</em> avoids that but compounds a
            possibly-stale base.
          </> : (()=>{
            /* "nothing is modeled" is a claim about PASSENGERS. A metric that
               publishes on a lag can still have been carried from the prior year
               even in a complete base year, and saying otherwise would overstate
               it. (No gateway hits this on today's feeds — it's the disclosure
               keeping pace with what the base-year builder can actually do.) */
            const label = { atm:"movements", cargo:"cargo" };
            const carried = ["atm","cargo"].filter(k => lt.baseModeledMonths[k] > 0).map(k=>label[k]);
            return (<>
              <b>{carried.length ? "Observed passengers" : "Fully observed"} —</b> {lt.baseYear} is complete, so
              the projection compounds off twelve real filings.
              {carried.length ? <> {carried.join(" and ")} publish on a lag and carry the prior year&rsquo;s
                same month.</> : null}
              {baseMode === "observed" && <> No later partial year exists, so <em>Forecast-completed</em> resolves
                to the same year.</>}</>);
          })()}
        </div>
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

      {(()=>{
        // when a cap actually bites, the table reports SERVED traffic (what the
        // airport can physically handle) — unconstrained demand stays on the
        // chart above as the pink line
        const capped = lt.hasCap && lt.months.some(r =>
          (r.paxC != null && r.paxC !== r.pax) || (r.atmC != null && r.atmC !== r.atm) || (r.cargoC != null && r.cargoC !== r.cargo));
        const cell = (r, k) => GP_fmt.int(capped ? (r[k+"C"] ?? r[k]) : r[k]);
        return (
      <div className="panel panel-pad">
        <SectionHead kicker={"Monthly table · "+macro.label+" macro baseline"} title="Month-by-month forecast"
          right={<span className="air-meta">{lt.months.length} months · {macro.label} baseline{capped?" · capacity-constrained":""}</span>}/>
        <div className="tbl-wrap" style={{maxHeight:360}}>
          <table className="tbl">
            <thead><tr><th>Month</th><th>Passengers</th>{lt.hasAtm&&<th>Movements</th>}{lt.hasCargo&&<th>Cargo (t)</th>}</tr></thead>
            <tbody>
              {lt.months.map((r,i)=>(
                <tr key={i} style={r.m===0?{borderTop:"1px solid var(--line-2)"}:{}}>
                  <td style={{color:r.m===0?"var(--text)":"var(--dim)",fontWeight:r.m===0?700:400}}>{r.label}</td>
                  <td style={{color:"var(--pink-2)",fontWeight:700}}>{cell(r,"pax")}</td>
                  {lt.hasAtm&&<td>{cell(r,"atm")}</td>}
                  {lt.hasCargo&&<td>{cell(r,"cargo")}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="air-meta" style={{marginTop:12}}>Passengers compound at the blended demand growth on the {modeled?"":"observed "}{lt.baseYear} seasonal shape{lt.hasAtm?"; movements are held proportional to passengers at the latest observed ratio":""}.{capped?<> A binding capacity cap is applied — this table shows <b style={{color:"var(--amber)"}}>served traffic</b>; the chart's unconstrained line is demand.</>:null}</div>
      </div>
        );
      })()}

      {/* design-day / peak-hour: the granularity terminal & runway planning
          actually happens at. Derived from the real seasonal shape with
          disclosed heuristics — see GP_designDay in data.jsx. */}
      {(()=>{
        const seas = GP_observedSeasonality(history, "pax");
        const ddBase = GP_designDay(start.pax, seas);
        // hasCap, not paxCap: a slot-only cap or a phased capacity step
        // constrains passengers just as much (the coupled model in data.jsx
        // propagates it), and reading them off the unconstrained demand here
        // sized the terminal for traffic the airport can't actually serve
        const endPax = lt.hasCap ? (end.paxC ?? end.pax) : end.pax;
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
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th style={{textAlign:"left"}}>Measure</th><th>{lt.baseYear} {modeled?"(part modeled)":"(observed)"}</th><th>{lt.endYear} (scenario{lt.hasCap?", constrained":""})</th></tr></thead>
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
            </div>
            <div className="method" style={{marginTop:12}}>
              <b>Assumptions —</b> busy day = peak-month average day × 1.10; peak hour takes
              {" "}{Math.round(ddEnd.peakHourShare*100)}% of it (12% under 1M annual pax, 10% to 10M, 8% above).
              Derived from monthly data — replace with measured factors if you have daily/hourly.
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

function Scenario({ airport, history, scenario, setScenario, ltOpts }){
  const base = useMemoS(()=>GP_defaultScenario(airport.iata),[airport]);
  const d = useMemoS(()=>{
    // this page is the lever baseline — show the assumptions without shock
    // events (those live on their own page); compare against the macro default
    const lt = GP_longTerm(airport.iata, history, { ...scenario, events: [] }, ltOpts);
    const baseLt = GP_longTerm(airport.iata, history, { ...base, horizon: scenario.horizon || base.horizon }, ltOpts);
    const labels = lt ? lt.months.map(r=>r.label) : [];
    return { lt, baseLt, labels };
  },[airport, history, scenario, base, ltOpts]);

  // metric the impact chart + KPIs focus on; extra metrics appear only when the
  // gateway actually carries movements / cargo
  const metricDefs = [{ k:"pax", label:"Passengers" },
    ...(d.lt && d.lt.hasAtm   ? [{ k:"atm",   label:"Movements" }] : []),
    ...(d.lt && d.lt.hasCargo ? [{ k:"cargo", label:"Cargo" }]     : [])];
  const [metric, setMetric] = React.useState("pax");
  const m = metricDefs.some(x=>x.k===metric) ? metric : "pax";
  // monthly shows the seasonal shape; annual sums each year so totals are
  // readable at a glance while shaping the forecast
  const [view, setView] = React.useState("monthly");

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
  // when a capacity cap bites the metric on screen, the headline numbers are
  // the SERVED values — a slot cap that the KPIs ignored used to read
  // "+0 vs base" no matter what the cap did to the trajectory
  const ck = { pax:"paxC", atm:"atmC", cargo:"cargoC" }[m];
  const endDemand = end[m] ?? 0;
  const endM = (d.lt.hasCap && end[ck] != null) ? end[ck] : endDemand;
  const capBites = endM !== endDemand;
  const baseEndM = baseEnd[m] ?? 0, diffM = endM - baseEndM;
  const yrs = d.lt.endYear - d.lt.baseYear;
  const cagrM = (d.lt.rows[0][m] && endM) ? (Math.pow(endM/d.lt.rows[0][m], 1/yrs)-1)*100 : 0;
  const mLabel = (metricDefs.find(x=>x.k===m)||{}).label || "Passengers";
  // chart data for the current view — annual plots the yearly roll-ups
  // (base-year anchor included) instead of the 300-month seasonal ribbon
  const chart = (()=>{
    const src = view==="annual" ? d.lt.rows : d.lt.months;
    const baseSrc = view==="annual" ? d.baseLt.rows : d.baseLt.months;
    const labels = view==="annual" ? src.map(r=>String(r.y)) : d.labels;
    const capVals = (d.lt.hasCap && src.some(r => r[ck] != null && r[ck] !== r[m]))
      ? src.map(r => r[ck] ?? r[m]) : null;
    return { labels, scen: src.map(r=>r[m]), base: baseSrc.map(r=>r[m]), capVals };
  })();
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
              delta={(diffM>=0?"+":"")+fmtM(Math.abs(diffM))+" vs base"} deltaDir={diffM>=0?"up":"down"}
              sub={capBites ? "capacity-capped · demand "+fmtM(endDemand) : mLabel.toLowerCase()}/>
            <KPI label={mLabel+" CAGR"} value={GP_fmt.pct(cagrM)} sub={d.lt.baseYear+"→"+d.lt.endYear+(capBites?" · served":"")} sparkColor="var(--cyan)"/>
            <KPI label="vs baseline" value={GP_fmt.pct(baseEndM?(endM/baseEndM-1)*100:0)} deltaDir={diffM>=0?"up":"down"} sub={d.lt.endYear+" "+mLabel.toLowerCase()} />
          </div>

          <div className="panel panel-pad">
            <SectionHead kicker="Live impact" title="Scenario vs baseline"
              right={<div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
                {metricDefs.length>1 && <div className="seg">{metricDefs.map(x=><button key={x.k} className={m===x.k?"on":""} onClick={()=>setMetric(x.k)}>{x.label}</button>)}</div>}
                <div className="seg seg-sub">
                  {[["monthly","Monthly"],["annual","Annual"]].map(([v,lb])=>
                    <button key={v} className={view===v?"on":""} onClick={()=>setView(v)}>{lb}</button>)}
                </div>
                <div className="chart-legend">
                  <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)"}}></span>Scenario</span>
                  <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--faint)",borderStyle:"dashed"}}></span>Baseline</span>
                  {chart.capVals && <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--amber)"}}></span>Constrained</span>}
                </div>
              </div>}/>
            <LineChart labels={chart.labels} height={270}
              valueFmt={m==="cargo"?(v=>GP_fmt.int(v)+" t"):undefined}
              series={[
                { name:"Baseline", color:"var(--faint)", values:chart.base, dash:"5 4", width:1.8 },
                { name:"Scenario", color:"var(--pink)", values:chart.scen, fill:!chart.capVals, glow:true, width:2.8 },
                ...(chart.capVals ? [{ name:"Constrained", color:"var(--amber)", values:chart.capVals, fill:true, width:2.2 }] : []),
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
function EventSim({ airport, history, scenario, setScenario, ltOpts }){
  const d = useMemoS(()=>{
    const lt = GP_longTerm(airport.iata, history, scenario, ltOpts);                       // with events
    const baseLt = GP_longTerm(airport.iata, history, { ...scenario, events: [] }, ltOpts); // same levers, no shocks
    const labels = lt ? lt.months.map(r=>r.label) : [];
    return { lt, baseLt, labels };
  },[airport, history, scenario, ltOpts]);

  const metricDefs = [{ k:"pax", label:"Passengers" },
    ...(d.lt && d.lt.hasAtm   ? [{ k:"atm",   label:"Movements" }] : []),
    ...(d.lt && d.lt.hasCargo ? [{ k:"cargo", label:"Cargo" }]     : [])];
  const [metric, setMetric] = React.useState("pax");
  const m = metricDefs.some(x=>x.k===metric) ? metric : "pax";
  // monthly shows the shock month-by-month; annual sums each year so the
  // lasting damage (or recovery) reads directly in yearly totals
  const [view, setView] = React.useState("monthly");

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
  // KPIs report SERVED values when a capacity cap bites this metric — both
  // sides carry the same caps (baseLt is this scenario minus its events), so
  // the "vs no-shock" delta stays like-for-like
  const ck = { pax:"paxC", atm:"atmC", cargo:"cargoC" }[m];
  const served = (row)=> (d.lt.hasCap && row[ck] != null) ? row[ck] : (row[m] ?? 0);
  const endServed = served(end);
  const capBites = endServed !== (end[m] ?? 0);
  const endDelta = endServed - served(baseEnd);
  const targetOpts = [{ k:"all", label:"All traffic" }, ...(d.lt.hasSeg ? d.lt.segKeys.map((k,i)=>({ k, label:d.lt.segLabels[i] })) : [])];
  const yearOpts = []; for (let yy=by+1; yy<=d.lt.endYear; yy++) yearOpts.push(yy);
  const eventSpans = events.map(ev=>{
    const si = d.lt.months.findIndex(r=> r.date >= ev.start); if (si < 0) return null;
    const len = Math.round(+(ev.length!=null?ev.length:ev.hold)||0);
    const span = (len + (ev.permanent ? 6 : Math.round(+ev.recovery||0))) || 1;
    return { from:si, to:Math.min(d.lt.months.length-1, si+span), color:"var(--bad)", label:ev.label };
  }).filter(Boolean);
  // chart data for the current view — annual plots yearly roll-ups, with the
  // event shading windows mapped from month indices to year indices
  const chart = (()=>{
    if (view !== "annual"){
      const capVals = (d.lt.hasCap && d.lt.months.some(r => r[ck] != null && r[ck] !== r[m]))
        ? d.lt.months.map(r => r[ck] ?? r[m]) : null;
      return { labels: d.labels, shock: d.lt.months.map(r=>r[m]), base: d.baseLt.months.map(r=>r[m]), capVals, spans: eventSpans };
    }
    const labels = d.lt.rows.map(r=>String(r.y));
    const capVals = (d.lt.hasCap && d.lt.rows.some(r => r[ck] != null && r[ck] !== r[m]))
      ? d.lt.rows.map(r => r[ck] ?? r[m]) : null;
    const spans = eventSpans.map(sp=>({ ...sp,
      from: d.lt.months[sp.from].y - d.lt.baseYear,
      to:   d.lt.months[sp.to].y - d.lt.baseYear }));
    return { labels, shock: d.lt.rows.map(r=>r[m]), base: d.baseLt.rows.map(r=>r[m]), capVals, spans };
  })();

  return (
    <div className="content fade-in">
      <div className="grid g-3" style={{marginBottom:16}}>
        <KPI accent label={d.lt.endYear+" "+(metricDefs.find(x=>x.k===m)||{}).label.toLowerCase()+" · with events"} value={fmtM(endServed)}
          delta={(endDelta>=0?"+":"")+fmtM(Math.abs(endDelta))+" vs no-shock"} deltaDir={endDelta>=0?"up":"down"}
          sub={capBites ? "capacity-capped · demand "+fmtM(end[m]??0) : "end of horizon"}/>
        <KPI label="Deepest month" value={fmtM(trough[m]??0)} sub={trough.label} sparkColor="var(--bad)"/>
        <KPI label="Events stacked" value={String(events.length)} sub="active shocks"/>
      </div>

      <div className="panel panel-pad" style={{marginBottom:16}}>
        <SectionHead kicker="Event impact" title="Forecast with shocks"
          right={<div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
            {metricDefs.length>1 && <div className="seg">{metricDefs.map(x=><button key={x.k} className={m===x.k?"on":""} onClick={()=>setMetric(x.k)}>{x.label}</button>)}</div>}
            <div className="seg seg-sub">
              {[["monthly","Monthly"],["annual","Annual"]].map(([v,lb])=>
                <button key={v} className={view===v?"on":""} onClick={()=>setView(v)}>{lb}</button>)}
            </div>
            <div className="chart-legend">
              <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)"}}></span>With events</span>
              <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--faint)",borderStyle:"dashed"}}></span>No shocks</span>
              {chart.capVals && <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--amber)"}}></span>Constrained</span>}
            </div>
          </div>}/>
        <LineChart labels={chart.labels} height={300} spans={chart.spans}
          valueFmt={m==="cargo"?(v=>GP_fmt.int(v)+" t"):undefined}
          series={[
            { name:"No shocks", color:"var(--faint)", values:chart.base, dash:"5 4", width:1.8 },
            { name:"With events", color:"var(--pink)", values:chart.shock, fill:!chart.capVals, glow:true, width:2.8 },
            ...(chart.capVals ? [{ name:"Constrained", color:"var(--amber)", values:chart.capVals, fill:true, width:2.2 }] : []),
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

function ExportView({ airport, history, scenario, ltOpts, stModel }){
  const d = useMemoS(()=>{
    const lt = GP_longTerm(airport.iata, history, scenario, ltOpts);
    const st = GP_tacticalForecast(airport.iata, "pax", history, stModel);
    return { lt, st };
  },[airport, history, scenario, ltOpts, stModel]);
  const [fmtSel, setFmt] = React.useState("xlsx");
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
  // the model that actually produced this export's short-term numbers, and how
  // the long-term's base year was assembled — an exported deck outlives the
  // session that made it, so both have to travel with the figures
  const stModelName = d.st ? (GP_MODEL_META[d.st.method]||{}).label : null;
  const baseNote = d.lt.baseForecastMonths.length
    ? `${d.lt.baseYear} base year: ${d.lt.baseObservedMonths} observed months + ${d.lt.baseForecastMonths.length} from the ${stModelName||"tactical"} short-term model`
    : `${d.lt.baseYear} base year: 12 observed months`;
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
      ...(d.lt.hasCap?[
        [end.y+" passengers (served, capacity-constrained)", end.paxC ?? end.pax],
        ...(hasAtm?[[end.y+" movements (served, capacity-constrained)", end.atmC ?? end.atm]]:[]),
        [end.y+" unserved demand (spill)", end.spill ?? 0],
      ]:[]),
      ...(d.st&&d.st.mape!=null?[["Next-12mo confidence ±MAPE (%)", d.st.mape]]:[]),
      ...(d.st&&d.st.mase!=null?[["Short-term MASE (1.00 = seasonal-naive)", d.st.mase]]:[]),
      ...(stModelName?[["Short-term model", stModelName]]:[]),
      ...(d.st&&d.st.coverage!=null?[["Short-term raw band coverage (%)", d.st.coverage]]:[]),
      ...(d.st&&d.st.bandScale!=null?[["Short-term band calibration (x)", d.st.bandScale]]:[]),
      ["Base year composition", baseNote],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "Summary");

    const segHeadCols = d.lt.hasSeg ? d.lt.segLabels.map(l=>l+" pax") : [];
    // same coupled-constraint columns the CSV extract ships whenever a cap is set
    const capHeadCols = d.lt.hasCap
      ? ["Passengers (constrained)","Spill", ...(hasAtm?["Movements (constrained)"]:[]), ...(hasCargo?["Cargo t (constrained)"]:[])]
      : [];
    const ltHead = ["Year","Passengers", ...(hasAtm?["Movements"]:[]), ...(hasCargo?["Cargo (t)"]:[]), ...segHeadCols, ...capHeadCols];
    const ltRow = (r,key) => [r[key], r.pax, ...(hasAtm?[r.atm]:[]), ...(hasCargo?[r.cargo]:[]),
      ...(d.lt.hasSeg ? d.lt.segKeys.map(k=> (r.seg&&r.seg[k]) ?? "") : []),
      ...(d.lt.hasCap ? [r.paxC ?? "", (r.spill != null ? r.spill : (r.paxC != null ? r.pax - r.paxC : "")),
        ...(hasAtm?[r.atmC ?? ""]:[]), ...(hasCargo?[r.cargoC ?? ""]:[])] : [])];
    const ltAoa = [ltHead];
    d.lt.rows.forEach(r=> ltAoa.push(ltRow(r,"y")));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ltAoa), "Long-term annual");

    const ltmHead = ["Month","Passengers", ...(hasAtm?["Movements"]:[]), ...(hasCargo?["Cargo (t)"]:[]), ...segHeadCols, ...capHeadCols];
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
      session.customAirport = { iata: airport.iata, meta: GP_getActivityMeta(airport.iata),
        series: GP_getObservedSeries(airport.iata), paxSeg: GP_getSegments(airport.iata) };
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

  const GEN = { csv:genCSV, xlsx:genXLSX, session:genSession, share:genShare };

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
    { id:"xlsx", name:"Model workbook", desc:"Real Excel workbook — summary, long-term annual + monthly (with segment columns when set), short-term monthly, full history, assumptions and an events sheet.", tag:"XLSX" },
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
              ...(stModelName?[["Short-term model",stModelName+(d.st.mase!=null?` · MASE ${d.st.mase.toFixed(2)}`:"")]]:[]),
              ["Base year",baseNote],
              ...(hasAtm?[[end.y+" movements",GP_fmt.int(end.atm)]]:[]),
              ...(d.lt.hasCap&&end.paxC!=null&&end.paxC<end.pax?[[end.y+" PAX (served)",GP_fmt.int(end.paxC)]]:[]),
              ...(d.lt.hasCap&&hasAtm&&end.atmC!=null&&end.atmC<end.atm?[[end.y+" movements (served)",GP_fmt.int(end.atmC)]]:[]),
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
              ? "runs on the monthly figures you uploaded, plus World Bank population & GDP/capita for the macro drivers. The short-term view is a Holt-Winters (ETS) model fit in your browser — the nightly model selection only runs for the committed public data sources."
              : "OpenFlights reference · World Bank (GDP per capita & population) · Eurostat/StatCan/BTS (monthly passengers, movements & cargo, wired nightly). Every figure traces to a public source; the workbook ships the full audit trail."}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { LongTerm, Scenario, EventSim, ExportView });

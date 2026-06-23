/* ============================================================
   screens-strategic.jsx — Long-term, Scenario builder, Export
   ============================================================ */
const { useMemo:useMemoS } = React;

/* ---------- LONG-TERM STRATEGIC ------------------------------ */
function LongTerm({ airport, history, scenario, go }){
  const [metric, setMetric] = React.useState("pax");
  const a = ANCHOR[airport.iata];
  const metrics=[{k:"pax",label:"Passengers"},{k:"atm",label:"Movements"},{k:"cargo",label:"Cargo"},{k:"seats",label:"Seats"}];
  const d = useMemoS(()=>{
    const lt = GP_longTerm(airport.iata, history, scenario);
    const histAnn = GP_annualize(history, metric);
    const histTail = histAnn.filter(r=>r.y>=2018);
    const labels = [...histTail.map(r=>"'"+String(r.y).slice(2)), ...lt.rows.slice(1).map(r=>"'"+String(r.y).slice(2))];
    const nHist = histTail.length;
    const histVals = [...histTail.map(r=>r.v), ...lt.rows.slice(1).map(()=>null)];
    const fcVals = [...histTail.map(()=>null), ...lt.rows.slice(1).map(r=>r[metric])];
    fcVals[nHist-1] = histTail[histTail.length-1].v;
    return { lt, labels, histVals, fcVals, nHist };
  },[airport, history, scenario, metric]);

  const macro = MACRO[airport.cc];
  const end = d.lt.rows[d.lt.rows.length-1];
  const start = d.lt.rows[0];
  const cargoFmt = metric==="cargo";

  return (
    <div className="content fade-in">
      <div className="grid g-4" style={{marginBottom:16}}>
        <KPI accent label="2035 passengers" value={GP_fmt.k1(end.pax)} delta={GP_fmt.pct(d.lt.cagr)+" CAGR"} deltaDir="up" sub={"from "+GP_fmt.k1(start.pax)+" today"}/>
        <KPI label="Demand growth" value={GP_fmt.pct(d.lt.gDemand)} sub="annual, blended drivers" sparkColor="var(--cyan)"/>
        <KPI label="2035 movements" value={GP_fmt.k(end.atm)} sub={d.lt.constrainedFrom?("capacity-bound from "+d.lt.constrainedFrom):"within slot envelope"} sparkColor="var(--lime)"/>
        <KPI label="Avg gauge 2035" value={end.gauge.toFixed(0)+" seats"} delta={GP_fmt.pct((end.gauge/start.gauge-1)*100)} deltaDir="up" sub="per movement"/>
      </div>

      <div className="grid" style={{gridTemplateColumns:"1.55fr 1fr", marginBottom:16}}>
        <div className="panel panel-pad">
          <SectionHead kicker="Strategic forecast · elasticity model" title="10-year trajectory to 2035"
            right={<div className="seg">{metrics.map(m=><button key={m.k} className={metric===m.k?"on":""} onClick={()=>setMetric(m.k)}>{m.label}</button>)}</div>}/>
          <LineChart labels={d.labels} height={285} markerIndex={d.nHist-1}
            yFmt={cargoFmt?(v=>GP_fmt.k(v)):undefined}
            series={[
              { name:"Actual", color:"var(--text)", values:d.histVals, width:2.4 },
              { name:"Forecast", color:"var(--pink)", values:d.fcVals, fill:true, glow:true, width:2.8 },
            ]}/>
          <div style={{display:"flex",gap:18,marginTop:12,flexWrap:"wrap"}}>
            <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--text)"}}></span>Actual</span>
            <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)"}}></span>Elasticity forecast</span>
            {metric==="atm" && d.lt.constrainedFrom && <span className="legend-item" style={{color:"var(--amber)"}}>● slot/noise ceiling binds {d.lt.constrainedFrom}</span>}
          </div>
        </div>

        <div className="panel panel-pad">
          <SectionHead kicker="Growth decomposition" title="What drives the curve"/>
          <div style={{display:"flex",flexDirection:"column",gap:11,marginBottom:14}}>
            {d.lt.breakdown.map((b,i)=>{
              const maxAbs = Math.max(...d.lt.breakdown.map(x=>Math.abs(x.v)),0.5);
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
            <span className="num" style={{fontSize:20,fontWeight:700,color:"var(--lime)"}}>{GP_fmt.pct(d.lt.gDemand)}</span>
          </div>
          <button className="btn btn-primary" style={{width:"100%",marginTop:16,justifyContent:"center"}} onClick={()=>go("scenario")}>Adjust assumptions {GP_Ico.arrow}</button>
        </div>
      </div>

      <div className="panel panel-pad">
        <SectionHead kicker={"Annual table · "+macro.label+" macro baseline"} title="Year-by-year forecast"/>
        <table className="tbl">
          <thead><tr><th>Year</th><th>Passengers</th><th>Movements</th><th>Seats</th><th>Cargo (t)</th><th>Avg gauge</th><th>Load factor</th></tr></thead>
          <tbody>
            {d.lt.rows.map((r,i)=>(
              <tr key={i} style={i===0?{opacity:.65}:{}}>
                <td style={{color:i===0?"var(--faint)":"var(--text)",fontWeight:i===0?400:600}}>{r.y}{i===0?" · base":""}</td>
                <td style={{color:"var(--pink-2)",fontWeight:700}}>{GP_fmt.int(r.pax)}</td>
                <td style={r.constrained?{color:"var(--amber)"}:{}}>{GP_fmt.int(r.atm)}{r.constrained?" ▲":""}</td>
                <td>{GP_fmt.int(r.seats)}</td>
                <td>{GP_fmt.int(r.cargo)}</td>
                <td>{r.gauge.toFixed(1)}</td>
                <td>{r.lf}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="air-meta" style={{marginTop:12}}>▲ movements bound by {airport.iata} slot/noise ceiling ({GP_fmt.int(d.lt.atmCap)}/yr) — residual demand absorbed by larger gauge & higher load factor.</div>
      </div>
    </div>
  );
}

/* ---------- SCENARIO BUILDER --------------------------------- */
const LEVERS = [
  { k:"gdp",        name:"Real GDP / capita growth", unit:"%/yr", min:-1, max:5, step:0.1, desc:"OECD trend output per head — the core income signal." },
  { k:"elasticity", name:"Income elasticity of demand", unit:"×", min:0.8, max:2.6, step:0.05, desc:"How strongly air travel responds to income. Mature ~1.5, emerging ~2.0." },
  { k:"pop",        name:"Catchment population growth", unit:"%/yr", min:-1, max:3, step:0.1, desc:"Net migration + natural change in the airport's drive-time catchment." },
  { k:"tourism",    name:"Inbound tourism shift", unit:"%/yr", min:-3, max:6, step:0.25, desc:"Destination-marketing, events & visa policy tailwinds (half-weighted)." },
  { k:"fuel",       name:"Fuel / yield shock", unit:"%", min:-10, max:40, step:1, desc:"Sustained jet-fuel & fare increase that suppresses price-sensitive demand." },
  { k:"lcc",        name:"LCC / new-route stimulation", unit:"%/yr", min:0, max:5, step:0.25, desc:"Demand uplift from low-cost entry or route development incentives." },
];

const PRESETS = {
  base:    { label:"Macro baseline", desc:"OECD/IMF central case", icon:"◆" },
  bull:    { label:"Upside", desc:"Strong economy + LCC entry", icon:"▲", set:{ gdp:+0.8, tourism:2.5, lcc:1.5, fuel:-3 } },
  bear:    { label:"Downside", desc:"Stagnation + fuel spike", icon:"▼", set:{ gdp:-1.0, tourism:-1.5, fuel:18, lcc:0 } },
  shock:   { label:"Demand shock", desc:"Recession-style contraction", icon:"⊘", set:{ gdp:-2.0, tourism:-2.5, fuel:10, pop:-0.4, lcc:0 } },
};

function Scenario({ airport, history, scenario, setScenario }){
  const base = useMemoS(()=>GP_defaultScenario(airport.iata),[airport]);
  const d = useMemoS(()=>{
    const lt = GP_longTerm(airport.iata, history, scenario);
    const baseLt = GP_longTerm(airport.iata, history, base);
    const labels = lt.rows.map(r=>"'"+String(r.y).slice(2));
    return { lt, baseLt, labels };
  },[airport, history, scenario, base]);

  const setLever = (k,v)=> setScenario({ ...scenario, [k]: v });
  const applyPreset = (id)=>{
    if (id==="base") return setScenario({ ...base });
    const p = PRESETS[id];
    const next = { ...base };
    Object.keys(p.set).forEach(k=> next[k] = (base[k]??0) + p.set[k]);
    setScenario(next);
  };

  const end = d.lt.rows[d.lt.rows.length-1], baseEnd = d.baseLt.rows[d.baseLt.rows.length-1];
  const diffPax = end.pax - baseEnd.pax;
  const activePreset = (()=>{
    const eq=(o)=>Object.keys(o).every(k=>Math.abs((scenario[k]??0)-(o[k]??0))<0.001);
    if (eq(base)) return "base";
    for (const id of Object.keys(PRESETS)){ if(id==="base") continue; const t={...base}; Object.keys(PRESETS[id].set).forEach(k=>t[k]=(base[k]??0)+PRESETS[id].set[k]); if(eq(t)) return id; }
    return null;
  })();

  return (
    <div className="content fade-in">
      <div className="grid" style={{gridTemplateColumns:"1fr 1.5fr", alignItems:"start"}}>
        {/* left: levers */}
        <div className="panel panel-pad" style={{position:"sticky",top:18}}>
          <SectionHead kicker="Assumptions" title="Scenario levers"/>
          <div style={{display:"flex",gap:7,flexWrap:"wrap",marginBottom:8}}>
            {Object.keys(PRESETS).map(id=>(
              <button key={id} className={"btn btn-sm"+(activePreset===id?" btn-primary":"")} style={{flex:"1 1 auto",justifyContent:"center",flexDirection:"column",gap:2,padding:"9px 8px"}} onClick={()=>applyPreset(id)}>
                <span style={{fontSize:13,fontWeight:700}}>{PRESETS[id].icon} {PRESETS[id].label}</span>
                <span style={{fontSize:10,opacity:.7,fontWeight:400}}>{PRESETS[id].desc}</span>
              </button>
            ))}
          </div>
          <div style={{marginTop:6}}>
            {LEVERS.map(l=>{
              const v = scenario[l.k] ?? 0, bv = base[l.k] ?? 0;
              const changed = Math.abs(v-bv)>0.001;
              return (
                <div className="lever" key={l.k}>
                  <div className="lever-head">
                    <div className="lever-name">{l.name} {changed && <span className="dot dot-pink"></span>}</div>
                    <div className="lever-val">{v>0&&l.k!=="elasticity"?"+":""}{l.k==="elasticity"?v.toFixed(2):v.toFixed(l.step<1?1:0)}{l.unit}</div>
                  </div>
                  <input type="range" min={l.min} max={l.max} step={l.step} value={v} onChange={e=>setLever(l.k, +e.target.value)}/>
                  <div className="lever-desc">{l.desc} {changed && <span style={{color:"var(--faint)"}}>· base {l.k==="elasticity"?bv.toFixed(2):bv.toFixed(1)}{l.unit}</span>}</div>
                </div>
              );
            })}
          </div>
          <button className="btn" style={{width:"100%",justifyContent:"center",marginTop:14}} onClick={()=>setScenario({...base})}>Reset to baseline</button>
        </div>

        {/* right: live impact */}
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div className="grid g-3">
            <KPI accent label="2035 PAX · scenario" value={GP_fmt.k1(end.pax)}
              delta={(diffPax>=0?"+":"")+GP_fmt.k1(Math.abs(diffPax)).replace("M","M")+" vs base"} deltaDir={diffPax>=0?"up":"down"} sub="passengers"/>
            <KPI label="PAX CAGR" value={GP_fmt.pct(d.lt.cagr)} sub="2025→2035" sparkColor="var(--cyan)"/>
            <KPI label="Cumulative Δ" value={(diffPax>=0?"+":"–")+GP_fmt.k1(Math.abs(end.pax-baseEnd.pax))} sub="vs baseline · 2035" />
          </div>

          <div className="panel panel-pad">
            <SectionHead kicker="Live impact" title="Scenario vs baseline"
              right={<div className="chart-legend">
                <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)"}}></span>Scenario</span>
                <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--faint)",borderStyle:"dashed"}}></span>Baseline</span>
              </div>}/>
            <LineChart labels={d.labels} height={270} markerIndex={0}
              series={[
                { name:"Baseline", color:"var(--faint)", values:d.baseLt.rows.map(r=>r.pax), dash:"5 4", width:1.8 },
                { name:"Scenario", color:"var(--pink)", values:d.lt.rows.map(r=>r.pax), fill:true, glow:true, width:2.8 },
              ]}/>
          </div>

          <div className="panel panel-pad">
            <SectionHead kicker="Decomposition" title="Driver contribution to annual growth"/>
            <BarChart labels={d.lt.breakdown.map(b=>b.k.split(" ")[0])} height={170} yFmt={v=>v.toFixed(1)+"%"}
              series={[{ name:"Contribution", color:"var(--pink)", values:d.lt.breakdown.map(b=>Math.max(0,b.v)) }]}/>
            <div className="method" style={{marginTop:6}}>
              <b>Model —</b> <span className="formula">g = GDPpc·ε + pop + 0.5·tourism + lcc − 0.18·fuel</span>. Passengers compound at g;
              movements are held under the {airport.iata} slot/noise ceiling, with surplus demand met by larger aircraft and fuller cabins.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- EXPORT ------------------------------------------- */
function ExportView({ airport, history, scenario }){
  const d = useMemoS(()=>{
    const lt = GP_longTerm(airport.iata, history, scenario);
    const st = GP_shortTerm(history,"pax",12);
    return { lt, st };
  },[airport, history, scenario]);
  const [fmtSel, setFmt] = React.useState("pdf");
  const end = d.lt.rows[d.lt.rows.length-1];

  const downloadCSV = ()=>{
    let csv = "year,passengers,movements,seats,cargo_t,avg_gauge,load_factor_pct,constrained\n";
    d.lt.rows.forEach(r=> csv += `${r.y},${r.pax},${r.atm},${r.seats},${r.cargo},${r.gauge},${r.lf},${r.constrained?1:0}\n`);
    const blob = new Blob([csv],{type:"text/csv"});
    const url = URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=`glidepath_${airport.iata}_forecast.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const deliverables = [
    { id:"pdf", name:"Board-ready PDF brief", desc:"8-page narrative: history, tactical & strategic forecasts, scenarios, methodology appendix.", tag:"PDF" },
    { id:"xlsx", name:"Model workbook", desc:"Every series, assumption and formula — fully auditable and editable.", tag:"XLSX" },
    { id:"csv", name:"Forecast data extract", desc:"Flat annual + monthly tables for your BI stack or master-plan model.", tag:"CSV" },
    { id:"deck", name:"Stakeholder deck", desc:"12-slide presentation for airline negotiations & funding cases.", tag:"PPTX" },
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
            <button className="btn btn-primary btn-lg" style={{flex:1,justifyContent:"center"}} onClick={fmtSel==="csv"?downloadCSV:()=>alert("Prototype: "+fmtSel.toUpperCase()+" generation would run here.\nThe CSV extract is fully wired — try that one.")}>
              Generate {deliverables.find(x=>x.id===fmtSel).tag} {GP_Ico.arrow}
            </button>
            <button className="btn btn-lg" onClick={downloadCSV}>Quick CSV</button>
          </div>
        </div>

        <div className="panel panel-pad">
          <div className="eyebrow" style={{marginBottom:12}}>Forecast summary · {airport.iata}</div>
          <div style={{display:"flex",flexDirection:"column",gap:0}}>
            {[
              ["Gateway",airport.name],
              ["Base year PAX",GP_fmt.int(d.lt.rows[0].pax)],
              ["2035 PAX",GP_fmt.int(end.pax)],
              ["10-yr CAGR",GP_fmt.pct(d.lt.cagr)],
              ["Next-12mo confidence","±"+d.st.mape+"%"],
              ["2035 movements",GP_fmt.int(end.atm)],
              ["Demand growth",GP_fmt.pct(d.lt.gDemand)],
            ].map((r,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",gap:14,padding:"10px 0",borderBottom:i<6?"1px solid var(--line)":"none"}}>
                <span style={{color:"var(--faint)",fontSize:13}}>{r[0]}</span>
                <span className="num" style={{fontSize:13,color:"var(--text)",fontWeight:600,textAlign:"right"}}>{r[1]}</span>
              </div>
            ))}
          </div>
          <div className="method" style={{marginTop:16}}>
            <b>Provenance —</b> OpenFlights reference · OECD Economic Outlook (GDP projections) · World Bank (population) · Eurostat/StatCan (monthly passengers, wired nightly). Every figure traces to a public source; the workbook ships the full audit trail.
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { LongTerm, Scenario, ExportView });

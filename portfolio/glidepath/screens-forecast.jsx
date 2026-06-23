/* ============================================================
   screens-forecast.jsx — Overview + Short-term tactical (ML)
   ============================================================ */
const { useMemo:useMemoF } = React;

function KPI({ label, value, sub, delta, deltaDir, spark, sparkColor, accent }){
  return (
    <div className={"kpi"+(accent?" kpi-accent":"")}>
      <div className="kpi-label eyebrow">{label}</div>
      <div className="kpi-value">{value}</div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:12}}>
        <div className="kpi-sub" style={{margin:0}}>
          {delta!=null && <span className={"delta "+(deltaDir==="up"?"delta-up":deltaDir==="down"?"delta-down":"")}>{delta}</span>}
          <span>{sub}</span>
        </div>
        {spark && <Sparkline values={spark} color={sparkColor||"var(--pink)"} width={84} height={28}/>}
      </div>
    </div>
  );
}

function SectionHead({ kicker, title, right }){
  return (
    <div style={{display:"flex",alignItems:"flex-end",justifyContent:"space-between",marginBottom:16,gap:16,flexWrap:"wrap"}}>
      <div>
        {kicker && <div className="eyebrow" style={{marginBottom:7}}>{kicker}</div>}
        <h2 style={{fontSize:21}}>{title}</h2>
      </div>
      {right}
    </div>
  );
}

/* ---------- OVERVIEW ----------------------------------------- */
function Overview({ airport, history, scenario, go }){
  const a = ANCHOR[airport.iata];
  const d = useMemoF(()=>{
    const annPax = GP_annualize(history,"pax");
    const annAtm = GP_annualize(history,"atm");
    const annCargo = GP_annualize(history,"cargo");
    const last = annPax[annPax.length-1].v, prev = annPax[annPax.length-2].v;
    const lt = GP_longTerm(airport.iata, history, scenario);
    const st = GP_shortTerm(history,"pax",12);
    const routes = GP_routeMix(airport.iata);
    return { annPax, annAtm, annCargo, last, prev, lt, st, routes };
  },[airport, history, scenario]);

  const yrLabels = d.annPax.map(r=>"'"+String(r.y).slice(2));
  const macro = MACRO[airport.cc];

  return (
    <div className="content fade-in">
      <div className="grid g-4" style={{marginBottom:16}}>
        <KPI accent label="PAX · 2025" value={GP_fmt.k1(d.last)}
          delta={GP_fmt.pct((d.last/d.prev-1)*100)} deltaDir={d.last>=d.prev?"up":"down"} sub="vs 2024"
          spark={d.annPax.slice(-6).map(r=>r.v)} sparkColor="var(--pink)"/>
        <KPI label="2035 PAX · forecast" value={GP_fmt.k1(d.lt.rows[d.lt.rows.length-1].pax)}
          delta={GP_fmt.pct(d.lt.cagr)+" CAGR"} deltaDir="up" sub="elasticity model"
          spark={d.lt.rows.map(r=>r.pax)} sparkColor="var(--cyan)"/>
        <KPI label="Movements · 2025" value={GP_fmt.k(d.annAtm[d.annAtm.length-1].v)}
          sub={a.noiseCapped?"noise-capped gateway":"slot headroom"} spark={d.annAtm.slice(-6).map(r=>r.v)} sparkColor="var(--lime)"/>
        <KPI label="Next-12mo confidence" value={"±"+d.st.mape.toFixed(1)+"%"}
          sub="backtested MAPE" spark={d.st.forecast.slice(0,12).map(r=>r.v)} sparkColor="var(--violet)"/>
      </div>

      <div className="grid" style={{gridTemplateColumns:"1.55fr 1fr", marginBottom:16}}>
        <div className="panel panel-pad">
          <SectionHead kicker="Reconstructed history · 2015–2025" title="Annual passenger throughput"
            right={<div className="chart-legend">
              <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)"}}></span>Passengers</span>
              <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--cyan)"}}></span>Seats</span>
            </div>}/>
          <LineChart labels={yrLabels} height={250}
            series={[
              { name:"Passengers", color:"var(--pink)", values:d.annPax.map(r=>r.v), fill:true, glow:true, width:2.6 },
              { name:"Seats", color:"var(--cyan)", values:GP_annualize(history,"seats").map(r=>r.v), width:1.8, dash:"4 4" },
            ]}/>
          <div className="method" style={{marginTop:14}}>
            <b>How this was built —</b> StatCan/Eurostat monthly aero filings, back-cast to {2015} and reconciled against
            OpenFlights capacity. The 2020–21 trough is the COVID demand shock; recovery indexed to {macro.label} GDP.
          </div>
        </div>

        <div className="panel panel-pad">
          <SectionHead kicker="Destination mix" title="Top routes by share"/>
          <div style={{display:"flex",alignItems:"center",gap:22,marginBottom:6}}>
            <div style={{position:"relative"}}>
              <Donut size={132} thickness={18} items={d.routes.map((r,i)=>({ value:r.share, color:["var(--pink)","var(--cyan)","var(--lime)","var(--violet)","var(--amber)","var(--mute)"][i] }))}/>
              <div style={{position:"absolute",inset:0,display:"grid",placeItems:"center",textAlign:"center"}}>
                <div><div className="num" style={{fontSize:20,fontWeight:700}}>{a.carriers}</div><div className="air-meta">carriers</div></div>
              </div>
            </div>
            <div style={{flex:1}}>
              {d.routes.slice(0,5).map((r,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:9,padding:"5px 0",fontSize:12.5}}>
                  <span className="legend-swatch" style={{background:["var(--pink)","var(--cyan)","var(--lime)","var(--violet)","var(--amber)"][i]}}></span>
                  <span style={{flex:1,color:"var(--dim)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.name}</span>
                  <span className="num" style={{color:"var(--text)"}}>{r.share}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="grid g-3" style={{marginBottom:16}}>
        <div className="panel panel-pad" style={{cursor:"pointer"}} onClick={()=>go("short")}>
          <div className="eyebrow" style={{marginBottom:10}}>Tactical · ML</div>
          <div style={{fontSize:17,fontWeight:600,marginBottom:6}}>Short-term forecast</div>
          <p style={{fontSize:13,color:"var(--dim)",marginBottom:14}}>24-month, seasonally-decomposed demand for capacity & roster planning.</p>
          <div className="stat-strip" style={{border:"none",gap:14}}>
            <div style={{padding:0,border:"none"}}><div className="air-meta">MAPE</div><div className="num" style={{fontSize:17}}>±{d.st.mape}%</div></div>
            <div style={{padding:0,border:"none"}}><div className="air-meta">Next peak</div><div className="num" style={{fontSize:17}}>{GP_fmt.k(Math.max(...d.st.forecast.slice(0,12).map(r=>r.v)))}</div></div>
          </div>
          <div className="btn btn-ghost btn-sm" style={{marginTop:12,paddingLeft:0,color:"var(--pink-2)"}}>Open tactical view {GP_Ico.arrow}</div>
        </div>
        <div className="panel panel-pad" style={{cursor:"pointer"}} onClick={()=>go("long")}>
          <div className="eyebrow" style={{marginBottom:10}}>Strategic · Elasticity</div>
          <div style={{fontSize:17,fontWeight:600,marginBottom:6}}>10-year forecast</div>
          <p style={{fontSize:13,color:"var(--dim)",marginBottom:14}}>Macro-driven trajectory to 2035 for master-planning & business cases.</p>
          <div className="stat-strip" style={{border:"none",gap:14}}>
            <div style={{padding:0,border:"none"}}><div className="air-meta">PAX CAGR</div><div className="num" style={{fontSize:17,color:"var(--cyan)"}}>{GP_fmt.pct(d.lt.cagr)}</div></div>
            <div style={{padding:0,border:"none"}}><div className="air-meta">2035 PAX</div><div className="num" style={{fontSize:17}}>{GP_fmt.k1(d.lt.rows[d.lt.rows.length-1].pax)}</div></div>
          </div>
          <div className="btn btn-ghost btn-sm" style={{marginTop:12,paddingLeft:0,color:"var(--pink-2)"}}>Open strategic view {GP_Ico.arrow}</div>
        </div>
        <div className="panel panel-pad" style={{cursor:"pointer"}} onClick={()=>go("scenario")}>
          <div className="eyebrow" style={{marginBottom:10}}>What-if · Levers</div>
          <div style={{fontSize:17,fontWeight:600,marginBottom:6}}>Scenario builder</div>
          <p style={{fontSize:13,color:"var(--dim)",marginBottom:14}}>Flex GDP, propensity to fly, fuel & route stimulation; watch 2035 move live.</p>
          <div className="stat-strip" style={{border:"none",gap:14}}>
            <div style={{padding:0,border:"none"}}><div className="air-meta">Demand g</div><div className="num" style={{fontSize:17,color:"var(--lime)"}}>{GP_fmt.pct(d.lt.gDemand)}</div></div>
            <div style={{padding:0,border:"none"}}><div className="air-meta">Levers</div><div className="num" style={{fontSize:17}}>6</div></div>
          </div>
          <div className="btn btn-ghost btn-sm" style={{marginTop:12,paddingLeft:0,color:"var(--pink-2)"}}>Open scenarios {GP_Ico.arrow}</div>
        </div>
      </div>
    </div>
  );
}

/* ---------- SHORT-TERM TACTICAL (ML) ------------------------- */
function ShortTerm({ airport, history }){
  const [metric, setMetric] = React.useState("pax");
  const [horizon, setHorizon] = React.useState(24);
  const metrics = [{k:"pax",label:"Passengers"},{k:"atm",label:"Movements"},{k:"cargo",label:"Cargo"},{k:"seats",label:"Seats"}];
  const d = useMemoF(()=>{
    const st = GP_shortTerm(history, metric, horizon);
    const tail = history.slice(-18);
    const histLabels = tail.map(r=>r.label);
    const fcLabels = st.forecast.map(r=>r.label);
    const labels = [...histLabels, ...fcLabels];
    const nHist = tail.length, nAll = labels.length;
    const actual = [...tail.map(r=>r[metric]), ...st.forecast.map(()=>null)];
    const fitted = [...tail.map(()=>null), ...st.forecast.map(r=>r.v)];
    // connect last actual to first forecast
    fitted[nHist-1] = tail[tail.length-1][metric];
    const lo = Array(nAll).fill(null), hi = Array(nAll).fill(null);
    st.forecast.forEach((r,i)=>{ lo[nHist+i]=r.lo; hi[nHist+i]=r.hi; });
    lo[nHist-1]=tail[tail.length-1][metric]; hi[nHist-1]=tail[tail.length-1][metric];
    return { st, labels, actual, fitted, lo, hi, nHist, tail };
  },[airport, history, metric, horizon]);

  const unit = metric==="cargo" ? (v=>GP_fmt.k(v)+"t") : (v=>GP_fmt.k(v));
  const next12 = d.st.forecast.slice(0,12);
  const next12sum = next12.reduce((s,r)=>s+r.v,0);
  const ly = d.tail.slice(-12).reduce((s,r)=>s+r[metric],0);

  return (
    <div className="content fade-in">
      <div className="grid g-4" style={{marginBottom:16}}>
        <KPI accent label="Model MAPE" value={"±"+d.st.mape+"%"} sub="12-mo holdout backtest" deltaDir="up" delta={d.st.mape<7?"strong fit":"usable"}/>
        <KPI label="Next 12 months" value={unit(next12sum)} delta={GP_fmt.pct((next12sum/ly-1)*100)} deltaDir={next12sum>=ly?"up":"down"} sub="vs trailing year"/>
        <KPI label="Forecast peak" value={unit(Math.max(...next12.map(r=>r.v)))} sub={next12.reduce((a,b)=>a.v>b.v?a:b).label}/>
        <KPI label="Seasonal swing" value={(Math.max(...d.st.seasIdx)/Math.min(...d.st.seasIdx)).toFixed(2)+"×"} sub="peak ÷ trough month"/>
      </div>

      <div className="panel panel-pad" style={{marginBottom:16}}>
        <SectionHead kicker="Tactical forecast · ML decomposition" title="Monthly demand, actuals → forecast"
          right={
            <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
              <div className="seg seg-sub">
                {[12,24].map(h=> <button key={h} className={horizon===h?"on":""} onClick={()=>setHorizon(h)}>{h}mo</button>)}
              </div>
              <div className="seg">
                {metrics.map(m=> <button key={m.k} className={metric===m.k?"on":""} onClick={()=>setMetric(m.k)}>{m.label}</button>)}
              </div>
            </div>
          }/>
        <LineChart labels={d.labels} height={300} markerIndex={d.nHist-1}
          yFmt={metric==="cargo"?(v=>GP_fmt.k(v)):undefined}
          band={{lo:d.lo, hi:d.hi, color:"var(--pink)"}}
          series={[
            { name:"Actual", color:"var(--text)", values:d.actual, width:2.4 },
            { name:"Forecast", color:"var(--pink)", values:d.fitted, dash:"6 4", width:2.6, glow:true },
          ]}/>
        <div style={{display:"flex",gap:18,marginTop:12,flexWrap:"wrap",alignItems:"center"}}>
          <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--text)"}}></span>Actual (StatCan/Eurostat)</span>
          <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)",borderStyle:"dashed"}}></span>ML forecast</span>
          <span className="legend-item"><span className="legend-swatch" style={{background:"var(--pink)",opacity:.3}}></span>90% prediction interval</span>
        </div>
      </div>

      <div className="grid" style={{gridTemplateColumns:"1fr 1.4fr"}}>
        <div className="panel panel-pad">
          <SectionHead kicker="Under the hood" title="Model card"/>
          <div style={{display:"flex",flexDirection:"column",gap:0}}>
            {[
              ["Method","Seasonal-trend decomposition + Holt damped trend"],
              ["Seasonality","Multiplicative, 12-month, last 3 clean years"],
              ["Backtest","12-month rolling holdout"],
              ["Accuracy","MAPE ±"+d.st.mape+"%"],
              ["Interval","90% · widens with horizon (√t)"],
              ["Refresh","On every new monthly filing"],
            ].map((r,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",gap:16,padding:"10px 0",borderBottom:i<5?"1px solid var(--line)":"none"}}>
                <span style={{color:"var(--faint)",fontSize:13}}>{r[0]}</span>
                <span style={{fontSize:13,textAlign:"right",fontFamily:i>=2&&i<=4?"var(--mono)":"var(--sans)",color:i>=2&&i<=4?"var(--pink-2)":"var(--dim)"}}>{r[1]}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel panel-pad">
          <SectionHead kicker="Next 12 months" title="Monthly forecast detail"/>
          <div style={{maxHeight:268,overflowY:"auto"}}>
            <table className="tbl">
              <thead><tr><th>Month</th><th>Forecast</th><th>Low</th><th>High</th><th>YoY</th></tr></thead>
              <tbody>
                {next12.map((r,i)=>{
                  const lyv = d.tail.find(t=>t.m===r.m)?.[metric] || ly/12;
                  const yoy = (r.v/lyv-1)*100;
                  return <tr key={i}>
                    <td>{r.label}</td>
                    <td style={{color:"var(--text)",fontWeight:700}}>{GP_fmt.int(r.v)}</td>
                    <td style={{color:"var(--faint)"}}>{GP_fmt.int(r.lo)}</td>
                    <td style={{color:"var(--faint)"}}>{GP_fmt.int(r.hi)}</td>
                    <td style={{color:yoy>=0?"var(--ok)":"var(--bad)"}}>{GP_fmt.pct(yoy)}</td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Overview, ShortTerm, KPI:KPI, SectionHead });

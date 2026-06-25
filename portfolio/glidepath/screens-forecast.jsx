/* ============================================================
   screens-forecast.jsx — Overview + Short-term tactical (Prophet)
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
  const macro = MACRO[airport.cc];
  const d = useMemoF(()=>{
    const paxY = GP_fullYears(history,"pax");
    const atmY = GP_fullYears(history,"atm");
    const cargoY = GP_fullYears(history,"cargo");
    const lt = GP_longTerm(airport.iata, history, scenario);
    const st = GP_forecastFor(airport.iata,"pax");
    const last = paxY.length?paxY[paxY.length-1].v:0, prev = paxY.length>1?paxY[paxY.length-2].v:last;
    return { paxY, atmY, cargoY, lt, st, last, prev,
      hasAtm:atmY.length>0, hasCargo:cargoY.length>0 };
  },[airport, history, scenario]);

  const yrLabels = d.paxY.map(r=>"'"+String(r.y).slice(2));
  const baseYear = d.lt ? d.lt.baseYear : (d.paxY.length?d.paxY[d.paxY.length-1].y:"");
  const endYear = d.lt ? d.lt.endYear : "";

  // align movements to the passenger years so chart indices line up even when
  // the two series cover slightly different complete-year spans
  const atmByYear = Object.fromEntries(d.atmY.map(r=>[r.y, r.v]));
  const atmVals = d.paxY.map(r=> atmByYear[r.y] ?? null);
  const latestAtm = d.atmY.length ? d.atmY[d.atmY.length-1] : null;
  const latestCargo = d.cargoY.length ? d.cargoY[d.cargoY.length-1] : null;

  return (
    <div className="content fade-in">
      <div className="grid g-4" style={{marginBottom:16}}>
        <KPI accent label={"PAX · "+baseYear} value={GP_fmt.k1(d.last)}
          delta={d.prev?GP_fmt.pct((d.last/d.prev-1)*100):null} deltaDir={d.last>=d.prev?"up":"down"} sub={"vs "+(baseYear-1)}
          spark={d.paxY.slice(-6).map(r=>r.v)} sparkColor="var(--pink)"/>
        {d.lt && <KPI label={endYear+" PAX · forecast"} value={GP_fmt.k1(d.lt.rows[d.lt.rows.length-1].pax)}
          delta={GP_fmt.pct(d.lt.cagr)+" CAGR"} deltaDir="up" sub="elasticity model"
          spark={d.lt.rows.map(r=>r.pax)} sparkColor="var(--cyan)"/>}
        {d.hasAtm
          ? <KPI label={"Movements · "+baseYear} value={GP_fmt.k(d.atmY[d.atmY.length-1].v)}
              sub="observed flights" spark={d.atmY.slice(-6).map(r=>r.v)} sparkColor="var(--lime)"/>
          : d.hasCargo
          ? <KPI label={"Cargo · "+baseYear} value={GP_fmt.k(d.cargoY[d.cargoY.length-1].v)+"t"}
              sub="observed freight" spark={d.cargoY.slice(-6).map(r=>r.v)} sparkColor="var(--lime)"/>
          : <KPI label="History" value={d.paxY.length+" yrs"} sub="observed monthly"/>}
        {d.st && <KPI label="Next-12mo confidence" value={"±"+d.st.mape+"%"}
          sub="Prophet backtest MAPE" spark={d.st.forecast.slice(0,12).map(r=>r.v)} sparkColor="var(--violet)"/>}
      </div>

      <div className="grid" style={{gridTemplateColumns:"1.55fr 1fr", marginBottom:16}}>
        <div className="panel panel-pad">
          <SectionHead kicker={"Observed history · "+(d.paxY.length?d.paxY[0].y:"")+"–"+baseYear} title="Annual throughput"
            right={<div className="chart-legend">
              <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)"}}></span>Passengers</span>
              {d.hasAtm && <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--lime)"}}></span>Movements <span style={{color:"var(--faint)"}}>(right axis)</span></span>}
            </div>}/>
          <LineChart labels={yrLabels} height={250} yFmtRight={v=>GP_fmt.k(v)}
            series={[
              { name:"Passengers", color:"var(--pink)", values:d.paxY.map(r=>r.v), fill:true, glow:true, width:2.6 },
              ...(d.hasAtm?[{ name:"Movements", color:"var(--lime)", values:atmVals, width:2, dash:"4 4", axis:"right" }]:[]),
            ]}/>
          {(d.hasAtm || d.hasCargo) && (
            <div className="stat-strip" style={{marginTop:14}}>
              <div><div className="air-meta">Passengers · {baseYear}</div><div className="num" style={{color:"var(--pink-2)"}}>{GP_fmt.k1(d.last)}</div></div>
              {latestAtm && <div><div className="air-meta">Movements · {latestAtm.y}</div><div className="num" style={{color:"var(--lime)"}}>{GP_fmt.k(latestAtm.v)}</div></div>}
              {latestCargo && <div><div className="air-meta">Cargo · {latestCargo.y}</div><div className="num" style={{color:"var(--cyan)"}}>{GP_fmt.t(latestCargo.v)}</div></div>}
            </div>
          )}
          <div className="method" style={{marginTop:14}}>
            <b>Source —</b> real monthly filings ({(GP_activityFor(airport.iata).source||"public").split(":")[0]}),
            reconciled to complete calendar years{(d.hasAtm||d.hasCargo)?` — passengers${d.hasAtm?", aircraft movements":""}${d.hasCargo?" and cargo tonnage":""} tracked side by side`:""}.
            Indexed to {macro.label} macro drivers for the strategic outlook.
          </div>
        </div>

        <div className="panel panel-pad">
          <SectionHead kicker="Demand seasonality" title="Share of an average month"/>
          {d.st
            ? <>
                <BarChart labels={MONTHS} height={210} yFmt={v=>v.toFixed(2)+"×"}
                  tipFmt={v=>(v>=1?"+":"")+Math.round((v-1)*100)+"% vs avg month"}
                  series={[{ name:"Demand", color:"var(--cyan)", values:d.st.seasIdx }]}/>
                <div className="method" style={{marginTop:10}}>
                  <b>Peak —</b> {MONTHS[d.st.seasIdx.indexOf(Math.max(...d.st.seasIdx))]} runs
                  {" "}{(Math.max(...d.st.seasIdx)/Math.min(...d.st.seasIdx)).toFixed(2)}× the quietest month.
                </div>
              </>
            : <div className="air-meta">No forecast yet for this gateway.</div>}
        </div>
      </div>

      <div className="grid g-3" style={{marginBottom:16}}>
        {d.st && <div className="panel panel-pad" style={{cursor:"pointer"}} onClick={()=>go("short")}>
          <div className="eyebrow" style={{marginBottom:10}}>Tactical · Prophet</div>
          <div style={{fontSize:17,fontWeight:600,marginBottom:6}}>Short-term forecast</div>
          <p style={{fontSize:13,color:"var(--dim)",marginBottom:14}}>24-month Meta Prophet demand with country holidays, for capacity & roster planning.</p>
          <div className="stat-strip" style={{border:"none",gap:14}}>
            <div style={{padding:0,border:"none"}}><div className="air-meta">MAPE</div><div className="num" style={{fontSize:17}}>±{d.st.mape}%</div></div>
            <div style={{padding:0,border:"none"}}><div className="air-meta">Next peak</div><div className="num" style={{fontSize:17}}>{GP_fmt.k(Math.max(...d.st.forecast.slice(0,12).map(r=>r.v)))}</div></div>
          </div>
          <div className="btn btn-sm" style={{marginTop:14,width:"100%",justifyContent:"center",color:"var(--pink-2)",borderColor:"var(--pink-line)"}}>Open tactical view {GP_Ico.arrow}</div>
        </div>}
        {d.lt && <div className="panel panel-pad" style={{cursor:"pointer"}} onClick={()=>go("long")}>
          <div className="eyebrow" style={{marginBottom:10}}>Strategic · Elasticity</div>
          <div style={{fontSize:17,fontWeight:600,marginBottom:6}}>{d.lt.endYear-d.lt.baseYear}-year forecast</div>
          <p style={{fontSize:13,color:"var(--dim)",marginBottom:14}}>Macro-driven trajectory to {endYear} for master-planning & business cases.</p>
          <div className="stat-strip" style={{border:"none",gap:14}}>
            <div style={{padding:0,border:"none"}}><div className="air-meta">PAX CAGR</div><div className="num" style={{fontSize:17,color:"var(--cyan)"}}>{GP_fmt.pct(d.lt.cagr)}</div></div>
            <div style={{padding:0,border:"none"}}><div className="air-meta">{endYear} PAX</div><div className="num" style={{fontSize:17}}>{GP_fmt.k1(d.lt.rows[d.lt.rows.length-1].pax)}</div></div>
          </div>
          <div className="btn btn-sm" style={{marginTop:14,width:"100%",justifyContent:"center",color:"var(--pink-2)",borderColor:"var(--pink-line)"}}>Open strategic view {GP_Ico.arrow}</div>
        </div>}
        {d.lt && <div className="panel panel-pad" style={{cursor:"pointer"}} onClick={()=>go("scenario")}>
          <div className="eyebrow" style={{marginBottom:10}}>What-if · Levers</div>
          <div style={{fontSize:17,fontWeight:600,marginBottom:6}}>Scenario builder</div>
          <p style={{fontSize:13,color:"var(--dim)",marginBottom:14}}>Flex GDP, propensity to fly, fuel & route stimulation; watch {endYear} move live.</p>
          <div className="stat-strip" style={{border:"none",gap:14}}>
            <div style={{padding:0,border:"none"}}><div className="air-meta">Demand g</div><div className="num" style={{fontSize:17,color:"var(--lime)"}}>{GP_fmt.pct(d.lt.gDemand)}</div></div>
            <div style={{padding:0,border:"none"}}><div className="air-meta">Levers</div><div className="num" style={{fontSize:17}}>6</div></div>
          </div>
          <div className="btn btn-sm" style={{marginTop:14,width:"100%",justifyContent:"center",color:"var(--pink-2)",borderColor:"var(--pink-line)"}}>Open scenarios {GP_Ico.arrow}</div>
        </div>}
      </div>
    </div>
  );
}

/* ---------- SHORT-TERM TACTICAL (Prophet) -------------------- */
function ShortTerm({ airport, history }){
  const avail = GP_availableMetrics(airport.iata).filter(k=>GP_hasForecast(airport.iata,k));
  const metrics = (avail.length?avail:["pax"]).map(k=>METRIC_META[k]);
  const [metric, setMetric] = React.useState(metrics[0]?metrics[0].key:"pax");
  const [horizon, setHorizon] = React.useState(24);
  const macro = MACRO[airport.cc];

  const d = useMemoF(()=>{
    const st = GP_forecastFor(airport.iata, metric);
    if (!st) return null;
    const fc = st.forecast.slice(0, horizon);
    const tail = history.filter(r=>r[metric]!=null).slice(-18);
    const labels = [...tail.map(r=>r.label), ...fc.map(r=>r.label)];
    const nHist = tail.length, nAll = labels.length;
    const actual = [...tail.map(r=>r[metric]), ...fc.map(()=>null)];
    const fitted = [...tail.map(()=>null), ...fc.map(r=>r.v)];
    if (nHist>0) fitted[nHist-1] = tail[tail.length-1][metric];
    const lo = Array(nAll).fill(null), hi = Array(nAll).fill(null);
    fc.forEach((r,i)=>{ lo[nHist+i]=r.lo; hi[nHist+i]=r.hi; });
    if (nHist>0){ lo[nHist-1]=tail[tail.length-1][metric]; hi[nHist-1]=tail[tail.length-1][metric]; }
    return { st, fc, labels, actual, fitted, lo, hi, nHist, tail };
  },[airport, history, metric, horizon]);

  if (!d) return <div className="content fade-in"><div className="panel panel-pad"><div className="air-meta">No forecast available for this gateway yet.</div></div></div>;

  const unit = metric==="cargo" ? (v=>GP_fmt.k(v)+"t") : (v=>GP_fmt.k(v));
  const next12 = d.fc.slice(0,12);
  const next12sum = next12.reduce((s,r)=>s+r.v,0);
  const ly = d.tail.slice(-12).reduce((s,r)=>s+r[metric],0);
  const seasSwing = (Math.max(...d.st.seasIdx)/Math.min(...d.st.seasIdx)).toFixed(2);

  return (
    <div className="content fade-in">
      <div className="grid g-4" style={{marginBottom:16}}>
        <KPI accent label="Model MAPE" value={d.st.mape!=null?("±"+d.st.mape+"%"):"—"} sub="12-mo holdout backtest" deltaDir="up" delta={d.st.mape!=null&&d.st.mape<7?"strong fit":"usable"}/>
        <KPI label="Next 12 months" value={unit(next12sum)} delta={ly?GP_fmt.pct((next12sum/ly-1)*100):null} deltaDir={next12sum>=ly?"up":"down"} sub="vs trailing year"/>
        <KPI label="Forecast peak" value={unit(Math.max(...next12.map(r=>r.v)))} sub={next12.reduce((a,b)=>a.v>b.v?a:b).label}/>
        <KPI label="Seasonal swing" value={seasSwing+"×"} sub="peak ÷ trough month"/>
      </div>

      <div className="panel panel-pad" style={{marginBottom:16}}>
        <SectionHead kicker="Tactical forecast · Meta Prophet" title="Monthly demand, actuals → forecast"
          right={
            <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
              <div className="seg seg-sub">
                {[12,24].map(h=> <button key={h} className={horizon===h?"on":""} onClick={()=>setHorizon(h)}>{h}mo</button>)}
              </div>
              {metrics.length>1 && <div className="seg">
                {metrics.map(m=> <button key={m.key} className={metric===m.key?"on":""} onClick={()=>setMetric(m.key)}>{m.label}</button>)}
              </div>}
            </div>
          }/>
        <LineChart labels={d.labels} height={300} markerIndex={d.nHist-1}
          yFmt={metric==="cargo"?(v=>GP_fmt.k(v)):undefined}
          band={{lo:d.lo, hi:d.hi, color:"var(--pink)"}}
          series={[
            { name:"Actual", color:"var(--text)", values:d.actual, width:2.4 },
            { name:"Prophet", color:"var(--pink)", values:d.fitted, dash:"6 4", width:2.6, glow:true },
          ]}/>
        <div style={{display:"flex",gap:18,marginTop:12,flexWrap:"wrap",alignItems:"center"}}>
          <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--text)"}}></span>Actual ({(GP_activityFor(airport.iata).source||"public").split(":")[0]})</span>
          <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)",borderStyle:"dashed"}}></span>Prophet forecast</span>
          <span className="legend-item"><span className="legend-swatch" style={{background:"var(--pink)",opacity:.3}}></span>{Math.round((GP_FORECAST_META?.interval||0.8)*100)}% interval (P10–P90)</span>
        </div>
      </div>

      <div className="grid" style={{gridTemplateColumns:"1fr 1.4fr"}}>
        <div className="panel panel-pad">
          <SectionHead kicker="Under the hood" title="Model card"/>
          <div style={{display:"flex",flexDirection:"column",gap:0}}>
            {[
              ["Method","Meta Prophet · trend + yearly + holidays"],
              ["Seasonality","Multiplicative yearly (Fourier)"],
              ["Holidays",d.st.holidaysTotal+" public · "+macro.label],
              ["Shocks","COVID 2020–21 modeled as events"],
              ["Backtest","12-month holdout"],
              ["Accuracy",d.st.mape!=null?("MAPE ±"+d.st.mape+"%"):"—"],
              ["Refresh","Nightly · server-side"],
            ].map((r,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",gap:16,padding:"10px 0",borderBottom:i<6?"1px solid var(--line)":"none"}}>
                <span style={{color:"var(--faint)",fontSize:13}}>{r[0]}</span>
                <span style={{fontSize:13,textAlign:"right",fontFamily:i>=4&&i<=5?"var(--mono)":"var(--sans)",color:i>=4&&i<=5?"var(--pink-2)":"var(--dim)"}}>{r[1]}</span>
              </div>
            ))}
          </div>
          <div className="method" style={{marginTop:14}}>
            <b>COVID handling —</b> the 2020–21 collapse is fit as explicit monthly events, so it doesn't distort seasonality or widen the forecast band. No data is dropped — every observed month still trains the model and shows on the chart.
          </div>
          {d.st.holidays.length>0 && <div className="method" style={{marginTop:14}}>
            <b>Top holiday effects —</b> {d.st.holidays.slice(0,4).join(" · ")}.
          </div>}
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

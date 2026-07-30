/* ============================================================
   screens-forecast.jsx — Overview + Short-term tactical (auto-selected model)
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

/* Low-confidence data disclaimer. Statistics Canada gives us CATSA
   screened-passenger counts as a stand-in for enplaned passengers — a proxy
   that under-counts true throughput and reads low even as an enplanement
   estimate — so we flag it wherever those numbers are shown. */
function DataCaveat({ airport, style }){
  if (airport.custom) {
    return (
      <div className="caveat fade-in" style={{marginBottom:16, ...style}}>
        <b>Your data —</b> {airport.iata} runs on the monthly figures you uploaded, not a public feed. The long-term
        elasticity forecast, scenario levers, event simulator and export all work exactly the same as for a catalogue
        gateway. The short-term view uses a Holt-Winters (ETS) model fit right here in your browser — the nightly
        server-side model bake-off (seasonal naïve vs damped ETS vs Prophet) only runs for the committed public
        data sources, so there&rsquo;s no model toggle here; the model card says exactly what you&rsquo;re looking at.
      </div>
    );
  }
  const src = (GP_activityFor(airport.iata)||{}).source;
  if (src !== "statcan") return null;
  return (
    <div className="caveat fade-in" style={{marginBottom:16, ...style}}>
      <b>Data caveat —</b> {airport.iata}&rsquo;s passenger series is Statistics Canada <em>screened-passenger</em> counts
      (CATSA security screenings) used as a proxy for enplaned passengers. They under-count true throughput — missing
      connecting, US-precleared and unscreened travellers — and tend to read low even as an enplanement estimate. Treat
      these figures as a rough indicator of trend and seasonality, not exact passenger volumes.
    </div>
  );
}

/* ---------- OVERVIEW ----------------------------------------- */
function Overview({ airport, history, scenario, ltOpts, go }){
  const macro = MACRO[airport.cc];
  const d = useMemoF(()=>{
    const paxY = GP_fullYears(history,"pax");
    const atmY = GP_fullYears(history,"atm");
    const cargoY = GP_fullYears(history,"cargo");
    const lt = GP_longTerm(airport.iata, history, scenario, ltOpts);
    // whichever model the nightly picked for this series (or the visitor's
    // override), else in-browser ETS — custom uploads, or a real gateway the
    // nightly hasn't cleared its history minimum for
    const st = GP_tacticalForecast(airport.iata, "pax", history, ltOpts && ltOpts.model);
    // and if even ETS can't run (< 24 contiguous months), fall back to a
    // seasonal index read straight off the observed months rather than
    // hiding the seasonality panel.
    const obsSeas = st ? null : GP_observedSeasonality(history, "pax");
    const seasIdx = st ? st.seasIdx : obsSeas;
    const last = paxY.length?paxY[paxY.length-1].v:0, prev = paxY.length>1?paxY[paxY.length-2].v:last;
    return { paxY, atmY, cargoY, lt, st, seasIdx, last, prev,
      hasAtm:atmY.length>0, hasCargo:cargoY.length>0 };
  },[airport, history, scenario, ltOpts]);

  const yrLabels = d.paxY.map(r=>"'"+String(r.y).slice(2));
  // the last COMPLETE observed calendar year — what every observed-history KPI
  // and panel on this screen reports. Distinct from d.lt.baseYear, which is the
  // year the long-term model compounds off and may be the current year with its
  // remaining months filled in by the tactical model.
  const obsYear = d.paxY.length ? d.paxY[d.paxY.length-1].y : "";
  const endYear = d.lt ? d.lt.endYear : "";
  const modeled = d.lt && d.lt.baseForecastMonths.length;

  // align movements to the passenger years so chart indices line up even when
  // the two series cover slightly different complete-year spans
  const atmByYear = Object.fromEntries(d.atmY.map(r=>[r.y, r.v]));
  const atmVals = d.paxY.map(r=> atmByYear[r.y] ?? null);
  const latestAtm = d.atmY.length ? d.atmY[d.atmY.length-1] : null;
  const latestCargo = d.cargoY.length ? d.cargoY[d.cargoY.length-1] : null;

  return (
    <div className="content fade-in">
      <DataCaveat airport={airport}/>
      <div className="grid g-4" style={{marginBottom:16}}>
        <KPI accent label={"PAX · "+obsYear} value={GP_fmt.k1(d.last)}
          delta={d.prev?GP_fmt.pct((d.last/d.prev-1)*100):null} deltaDir={d.last>=d.prev?"up":"down"} sub={"vs "+(obsYear-1)}
          spark={d.paxY.slice(-6).map(r=>r.v)} sparkColor="var(--pink)"/>
        {d.lt && <KPI label={endYear+" PAX · forecast"} value={GP_fmt.k1(d.lt.rows[d.lt.rows.length-1].pax)}
          delta={GP_fmt.pct(d.lt.cagr)+" CAGR"} deltaDir="up" sub="elasticity model"
          spark={d.lt.rows.map(r=>r.pax)} sparkColor="var(--cyan)"/>}
        {d.hasAtm
          ? <KPI label={"Movements · "+d.atmY[d.atmY.length-1].y} value={GP_fmt.k(d.atmY[d.atmY.length-1].v)}
              sub="observed flights" spark={d.atmY.slice(-6).map(r=>r.v)} sparkColor="var(--lime)"/>
          : d.hasCargo
          ? <KPI label={"Cargo · "+d.cargoY[d.cargoY.length-1].y} value={GP_fmt.k(d.cargoY[d.cargoY.length-1].v)+"t"}
              sub="observed freight" spark={d.cargoY.slice(-6).map(r=>r.v)} sparkColor="var(--lime)"/>
          : <KPI label="History" value={d.paxY.length+" yrs"} sub="observed monthly"/>}
        {d.st && d.st.mape!=null && <KPI label="Next-12mo confidence" value={"±"+d.st.mape+"%"}
          sub={(GP_MODEL_META[d.st.method]||{}).short+" backtest MAPE"+(d.st.mase!=null?` · MASE ${d.st.mase.toFixed(2)}`:"")}
          spark={d.st.forecast.slice(0,12).map(r=>r.v)} sparkColor="var(--violet)"/>}
      </div>

      <div className="grid" style={{gridTemplateColumns:"1.55fr 1fr", marginBottom:16}}>
        <div className="panel panel-pad">
          <SectionHead kicker={"Observed history · "+(d.paxY.length?d.paxY[0].y:"")+"–"+obsYear} title="Annual throughput"
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
              <div><div className="air-meta">Passengers · {obsYear}</div><div className="num" style={{color:"var(--pink-2)"}}>{GP_fmt.k1(d.last)}</div></div>
              {latestAtm && <div><div className="air-meta">Movements · {latestAtm.y}</div><div className="num" style={{color:"var(--lime)"}}>{GP_fmt.k(latestAtm.v)}</div></div>}
              {latestCargo && <div><div className="air-meta">Cargo · {latestCargo.y}</div><div className="num" style={{color:"var(--cyan)"}}>{GP_fmt.t(latestCargo.v)}</div></div>}
            </div>
          )}
          <div className="method" style={{marginTop:14}}>
            <b>Source —</b> {airport.custom ? "the monthly figures you uploaded" : `real monthly filings (${GP_sourceLabel(GP_activityFor(airport.iata).source)})`},
            reconciled to complete calendar years{(d.hasAtm||d.hasCargo)?` — passengers${d.hasAtm?", aircraft movements":""}${d.hasCargo?" and cargo tonnage":""} tracked side by side`:""}.
            Indexed to {macro.label} macro drivers for the strategic outlook.
          </div>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div className="panel panel-pad">
            <SectionHead kicker="Demand seasonality" title="Share of an average month"/>
            {d.seasIdx
              ? <>
                  <BarChart labels={MONTHS} height={210} yFmt={v=>v.toFixed(2)+"×"}
                    tipFmt={v=>(v>=1?"+":"")+Math.round((v-1)*100)+"% vs avg month"}
                    series={[{ name:"Demand", color:"var(--cyan)", values:d.seasIdx }]}/>
                  <div className="method" style={{marginTop:10}}>
                    {Math.min(...d.seasIdx) > 0
                      ? <><b>Peak —</b> {MONTHS[d.seasIdx.indexOf(Math.max(...d.seasIdx))]} runs
                          {" "}{(Math.max(...d.seasIdx)/Math.min(...d.seasIdx)).toFixed(2)}× the quietest month</>
                      : <><b>Peak —</b> {MONTHS[d.seasIdx.indexOf(Math.max(...d.seasIdx))]}; at least one month
                          averages effectively zero, so a peak-to-quietest ratio isn't meaningful</>}
                    {!d.st && " — read straight off your observed months, not a fitted model"}.
                  </div>
                </>
              : <div className="air-meta">Needs a full calendar year of data to show seasonality.</div>}
          </div>

          {d.lt && d.lt.hasSeg && (()=>{
            const seg = d.lt.rows[0].seg;
            const tot = d.lt.segKeys.reduce((t,k)=>t+seg[k],0) || 1;
            return (
              <div className="panel panel-pad">
                <SectionHead kicker={"Passenger mix · "+d.lt.baseYear} title="Sector distribution"/>
                <div style={{display:"flex",gap:18,alignItems:"center",flexWrap:"wrap"}}>
                  <Donut size={140} thickness={24}
                    items={d.lt.segKeys.map((k,i)=>({ label:d.lt.segLabels[i], value:seg[k], color:d.lt.segColors[i] }))}/>
                  <div style={{flex:"1 1 150px",minWidth:140}}>
                    {d.lt.segKeys.map((k,i)=>(
                      <div key={k} className="legend-item" style={{justifyContent:"space-between",marginBottom:10}}>
                        <span><span className="legend-swatch" style={{background:d.lt.segColors[i]}}></span>{d.lt.segLabels[i]}</span>
                        <span className="num" style={{color:"var(--text)"}}>{Math.round(seg[k]/tot*100)}% · {GP_fmt.k1(seg[k])}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      <div className="grid g-3" style={{marginBottom:16}}>
        {d.st && <div className="panel panel-pad" style={{cursor:"pointer"}} onClick={()=>go("short")}>
          <div className="eyebrow" style={{marginBottom:10}}>Tactical · {(GP_MODEL_META[d.st.method]||{}).short}</div>
          <div style={{fontSize:17,fontWeight:600,marginBottom:6}}>Short-term forecast</div>
          <p style={{fontSize:13,color:"var(--dim)",marginBottom:14}}>{d.st.source==="browser"
            ? "24-month Holt-Winters (ETS) demand forecast, fit in your browser on the observed months."
            : `24-month demand forecast for capacity & roster planning — ${(GP_MODEL_META[d.st.method]||{}).label} won this series' backtest.`}</p>
          <div className="stat-strip" style={{border:"none",gap:14}}>
            <div style={{padding:0,border:"none"}}><div className="air-meta">MASE</div><div className="num" style={{fontSize:17}}>{d.st.mase!=null?d.st.mase.toFixed(2):"—"}</div></div>
            <div style={{padding:0,border:"none"}}><div className="air-meta">Next peak</div><div className="num" style={{fontSize:17}}>{GP_fmt.k(Math.max(...d.st.forecast.slice(0,12).map(r=>r.v)))}</div></div>
          </div>
          <div className="btn btn-sm" style={{marginTop:14,width:"100%",justifyContent:"center",color:"var(--pink-2)",borderColor:"var(--pink-line)"}}>Open tactical view {GP_Ico.arrow}</div>
        </div>}
        {d.lt && <div className="panel panel-pad" style={{cursor:"pointer"}} onClick={()=>go("long")}>
          <div className="eyebrow" style={{marginBottom:10}}>Strategic · Elasticity</div>
          <div style={{fontSize:17,fontWeight:600,marginBottom:6}}>{d.lt.endYear-d.lt.baseYear}-year forecast</div>
          <p style={{fontSize:13,color:"var(--dim)",marginBottom:14}}>Macro-driven trajectory to {endYear} for master-planning & business cases
            {modeled
              ? <>, compounding off a {d.lt.baseYear} base year completed by the tactical model.</>
              : <>, compounding off the observed {d.lt.baseYear}.</>}</p>
          <div className="stat-strip" style={{border:"none",gap:14}}>
            <div style={{padding:0,border:"none"}}><div className="air-meta">PAX CAGR</div><div className="num" style={{fontSize:17,color:"var(--cyan)"}}>{GP_fmt.pct(d.lt.cagr)}</div></div>
            <div style={{padding:0,border:"none"}}><div className="air-meta">{endYear} PAX</div><div className="num" style={{fontSize:17}}>{GP_fmt.k1(d.lt.rows[d.lt.rows.length-1].pax)}</div></div>
          </div>
          <div className="btn btn-sm" style={{marginTop:14,width:"100%",justifyContent:"center",color:"var(--pink-2)",borderColor:"var(--pink-line)"}}>Open strategic view {GP_Ico.arrow}</div>
        </div>}
        {d.lt && <div className="panel panel-pad" style={{cursor:"pointer"}} onClick={()=>go("scenario")}>
          <div className="eyebrow" style={{marginBottom:10}}>What-if · Levers</div>
          <div style={{fontSize:17,fontWeight:600,marginBottom:6}}>Baseline assumptions</div>
          <p style={{fontSize:13,color:"var(--dim)",marginBottom:14}}>Flex GDP, fuel, route stimulation, cargo, fleet{d.lt.hasSeg?" & passenger mix":""} — watch {endYear} move live. Add shocks in the event simulator.</p>
          <div className="stat-strip" style={{border:"none",gap:14}}>
            <div style={{padding:0,border:"none"}}><div className="air-meta">Demand g</div><div className="num" style={{fontSize:17,color:"var(--lime)"}}>{GP_fmt.pct(d.lt.gDemand)}</div></div>
            <div style={{padding:0,border:"none"}}><div className="air-meta">Levers</div><div className="num" style={{fontSize:17}}>{6+(d.lt.hasAtm?1:0)+(d.lt.hasCargo?1:0)+(d.lt.hasSeg?d.lt.segKeys.length:0)}</div></div>
          </div>
          <div className="btn btn-sm" style={{marginTop:14,width:"100%",justifyContent:"center",color:"var(--pink-2)",borderColor:"var(--pink-line)"}}>Open assumptions {GP_Ico.arrow}</div>
        </div>}
      </div>
    </div>
  );
}

/* ---------- SHORT-TERM TACTICAL (auto-selected model) --------- */
function ShortTerm({ airport, history, stModel, setStModel }){
  // a metric is offered when a tactical model can actually run on it —
  // the nightly output where it exists, in-browser ETS otherwise
  const avail = useMemoF(()=> GP_availableMetrics(airport.iata)
    .filter(k => GP_hasForecast(airport.iata,k) || GP_tacticalForecast(airport.iata,k,history)),
    [airport, history]);
  const metrics = (avail.length?avail:["pax"]).map(k=>METRIC_META[k]);
  const [metric, setMetric] = React.useState(metrics[0]?metrics[0].key:"pax");
  const [horizon, setHorizon] = React.useState(24);
  const macro = MACRO[airport.cc];
  // every candidate the nightly scored for THIS metric, in simplest-first
  // order, with the scores each earned on identical folds
  const models = useMemoF(()=> GP_forecastModels(airport.iata, metric), [airport, metric]);

  const d = useMemoF(()=>{
    const st = GP_tacticalForecast(airport.iata, metric, history, stModel);
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
  },[airport, history, metric, horizon, stModel]);

  if (!d) return <div className="content fade-in"><div className="panel panel-pad"><div className="air-meta">No forecast available for this gateway yet — the tactical models need at least 24 contiguous months of history.</div></div></div>;

  const meta = GP_MODEL_META[d.st.method] || GP_MODEL_META.prophet;
  const inBrowser = d.st.source === "browser";
  const modelName = meta.label;
  // an override is only "overridden" if it actually differs from the auto-pick
  // set = the visitor has forced a model. That is NOT the same as `method !==
  // chosen`: a metric that doesn't carry the forced candidate silently falls
  // back to its own auto-pick, and the revert control has to stay reachable
  // anyway, since the override is still in force for the other metrics.
  const overridden = !inBrowser && !!stModel;
  const overrideApplied = overridden && d.st.method === stModel;
  const unit = metric==="cargo" ? (v=>GP_fmt.k(v)+"t") : (v=>GP_fmt.k(v));
  const next12 = d.fc.slice(0,12);
  const next12sum = next12.reduce((s,r)=>s+r.v,0);
  const ly = d.tail.slice(-12).reduce((s,r)=>s+r[metric],0);
  const seasMin = Math.min(...d.st.seasIdx);
  const seasSwing = seasMin > 0 ? (Math.max(...d.st.seasIdx)/seasMin).toFixed(2) : null;
  const nFolds = (d.st.mapeFolds||[]).length;

  return (
    <div className="content fade-in">
      <DataCaveat airport={airport}/>
      <div className="grid g-4" style={{marginBottom:16}}>
        {/* MASE leads, not MAPE: it's the number model selection actually runs
            on, and it stays meaningful on series MAPE can't score — a gateway
            whose traffic collapsed, or a cargo feed at single-digit tonnes. */}
        {d.st.mase!=null
          ? <KPI accent label="Model MASE" value={d.st.mase.toFixed(2)}
              sub={"1.00 = seasonal-naïve; lower is better"+(nFolds>1?` · mean of ${nFolds} folds`:"")}
              deltaDir={d.st.mase<1 ? "up" : "down"}
              delta={d.st.mase<1?"beats seasonal-naïve":"loses to seasonal-naïve"}/>
          : <KPI accent label="Model MAPE" value={d.st.mape!=null?("±"+d.st.mape+"%"):"—"}
              sub="MASE undefined — no year-on-year variation to scale by"
              deltaDir="up" delta={nFolds>1?`mean of ${nFolds} folds`:"12-mo holdout"}/>}
        <KPI label="Next 12 months" value={unit(next12sum)} delta={ly?GP_fmt.pct((next12sum/ly-1)*100):null} deltaDir={next12sum>=ly?"up":"down"} sub="vs trailing year"/>
        <KPI label="Forecast peak" value={unit(Math.max(...next12.map(r=>r.v)))} sub={next12.reduce((a,b)=>a.v>b.v?a:b).label}/>
        <KPI label="Seasonal swing" value={seasSwing?seasSwing+"×":"—"} sub="peak ÷ trough month"/>
      </div>

      {/* ---- model picker ----
          The nightly scores all three candidates on identical folds and
          publishes the winner; this is where that decision becomes visible and
          reversible. Selecting a model also re-anchors the long-term forecast's
          base year (see GP_longTerm's baseMode), which is why it lives in app
          state rather than here. */}
      {models.length>1 && (
        <div className="panel panel-pad" style={{marginBottom:16}}>
          <SectionHead kicker="Model selection" title={"Scored on the same held-out months"}
            right={overridden
              ? <button className="btn btn-sm" onClick={()=>setStModel(null)}>Back to auto-pick</button>
              : <span className="air-meta">auto-picked nightly by MASE</span>}/>
          <div className="seg" style={{flexWrap:"wrap"}}>
            {models.map(m=>(
              <button key={m.key} className={d.st.method===m.key?"on":""}
                title={m.blurb} onClick={()=>setStModel(m.key===d.st.chosen ? null : m.key)}>
                {m.label}{m.chosen?" ★":""}
                <span style={{marginLeft:7,fontFamily:"var(--mono)",fontSize:11,opacity:.72}}>
                  {m.mase!=null?m.mase.toFixed(2):(m.mape!=null?"±"+m.mape+"%":"—")}
                </span>
              </button>
            ))}
          </div>
          <div className="method" style={{marginTop:12}}>
            <b>★ is the nightly's pick —</b> the candidate with the lowest backtest MASE, with a 5% margin
            required to unseat a simpler model (ties go to the simpler one, and the seasonal naive is the
            incumbent rather than a footnote). The numbers on the buttons are MASE — or MAPE, where this
            series has no year-on-year variation for MASE to scale by. Every candidate was trained on the
            same months and scored on the same holdouts, so they're directly comparable.
            {overrideApplied && <> You&rsquo;re currently overriding it with <b>{meta.label}</b> — the whole page,
            including the long-term base year, follows this choice.</>}
            {overridden && !overrideApplied && <> You&rsquo;ve forced <b>{(GP_MODEL_META[stModel]||{}).label}</b>, but
            this metric doesn&rsquo;t carry that candidate, so it&rsquo;s showing its own pick
            (<b>{meta.label}</b>). The override still applies to the metrics that do.</>}
          </div>
        </div>
      )}

      <div className="panel panel-pad" style={{marginBottom:16}}>
        <SectionHead kicker={"Tactical forecast · "+modelName} title="Monthly demand, actuals → forecast"
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
            { name:modelName, color:"var(--pink)", values:d.fitted, dash:"6 4", width:2.6, glow:true },
          ]}/>
        <div style={{display:"flex",gap:18,marginTop:12,flexWrap:"wrap",alignItems:"center"}}>
          <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--text)"}}></span>Actual ({GP_sourceLabel(GP_activityFor(airport.iata).source)})</span>
          <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)",borderStyle:"dashed"}}></span>{modelName} forecast</span>
          {/* the band is the model's own, rescaled to the coverage it actually
              achieved on held-out months — see the model card */}
          <span className="legend-item"><span className="legend-swatch" style={{background:"var(--pink)",opacity:.3}}></span>
            {Math.round((GP_FORECAST_META?.interval||0.8)*100)}% interval{d.st.bandScale!=null?" (backtest-calibrated)":" (uncalibrated)"}</span>
        </div>
      </div>

      {/* forecast accountability: the most recent 12 months the model never
          saw, refit without them, next to what actually happened — the
          quickest way to judge whether the confidence band means anything */}
      {d.st.backtest && d.st.backtest.length>0 && (()=>{
        const bt = d.st.backtest;
        const btLabels = bt.map(r=>{ const p=r.date.split("-"); return MONTHS[+p[1]-1]+" "+p[0].slice(2); });
        const inBand = bt.filter(r=>r.lo<=r.actual&&r.actual<=r.hi).length;
        return (
          <div className="panel panel-pad" style={{marginBottom:16}}>
            <SectionHead kicker="Held-out backtest" title="What the model predicted vs what happened"
              right={<span className="air-meta">{inBand}/{bt.length} months inside the 80% band</span>}/>
            <LineChart labels={btLabels} height={220}
              yFmt={metric==="cargo"?(v=>GP_fmt.k(v)):undefined}
              band={{lo:bt.map(r=>r.lo), hi:bt.map(r=>r.hi), color:"var(--violet)"}}
              series={[
                { name:"Predicted", color:"var(--violet)", values:bt.map(r=>r.v), dash:"6 4", width:2.2 },
                { name:"Actual", color:"var(--text)", values:bt.map(r=>r.actual), width:2.4 },
              ]}/>
            <div className="method" style={{marginTop:10}}>
              <b>How to read this —</b> the model was refit with these {bt.length} months hidden, then asked to predict
              them. Solid is what really happened; dashed is the blind prediction with its 80% band. Every accuracy
              figure on this page comes from holdouts like this one — never from data the model trained on.
            </div>
          </div>
        );
      })()}

      <div className="grid" style={{gridTemplateColumns:"1fr 1.4fr"}}>
        <div className="panel panel-pad">
          <SectionHead kicker="Under the hood" title="Model card"/>
          <div style={{display:"flex",flexDirection:"column",gap:0}}>
            {[
              ["Model", meta.label + (overrideApplied ? " · your override" : (!inBrowser && d.st.chosen===d.st.method) ? " · auto-picked" : "")],
              ...(d.st.method==="snaive" ? [
                ["Method","Seasonal naive · last observed same month"],
                ["Seasonality","Carried, not fitted"],
                ["Band","Seasonal random walk · σ√cycles"],
              ] : d.st.method==="ets" ? [
                ["Method","Holt-Winters · damped trend + seasonality"],
                ["Seasonality","Multiplicative monthly indices"],
                ...(inBrowser?[["Fit","In this browser, on the observed months"]]:[["Damping","φ grid-searched with the smoothing constants"]]),
              ] : [
                ["Method","Meta Prophet · trend + yearly + holidays"],
                ["Seasonality","Multiplicative yearly (Fourier)"],
                ["Holidays",d.st.holidaysTotal+" public · "+macro.label],
                ...(d.st.gdpRegressor?[["GDP/capita", d.st.gdpForecast
                  ? "World Bank actuals + real IMF WEO forecast"
                  : "World Bank actuals + trailing-rate extrapolation"]]:[]),
                ["Shocks","COVID 2020–21 modeled as events"],
              ]),
              ["Backtest", nFolds>1 ? `rolling-origin · ${nFolds} × 12-mo holdouts` : "12-month holdout"],
              ["Accuracy", d.st.mase!=null
                ? ("MASE "+d.st.mase.toFixed(3)+(nFolds>1?` (folds ${d.st.maseFolds.join(" / ")})`:""))
                : (d.st.mae!=null ? "MAE "+GP_fmt.int(d.st.mae)+" · MASE undefined" : "—")],
              ["MAPE", d.st.mape!=null?("±"+d.st.mape+"%"+(nFolds>1?` (folds ${d.st.mapeFolds.join(" / ")})`:"")):"—"],
              ...(d.st.naiveMase!=null?[["vs seasonal-naïve", "MASE "+d.st.naiveMase.toFixed(3)
                +(d.st.naiveMape!=null?` · ±${d.st.naiveMape}%`:"")]]:[]),
              ...(d.st.coverage!=null?[["Raw band coverage", d.st.coverage+"% of held-out months"]]:[]),
              ...(d.st.bandScale!=null?[["Band calibration", "\u00d7"+d.st.bandScale.toFixed(2)
                +(d.st.coverageCal!=null?` \u2192 ${d.st.coverageCal}%`:"")]]:[]),
              ["Refresh", inBrowser ? "Live · in this browser" : "Nightly · server-side"],
            ].map((r,i,arr)=>{
              const mono = r[0]==="Backtest"||r[0]==="Accuracy"||r[0]==="MAPE";
              return (
                <div key={i} style={{display:"flex",justifyContent:"space-between",gap:16,padding:"10px 0",borderBottom:i<arr.length-1?"1px solid var(--line)":"none"}}>
                  <span style={{color:"var(--faint)",fontSize:13}}>{r[0]}</span>
                  <span style={{fontSize:13,textAlign:"right",fontFamily:mono?"var(--mono)":"var(--sans)",color:mono?"var(--pink-2)":"var(--dim)"}}>{r[1]}</span>
                </div>
              );
            })}
          </div>
          <div className="method" style={{marginTop:14}}>
            <b>Why MASE —</b> mean absolute error over the held-out months divided by the in-sample
            seasonal-naïve error, so 1.00 means &ldquo;no better than repeating last year&rsquo;s month&rdquo;.
            Unlike MAPE it never divides by the actual, which is what makes it usable on a series that
            approaches zero — a gateway that lost its traffic, or cargo measured in single-digit tonnes,
            where MAPE runs into the thousands of percent and says nothing. Model selection uses MASE alone;
            MAPE is shown because planners recognise it, but it decides nothing.
          </div>
          {d.st.bandScale!=null && <div className="method" style={{marginTop:14}}>
            <b>Band calibration —</b> this model&rsquo;s own band covered {d.st.coverage}% of held-out months
            against a nominal 80%, so the plotted interval is scaled by <b>&times;{d.st.bandScale.toFixed(2)}</b> —
            {d.st.bandScale < 1 ? " tightened, because the raw band was wider than the errors it needed to cover"
              : " widened, because the raw band was narrower than the errors it needed to cover"}. The factor is
            the 80th percentile of each held-out month&rsquo;s error measured in units of its own band.
            {d.st.coverageCal!=null && <> On those months the scaled band covers {d.st.coverageCal}% — but the
            factor was fitted on exactly those months, so treat that as in-sample, not a fresh measurement.</>}
            {" "}The held-out chart above shows the <em>raw</em> band, which is what the model actually claimed at
            the time.
          </div>}
          {(d.st.coverageCal ?? d.st.coverage) != null && (d.st.coverageCal ?? d.st.coverage) < 65 && <div className="method" style={{marginTop:14}}>
            <b>Read the band with caution —</b> even after calibration only {d.st.coverageCal ?? d.st.coverage}% of
            held-out months fall inside the interval. The calibration is clamped, so a model whose errors are this
            far outside its own band can&rsquo;t be stretched into honesty — read the point forecast, not the range.
          </div>}
          {d.st.method==="snaive" && <div className="method" style={{marginTop:14}}>
            <b>What the seasonal naïve is —</b> every month simply repeats the most recent observed value for
            that calendar month. No trend, no holidays, no macro. It is here as a competitor rather than a
            benchmark because across this catalogue it wins more often than not — and a fitted model that
            can&rsquo;t beat it isn&rsquo;t earning its complexity.
          </div>}
          {d.st.method==="ets" && <div className="method" style={{marginTop:14}}>
            <b>What ETS is —</b> exponential smoothing with an additive <em>damped</em> trend and
            multiplicative monthly seasonality, constants grid-searched on one-step error. Damping is what it
            brings: where an undamped trend compounds whatever slope the last months happened to show,
            φ&nbsp;&lt;&nbsp;1 flattens it out. The 80% band grows from the in-sample residuals — an
            approximation, not a posterior.
            {inBrowser && " No holidays, no macro regressor: it's the honest small model for data that lives only in this browser."}
          </div>}
          {d.st.method==="prophet" && <div className="method" style={{marginTop:14}}>
            <b>COVID handling —</b> the 2020–21 collapse is fit as explicit monthly events, so it doesn't distort seasonality or widen the forecast band. No data is dropped — every observed month still trains the model and shows on the chart.
          </div>}
          {d.st.method==="prophet" && d.st.holidays.length>0 && <div className="method" style={{marginTop:14}}>
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
                  // the ACTUAL year-ago month, by date — `find` on calendar
                  // month alone matched the older of the two occurrences in an
                  // 18-month tail, so forecast months 7–12 were being compared
                  // against 24 months back instead of 12
                  const lyKey = `${r.y-1}-${String(r.m+1).padStart(2,"0")}`;
                  const lyv = d.tail.find(t=>t.date===lyKey)?.[metric] || ly/12;
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

Object.assign(window, { Overview, ShortTerm, KPI:KPI, SectionHead, DataCaveat });

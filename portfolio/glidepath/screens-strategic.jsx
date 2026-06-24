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
    return { labels, histVals, fcVals, nHist };
  },[lt, history, m]);

  if (!lt || !d) return <div className="content fade-in"><div className="panel panel-pad"><div className="air-meta">Not enough complete years of data for a strategic forecast yet.</div></div></div>;

  const end = lt.rows[lt.rows.length-1];
  const start = lt.rows[0];
  const cargoFmt = m==="cargo";

  return (
    <div className="content fade-in">
      <div className="grid g-4" style={{marginBottom:16}}>
        <KPI accent label={lt.endYear+" passengers"} value={GP_fmt.k1(end.pax)} delta={GP_fmt.pct(lt.cagr)+" CAGR"} deltaDir="up" sub={"from "+GP_fmt.k1(start.pax)+" in "+lt.baseYear}/>
        <KPI label="Demand growth" value={GP_fmt.pct(lt.gDemand)} sub="annual, blended drivers" sparkColor="var(--cyan)"/>
        {lt.hasAtm
          ? <KPI label={lt.endYear+" movements"} value={GP_fmt.k(end.atm)} sub="held proportional to PAX" sparkColor="var(--lime)"/>
          : lt.hasCargo
          ? <KPI label={lt.endYear+" cargo"} value={GP_fmt.k(end.cargo)+"t"} sub="freight trajectory" sparkColor="var(--lime)"/>
          : <KPI label="Horizon" value={(lt.endYear-lt.baseYear)+" yrs"} sub={"to "+lt.endYear}/>}
        <KPI label={lt.baseYear+" passengers"} value={GP_fmt.k1(start.pax)} sub="observed base year"/>
      </div>

      <div className="grid" style={{gridTemplateColumns:"1.55fr 1fr", marginBottom:16}}>
        <div className="panel panel-pad">
          <SectionHead kicker="Strategic forecast · elasticity model" title={"Monthly trajectory to "+lt.endYear}
            right={metricDefs.length>1 && <div className="seg">{metricDefs.map(x=><button key={x.k} className={m===x.k?"on":""} onClick={()=>setMetric(x.k)}>{x.label}</button>)}</div>}/>
          <LineChart labels={d.labels} height={285} markerIndex={d.nHist-1}
            yFmt={cargoFmt?(v=>GP_fmt.k(v)):undefined}
            series={[
              { name:"Actual", color:"var(--text)", values:d.histVals, width:2.4 },
              { name:"Forecast", color:"var(--pink)", values:d.fcVals, fill:true, glow:true, width:2.8 },
            ]}/>
          <div style={{display:"flex",gap:18,marginTop:12,flexWrap:"wrap"}}>
            <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--text)"}}></span>Actual (observed)</span>
            <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)"}}></span>Elasticity forecast</span>
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
    const labels = lt ? lt.months.map(r=>r.label) : [];
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

  if (!d.lt || !d.baseLt) return <div className="content fade-in"><div className="panel panel-pad"><div className="air-meta">Not enough complete years of data to build scenarios yet.</div></div></div>;
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
        <div className="panel panel-pad lever-panel" style={{position:"sticky",top:18}}>
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
            <KPI accent label={d.lt.endYear+" PAX · scenario"} value={GP_fmt.k1(end.pax)}
              delta={(diffPax>=0?"+":"")+GP_fmt.k1(Math.abs(diffPax))+" vs base"} deltaDir={diffPax>=0?"up":"down"} sub="passengers"/>
            <KPI label="PAX CAGR" value={GP_fmt.pct(d.lt.cagr)} sub={d.lt.baseYear+"→"+d.lt.endYear} sparkColor="var(--cyan)"/>
            <KPI label="Cumulative Δ" value={(diffPax>=0?"+":"–")+GP_fmt.k1(Math.abs(end.pax-baseEnd.pax))} sub={"vs baseline · "+d.lt.endYear} />
          </div>

          <div className="panel panel-pad">
            <SectionHead kicker="Live impact" title="Scenario vs baseline"
              right={<div className="chart-legend">
                <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--pink)"}}></span>Scenario</span>
                <span className="legend-item"><span className="legend-line" style={{borderColor:"var(--faint)",borderStyle:"dashed"}}></span>Baseline</span>
              </div>}/>
            <LineChart labels={d.labels} height={270} markerIndex={0}
              series={[
                { name:"Baseline", color:"var(--faint)", values:d.baseLt.months.map(r=>r.pax), dash:"5 4", width:1.8 },
                { name:"Scenario", color:"var(--pink)", values:d.lt.months.map(r=>r.pax), fill:true, glow:true, width:2.8 },
              ]}/>
          </div>

          <div className="panel panel-pad">
            <SectionHead kicker="Decomposition" title="Driver contribution to annual growth"/>
            <BarChart labels={d.lt.breakdown.map(b=>b.k.split(" ")[0])} height={170} yFmt={v=>v.toFixed(1)+"%"}
              series={[{ name:"Contribution", color:"var(--pink)", values:d.lt.breakdown.map(b=>Math.max(0,b.v)) }]}/>
            <div className="method" style={{marginTop:6}}>
              <b>Model —</b> <span className="formula">g = GDPpc·ε + pop + 0.5·tourism + lcc − 0.18·fuel</span>. Passengers
              compound at g on the observed base-year seasonal shape; movements (where published) are held proportional to passengers.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- EXPORT ------------------------------------------- */
/* Lazily inject a CDN script only when a format needs it, so the app
   stays light until the user actually generates a workbook/deck.      */
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
    const st = GP_forecastFor(airport.iata, "pax");
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

  /* the scenario assumptions, paired with their lever metadata */
  const assumptions = LEVERS.map(l=>({ name:l.name, value:(scenario[l.k] ?? 0), unit:l.unit }));
  const stamp = new Date().toLocaleDateString("en-CA");
  const fileBase = `glidepath_${airport.iata}_${new Date().toISOString().slice(0,10)}`;

  /* ---- CSV: flat annual + monthly, dependency-free ---- */
  const genCSV = ()=>{
    let csv = "GLIDEPATH FORECAST — "+airport.name+" ("+airport.iata+")\n";
    csv += "generated,"+stamp+"\n\n";
    const cols = ["passengers", ...(hasAtm?["movements"]:[]), ...(hasCargo?["cargo_t"]:[])];
    const rowVals = r => [r.pax, ...(hasAtm?[r.atm]:[]), ...(hasCargo?[r.cargo]:[])].join(",");
    csv += "ANNUAL LONG-TERM FORECAST (roll-up)\n";
    csv += "year,"+cols.join(",")+"\n";
    d.lt.rows.forEach(r=> csv += `${r.y},${rowVals(r)}\n`);
    csv += "\nMONTHLY LONG-TERM FORECAST\n";
    csv += "month,"+cols.join(",")+"\n";
    d.lt.months.forEach(r=> csv += `${r.date},${rowVals(r)}\n`);
    if (d.st){
      csv += "\nMONTHLY SHORT-TERM FORECAST (passengers · Prophet)\n";
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

    const ltHead = ["Year","Passengers", ...(hasAtm?["Movements"]:[]), ...(hasCargo?["Cargo (t)"]:[])];
    const ltRow = (r,key) => [r[key], r.pax, ...(hasAtm?[r.atm]:[]), ...(hasCargo?[r.cargo]:[])];
    const ltAoa = [ltHead];
    d.lt.rows.forEach(r=> ltAoa.push(ltRow(r,"y")));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ltAoa), "Long-term annual");

    const ltmHead = ["Month","Passengers", ...(hasAtm?["Movements"]:[]), ...(hasCargo?["Cargo (t)"]:[])];
    const ltmAoa = [ltmHead];
    d.lt.months.forEach(r=> ltmAoa.push(ltRow(r,"date")));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ltmAoa), "Long-term monthly");

    if (d.st){
      const stAoa = [["Month","Forecast PAX","Low (P10)","High (P90)"]];
      d.st.forecast.forEach(r=> stAoa.push([r.date, r.v, r.lo, r.hi]));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(stAoa), "Short-term monthly");
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

  /* ---- PPTX: real editable deck via PptxGenJS ---- */
  const genPPTX = async ()=>{
    await GP_loadScript("https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js");
    const Ctor = window.PptxGenJS;
    const pptx = new Ctor();
    pptx.layout = "LAYOUT_WIDE";        // 13.33 × 7.5 in
    const PINK="FF3EA5", DARK="0E1015", PANEL="14171F", INK="F3F4F7", DIM="9AA0AD", CYAN="38E1FF";
    const W = 13.33;

    // 1 — title
    let s = pptx.addSlide(); s.background = { color: DARK };
    s.addText("G L I D E P A T H", { x:0.6, y:2.0, w:8, fontSize:13, color:PINK, bold:true });
    s.addText(airport.name, { x:0.6, y:2.5, w:11, fontSize:40, bold:true, color:INK });
    s.addText("Aero demand forecast · "+airport.iata+" / "+airport.icao+" · "+airport.city+", "+airport.country,
      { x:0.6, y:3.7, w:11, fontSize:18, color:DIM });
    s.addText("Generated "+stamp+"  ·  Sources: OpenFlights · OECD · World Bank · Eurostat/StatCan",
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

    await pptx.writeFile({ fileName: fileBase+"_deck.pptx" });
  };

  /* ---- DOCX: a Word-openable executive brief (HTML/.doc) ---- */
  const genDOC = ()=>{
    const rows = d.lt.rows.map(r=>
      `<tr><td>${r.y}</td><td>${GP_fmt.int(r.pax)}</td>${hasAtm?`<td>${GP_fmt.int(r.atm)}</td>`:""}${hasCargo?`<td>${GP_fmt.int(r.cargo)}</td>`:""}</tr>`
    ).join("");
    const asRows = assumptions.map(a=>`<tr><td>${a.name}</td><td>${(a.value>0?"+":"")+a.value} ${a.unit}</td></tr>`).join("");
    const html = `<!DOCTYPE html><html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset='utf-8'><title>Glidepath ${airport.iata} brief</title>
<style>
  body{font-family:Calibri,Arial,sans-serif;color:#1a1a1a;font-size:11pt;line-height:1.5;}
  h1{font-size:22pt;color:#c4196f;margin:0 0 2pt;} h2{font-size:14pt;color:#c4196f;border-bottom:1px solid #ddd;padding-bottom:3pt;margin-top:18pt;}
  .sub{color:#666;font-size:10pt;margin-bottom:14pt;}
  table{border-collapse:collapse;width:100%;font-size:10pt;margin-top:6pt;}
  th{background:#c4196f;color:#fff;text-align:right;padding:5pt 7pt;} th:first-child{text-align:left;}
  td{border-bottom:1px solid #e2e2e2;padding:4pt 7pt;text-align:right;} td:first-child{text-align:left;}
  .kpis td{font-size:11pt;border:none;text-align:left;} .kpis td:nth-child(2){font-weight:bold;color:#c4196f;text-align:right;}
</style></head><body>
<h1>${airport.name}</h1>
<div class='sub'>Aero demand forecast &middot; ${airport.iata} / ${airport.icao} &middot; ${airport.city}, ${airport.country} &middot; generated ${stamp}</div>

<h2>Executive summary</h2>
<p>This brief sets out the long-term passenger demand outlook for <b>${airport.name}</b> (${airport.iata}).
Under the current scenario, annual passengers grow from <b>${GP_fmt.int(base.pax)}</b> in ${base.y} to
<b>${GP_fmt.int(end.pax)}</b> by ${end.y} — a compound annual growth rate of <b>${GP_fmt.pct(d.lt.cagr)}</b>,
driven by blended income, population and tourism dynamics totalling <b>${GP_fmt.pct(d.lt.gDemand)}</b> annual demand growth.${d.st&&d.st.mape!=null?` The short-term Meta Prophet model carries a backtested confidence band of <b>&plusmn;${d.st.mape}%</b> over the next twelve months.`:""}</p>

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

<h2>Provenance</h2>
<p style='font-size:9.5pt;color:#444;'>OpenFlights reference &middot; OECD Economic Outlook (GDP projections) &middot; World Bank (population) &middot;
Eurostat / StatCan / US BTS (monthly passengers, movements, cargo) &middot; Meta Prophet short-term forecast. Every figure traces to a public source.</p>
</body></html>`;
    GP_saveBlob(new Blob(["﻿"+html], {type:"application/msword"}), fileBase+"_brief.doc");
  };

  const GEN = { csv:genCSV, xlsx:genXLSX, pptx:genPPTX, docx:genDOC };

  const run = async (id)=>{
    if (busy) return;
    setNote(null); setBusy(id);
    try {
      await GEN[id]();
      setNote({ ok:true, msg: deliverables.find(x=>x.id===id).tag+" generated — check your downloads." });
    } catch(e){
      setNote({ ok:false, msg: "Couldn't generate "+id.toUpperCase()+" ("+(e&&e.message||"error")+"). The CSV extract always works offline." });
    } finally { setBusy(null); }
  };

  const deliverables = [
    { id:"pptx", name:"Stakeholder deck", desc:"Editable PowerPoint: title, headline KPIs, 10-yr trajectory table and scenario assumptions.", tag:"PPTX" },
    { id:"xlsx", name:"Model workbook", desc:"Real Excel workbook — summary, long-term annual + monthly, short-term monthly, full history and assumptions.", tag:"XLSX" },
    { id:"docx", name:"Executive brief", desc:"Word-openable narrative: summary, KPIs, trajectory table, assumptions and provenance.", tag:"DOCX" },
    { id:"csv", name:"Forecast data extract", desc:"Flat annual + monthly tables for your BI stack or master-plan model.", tag:"CSV" },
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
                : <span style={{display:"inline-flex",alignItems:"center",gap:9}}>Generate {deliverables.find(x=>x.id===fmtSel).tag} {GP_Ico.arrow}</span>}
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
            ].map((r,i,arr)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",gap:14,padding:"10px 0",borderBottom:i<arr.length-1?"1px solid var(--line)":"none"}}>
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

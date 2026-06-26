/* ============================================================
   charts.jsx — hand-built SVG charts (dark/pink system)
   LineChart (multi-series + confidence band + hover crosshair),
   BarChart (grouped/stacked), Donut, Sparkline.
   ============================================================ */
const { useState, useRef, useMemo, useEffect } = React;

function niceMax(v){
  if (v<=0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v/mag;
  const step = f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10;
  return step*mag;
}

/* ---------- LineChart ---------------------------------------
   props:
   labels: string[]
   series: [{ name, color, values:number[], dash?, width?, axis? }]
           axis:"right" plots the series on an independent right-hand
           scale (e.g. movements vs passengers, very different magnitudes)
   band:   { lo:number[], hi:number[], color } (optional CI, left axis)
   markerIndex: index where forecast begins (draws a divider)
   height, yFmt (left axis), yFmtRight (right axis), valueFmt
*/
function LineChart({ labels, series, band, markerIndex, height=260, yFmt, yFmtRight, valueFmt, padL=52 }){
  const wrapRef = useRef(null);
  const [w, setW] = useState(720);
  const [hover, setHover] = useState(null);
  useEffect(()=>{
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(es => setW(es[0].contentRect.width));
    ro.observe(wrapRef.current);
    return ()=> ro.disconnect();
  },[]);
  const hasRight = series.some(s => s.axis==="right");
  const padR = hasRight ? 52 : 18, padT=14, padB=28;
  const H=height, innerW=Math.max(10,w-padL-padR), innerH=H-padT-padB;
  const n = labels.length;

  // build an independent {top,bot} scale from a flat list of values
  function scaleFor(vals){
    let maxV = 0, minV = Infinity;
    vals.forEach(v=>{ if(v!=null){ maxV=Math.max(maxV,v); minV=Math.min(minV,v);} });
    if (!isFinite(minV)){ minV=0; maxV=1; }
    minV = Math.min(minV, maxV*0.6);
    const top = niceMax(maxV*1.08);
    const bot = Math.max(0, Math.floor(minV/(top/5)) * (top/5));
    return { top, bot };
  }
  const leftVals = [];
  series.filter(s=>s.axis!=="right").forEach(s=> s.values.forEach(v=> leftVals.push(v)));
  if (band){ band.hi.forEach(v=>leftVals.push(v)); band.lo.forEach(v=>leftVals.push(v)); }
  const L = scaleFor(leftVals);
  const rightVals = [];
  series.filter(s=>s.axis==="right").forEach(s=> s.values.forEach(v=> rightVals.push(v)));
  const R = hasRight ? scaleFor(rightVals) : null;

  const x  = i => padL + (n<=1?0:(i/(n-1))*innerW);
  const yL = v => padT + innerH - ((v-L.bot)/(L.top-L.bot))*innerH;
  const yR = v => R ? padT + innerH - ((v-R.bot)/(R.top-R.bot))*innerH : yL(v);
  const yOf = s => (s && s.axis==="right") ? yR : yL;
  const ticks = 5;
  const gl = Array.from({length:ticks+1},(_,i)=> L.bot + (L.top-L.bot)*i/ticks);

  function path(vals, yf){
    let d="";
    vals.forEach((v,i)=>{ if(v==null) return; d += (d===""?"M":"L") + x(i).toFixed(1) + " " + yf(v).toFixed(1) + " "; });
    return d;
  }
  function area(lo,hi){
    let d="";
    hi.forEach((v,i)=>{ if(v==null) return; d += (d===""?"M":"L") + x(i).toFixed(1)+" "+yL(v).toFixed(1)+" "; });
    for (let i=lo.length-1;i>=0;i--){ if(lo[i]==null) continue; d += "L"+x(i).toFixed(1)+" "+yL(lo[i]).toFixed(1)+" "; }
    return d+"Z";
  }
  function onMove(e){
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let idx = Math.round(((px-padL)/innerW)*(n-1));
    idx = Math.max(0, Math.min(n-1, idx));
    setHover(idx);
  }
  const yf  = yFmt || (v=>GP_fmt.k(v));
  const yfR = yFmtRight || (v=>GP_fmt.k(v));
  const vf  = valueFmt || (v=>GP_fmt.int(v));
  const rcol = (series.find(s=>s.axis==="right")||{}).color || "var(--faint)";

  return (
    <div className="chart-wrap" ref={wrapRef} style={{position:"relative"}}>
      <svg width={w} height={H} onMouseMove={onMove} onMouseLeave={()=>setHover(null)} style={{display:"block"}}>
        <defs>
          {series.map((s,i)=> (
            <linearGradient key={i} id={`fill${i}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.18"/>
              <stop offset="100%" stopColor={s.color} stopOpacity="0"/>
            </linearGradient>
          ))}
        </defs>
        {gl.map((g,i)=> (
          <g key={i}>
            <line x1={padL} x2={w-padR} y1={yL(g)} y2={yL(g)} stroke="var(--line)" strokeWidth="1"/>
            <text x={padL-10} y={yL(g)+4} textAnchor="end" fontSize="11" fill="var(--faint)" fontFamily="var(--mono)">{yf(g)}</text>
            {hasRight && (
              <text x={w-padR+8} y={yL(g)+4} textAnchor="start" fontSize="11" fill={rcol} fontFamily="var(--mono)">
                {yfR(R.bot + (R.top-R.bot)*i/ticks)}
              </text>
            )}
          </g>
        ))}
        {/* forecast divider */}
        {markerIndex!=null && markerIndex<n && (
          <g>
            <line x1={x(markerIndex)} x2={x(markerIndex)} y1={padT} y2={padT+innerH} stroke="var(--pink-line)" strokeWidth="1" strokeDasharray="3 4"/>
            <text x={x(markerIndex)+6} y={padT+11} fontSize="10" fill="var(--pink-2)" fontFamily="var(--mono)" letterSpacing="0.1em">FORECAST →</text>
          </g>
        )}
        {/* confidence band (left axis) */}
        {band && <path d={area(band.lo,band.hi)} fill={band.color||"var(--pink)"} fillOpacity="0.13" stroke="none"/>}
        {/* fill under primary line */}
        {series.filter(s=>s.fill).map((s,i)=>{
          const idx = series.indexOf(s);
          const yf2 = yOf(s);
          const p = path(s.values, yf2);
          if(!p) return null;
          const lastI = s.values.map((v,j)=>v!=null?j:-1).filter(j=>j>=0);
          const x0 = x(lastI[0]), x1 = x(lastI[lastI.length-1]);
          const baseY = yf2(s.axis==="right" ? R.bot : L.bot);
          return <path key={i} d={`${p} L${x1} ${baseY} L${x0} ${baseY} Z`} fill={`url(#fill${idx})`} stroke="none"/>;
        })}
        {/* lines */}
        {series.map((s,i)=> (
          <path key={i} d={path(s.values, yOf(s))} fill="none" stroke={s.color} strokeWidth={s.width||2.2}
            strokeDasharray={s.dash||"none"} strokeLinejoin="round" strokeLinecap="round"
            style={{filter: s.glow?`drop-shadow(0 0 6px ${s.color}66)`:"none"}}/>
        ))}
        {/* hover */}
        {hover!=null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT+innerH} stroke="var(--line-3)" strokeWidth="1"/>
            {series.map((s,i)=> s.values[hover]!=null && (
              <circle key={i} cx={x(hover)} cy={yOf(s)(s.values[hover])} r="4" fill="var(--bg)" stroke={s.color} strokeWidth="2.5"/>
            ))}
          </g>
        )}
      </svg>
      {hover!=null && (
        <div className="tip" style={{ left: Math.max(70, Math.min(w-70, x(hover))), top: padT+8 }}>
          <div style={{fontFamily:"var(--mono)",fontSize:"11px",color:"var(--faint)",marginBottom:"6px"}}>{labels[hover]}</div>
          {band && band.hi[hover]!=null && (
            <div className="tip-row" style={{marginBottom:"4px"}}>
              <span className="tip-k">90% band</span>
              <span className="tip-v" style={{color:"var(--dim)"}}>{GP_fmt.k(band.lo[hover])}–{GP_fmt.k(band.hi[hover])}</span>
            </div>
          )}
          {series.filter(s=>s.values[hover]!=null && !s.hideTip).map((s,i)=> (
            <div className="tip-row" key={i}>
              <span className="tip-k"><span className="legend-swatch" style={{background:s.color,width:8,height:8}}></span>{s.name}</span>
              <span className="tip-v" style={{color:s.color}}>{vf(s.values[hover])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- BarChart (grouped) ------------------------------- */
function BarChart({ labels, series, height=240, stacked=false, yFmt, tipFmt, labelFmt }){
  const wrapRef = useRef(null);
  const [w,setW] = useState(680);
  const [hover,setHover] = useState(null);
  useEffect(()=>{ if(!wrapRef.current) return; const ro=new ResizeObserver(es=>setW(es[0].contentRect.width)); ro.observe(wrapRef.current); return ()=>ro.disconnect(); },[]);
  const padL=52,padR=16,padT=14,padB=30, H=height, innerW=Math.max(10,w-padL-padR), innerH=H-padT-padB;
  const n=labels.length;
  let maxV=0;
  if (stacked){ for(let i=0;i<n;i++){ let s=0; series.forEach(se=>s+=se.values[i]||0); maxV=Math.max(maxV,s);} }
  else series.forEach(se=> se.values.forEach(v=> maxV=Math.max(maxV,v)));
  const top=niceMax(maxV*1.05);
  const y=v=> padT+innerH-(v/top)*innerH;
  const groupW = innerW/n;
  const yf = yFmt || (v=>GP_fmt.k(v));
  const tf = tipFmt || (v=>GP_fmt.int(v));
  const ticks=4, gl=Array.from({length:ticks+1},(_,i)=>top*i/ticks);
  return (
    <div className="chart-wrap" ref={wrapRef} style={{position:"relative"}}>
      <svg width={w} height={H} style={{display:"block"}}>
        {gl.map((g,i)=>(<g key={i}>
          <line x1={padL} x2={w-padR} y1={y(g)} y2={y(g)} stroke="var(--line)"/>
          <text x={padL-10} y={y(g)+4} textAnchor="end" fontSize="11" fill="var(--faint)" fontFamily="var(--mono)">{yf(g)}</text>
        </g>))}
        {labels.map((lb,i)=>{
          const gx = padL + i*groupW;
          const bw = stacked ? groupW*0.5 : (groupW*0.62)/series.length;
          let acc=0;
          return (
            <g key={i} onMouseEnter={()=>setHover(i)} onMouseLeave={()=>setHover(null)}>
              <rect x={gx} y={padT} width={groupW} height={innerH} fill={hover===i?"var(--bg-2)":"transparent"} opacity="0.5"/>
              {series.map((se,si)=>{
                const v=se.values[i]||0;
                if (stacked){ const yy=y(acc+v), hh=y(acc)-y(acc+v); acc+=v;
                  return <rect key={si} x={gx+groupW*0.25} y={yy} width={bw} height={Math.max(0,hh)} fill={se.color} rx="2"/>;
                } else { const bx=gx+groupW*0.19+si*bw;
                  return (
                    <g key={si}>
                      <rect x={bx} y={y(v)} width={bw*0.86} height={Math.max(0,innerH-(y(v)-padT))} fill={se.color} rx="2"/>
                      {labelFmt && v>0 && <text x={bx+bw*0.86/2} y={y(v)-5} textAnchor="middle" fontSize="10.5" fontWeight="700" fontFamily="var(--mono)" fill="var(--dim)">{labelFmt(v)}</text>}
                    </g>
                  );
                }
              })}
              <text x={gx+groupW/2} y={H-10} textAnchor="middle" fontSize="11" fill="var(--faint)" fontFamily="var(--mono)">{lb}</text>
            </g>
          );
        })}
      </svg>
      {hover!=null && (
        <div className="tip" style={{left:Math.max(70,Math.min(w-70,padL+hover*groupW+groupW/2)), top:padT+8}}>
          <div style={{fontFamily:"var(--mono)",fontSize:"11px",color:"var(--faint)",marginBottom:"6px"}}>{labels[hover]}</div>
          {series.map((se,i)=>(
            <div className="tip-row" key={i}>
              <span className="tip-k"><span className="legend-swatch" style={{background:se.color,width:8,height:8}}></span>{se.name}</span>
              <span className="tip-v" style={{color:se.color}}>{tf(se.values[hover])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Donut -------------------------------------------- */
/* items: [{ label, value, color }]. showPct prints the share inside each slice
   that's big enough to read; center is optional middle text. */
function Donut({ items, size=150, thickness=22, showPct=true, center }){
  const total = items.reduce((s,i)=>s+i.value,0) || 1;
  const r=(size-thickness)/2, cx=size/2, cy=size/2, C=2*Math.PI*r;
  let off=0, acc=0;
  return (
    <svg width={size} height={size} style={{display:"block"}}>
      <g transform={`rotate(-90 ${cx} ${cy})`}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--bg-3)" strokeWidth={thickness}/>
        {items.map((it,i)=>{
          const frac=it.value/total, len=frac*C;
          const el=<circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={it.color} strokeWidth={thickness}
            strokeDasharray={`${len} ${C-len}`} strokeDashoffset={-off} strokeLinecap="butt"/>;
          off+=len; return el;
        })}
      </g>
      {showPct && items.map((it,i)=>{
        const frac=it.value/total, mid=acc+frac/2; acc+=frac;
        if (frac < 0.07) return null;                     // too thin to label legibly
        const ang=(-90 + mid*360) * Math.PI/180;
        const x=cx + r*Math.cos(ang), y=cy + r*Math.sin(ang);
        return <text key={i} x={x} y={y} textAnchor="middle" dominantBaseline="central"
          fontSize="11.5" fontWeight="700" fontFamily="var(--mono)" fill="#0e1015">{Math.round(frac*100)}%</text>;
      })}
      {center!=null && <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
        fontSize="12" fontFamily="var(--mono)" fill="var(--dim)">{center}</text>}
    </svg>
  );
}

/* ---------- Sparkline ---------------------------------------- */
function Sparkline({ values, color="var(--pink)", width=120, height=34 }){
  const max=Math.max(...values), min=Math.min(...values);
  const x=i=> (i/(values.length-1))*width;
  const y=v=> height-2 - ((v-min)/(max-min||1))*(height-4);
  let d=""; values.forEach((v,i)=> d+=(i?"L":"M")+x(i).toFixed(1)+" "+y(v).toFixed(1)+" ");
  return (
    <svg width={width} height={height} style={{display:"block"}}>
      <path d={`${d} L${width} ${height} L0 ${height} Z`} fill={color} fillOpacity="0.12" stroke="none"/>
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

Object.assign(window, { LineChart, BarChart, Donut, Sparkline });

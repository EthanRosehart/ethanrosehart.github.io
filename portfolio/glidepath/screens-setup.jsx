/* ============================================================
   screens-setup.jsx — Onboarding (airport select) + Connect data
   ============================================================ */
const { useState:useStateA, useMemo:useMemoA, useEffect:useEffectA, useRef:useRefA } = React;

/* simple inline icons */
const Ico = {
  search:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>,
  pin:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>,
  plane:   <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L11 19v-5.5z"/></svg>,
  check:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>,
  arrow:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>,
  db:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>,
  upload:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 16V4m0 0L7 9m5-5l5 5"/><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/></svg>,
  close:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18"/></svg>,
};

function Onboarding({ onSelect, selected, onUpload, onImportSession }){
  const [q, setQ] = useStateA("");
  const searchRef = useRefA(null);
  const [importBusy, setImportBusy] = useStateA(false);
  const [importError, setImportError] = useStateA(null);
  const live = GP_liveAirports();
  const t = q.trim().toLowerCase();
  const matches = useMemoA(()=>{
    if (!t) return live;
    return live.filter(a => (a.iata+a.icao+a.name+a.city+a.country).toLowerCase().includes(t));
  },[t, live.length]);
  // keep the picker short — a long catalogue is hard to scan and, on mobile,
  // an over-tall list traps the scroll gesture. Show a compact set and lean on
  // search to narrow rather than dumping every gateway at once.
  const CAP = t ? 24 : 8;
  const list = matches.slice(0, CAP);

  const handleImportFile = async (file)=>{
    setImportBusy(true); setImportError(null);
    const err = await onImportSession(file);
    setImportBusy(false);
    if (err) setImportError(err);
  };

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

      <div className="panel panel-pad" style={{marginBottom:22, display:"flex", alignItems:"center", gap:16, flexWrap:"wrap"}}>
        <button className="btn btn-lg" style={{flex:"1 1 220px",justifyContent:"center"}} onClick={onUpload}>{Ico.upload} Upload your own data</button>
        <span className="air-meta" style={{flex:"none", fontFamily:"var(--mono)", letterSpacing:".1em"}}>OR</span>
        <button className="btn btn-lg" style={{flex:"1 1 220px",justifyContent:"center"}} onClick={()=>searchRef.current?.focus()}>{Ico.search} Connect to open-source data</button>
      </div>

      <div className="search" style={{marginBottom:18}}>
        <span style={{width:20,height:20,color:"var(--faint)"}}>{Ico.search}</span>
        <input ref={searchRef} autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder="Search IATA / ICAO / city — try “YTZ”, “Toronto”, “Exeter”…" />
        <span className="chip mono">{matches.length} of {live.length}</span>
      </div>

      <div className="grid air-grid" style={{gridTemplateColumns:"repeat(2, minmax(0, 1fr))", gap:10, maxHeight:420, overflowY:"auto", overflowX:"hidden", overscrollBehavior:"contain", paddingRight:4, marginBottom:14}}>
        {list.map(a => (
          <div key={a.iata} className={"air-card"+(selected?.iata===a.iata?" sel":"")} onClick={()=>onSelect(a)}>
            <div className="air-code">{a.iata}</div>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:14, fontWeight:600, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{a.name}</div>
              <div className="air-meta" style={{whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{a.city}, {a.country} · {a.icao}</div>
            </div>
            {selected?.iata===a.iata
              ? <span style={{width:22,height:22,color:"var(--pink)"}}>{Ico.check}</span>
              : <span className="air-meta">{a.annualPax ? GP_fmt.k1(a.annualPax)+"/yr" : a.region}</span>}
          </div>
        ))}
      </div>

      <div className="air-meta" style={{textAlign:"center", marginBottom:24, minHeight:16}}>
        {matches.length > list.length
          ? <>Showing {list.length} of {matches.length} matches — keep typing to narrow it down.</>
          : matches.length===0
          ? <>No gateway matches “{q.trim()}”. Try an IATA code or city name.</>
          : null}
      </div>

      {selected && (
        <div className="panel panel-pad fade-in confirm-bar" style={{display:"flex", alignItems:"center", justifyContent:"space-between", gap:20, marginBottom:18}}>
          <div style={{display:"flex", alignItems:"center", gap:18}}>
            <div style={{width:54,height:54,borderRadius:12,background:"var(--pink-soft)",border:"1px solid var(--pink-line)",display:"grid",placeItems:"center",color:"var(--pink-2)",fontFamily:"var(--mono)",fontWeight:700,fontSize:18}}>{selected.iata}</div>
            <div>
              <div style={{fontSize:17,fontWeight:600}}>{selected.name}</div>
              <div className="air-meta" style={{marginTop:3}}>{selected.icao} · {selected.lat!=null?selected.lat.toFixed(3):"—"}, {selected.lon!=null?selected.lon.toFixed(3):"—"} · {selected.region} · {selected.annualPax ? GP_fmt.k1(selected.annualPax)+" PAX/yr" : "—"}</div>
            </div>
          </div>
          <button className="btn btn-primary btn-lg" onClick={()=>onSelect(selected, true)}>Connect data {Ico.arrow}</button>
        </div>
      )}

      <div style={{textAlign:"center", paddingTop:4}}>
        <span className="air-meta">Already have a Glidepath session file? </span>
        <label className="btn btn-sm" style={{marginLeft:8, cursor:importBusy?"default":"pointer"}}>
          {importBusy ? "Importing…" : "Import session"}
          <input type="file" accept=".json,application/json" style={{display:"none"}} disabled={importBusy}
            onChange={e => e.target.files[0] && handleImportFile(e.target.files[0])}/>
        </label>
        {importError && <div className="caveat fade-in" style={{marginTop:14, maxWidth:520, marginLeft:"auto", marginRight:"auto"}}><b>Couldn't import that file —</b> {importError}</div>}
      </div>
    </div>
  );
}

/* ---------- Upload your own data ------------------------------
   An alternative to picking a catalogue gateway: parse an uploaded
   CSV/XLSX client-side (lazy-loads the same SheetJS build ExportView
   already uses), let the visitor confirm/fix the column mapping and edit
   the monthly numbers directly, then register it through the exact same
   catalogue machinery a real airport uses (GP_registerCustomAirport) —
   every downstream screen just works, except the short-term Prophet
   forecast, which is fit server-side nightly and isn't available here
   (see DataCaveat). Nothing leaves the browser; there's no server this
   data could be sent to even if we wanted to. */
const ROLE_LABELS = { date:"Month", pax:"Passengers", atm:"Movements", cargo:"Cargo", ignore:"Ignore" };
const UPLOAD_COUNTRIES = Object.keys(MACRO).map(cc => ({ cc, label: MACRO[cc].label })).concat([{ cc:"OTH", label:"Other / not listed" }]);

function UploadData({ onDone, onCancel }){
  const [name, setName] = useStateA("");
  const [code, setCode] = useStateA("");
  const [cc, setCc] = useStateA("USA");
  // { sheetNames:[...], sheets:{ name: arrayOfArrays } } — every sheet that
  // has data rows, not just the first. Excel workbooks with the same series
  // split across tabs (by year range, say) are common enough to support
  // directly rather than silently reading only sheet 1.
  const [workbook, setWorkbook] = useStateA(null);
  const [sheetChoice, setSheetChoice] = useStateA(null); // a sheet name, or "__all__"
  const [roles, setRoles] = useStateA([]);           // per-column role, parallel to the header row
  const [rows, setRows] = useStateA([]);             // editable working rows: [{month,pax,atm,cargo}]
  const [fileName, setFileName] = useStateA(null);
  const [fileError, setFileError] = useStateA(null);
  const [busy, setBusy] = useStateA(false);
  const [addMonth, setAddMonth] = useStateA("");

  const onFile = async (file) => {
    setFileError(null); setBusy(true);
    try {
      await GP_loadScript("https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js");
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type:"array", cellDates:true });
      const sheets = {};
      for (const sheetName of wb.SheetNames) {
        const aoa = window.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header:1, raw:true, blankrows:false });
        if (aoa.length > 1) sheets[sheetName] = aoa; // skip sheets with no data rows (notes, instructions, ...)
      }
      const sheetNames = Object.keys(sheets);
      if (!sheetNames.length) throw new Error("no sheet in that file has any rows");
      // column mapping is read from the first data-bearing sheet and assumed
      // to apply to all of them — true for the common case (the same series
      // split across tabs), and "combine all sheets" is opt-in below rather
      // than the assumed default when that's not actually what's going on
      const header = sheets[sheetNames[0]][0].map(c => String(c ?? ""));
      setWorkbook({ sheetNames, sheets });
      setSheetChoice(sheetNames.length > 1 ? "__all__" : sheetNames[0]);
      setRoles(GP_guessColumnRoles(header));
      setFileName(file.name);
    } catch(e) {
      setFileError("Couldn't read that file — try exporting it as CSV. (" + (e && e.message || e) + ")");
      setWorkbook(null);
    } finally { setBusy(false); }
  };

  // re-derive the editable table whenever the file, the active sheet(s), or
  // the column mapping changes; after that, rows are edited independently
  // (this effect won't clobber in-progress edits since none of those change
  // again on their own)
  useEffectA(() => {
    if (!workbook) return;
    const activeSheets = sheetChoice === "__all__" ? workbook.sheetNames : [sheetChoice];
    const dateIdx = roles.indexOf("date");
    const byMonth = {};
    for (const sheetName of activeSheets) {
      const aoa = workbook.sheets[sheetName];
      for (let r = 1; r < aoa.length; r++) {
        const raw = aoa[r];
        const month = dateIdx >= 0 ? GP_parseMonthKey(raw[dateIdx]) : null;
        if (!month) continue;
        const rec = byMonth[month] || { month };
        roles.forEach((role, ci) => {
          if (role !== "pax" && role !== "atm" && role !== "cargo") return;
          const v = raw[ci];
          const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[,\s]/g, ""));
          if (!isNaN(n)) rec[role] = n;
        });
        byMonth[month] = rec;
      }
    }
    setRows(Object.values(byMonth).sort((a,b)=>a.month.localeCompare(b.month)));
  }, [workbook, sheetChoice, roles.join(",")]);

  const setRole = (colIdx, role) => setRoles(rs => rs.map((r,i)=> i===colIdx ? role : r));
  const updateCell = (i, field, value) => setRows(rs => rs.map((r,ri)=> ri===i ? { ...r, [field]: value } : r));
  const removeRow = (i) => setRows(rs => rs.filter((_,ri)=> ri!==i));
  const addRow = () => {
    if (!addMonth) return;
    setRows(rs => [...rs, { month:addMonth, pax:"" }].sort((a,b)=>a.month.localeCompare(b.month)));
    setAddMonth("");
  };

  // the series this table would produce, and whether it's enough to build
  // on — reuses the app's real long-term-model threshold (>=1 complete
  // calendar year), not an arbitrary made-up minimum
  const { series, fullYearCount, monthCount } = useMemoA(() => {
    const s = { pax:{} };
    rows.forEach(r => {
      if (!r.month) return;
      if (r.pax !== "" && r.pax != null && !isNaN(+r.pax)) s.pax[r.month] = +r.pax;
      if (r.atm !== "" && r.atm != null && !isNaN(+r.atm)) (s.atm ||= {})[r.month] = +r.atm;
      if (r.cargo !== "" && r.cargo != null && !isNaN(+r.cargo)) (s.cargo ||= {})[r.month] = +r.cargo;
    });
    const hist = Object.keys(s.pax).map(k => ({ y:+k.slice(0,4), m:+k.slice(5,7)-1, pax:s.pax[k] }));
    const fy = GP_fullYears(hist, "pax");
    return { series:s, fullYearCount:fy.length, monthCount: Object.keys(s.pax).length };
  }, [rows]);

  const canSubmit = name.trim().length>0 && code.trim().length>0 && fullYearCount>=1 && !busy;
  // the numbers can say "ready" while the button next to them stays grey for
  // an unrelated reason (no gateway name yet, say) — spell out what's still
  // missing rather than leaving a disabled button unexplained
  const missing = [];
  if (!name.trim()) missing.push("a gateway name");
  if (!code.trim()) missing.push("a short code");
  if (!rows.length) missing.push("a source file");
  else if (fullYearCount<1) missing.push("one full calendar year of passengers");
  const joinList = (arr)=> arr.length<2 ? arr.join("") : arr.length===2 ? arr.join(" and ") : arr.slice(0,-1).join(", ")+", and "+arr[arr.length-1];

  const submit = () => {
    const iata = "C-" + code.trim().toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,10);
    const country = UPLOAD_COUNTRIES.find(c=>c.cc===cc) || UPLOAD_COUNTRIES[UPLOAD_COUNTRIES.length-1];
    const meta = {
      name: name.trim(), cc, countryName: country.label, region:"Your data",
      city:"", icao:"", lat:null, lon:null, rep_airp:null, country:null,
    };
    onDone(iata, meta, series);
  };

  const dateColIdx = roles.indexOf("date");

  const downloadTemplate = () => {
    const rows = [
      ["Month","Passengers","Movements","Cargo (t)"],
      ["2024-01","52000","430","26"],
      ["2024-02","49500","415","25"],
      ["2024-03","61000","505","30"],
    ];
    GP_saveBlob(new Blob([rows.map(r=>r.join(",")).join("\n")], {type:"text/csv;charset=utf-8"}), "glidepath_upload_template.csv");
  };

  return (
    <div className="content fade-in" style={{maxWidth:900}}>
      <div style={{marginBottom:26}}>
        <div className="eyebrow" style={{marginBottom:12}}>Step 02 · Provide your data</div>
        <h1 style={{fontSize:34, marginBottom:12}}>Bring your own monthly history</h1>
        <p style={{color:"var(--dim)", fontSize:16, maxWidth:640}}>
          Upload a spreadsheet of monthly passengers (and, optionally, movements or cargo) — up to 10 years works
          best — then fix up the numbers right here. Nothing is uploaded anywhere; it stays in this browser.
        </p>
      </div>

      <div className="panel panel-pad" style={{marginBottom:16}}>
        <SectionHead kicker="Gateway details" title="Name it"/>
        <div className="grid g-3" style={{gap:14}}>
          <div>
            <div className="lever-desc" style={{marginBottom:6}}>Gateway name</div>
            <input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Riverside Regional"
              style={{width:"100%",background:"var(--bg-2)",border:"1px solid var(--line-2)",borderRadius:"var(--r-sm)",color:"var(--text)",fontFamily:"var(--sans)",fontSize:14,padding:"10px 12px",outline:"none"}}/>
          </div>
          <div>
            <div className="lever-desc" style={{marginBottom:6}}>Short code (for charts &amp; exports)</div>
            <input value={code} onChange={e=>setCode(e.target.value)} placeholder="e.g. RVR" maxLength={10}
              style={{width:"100%",background:"var(--bg-2)",border:"1px solid var(--line-2)",borderRadius:"var(--r-sm)",color:"var(--text)",fontFamily:"var(--mono)",fontSize:14,padding:"10px 12px",outline:"none",textTransform:"uppercase"}}/>
          </div>
          <div>
            <div className="lever-desc" style={{marginBottom:6}}>Country (for macro drivers)</div>
            <select value={cc} onChange={e=>setCc(e.target.value)} className="seg-select" style={{width:"100%",padding:"10px 12px"}}>
              {UPLOAD_COUNTRIES.map(c => <option key={c.cc} value={c.cc}>{c.label}{c.cc==="OTH"?"":" (World Bank data)"}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="panel panel-pad" style={{marginBottom:16}}>
        <SectionHead kicker="Source file" title="Upload a CSV or Excel file"/>
        <p style={{color:"var(--dim)", fontSize:13.5, lineHeight:1.6, marginBottom:16, maxWidth:640}}>
          One row per month, with a column for the month and at least one for passengers — movements and cargo are
          optional. Column headers don't have to match exactly: common ones (Month, Date, Passengers, PAX,
          Movements, Flights, Cargo) are detected automatically, and you can fix the mapping below if we guess
          wrong. Not sure what that should look like? Grab the template. This all happens
          {" "}<b style={{color:"var(--text)"}}>right here in your browser</b> — the file is never sent anywhere;
          there's no server on the other end of this screen for it to go to.
        </p>
        <div style={{display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
          <label className="btn btn-primary" style={{cursor:"pointer"}}>
            {Ico.upload} {busy ? "Reading…" : "Choose file"}
            <input type="file" accept=".csv,.xlsx,.xls" style={{display:"none"}} disabled={busy}
              onChange={e => e.target.files[0] && onFile(e.target.files[0])}/>
          </label>
          <button className="btn btn-sm" onClick={downloadTemplate}>Download template (CSV)</button>
          {fileName && !fileError && <span className="air-meta">{fileName} · {workbook ? workbook.sheetNames.length : 0} sheet{workbook && workbook.sheetNames.length!==1?"s":""} read</span>}
        </div>
        {fileError && <div className="caveat fade-in" style={{marginTop:14}}><b>Couldn't read that file —</b> {fileError.replace(/^Couldn't read that file — /,"")}</div>}
        {workbook && workbook.sheetNames.length>1 && (
          <div style={{marginTop:16}}>
            <div className="lever-desc" style={{marginBottom:6}}>This file has {workbook.sheetNames.length} sheets — which one has your data?</div>
            <select value={sheetChoice} onChange={e=>setSheetChoice(e.target.value)} className="seg-select">
              <option value="__all__">Combine all {workbook.sheetNames.length} sheets</option>
              {workbook.sheetNames.map(n => <option key={n} value={n}>{n} only ({workbook.sheets[n].length-1} rows)</option>)}
            </select>
            <div className="lever-desc" style={{marginTop:6}}>
              "Combine" assumes every sheet has the same columns in the same order — that's the common case (the
              same series split across tabs, by year say). Pick a single sheet instead if they don't.
            </div>
          </div>
        )}
        {workbook && (
          <div style={{marginTop:18}}>
            <div className="lever-desc" style={{marginBottom:10}}>We guessed what each column is — fix anything that's wrong:</div>
            <div className="grid" style={{gridTemplateColumns:`repeat(${workbook.sheets[workbook.sheetNames[0]][0].length}, minmax(120px,1fr))`, gap:10, overflowX:"auto"}}>
              {workbook.sheets[workbook.sheetNames[0]][0].map((h,i)=>(
                <div key={i}>
                  <div className="air-meta" style={{marginBottom:5, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}} title={String(h)}>{String(h) || `Column ${i+1}`}</div>
                  <select value={roles[i]} onChange={e=>setRole(i,e.target.value)} className="seg-select" style={{width:"100%"}}>
                    {Object.keys(ROLE_LABELS).map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                </div>
              ))}
            </div>
            {dateColIdx<0 && <div className="caveat fade-in" style={{marginTop:14}}><b>Pick a Month column —</b> we need to know which column holds the date before we can build the table below.</div>}
          </div>
        )}
      </div>

      {rows.length>0 && (
        <div className="panel panel-pad" style={{marginBottom:16}}>
          <SectionHead kicker={monthCount+" months detected"} title="Check the numbers"
            right={<span className="air-meta" style={{color: fullYearCount>=1 ? "var(--ok)" : "var(--bad)"}}>
              {fullYearCount>=1 ? `${fullYearCount} complete calendar year${fullYearCount>1?"s":""} — ready` : "needs one full Jan–Dec year of passengers"}
            </span>}/>
          <div style={{maxHeight:320, overflowY:"auto"}}>
            <table className="tbl">
              <thead><tr><th>Month</th><th>Passengers</th><th>Movements</th><th>Cargo (t)</th><th></th></tr></thead>
              <tbody>
                {rows.map((r,i)=>(
                  <tr key={i}>
                    <td style={{textAlign:"left"}}>
                      <input type="month" value={r.month||""} onChange={e=>updateCell(i,"month",e.target.value)}
                        style={{background:"transparent",border:"none",color:"var(--text)",fontFamily:"var(--mono)",fontSize:13,outline:"none"}}/>
                    </td>
                    {["pax","atm","cargo"].map(field=>(
                      <td key={field}>
                        <input type="number" value={r[field]??""} onChange={e=>updateCell(i,field,e.target.value)} placeholder="—"
                          style={{width:88,background:"transparent",border:"none",borderBottom:"1px solid var(--line)",color:"var(--text)",fontFamily:"var(--mono)",fontSize:13,textAlign:"right",padding:"2px 0",outline:"none"}}/>
                      </td>
                    ))}
                    <td style={{width:30}}>
                      <button className="icon-btn" title="Remove row" onClick={()=>removeRow(i)} style={{width:26,height:26}}>
                        <span style={{width:12,height:12,display:"inline-block"}}>{Ico.close}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10,marginTop:14,paddingTop:14,borderTop:"1px solid var(--line)"}}>
            <input type="month" value={addMonth} onChange={e=>setAddMonth(e.target.value)} className="seg-select"/>
            <button className="btn btn-sm" disabled={!addMonth} onClick={addRow}>+ Add month</button>
            <span className="air-meta">for a month your file was missing</span>
          </div>
        </div>
      )}

      <div className="panel panel-pad confirm-bar" style={{display:"flex", alignItems:"center", justifyContent:"space-between", gap:20, flexWrap:"wrap"}}>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <div style={{display:"flex", alignItems:"center", gap:14, flexWrap:"wrap", justifyContent:"flex-end"}}>
          {!canSubmit && !busy && missing.length>0 &&
            <span className="air-meta" style={{color:"var(--bad)"}}>Add {joinList(missing)} above to continue</span>}
          <button className="btn btn-primary btn-lg" disabled={!canSubmit} onClick={submit}>Build forecast {Ico.arrow}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Connect data sources ----------------------------- */
const SOURCES = [
  { id:"openflights", abbr:"OF", name:"OpenFlights Airport DB", desc:"Identifiers, geography & timezone reference", rows:"reference DB", live:true, wired:true, kind:"openflights" },
  { id:"activity",    abbr:"AVIA", name:"Eurostat / StatCan Aviation", desc:"Monthly passengers by airport — the series the forecasts run on", rows:"132 months", live:true, wired:true, kind:"activity" },
  { id:"worldbank",   abbr:"WB", name:"World Bank Open Data", desc:"Population & historical GDP/capita — catchment driver", rows:"Indicators API", live:true, wired:true, kind:"macro" },
];

/* progress/status here track the REAL fetches (App loads OpenFlights +
   World Bank once on mount, and this airport's own series once selected) —
   there's no simulated timer. "activity" is the one row genuinely still in
   flight when this screen first shows, since it's fetched lazily per
   airport rather than preloaded like the other two. */
function ConnectData({ airport, onDone, alreadyDone, macroMeta, actMeta, ofMeta, seriesStatus }){
  const wb = macroMeta && macroMeta.countries ? macroMeta.countries[airport.cc] : null;
  const of = ofMeta && ofMeta.airports ? ofMeta.airports[airport.iata] : null;
  const act = (typeof GP_activityFor==="function") ? GP_activityFor(airport.iata) : null;
  const forThisAirport = seriesStatus && seriesStatus.iata === airport.iata;
  const activityReady = alreadyDone || (forThisAirport && seriesStatus.ready);
  const activityError = forThisAirport && seriesStatus.error;

  const rowStatus = [
    ofMeta ? "connected" : "syncing",
    activityError ? "error" : activityReady ? "connected" : "syncing",
    macroMeta ? "connected" : "syncing",
  ];
  const progress = [ ofMeta?100:0, activityError?100:activityReady?100:55, macroMeta?100:0 ];
  const done = rowStatus.every(s => s==="connected");

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
          const p = progress[i], status = rowStatus[i], ok = status==="connected", err = status==="error";
          // the aviation feed badge reflects the actual provider for this
          // gateway — AVIA (Eurostat), CAN (Statistics Canada), BTS (US DOT)
          const ico = s.kind==="activity" && act ? GP_sourceBadge(act.source) : s.abbr;
          return (
            <div key={s.id} className={"src-row"+(ok?" connected":"")}>
              <div className="src-ico">{ico}</div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{display:"flex", alignItems:"center", gap:10}}>
                  <span style={{fontSize:14.5, fontWeight:600}}>{s.name}</span>
                  {s.live && <span className="chip chip-ok" style={{fontSize:9.5, padding:"2px 7px"}}>LIVE</span>}
                </div>
                <div style={{fontSize:12.5, color:"var(--faint)", marginTop:2}}>
                  {err
                    ? <span style={{color:"var(--bad)"}}>Couldn't reach the {s.name} feed — check your connection and reload.</span>
                    : s.kind==="macro" && ok && wb
                    ? <span>{wb.name}: population <b style={{color:"var(--cyan)"}}>{(wb.pop>=0?"+":"")+wb.pop}%</b> · GDP/capita <b style={{color:"var(--cyan)"}}>{(wb.gdpcap>=0?"+":"")+wb.gdpcap}%</b> ({wb.year})</span>
                    : s.kind==="openflights" && ok && of
                    ? <span>{of.icao} · {of.lat!=null?of.lat.toFixed(3):"—"}, {of.lon!=null?of.lon.toFixed(3):"—"} · verified against {ofMeta?ofMeta.count:""} reference airports</span>
                    : s.kind==="activity" && ok && act
                    ? (act.observed
                        ? <span>Observed via <b style={{color:"var(--cyan)"}}>{GP_sourceLabel(act.source)}</b> · <b style={{color:"var(--cyan)"}}>{act.months}</b> months of passengers{act.latest?` · to ${act.latest}`:""}</span>
                        : <span>No public monthly feed for {airport.iata} — series reconstructed from anchors</span>)
                    : s.desc}
                </div>
                <div className="src-bar"><i style={{width:p+"%", background: err?"var(--bad)":undefined}}></i></div>
              </div>
              <div style={{textAlign:"right", minWidth:120}}>
                {err
                  ? <div style={{display:"flex",alignItems:"center",gap:7,justifyContent:"flex-end",color:"var(--bad)",fontSize:13,fontWeight:600}}><span className="dot" style={{background:"var(--bad)"}}></span>Failed</div>
                  : ok
                  ? (s.kind==="activity" && act && !act.observed
                      ? <div style={{display:"flex",alignItems:"center",gap:7,justifyContent:"flex-end",color:"var(--amber)",fontSize:13,fontWeight:600}}><span className="dot" style={{background:"var(--amber)"}}></span>Modeled</div>
                      : <div style={{display:"flex",alignItems:"center",gap:7,justifyContent:"flex-end",color:"var(--ok)",fontSize:13,fontWeight:600}}><span className="dot dot-ok"></span>Connected</div>)
                  : <div style={{display:"flex",alignItems:"center",gap:7,justifyContent:"flex-end",color:"var(--dim)",fontSize:13}}><span style={{width:13,height:13,display:"inline-block",color:"var(--pink-2)"}}>{Ico.search}</span>Syncing…</div>}
                <div className="air-meta" style={{marginTop:4}}>
                  {s.kind==="activity" && actMeta ? "snapshot "+new Date(actMeta.generatedAt).toLocaleDateString("en-CA")
                    : s.kind==="macro" && macroMeta ? "snapshot "+new Date(macroMeta.generatedAt).toLocaleDateString("en-CA")
                    : s.kind==="openflights" && ofMeta ? "snapshot "+new Date(ofMeta.generatedAt).toLocaleDateString("en-CA")
                    : s.rows}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {done && <DataCaveat airport={airport} style={{marginBottom:16}}/>}

      <div className="panel panel-pad confirm-bar" style={{display:"flex", alignItems:"center", justifyContent:"space-between", gap:20,
        borderColor: done?"var(--pink-line)":"var(--line)", background: done?"var(--pink-soft)":"var(--bg-1)"}}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <span style={{width:38,height:38,borderRadius:10,display:"grid",placeItems:"center",
            background: done?"var(--pink)":activityError?"var(--bad)":"var(--bg-2)", color: done?"#12030a":activityError?"#2a0a0a":"var(--faint)"}}>
            {done ? Ico.check : activityError ? "!" : <span className="spin" style={{width:18,height:18}}>{Ico.search}</span>}
          </span>
          <div>
            <div style={{fontWeight:600, fontSize:15}}>{done ? (act && act.observed ? `Dataset ready — ${act.months} months of observed passengers` : "Dataset ready — 132 months assembled") : activityError ? "Couldn't load this gateway's data" : "Reconciling feeds…"}</div>
            <div className="air-meta" style={{marginTop:3}}>{done ? (act && act.observed ? `${GP_sourceLabel(act.source)} passengers drive the forecasts · movements, seats & cargo aligned to ${airport.iata}` : "PAX · ATM · cargo · seats · macro drivers, all aligned to "+airport.iata) : activityError ? "Try reloading the page" : "Cross-checking units, gaps and outliers"}</div>
          </div>
        </div>
        <button className="btn btn-primary btn-lg" disabled={!done} onClick={onDone}>Build forecast {Ico.arrow}</button>
      </div>

    </div>
  );
}

Object.assign(window, { Onboarding, ConnectData, UploadData, GP_Ico:Ico, GP_SOURCES:SOURCES });

#!/usr/bin/env node
/* ============================================================
 * fetch-activity.mjs — Glidepath monthly-passenger snapshot
 *
 * Runs on a GitHub Actions runner (Node 20+), server-side, so no
 * browser CORS limits. Pulls real monthly passenger counts by
 * airport and writes data/activity.json. The app reads that file
 * same-origin and runs its forecasts on the observed series.
 *
 *   • European airports  → Eurostat  avia_paoc  (no key)
 *   • Canadian airports  → Statistics Canada WDS (Table 23-10-0253)
 *   • US airports        → left modeled (no single clean public feed)
 *
 * Run locally:  node scripts/fetch-activity.mjs
 * ============================================================ */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data", "activity.json");

/* airport set — iata, ISO3, ICAO. Keep in sync with data.jsx */
const AIRPORTS = [
  ["YTZ","CAN","CYTZ"],["YOW","CAN","CYOW"],["YHM","CAN","CYHM"],["YQB","CAN","CYQB"],
  ["YHZ","CAN","CYHZ"],["YKF","CAN","CYKF"],["BUR","USA","KBUR"],["PVU","USA","KPVU"],
  ["PSP","USA","KPSP"],["BZN","USA","KBZN"],["EXT","GBR","EGTE"],["NQY","GBR","EGHQ"],
  ["INV","GBR","EGPE"],["RTM","NLD","EHRD"],["FMM","DEU","EDJA"],["AAR","DNK","EKAH"],
  ["GRZ","AUT","LOWG"],["KLU","AUT","LOWK"],["SZG","AUT","LOWS"],["NAP","ITA","LIRN"],
  ["WRO","POL","EPWR"],
];
const EU_GEO = { GBR:"UK", NLD:"NL", DEU:"DE", DNK:"DK", AUT:"AT", ITA:"IT", POL:"PL" };

/* ---- Eurostat: air passenger transport by reporting airport ----
 * Dataset avia_paoc, measure PAS_CRD (passengers carried, arr+dep),
 * unit PAS. Dissemination API returns JSON-stat. The rep_airp code
 * is "<geo>_<ICAO>", e.g. UK_EGTE (Exeter), AT_LOWG (Graz).        */
async function fetchEurostat(repAirp) {
  const base = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/avia_paoc";
  const url = `${base}?format=JSON&lang=EN&freq=M&unit=PAS&tra_meas=PAS_CRD&rep_airp=${repAirp}&sinceTimePeriod=2015-01`;
  const res = await fetch(url, { headers: { "User-Agent": "glidepath-data-bot" } });
  if (!res.ok) throw new Error(`eurostat ${repAirp}: HTTP ${res.status}`);
  const js = await res.json();
  // JSON-stat: value is keyed by the flat index of the time dimension
  const timeDim = js.dimension?.time;
  if (!timeDim) throw new Error(`eurostat ${repAirp}: no time dimension`);
  const idx = timeDim.category.index;            // { "2015-01": 0, ... }
  const order = Object.entries(idx).sort((a, b) => a[1] - b[1]).map((e) => e[0]);
  const monthly = {};
  for (let i = 0; i < order.length; i++) {
    const v = js.value[i];
    if (v == null) continue;
    monthly[normMonth(order[i])] = Math.round(v);   // Eurostat months are "2015-01" or "2015M01"
  }
  return monthly;
}

/* ---- Statistics Canada: Table 23-10-0253 (WDS API) -------------
 * Air passenger traffic at Canadian airports, monthly. We resolve
 * each airport's vector once via the coordinate map below, then pull
 * the full series. Coordinate = member ids along each dimension;
 * here dim1 = geography (airport). Verify ids in the StatCan cube
 * metadata if you extend the airport set.                          */
const STATCAN_PID = 23100253;
const STATCAN_COORD = {
  // iata : coordinate string (airport member id + trailing zeros)
  YTZ: "11.0.0.0.0.0.0.0.0.0",
  YOW: "10.0.0.0.0.0.0.0.0.0",
  YHZ: "8.0.0.0.0.0.0.0.0.0",
  YQB: "9.0.0.0.0.0.0.0.0.0",
  YHM: "6.0.0.0.0.0.0.0.0.0",
  YKF: "5.0.0.0.0.0.0.0.0.0",
};
async function fetchStatCan(iata) {
  const coord = STATCAN_COORD[iata];
  if (!coord) return null;
  const res = await fetch("https://www150.statcan.gc.ca/t1/wds/rest/getDataFromCubePidCoordAndLatestNPeriods", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "glidepath-data-bot" },
    body: JSON.stringify([{ productId: STATCAN_PID, coordinate: coord, latestN: 132 }]),
  });
  if (!res.ok) throw new Error(`statcan ${iata}: HTTP ${res.status}`);
  const js = await res.json();
  const pts = js?.[0]?.object?.vectorDataPoint;
  if (!pts) throw new Error(`statcan ${iata}: no data points`);
  const monthly = {};
  for (const p of pts) {
    if (p.value == null) continue;
    monthly[normMonth(p.refPer)] = Math.round(p.value);   // refPer "2023-07-01"
  }
  return monthly;
}

function normMonth(s) {
  // accept "2015M01", "2015-01", "2015-01-01" -> "2015-01"
  const m = String(s).replace("M", "-").slice(0, 7);
  return m;
}

async function loadPrevious() {
  try { return JSON.parse(await readFile(OUT, "utf8")); } catch { return null; }
}

async function main() {
  const prev = await loadPrevious();
  const airports = {};
  let live = 0, kept = 0;

  for (const [iata, cc, icao] of AIRPORTS) {
    const isEU = !!EU_GEO[cc];
    const rep = isEU ? `${EU_GEO[cc]}_${icao}` : icao;
    const source = isEU ? "eurostat:avia_paoc" : cc === "CAN" ? "statcan:23-10-0253" : "modeled";
    try {
      let monthly = null;
      if (isEU) monthly = await fetchEurostat(rep);
      else if (cc === "CAN") monthly = await fetchStatCan(iata);

      if (monthly && Object.keys(monthly).length >= 12) {
        airports[iata] = { source, observed: true, rep_airp: rep, unit: "passengers carried", months: Object.keys(monthly).length, monthly };
        live++;
        console.log(`  ${iata}  ${source}  ${Object.keys(monthly).length} months  (latest ${Object.keys(monthly).sort().pop()})`);
        continue;
      }
      throw new Error("insufficient points");
    } catch (err) {
      // keep last good series for this airport if we have one; else mark modeled
      const before = prev?.airports?.[iata];
      if (before?.observed) {
        airports[iata] = before; kept++;
        console.warn(`  ${iata}  ${source}  FAILED (${err.message}) — kept previous ${before.months}-month snapshot`);
      } else {
        airports[iata] = before || { source: "modeled", observed: false, rep_airp: rep, unit: "passengers carried", months: 0, monthly: {} };
        console.warn(`  ${iata}  ${source}  FAILED (${err.message}) — modeled`);
      }
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    seed: false,
    note: "Monthly passengers by airport. Refreshed nightly by .github/workflows/refresh-data.yml. The browser reads this file same-origin; forecasts run on these observed series.",
    sources: {
      eurostat: "Eurostat avia_paoc — air passenger transport by reporting airport, monthly (PAS_CRD)",
      statcan: "Statistics Canada Table 23-10-0253 — air passenger traffic at Canadian airports, monthly",
      modeled: "No clean public monthly feed in this prototype — reconstructed series",
    },
    airports,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out) + "\n", "utf8");
  console.log(`Wrote ${OUT} — ${live} live, ${kept} kept, ${AIRPORTS.length - live - kept} modeled.`);
}

main().catch((err) => { console.error("Activity snapshot failed:", err.message); process.exit(1); });

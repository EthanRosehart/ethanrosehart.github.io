#!/usr/bin/env node
/* ============================================================
 * fetch-openflights.mjs — authoritative airport reference
 *
 * Pulls the OpenFlights airports.dat (a public CSV on GitHub) and
 * writes data/airports.json with the reference fields for every
 * airport in the Glidepath set. OpenFlights is a static dataset,
 * not a live API, so this just keeps our identifiers/coords in
 * sync with the canonical source.
 *
 * Run locally:  node scripts/fetch-openflights.mjs
 * ============================================================ */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data", "airports.json");

/* the Glidepath set, by IATA. Add codes here to widen the catalogue
   (also add the airport to data.jsx AIRPORTS and wire its activity feed). */
const WANT = ["YYZ","YTZ","YOW","YHM","YQB","YHZ","YKF","BUR","PVU","PSP","BZN",
              "EXT","NQY","INV","RTM","FMM","AAR","GRZ","KLU","SZG","NAP","WRO"];

const REGION = {
  Canada:"North America", "United States":"North America",
  "United Kingdom":"Europe", Netherlands:"Europe", Germany:"Europe",
  Denmark:"Europe", Austria:"Europe", Italy:"Europe", Poland:"Europe",
};
const ISO3 = {
  Canada:"CAN","United States":"USA","United Kingdom":"GBR",
  Netherlands:"NLD",Germany:"DEU",Denmark:"DNK",Austria:"AUT",Italy:"ITA",Poland:"POL",
};

const SRC = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat";

/* airports.dat is CSV with quoted strings; split respecting quotes */
function parseLine(line) {
  const out = []; let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => (s === "\\N" ? null : s));
}

async function main() {
  const res = await fetch(SRC, { headers: { "User-Agent": "glidepath-data-bot" } });
  if (!res.ok) throw new Error(`openflights: HTTP ${res.status}`);
  const text = await res.text();
  const want = new Set(WANT);
  const airports = {};

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // cols: id,name,city,country,IATA,ICAO,lat,lon,alt,tzoff,dst,tzname,type,source
    const c = parseLine(line);
    const iata = c[4];
    if (!iata || !want.has(iata)) continue;
    airports[iata] = {
      icao: c[5], name: c[1], city: c[2], country: c[3],
      cc: ISO3[c[3]] || null,
      lat: c[6] != null ? +c[6] : null,
      lon: c[7] != null ? +c[7] : null,
      elev_ft: c[8] != null ? +c[8] : null,
      tz: c[11], region: REGION[c[3]] || null,
      source: "openflights",
    };
  }

  const missing = WANT.filter((i) => !airports[i]);
  if (missing.length) console.warn("  not found in OpenFlights:", missing.join(", "));
  for (const iata of Object.keys(airports)) console.log(`  ${iata}  ${airports[iata].icao}  ${airports[iata].name}`);

  const out = {
    generatedAt: new Date().toISOString(),
    seed: false,
    source: "OpenFlights airports.dat (github.com/jpatokal/openflights)",
    note: "Authoritative airport reference, filtered to the Glidepath set. Browser reads this file same-origin.",
    count: Object.keys(airports).length,
    airports,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out) + "\n", "utf8");
  console.log(`Wrote ${OUT} — ${out.count}/${WANT.length} airports.`);
}

main().catch((err) => { console.error("OpenFlights snapshot failed:", err.message); process.exit(1); });

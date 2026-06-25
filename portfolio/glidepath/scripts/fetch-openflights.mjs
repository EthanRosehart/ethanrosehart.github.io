#!/usr/bin/env node
/* ============================================================
 * fetch-openflights.mjs — authoritative airport reference
 *
 * Pulls the OpenFlights airports.dat (a public CSV on GitHub) and
 * writes data/airports.json with the reference fields for EVERY
 * airport that has both an IATA and an ICAO code. fetch-activity.mjs
 * reads this to map the ICAO codes the aviation feeds report back to
 * IATA, and to enrich the catalogue with names / coordinates. It then
 * trims airports.json down to the airports that actually carry data,
 * so the file the browser loads stays small.
 *
 * OpenFlights is a static dataset, not a live API, so this just keeps
 * our identifiers/coords in sync with the canonical source.
 *
 * Run locally:  node scripts/fetch-openflights.mjs
 * ============================================================ */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data", "airports.json");

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
  const airports = {};

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // cols: id,name,city,country,IATA,ICAO,lat,lon,alt,tzoff,dst,tzname,type,source
    const c = parseLine(line);
    const iata = c[4], icao = c[5], type = c[12];
    if (!iata || !icao || iata.length !== 3) continue;          // need both codes
    if (type && type !== "airport") continue;                  // skip stations/ports
    if (airports[iata]) continue;                              // keep first match
    airports[iata] = {
      icao, name: c[1], city: c[2], country: c[3],
      lat: c[6] != null ? +c[6] : null,
      lon: c[7] != null ? +c[7] : null,
      elev_ft: c[8] != null ? +c[8] : null,
      tz: c[11],
      source: "openflights",
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    seed: false,
    source: "OpenFlights airports.dat (github.com/jpatokal/openflights)",
    note: "Full authoritative airport reference (every airport with IATA+ICAO). fetch-activity.mjs trims this to the airports that carry data.",
    count: Object.keys(airports).length,
    airports,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out) + "\n", "utf8");
  console.log(`Wrote ${OUT} — ${out.count} airports (full reference).`);
}

main().catch((err) => { console.error("OpenFlights snapshot failed:", err.message); process.exit(1); });

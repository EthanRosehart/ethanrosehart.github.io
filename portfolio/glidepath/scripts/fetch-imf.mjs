#!/usr/bin/env node
/* ONE-SHOT DIAGNOSTIC (temporary, branch-only — never merged to main).
 * Asks the IMF DataMapper API what actually exists instead of guessing:
 *  1. /indicators — the authoritative indicator catalogue; print every
 *     entry whose label mentions GDP per capita or population, WITH its
 *     dataset, so we finally learn the real WEO per-capita indicator ID.
 *  2. Response shapes for the candidate indicators, whole-dataset and
 *     single-country forms.
 * Exits 1 so nobody mistakes a probe run for a working snapshot. */

const API = "https://www.imf.org/external/datamapper/api/v1";
const get = async (path) => {
  const res = await fetch(`${API}${path}`, { headers: { "User-Agent": "glidepath-data-bot" } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, raw: text };
};

// 1: the indicator catalogue
{
  const { status, body, raw } = await get("/indicators");
  console.log(`\n=== /indicators -> HTTP ${status}, top-level keys: ${body ? JSON.stringify(Object.keys(body)) : raw.slice(0, 200)}`);
  const inds = body?.indicators || {};
  console.log(`total indicators: ${Object.keys(inds).length}`);
  for (const [id, meta] of Object.entries(inds)) {
    const label = (meta?.label || "") + " " + (meta?.description || "");
    if (/per capita|population/i.test(label)) {
      console.log(`  ${id.padEnd(16)} | ${meta?.label} | unit=${meta?.unit} | dataset=${meta?.dataset ?? meta?.source ?? "?"}`);
    }
  }
}

// 2: shapes for candidates
for (const path of [
  "/NGDP_RPCH/CAN",   // real GDP growth, single country — believed canonical
  "/LP/CAN",          // population, single country
  "/NGDPDPC/CAN",     // GDP per capita current USD
  "/PPPPC/CAN",       // GDP per capita current PPP
  "/NGDPRPPPPC",      // what the current fetcher tried (whole dataset)
  "/NGDP_RPCH",       // whole dataset form of the flagship
]) {
  const { status, body, raw } = await get(path);
  const values = body?.values;
  const indKey = values && Object.keys(values)[0];
  const countries = indKey ? Object.keys(values[indKey]) : [];
  const firstCountry = countries[0];
  const years = firstCountry ? Object.keys(values[indKey][firstCountry]) : [];
  console.log(`\n=== ${path} -> HTTP ${status}`);
  console.log(`  top-level: ${body ? JSON.stringify(Object.keys(body)) : "UNPARSEABLE: " + raw.slice(0, 150)}`);
  console.log(`  values keys: ${values ? JSON.stringify(Object.keys(values).slice(0, 5)) : "none"}`);
  console.log(`  countries under ${indKey}: ${countries.length} (sample: ${countries.slice(0, 8).join(",")})`);
  if (firstCountry) console.log(`  ${firstCountry} years: ${years.length} (${years[0]}..${years[years.length - 1]}), sample: ${JSON.stringify(Object.fromEntries(Object.entries(values[indKey][firstCountry]).slice(-4)))}`);
}

console.log("\nPROBE COMPLETE");
process.exit(1); // never let a probe run look like a good snapshot

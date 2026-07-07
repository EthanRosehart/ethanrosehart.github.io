#!/usr/bin/env node
/* ============================================================
 * build-manifest.mjs — writes data/manifest.json, the one-file audit
 * trail for everything under data/: which upstream source produced each
 * snapshot, when, under what license, and how much of it there is.
 * Runs at the end of the nightly refresh (after validation, before
 * commit); the export screen's provenance copy points here.
 *
 * Run locally:  node scripts/build-manifest.mjs
 * ============================================================ */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, "..", "data");

async function loadJSON(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }

/* upstream license/terms notes — kept here (not fetched) because they
   change on upstream's schedule, not ours; verify when adding a source */
const UPSTREAM = {
  openflights: { source: "OpenFlights airports.dat", url: "https://openflights.org/data", terms: "ODbL (database) — attribution + share-alike" },
  eurostat: { source: "Eurostat avia_paoa / avia_gooa", url: "https://ec.europa.eu/eurostat", terms: "CC BY 4.0 (Eurostat reuse policy)" },
  statcan: { source: "Statistics Canada WDS 23-10-0312 / 23-10-0296", url: "https://www.statcan.gc.ca", terms: "Statistics Canada Open Licence" },
  worldbank: { source: "World Bank Open Data Indicators API", url: "https://data.worldbank.org", terms: "CC BY 4.0" },
  imf: { source: "IMF World Economic Outlook (DataMapper API)", url: "https://www.imf.org/external/datamapper", terms: "IMF terms — attribution" },
};

export async function buildManifest(dataDir = DATA) {
  const index = await loadJSON(resolve(dataDir, "activity-index.json"));
  const airportsRef = await loadJSON(resolve(dataDir, "airports.json"));
  const macro = await loadJSON(resolve(dataDir, "macro.json"));
  const imf = await loadJSON(resolve(dataDir, "imf-weo.json"));
  const fcMeta = await loadJSON(resolve(dataDir, "forecast-meta.json"));

  const list = async (dir) => { try { return (await readdir(resolve(dataDir, dir))).filter((f) => f.endsWith(".json")); } catch { return []; } };
  const seriesFiles = await list("series");
  const forecastFiles = await list("forecasts");

  const bySource = {};
  for (const a of Object.values(index?.airports || {})) {
    const k = (a.source || "unknown").split(":")[0];
    bySource[k] = (bySource[k] || 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    note: "Provenance manifest for every snapshot under data/. Rebuilt at the end of each nightly refresh (scripts/build-manifest.mjs).",
    upstreams: UPSTREAM,
    snapshots: {
      "activity-index.json": { generatedAt: index?.generatedAt ?? null, airports: Object.keys(index?.airports || {}).length, airportsBySource: bySource },
      "series/": { files: seriesFiles.length },
      "airports.json": { generatedAt: airportsRef?.generatedAt ?? null, airports: Object.keys(airportsRef?.airports || {}).length, upstream: "openflights" },
      "macro.json": { generatedAt: macro?.generatedAt ?? null, countries: Object.keys(macro?.countries || {}).length, upstream: "worldbank" },
      "imf-weo.json": { generatedAt: imf?.generatedAt ?? null, countries: Object.keys(imf?.countries || {}).length, upstream: "imf" },
      "forecast-meta.json": { generatedAt: fcMeta?.generatedAt ?? null, model: fcMeta?.model ?? null },
      "forecasts/": { files: forecastFiles.length },
    },
  };
}

async function main() {
  const manifest = await buildManifest();
  const out = resolve(DATA, "manifest.json");
  await writeFile(out, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`Wrote ${out} — ${manifest.snapshots["activity-index.json"].airports} airports, ${manifest.snapshots["forecasts/"].files} forecasts.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("build-manifest failed:", e.message); process.exit(1); });
}

#!/usr/bin/env node
/* ============================================================
 * check-snapshots.mjs — staleness + anomaly report for the nightly.
 *
 * Two jobs, both about making feed problems LOUD instead of silent
 * (every fetch step is best-effort by design, which is right for
 * keeping last-good data but wrong for observability):
 *
 *   1. STALENESS (errors, exit 1): any core snapshot whose generatedAt
 *      is older than MAX_AGE_DAYS — the signature of a fetcher that has
 *      been quietly failing for days.
 *   2. ANOMALIES (warnings, exit 0): suspicious deltas vs a baseline
 *      copy of data/ taken before the fetchers ran — airports dropped,
 *      series that shrank, or a large level shift in months both
 *      snapshots cover (a unit change or upstream restatement).
 *
 * Usage:
 *   node scripts/check-snapshots.mjs                     # staleness only
 *   node scripts/check-snapshots.mjs --baseline <dir>    # + anomaly diff
 *
 * Output goes to stdout; refresh-data.yml pastes it into the pipeline
 * health issue. Pure helpers exported for test/pipeline.test.mjs.
 * ============================================================ */
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, "..", "data");

export const MAX_AGE_DAYS = 10;
const SHIFT_PCT = 30;      // level shift in an overlapping month worth flagging
const MIN_SHIFT_MONTHS = 3; // ...if at least this many months shifted together

export function ageDays(iso, now = Date.now()) {
  const t = Date.parse(iso);
  return isNaN(t) ? Infinity : (now - t) / 86400000;
}

/** Staleness findings for the core snapshots. -> [{file, days}] */
export function staleSnapshots(metas, now = Date.now(), maxDays = MAX_AGE_DAYS) {
  const out = [];
  for (const [file, doc] of Object.entries(metas)) {
    if (!doc) { out.push({ file, days: Infinity }); continue; }
    const d = ageDays(doc.generatedAt, now);
    if (d > maxDays) out.push({ file, days: Math.floor(d) });
  }
  return out;
}

/** Per-source freshness for feeds that stamp `refreshedAt` on their
 *  activity-index entries (currently BTS). The index-level generatedAt check
 *  above can't see a stuck BTS: fetch-activity.mjs rewrites activity-index's
 *  own generatedAt every night regardless of whether BTS delivered, so BTS's
 *  series files would go stale silently. Uses the FRESHEST stamp per source —
 *  an all-or-nothing feed stamps all its airports together on a live refresh,
 *  so the newest stamp is the last time the feed actually delivered. Sources
 *  with no stamped entry are skipped (no signal yet). -> [{source, days}] */
export function sourceStaleness(index, now = Date.now(), maxDays = MAX_AGE_DAYS) {
  const freshest = {};
  for (const a of Object.values(index?.airports || {})) {
    if (!a || typeof a.source !== "string" || a.refreshedAt == null) continue;
    const d = ageDays(a.refreshedAt, now);
    if (freshest[a.source] == null || d < freshest[a.source]) freshest[a.source] = d;
  }
  const out = [];
  for (const [source, days] of Object.entries(freshest)) {
    if (days > maxDays) out.push({ source, days: days === Infinity ? Infinity : Math.floor(days) });
  }
  return out;
}

/** Airports present in prev but gone from next. */
export function droppedAirports(prevIndex, nextIndex) {
  const next = new Set(Object.keys(nextIndex?.airports || {}));
  return Object.keys(prevIndex?.airports || {}).filter((i) => !next.has(i));
}

/** Anomalies between one airport's previous and current monthly series.
 *  -> array of human-readable warnings. */
export function seriesAnomalies(iata, prevSeries, nextSeries) {
  const warns = [];
  for (const metric of ["pax", "atm", "cargo"]) {
    const p = prevSeries?.[metric], n = nextSeries?.[metric];
    if (!p || !Object.keys(p).length) continue;
    if (!n || !Object.keys(n).length) { warns.push(`${iata}/${metric}: series vanished (${Object.keys(p).length} months before)`); continue; }
    const pk = Object.keys(p).length, nk = Object.keys(n).length;
    if (nk < pk - 1) warns.push(`${iata}/${metric}: history shrank ${pk} -> ${nk} months`);
    // level shift across overlapping months (unit change / restatement)
    let shifted = 0, overlap = 0;
    for (const k of Object.keys(p)) {
      if (n[k] == null || p[k] === 0) continue;
      overlap++;
      if (Math.abs(n[k] / p[k] - 1) * 100 > SHIFT_PCT) shifted++;
    }
    if (overlap >= 6 && shifted >= MIN_SHIFT_MONTHS && shifted / overlap > 0.25) {
      warns.push(`${iata}/${metric}: ${shifted}/${overlap} already-published months moved >${SHIFT_PCT}% — unit change or restatement?`);
    }
  }
  return warns;
}

/* ---- runner --------------------------------------------------- */
async function loadJSON(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }

async function main() {
  const baselineIdx = process.argv.indexOf("--baseline");
  const baseline = baselineIdx > -1 ? process.argv[baselineIdx + 1] : null;

  const metas = {
    "activity-index.json": await loadJSON(resolve(DATA, "activity-index.json")),
    "airports.json": await loadJSON(resolve(DATA, "airports.json")),
    "macro.json": await loadJSON(resolve(DATA, "macro.json")),
    "imf-weo.json": await loadJSON(resolve(DATA, "imf-weo.json")),
    "forecast-meta.json": await loadJSON(resolve(DATA, "forecast-meta.json")),
  };
  const stale = staleSnapshots(metas);
  const staleSources = sourceStaleness(metas["activity-index.json"]);
  const warns = [];

  if (baseline) {
    const prevIndex = await loadJSON(resolve(baseline, "activity-index.json"));
    const nextIndex = metas["activity-index.json"];
    for (const iata of droppedAirports(prevIndex, nextIndex)) warns.push(`${iata}: dropped from the catalogue`);
    let prevFiles = [];
    try { prevFiles = (await readdir(resolve(baseline, "series"))).filter((f) => f.endsWith(".json")); } catch {}
    for (const f of prevFiles) {
      const iata = f.slice(0, -5);
      const prev = (await loadJSON(resolve(baseline, "series", f)))?.series;
      const next = (await loadJSON(resolve(DATA, "series", f)))?.series;
      warns.push(...seriesAnomalies(iata, prev, next));
    }
  }

  if (warns.length) {
    console.log(`ANOMALIES (${warns.length}) — data still ships, but a human should look:`);
    for (const w of warns) console.log("  ~ " + w);
  }
  if (stale.length || staleSources.length) {
    console.log(`STALE SNAPSHOTS (older than ${MAX_AGE_DAYS} days) — a fetcher is failing silently:`);
    for (const s of stale) console.log(`  ! ${s.file}: ${s.days === Infinity ? "missing/unreadable" : s.days + " days old"}`);
    for (const s of staleSources) console.log(`  ! source "${s.source}": last live refresh ${s.days === Infinity ? "unknown" : s.days + " days ago"}`);
    process.exit(1);
  }
  if (!warns.length) console.log("check-snapshots: all snapshots fresh, no anomalies.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("check-snapshots failed:", e.message); process.exit(1); });
}

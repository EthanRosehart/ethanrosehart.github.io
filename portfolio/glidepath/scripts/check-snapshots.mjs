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
 *   2. MASS CATALOGUE LOSS (errors, exit 1): more than MAX_DROPPED
 *      airports vanishing from the catalogue in a single night. A gateway
 *      or two rotating out of the volume-ranked cap is ordinary churn; 29
 *      of them going at once (2026-07-25: Paris CDG, Zurich, Dublin,
 *      Brussels, Lisbon, Athens, Istanbul and 22 more, series files
 *      pruned) is an incident that shipped under a green run because
 *      dropped airports were only ever a warning.
 *   3. ANOMALIES (warnings, exit 0): the rest of the suspicious deltas vs
 *      a baseline copy of data/ taken before the fetchers ran — series
 *      that shrank, a large level shift in months both snapshots cover, or
 *      new months arriving at a different scale entirely (2026-08: German
 *      freight switched to kilograms and shipped, because every check here
 *      compared only months the two snapshots had in common). Plus a
 *      forecast whose backtest error is past anything a model choice
 *      explains, which is what a broken series looks like downstream.
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
const BREAK_FACTOR = 50;    // new months this far off the published level are a scale break
const MAX_MASE = 50;        // a backtest error no modelling choice explains
/* Airports may rotate out of the volume-ranked European cap night to night,
   so a small drop is churn. Past these bounds it's a feed defect, and the
   site silently loses gateways plus their whole committed history. */
export const MAX_DROPPED = 2;       // absolute: more than this pages
export const MAX_DROPPED_PCT = 5;   // ...or more than this % of the catalogue

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

/** Is tonight's catalogue loss big enough to page? -> message or null.
 *  Counted against the PREVIOUS catalogue size, since that's what was
 *  actually lost. Nothing dropped, or a couple of gateways rotating out of
 *  the volume cap, stays a warning. */
export function massDropAlert(dropped, prevIndex, max = MAX_DROPPED, maxPct = MAX_DROPPED_PCT) {
  const n = dropped.length;
  if (!n) return null;
  const prevN = Object.keys(prevIndex?.airports || {}).length;
  const pct = prevN ? (n / prevN) * 100 : 100;
  if (n <= max && pct <= maxPct) return null;
  return `${n} airport${n === 1 ? "" : "s"} dropped from the catalogue in one run` +
    (prevN ? ` (${pct.toFixed(0)}% of ${prevN})` : "") +
    ` — their series files are pruned too: ${dropped.slice(0, 12).join(", ")}${n > 12 ? `, +${n - 12} more` : ""}`;
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
    // ...and the same shift arriving as NEW months, which the overlap test
    // above cannot see. That is how the 2026-08 kilogram break shipped: the
    // German cargo months were all new, so nothing overlapped to compare.
    const pk2 = Object.keys(p).filter(k => p[k] > 0).sort();
    if (pk2.length >= 12) {
      const last = pk2[pk2.length - 1];
      const added = Object.keys(n).filter(k => k > last && n[k] > 0).sort();
      if (added.length) {
        const r = med(added.map(k => n[k])) / med(pk2.slice(-12).map(k => p[k]));
        if (r >= BREAK_FACTOR || r <= 1 / BREAK_FACTOR) {
          warns.push(`${iata}/${metric}: ${added.length} new month${added.length === 1 ? "" : "s"} from ${added[0]} sit ` +
            `${r >= 1 ? `${r.toFixed(0)}x above` : `${(1 / r).toFixed(0)}x below`} the last 12 published — scale break, not growth`);
        }
      }
    }
  }
  return warns;
}

function med(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

/** Forecasts whose two error measures disagree about reality — the downstream
 *  signature of a series that changed scale.
 *
 *  MASE is held-out error over the in-sample seasonal-naive error (~1 is par),
 *  MAPE is the same error as a percentage of the actual. Munich's cargo shipped
 *  at MASE 2737 with MAPE 19%: the model tracked the kilogram months perfectly
 *  well in percentage terms while scoring thousands of times worse than a
 *  naive scaled in tonnes. That gap is the tell, and it is why BOTH numbers
 *  are needed — MAPE is scale-free and cannot see a unit change at all.
 *
 *  A huge MASE with an equally huge MAPE is a different animal: Lublin's
 *  freight is 0-1 tonnes most months with a seasonal burst to 1867, so the
 *  naive denominator is nearly zero and MASE stops meaning anything. Those
 *  series are unforecastable, not broken, and warning about them nightly
 *  would just train everyone to skip the report. */
export function forecastAnomalies(iata, doc, { maxMase = MAX_MASE, sameStoryMape = 40 } = {}) {
  const warns = [];
  for (const metric of ["pax", "atm", "cargo"]) {
    const b = doc?.[metric];
    if (typeof b?.mase !== "number" || b.mase <= maxMase) continue;
    if (typeof b.mape === "number" && b.mape >= sameStoryMape) continue;   // both bad: a hard series
    warns.push(`${iata}/${metric}: backtest MASE ${b.mase.toFixed(0)} (par is ~1) against MAPE ${b.mape}% — ` +
      `the model fits the shape but not the scale, so look at the series, not the model`);
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
  let massDrop = null;

  if (baseline) {
    const prevIndex = await loadJSON(resolve(baseline, "activity-index.json"));
    const nextIndex = metas["activity-index.json"];
    const dropped = droppedAirports(prevIndex, nextIndex);
    for (const iata of dropped) warns.push(`${iata}: dropped from the catalogue`);
    massDrop = massDropAlert(dropped, prevIndex);
    let prevFiles = [];
    try { prevFiles = (await readdir(resolve(baseline, "series"))).filter((f) => f.endsWith(".json")); } catch {}
    for (const f of prevFiles) {
      const iata = f.slice(0, -5);
      const prev = (await loadJSON(resolve(baseline, "series", f)))?.series;
      const next = (await loadJSON(resolve(DATA, "series", f)))?.series;
      warns.push(...seriesAnomalies(iata, prev, next));
    }
  }

  // forecast sanity runs with or without a baseline: it reads tonight's own
  // numbers rather than a diff, and is the backstop for a series problem that
  // slipped past every check upstream of the model
  let fcFiles = [];
  try { fcFiles = (await readdir(resolve(DATA, "forecasts"))).filter((f) => f.endsWith(".json")); } catch {}
  for (const f of fcFiles) {
    warns.push(...forecastAnomalies(f.slice(0, -5), await loadJSON(resolve(DATA, "forecasts", f))));
  }

  if (warns.length) {
    console.log(`ANOMALIES (${warns.length}) — data still ships, but a human should look:`);
    for (const w of warns) console.log("  ~ " + w);
  }
  if (massDrop) {
    console.log("CATALOGUE LOSS — gateways vanished tonight, not just stale:");
    console.log(`  ! ${massDrop}`);
  }
  if (stale.length || staleSources.length) {
    console.log(`STALE SNAPSHOTS (older than ${MAX_AGE_DAYS} days) — a fetcher is failing silently:`);
    for (const s of stale) console.log(`  ! ${s.file}: ${s.days === Infinity ? "missing/unreadable" : s.days + " days old"}`);
    for (const s of staleSources) console.log(`  ! source "${s.source}": last live refresh ${s.days === Infinity ? "unknown" : s.days + " days ago"}`);
  }
  if (massDrop || stale.length || staleSources.length) process.exit(1);
  if (!warns.length) console.log("check-snapshots: all snapshots fresh, no anomalies.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("check-snapshots failed:", e.message); process.exit(1); });
}

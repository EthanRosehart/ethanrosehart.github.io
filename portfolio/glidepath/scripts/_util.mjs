/* ============================================================
 * _util.mjs — shared helpers for the Glidepath data pipeline
 *
 * Used by fetch-activity.mjs and fetch-bts.mjs, which both maintain the
 * same split layout: a small data/activity-index.json (catalogue metadata,
 * no series) plus one data/series/<IATA>.json per airport (the actual
 * monthly numbers). Splitting keeps the browser's initial load small — it
 * only needs the index to build the airport picker; the per-airport file is
 * fetched once a visitor actually selects that gateway.
 * ============================================================ */

/** Sum of the most recent COMPLETE (12-month) calendar year in a
 *  {"YYYY-MM": number} series. Used to show a "68.0M/yr" style summary in
 *  the airport picker without the browser having to download the full
 *  monthly series for every airport in the list. */
export function lastFullYearTotal(monthly) {
  if (!monthly) return null;
  const byYear = {};
  for (const [k, v] of Object.entries(monthly)) {
    if (v == null) continue;
    const y = k.slice(0, 4);
    (byYear[y] ||= []).push(v);
  }
  const fullYears = Object.keys(byYear).filter((y) => byYear[y].length === 12).sort();
  if (!fullYears.length) return null;
  const y = fullYears[fullYears.length - 1];
  return Math.round(byYear[y].reduce((a, b) => a + b, 0));
}

/** Which metrics (pax/atm/cargo) actually carry data in a per-airport
 *  series object — lets the UI know what's available before it has
 *  downloaded the series itself. */
export function metricsIn(series) {
  return ["pax", "atm", "cargo"].filter((m) => series?.[m] && Object.keys(series[m]).length);
}

/** Delete any "<iata><suffix>" file in dir whose <iata> isn't in
 *  keepIatas, so removed/renamed airports don't leave orphaned files
 *  behind forever. Best-effort: a missing dir is not an error. */
export async function pruneDir(dir, keepIatas, suffix = ".json") {
  const { readdir, unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  let files;
  try { files = await readdir(dir); } catch { return; }
  const keep = new Set(keepIatas);
  for (const f of files) {
    if (!f.endsWith(suffix)) continue;
    const iata = f.slice(0, -suffix.length);
    if (!keep.has(iata)) await unlink(join(dir, f)).catch(() => {});
  }
}

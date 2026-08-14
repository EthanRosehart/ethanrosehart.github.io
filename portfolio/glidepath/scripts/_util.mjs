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

/* ---- transient-failure retry ---------------------------------
   Every upstream here occasionally serves a one-off 5xx or drops the
   connection mid-handshake (a World Bank 502 failed the whole nightly on
   2026-07-13; a Eurostat "fetch failed" wiped the European enumerate on
   2026-07-23). Those are weather, not incidents, so they get retried with
   backoff before anything downstream treats them as a feed outage.

   Returns the Response whatever its status — callers own the non-ok case,
   since some statuses are load-bearing signals rather than errors (Eurostat
   answers 413 to mean "ask for a smaller window"). Only a network error
   that never once produced a response throws. */
const TRANSIENT_RETRIES = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Retrying each call independently is right when a feed blips and ruinous
   when one is properly down: fetch-activity makes ~50 StatCan calls a night,
   and four backed-off retries each (2+4+8+16s) would add ~24 minutes of pure
   sleeping to a run that should fail fast and keep last-good. So a host that
   burns its whole retry budget twice running trips a breaker, and further
   calls to that host get a single attempt until one succeeds and resets it. */
const CIRCUIT_TRIP_AFTER = 2;
const _breaker = new Map();   // host -> consecutive exhausted-retry failures

/** Reset the per-host breakers (tests; also useful for a long-lived process). */
export function resetCircuitBreakers() { _breaker.clear(); }

function hostOf(url) { try { return new URL(String(url)).host; } catch { return String(url); } }

/** Should this response be retried? 429 (rate limit) and 5xx (server-side)
 *  are transient; every other status is the server's real answer. */
export function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

export async function fetchWithRetry(url, label, init = {}, retries = TRANSIENT_RETRIES) {
  const host = hostOf(url);
  const failures = _breaker.get(host) || 0;
  const budget = failures >= CIRCUIT_TRIP_AFTER ? 0 : retries;   // breaker open -> one shot
  for (let attempt = 0; ; attempt++) {
    let res = null, netErr = null;
    try { res = await fetch(url, init); }
    catch (err) { netErr = err; }
    if (res && !isTransientStatus(res.status)) {                // the server's real answer
      if (failures) _breaker.delete(host);                      // host is back
      return res;
    }
    if (attempt >= budget) {
      _breaker.set(host, failures + 1);
      if (failures + 1 === CIRCUIT_TRIP_AFTER) console.warn(`  ${label}: ${host} has failed ${CIRCUIT_TRIP_AFTER} times — no more retries this run until it answers`);
      if (res) return res;                                      // caller reports the status
      throw new Error(`${label}: ${netErr ? netErr.message : "network error"}${budget ? ` after ${budget + 1} attempts` : ""}`);
    }
    const wait = 2000 * 2 ** attempt;
    console.warn(`  ${label}: ${res ? `HTTP ${res.status}` : `network error (${netErr && netErr.message})`} — retrying in ${wait / 1000}s (${attempt + 1}/${budget})`);
    await sleep(wait);
  }
}

/* ---- last-good vs fresh series -------------------------------
   A fetcher's "keep last good on failure" contract only fires when a feed
   returns NOTHING. The dangerous case is the one in between: on 2026-07-25
   Eurostat answered for all 70 European airports but handed back a short
   window for 29 of them, so a 12-month reply overwrote a 132-month history
   and then failed the catalogue's 24-month floor — dropping Paris CDG,
   Zurich, Dublin, Brussels and 25 more off the live site, with their series
   files pruned, on a run that reported success.

   So a fresh series has to earn the replacement: it must clear `minFresh`
   months AND not be a material shrink against what's already on disk.
   Upstream restatements do legitimately trim a month or two, hence a
   tolerance rather than a strict >=.

   The deliberate trade-off: a genuine, permanent upstream truncation past
   the tolerance is now pinned to last-good indefinitely, warning once per
   run rather than shrinking the committed history. That's the safe
   direction — a stale month is recoverable, a pruned gateway is not — but
   it means the "kept previous" lines in the run log are worth reading if
   one repeats night after night. */
export function chooseSeries(fresh, prev, { minFresh = 12, shrinkTolerance = 0.8 } = {}) {
  const freshN = fresh ? Object.keys(fresh).length : 0;
  const prevN = prev ? Object.keys(prev).length : 0;
  if (freshN >= minFresh && (!prevN || freshN >= prevN * shrinkTolerance)) {
    return { series: fresh, kind: "fresh", reason: null };
  }
  if (prevN) {
    const reason = freshN < minFresh
      ? `fresh reply had only ${freshN}mo (need ${minFresh})`
      : `fresh reply shrank ${prevN}mo -> ${freshN}mo`;
    return { series: prev, kind: "kept", reason };
  }
  if (freshN >= minFresh) return { series: fresh, kind: "fresh", reason: null };
  return { series: null, kind: "none", reason: freshN ? `only ${freshN}mo and nothing on disk` : "no data" };
}

/* ---- scale breaks in an otherwise well-formed reply ------------
   chooseSeries() guards the reply's SHAPE. This guards its SCALE, which is
   the failure it can't see: on 2026-08-04 Eurostat's avia_gooa started
   answering for German airports in kilograms under the tonnes unit code.
   Every reply was full-length and every value was a finite number, so it
   sailed through the fetcher, the structural validator and the drift check
   (which only compares months BOTH snapshots already carry — these arrived
   as new months). Munich shipped 29,895,178 t for March, the long-term
   chart drew a 30M spike next to a 23k forecast, and the nightly refit a
   cargo model on the mixed series: MASE 2737, a band top of 12.8 billion
   tonnes. MAPE stayed at 19% throughout, because it is scale-free — it
   cannot see a unit change at all.

   Two shapes of the same failure. A feed can restate months it has already
   published at a different scale, or it can add new ones at a different
   scale; the first is checked against the published values themselves, the
   second against the range the series has occupied lately. Either way a
   reply `breakFactor` clear of what we hold is not growth, and doesn't ship
   as-is. Two outcomes from there:

     - the break is a clean power of ten AND rescaling by it puts the broken
       months within `yoyBand` of the same calendar months a year earlier
       -> a unit change, and we can undo it exactly. Rescale and ship.
     - anything else -> we don't know what happened. Keep last-good and say
       so; a stale cargo month is recoverable, a 1000x one is not.

   Two deliberate choices. The comparison is against the last year's RANGE,
   not its average, so a series that already swings 500x on its own (Verona
   ran 1 to 573 tonnes last year) can't trip it — those airports move enough
   that no factor would mean anything. And the proof is seasonal, same month
   a year earlier, because freight has a shape: a trailing mean would both
   miss real breaks and reject real Februaries. */
export function levelBreak(fresh, prev, { breakFactor = 50, minProof = 3, yoyBand = [0.75, 1.35], looseBand = [0.5, 2.0] } = {}) {
  const ok = { verdict: "ok", series: fresh, reason: null };
  if (!fresh || !prev) return ok;
  const prevKeys = Object.keys(prev).filter(k => Number.isFinite(prev[k])).sort();
  if (prevKeys.length < 12) return ok;                       // no level to compare against

  /* First the whole-series case, because it is the one that can quietly
     rewrite history. Eurostat is republishing avia_gooa in kilograms under
     the "Tonne" label: on 2026-08-12 it went from 5 months to 17 over the
     course of a day, Frankfurt's newest reading 172,169,367 against the
     172,169 tonnes we hold. While the reply is short, chooseSeries keeps
     last-good and none of this matters. The day the backfill passes our
     133 months, a reply arrives that is entirely in kilograms — and rescaling
     only its NEW months would ship a x1000 history with a tidy-looking tail
     bolted on. So months we have already published are the reference: they
     should come back as the same numbers, and if they come back uniformly
     scaled by a power of ten, the whole reply moves with them. */
  const both = prevKeys.filter(k => prev[k] > 0 && Number.isFinite(fresh[k]) && fresh[k] > 0);
  if (both.length >= 12) {
    const r = median(both.map(k => fresh[k] / prev[k]));
    if (r >= 10 || r <= 0.1) {
      const step = Math.round(Math.log10(r));
      const scale = 10 ** step;
      // the same months, so the test is exact rather than seasonal: rescaled,
      // they have to land back on what we published, give or take a revision
      const agree = both.filter(k => Math.abs(fresh[k] / scale / prev[k] - 1) < 0.02).length;
      const detail = `every month restated ${r >= 1 ? `${r.toFixed(0)}x up` : `${(1 / r).toFixed(0)}x down`} across ${both.length} already-published months`;
      if (Math.abs(Math.log10(r) - step) < 0.05 && agree / both.length >= 0.9) {
        const whole = prevKeys.every(k => Number.isInteger(prev[k]));
        const out = {};
        for (const [k, v] of Object.entries(fresh)) out[k] = whole ? Math.round(v / scale) : v / scale;
        return { verdict: "rescaled", series: out, scale, reason: `${detail} — a clean 10^${step} unit change, ${agree}/${both.length} months land back on the published values, whole series rescaled` };
      }
      return { verdict: "rejected", series: prev, reason: `${detail} — not a confirmable unit change (${agree}/${both.length} months would land back on the published values), kept previous` };
    }
  }

  const lastPrev = prevKeys[prevKeys.length - 1];
  const added = Object.keys(fresh).filter(k => k > lastPrev && Number.isFinite(fresh[k]) && fresh[k] > 0).sort();
  if (!added.length) return ok;

  const tail = prevKeys.slice(-12).map(k => prev[k]);
  const hi = Math.max(...tail), lo = Math.min(...tail);
  const breaks = (v) => (hi > 0 && v / hi >= breakFactor) || (lo > 0 && lo / v >= breakFactor);
  // everything from the first broken month on: a feed that changes units
  // doesn't change back, and the months before it are still good
  const at = added.findIndex(k => breaks(fresh[k]));
  if (at < 0) return ok;
  const seg = added.slice(at);

  const ratio = median(seg.map(k => fresh[k])) / median(tail.filter(v => v > 0));
  const step = Math.round(Math.log10(ratio));
  const scale = 10 ** step;
  const proof = [];
  for (const k of seg) {
    const prior = `${+k.slice(0, 4) - 1}${k.slice(4)}`;
    if (prev[prior] > 0) proof.push(fresh[k] / scale / prev[prior]);
  }
  // The prior-year comparison carries the decision; the power-of-ten test is
  // only there to stop an arbitrary jump being "corrected" by 1000. Both are
  // robust rather than strict — one freak month (a diverted freighter, a
  // reporting gap) must not veto an otherwise unmistakable unit change, and
  // a pair of months either side of 1.0 must not wave through a series that
  // is bouncing around at random.
  const clean = Math.abs(Math.log10(ratio) - step) < 0.35;
  const mid = proof.length ? median(proof) : NaN;
  const near = proof.filter(v => v >= looseBand[0] && v <= looseBand[1]).length;
  const holds = proof.length >= minProof
    && mid >= yoyBand[0] && mid <= yoyBand[1]
    && near / proof.length >= 2 / 3;
  const detail = `${seg.length} month${seg.length === 1 ? "" : "s"} from ${seg[0]} sit ` +
    `${ratio >= 1 ? `${ratio.toFixed(0)}x above` : `${(1 / ratio).toFixed(0)}x below`} the last published year`;
  if (clean && holds) {
    // keep the series homogeneous: a feed publishing whole tonnes shouldn't
    // start carrying three decimal places for the months we divided
    const whole = tail.every(Number.isInteger);
    const out = { ...fresh };
    for (const k of seg) out[k] = whole ? Math.round(fresh[k] / scale) : fresh[k] / scale;
    return { verdict: "rescaled", series: out, scale, reason: `${detail} — a clean 10^${step} unit change, confirmed against ${proof.length} prior-year months, rescaled` };
  }
  // drop the broken tail rather than the whole reply: months before the break
  // are good data, and on a feed that has already published them they are the
  // last-good series anyway
  const out = {};
  for (const [k, v] of Object.entries(fresh)) if (!(k >= seg[0])) out[k] = v;
  return { verdict: "rejected", series: out, reason: `${detail} — not a confirmable unit change (${proof.length} prior-year month${proof.length === 1 ? "" : "s"} to check against), dropped` };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

/** How many months behind `now` the newest month in a {"YYYY-MM": n} series
 *  is. Infinity for an empty or unparsable series. Used to decide when an
 *  airport we're carrying on committed history has been frozen long enough
 *  that its feed is genuinely gone rather than briefly down. */
export function seriesAgeMonths(monthly, now = new Date()) {
  const keys = Object.keys(monthly || {});
  if (!keys.length) return Infinity;
  const m = /^(\d{4})-(\d{2})$/.exec(keys.sort()[keys.length - 1]);
  if (!m) return Infinity;
  return (now.getUTCFullYear() - +m[1]) * 12 + (now.getUTCMonth() + 1 - +m[2]);
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

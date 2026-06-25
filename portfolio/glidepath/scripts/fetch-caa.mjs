#!/usr/bin/env node
/* ============================================================
 * fetch-caa.mjs — UK monthly activity (CAA via data.gov.uk CKAN)
 *
 * UK airports left Eurostat after Brexit (data ends 2020-10), so the
 * 3 UK regionals (Exeter/Newquay/Inverness) need the CAA airport
 * statistics published on data.gov.uk. This first pass DISCOVERS the
 * right dataset/resource (logging candidate resources, datastore
 * status, fields and a sample row) and, if a queryable datastore
 * resource is found, attempts to pull monthly passengers/movements.
 * Merges any results into data/activity.json. Best-effort + verbose.
 * ============================================================ */
import { writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data", "activity.json");
const CKAN = "https://data.gov.uk/api/3/action";
const UA = { "User-Agent": "glidepath-data-bot" };
const UK = { EXT: /exeter/i, NQY: /newquay|cornwall/i, INV: /inverness/i };

async function ckan(action, qs) {
  const res = await fetch(`${CKAN}/${action}?${qs}`, { headers: UA });
  if (!res.ok) throw new Error(`${action} HTTP ${res.status}`);
  const js = await res.json();
  if (!js.success) throw new Error(`${action} not success`);
  return js.result;
}

async function discover() {
  // search CAA datasets that look like airport activity/statistics
  const r = await ckan("package_search", "q=airport+statistics+CAA&rows=30").catch((e) => { console.warn("  [caa] search failed:", e.message); return null; });
  if (!r) return [];
  console.log(`  [caa] ${r.count} datasets matched; scanning top ${r.results.length}`);
  const candidates = [];
  for (const d of r.results) {
    const org = d.organization?.name || "";
    for (const res of d.resources || []) {
      const hay = `${d.title} ${res.name} ${res.description || ""}`;
      if (!/airport|punctual|aircraft|passenger/i.test(hay)) continue;
      const cand = { dataset: d.title, org, name: res.name, format: res.format, datastore: !!res.datastore_active, id: res.id, url: res.url };
      candidates.push(cand);
    }
  }
  candidates.slice(0, 25).forEach((c) => console.log(`  [caa] cand ds="${c.dataset}" res="${c.name}" fmt=${c.format} datastore=${c.datastore} id=${c.id}`));
  return candidates;
}

async function probeDatastore(id) {
  // log fields + a sample row so we learn the schema
  const r = await ckan("datastore_search", `resource_id=${id}&limit=3`).catch((e) => { console.warn(`  [caa] datastore ${id} failed:`, e.message); return null; });
  if (!r) return null;
  console.log(`  [caa] datastore ${id} fields:`, (r.fields || []).map((f) => f.id).join(", "));
  if (r.records && r.records[0]) console.log(`  [caa] sample:`, JSON.stringify(r.records[0]).slice(0, 300));
  return r;
}

async function main() {
  let data; try { data = JSON.parse(await readFile(OUT, "utf8")); } catch { data = { airports: {} }; }
  data.airports = data.airports || {};

  const candidates = await discover();
  // probe the first couple of datastore-backed candidates to learn schema
  const ds = candidates.filter((c) => c.datastore).slice(0, 3);
  if (!ds.length) console.warn("  [caa] no datastore-backed resources found — UK needs a CSV-download parser (next iteration)");
  for (const c of ds) await probeDatastore(c.id);

  // NOTE: actual extraction wired once the schema is confirmed from the logs
  // above. UK airports stay absent until then (no synthetic fallback).
  await writeFile(OUT, JSON.stringify(data) + "\n", "utf8");
  console.log("CAA discovery done.");
}

main().catch((e) => { console.error("CAA failed:", e.message); process.exit(1); });

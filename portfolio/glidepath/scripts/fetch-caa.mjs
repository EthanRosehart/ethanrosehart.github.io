#!/usr/bin/env node
/* ============================================================
 * fetch-caa.mjs — UK monthly activity (CAA airport data)
 *
 * UK airports left Eurostat after Brexit. The CAA publishes monthly
 * airport statistics as CSV on caa.co.uk (one set of tables per
 * month). data.gov.uk only carries dead aspx links, so we go to the
 * CAA monthly pages directly, find the Table 10 (terminal
 * passengers) / Table 03 (air-transport movements) CSV links, and
 * parse the rows for our major UK airports.
 *
 * This pass PROBES: it fetches a couple of recent monthly pages with
 * a browser UA and logs HTTP status + any .csv links found, so the
 * parser can be wired from the real page/file structure. Best-effort;
 * UK stays absent until extraction is confirmed (no synthetic).
 *
 * Run locally:  node scripts/fetch-caa.mjs
 * ============================================================ */
import { writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data", "activity.json");
// major UK airports that appear in CAA airport data (swap for the Brexit-
// orphaned regionals). name patterns match the CAA "Reporting airport" column.
const UK = { BRS: /bristol/i, EDI: /edinburgh/i, BHX: /birmingham/i };
const BROWSER = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", "Accept": "text/html,application/xhtml+xml" };
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

function monthPages(n) {
  // most-recent n monthly pages, e.g. .../uk-airport-data-2025/october-2025/
  const out = [];
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth(); // 0-based
  for (let i = 0; i < n; i++) {
    m--; if (m < 0) { m = 11; y--; }
    out.push(`https://www.caa.co.uk/data-and-analysis/uk-aviation-market/airports/uk-airport-data/uk-airport-data-${y}/${MONTHS[m]}-${y}/`);
  }
  return out;
}

async function probe(url) {
  let res;
  try { res = await fetch(url, { headers: BROWSER, redirect: "follow" }); }
  catch (e) { console.warn(`  [caa] ${url} fetch error: ${e.message}`); return; }
  console.log(`  [caa] ${url} -> HTTP ${res.status}`);
  if (!res.ok) return;
  const html = await res.text();
  // collect .csv links + nearby text labels
  const links = [...html.matchAll(/href="([^"]+\.csv[^"]*)"/gi)].map((m) => m[1]);
  console.log(`  [caa] found ${links.length} csv links`);
  links.slice(0, 12).forEach((l) => console.log(`  [caa] csv: ${l}`));
  // also log any link whose surrounding text mentions Table 10 / passengers
  const tableLinks = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]*(?:Table\s*10|Table\s*03|passenger|movement)[^<]*)<\/a>/gi)]
    .slice(0, 12).map((m) => `${m[2].trim()} -> ${m[1]}`);
  tableLinks.forEach((t) => console.log(`  [caa] table-link: ${t}`));
}

async function main() {
  let data; try { data = JSON.parse(await readFile(OUT, "utf8")); } catch { data = { airports: {} }; }
  data.airports = data.airports || {};

  for (const url of monthPages(2)) await probe(url);

  // extraction wired once the page/CSV structure is confirmed from the logs.
  await writeFile(OUT, JSON.stringify(data) + "\n", "utf8");
  console.log("CAA probe done.");
}

main().catch((e) => { console.error("CAA failed:", e.message); process.exit(1); });

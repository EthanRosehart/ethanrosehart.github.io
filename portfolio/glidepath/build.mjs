#!/usr/bin/env node
/* ============================================================
 * build.mjs — precompiles Glidepath's JSX into dist/app.bundle.js
 *
 * The six .jsx files are NOT bundled as ES modules — they share one
 * global scope on purpose (see README.md § Architecture), the same way
 * six separate <script> tags do today. So each file is transformed
 * (JSX → JS, minified) INDEPENDENTLY via esbuild's transform API, never
 * esbuild's bundler, and the results are concatenated in load order.
 * esbuild's minifier only renames identifiers it can prove are local to
 * a function/block; top-level names it can't prove are private survive
 * unchanged, which is exactly what lets later files keep referencing
 * earlier ones (AIRPORTS, MACRO, GP_*) by name after concatenation.
 *
 * Run once:      node build.mjs
 * Rebuild on save: node build.mjs --watch
 * ============================================================ */
import { transform } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "dist");
const OUT_FILE = resolve(OUT_DIR, "app.bundle.js");

// load order matters — later files reference consts/functions declared in
// earlier ones (AIRPORTS, MACRO, GP_Ico, ...) in the shared global scope.
const FILES = [
  "data.jsx", "charts.jsx", "screens-setup.jsx",
  "screens-forecast.jsx", "screens-strategic.jsx", "app.jsx",
];

async function build() {
  const start = performance.now();
  const parts = [];
  for (const f of FILES) {
    const src = await readFile(resolve(__dirname, f), "utf8");
    const { code, warnings } = await transform(src, {
      loader: "jsx",
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
      minify: true,
      target: "es2019",
      sourcefile: f,
    });
    for (const w of warnings) console.warn(`  ${f}: ${w.text}`);
    parts.push(`/* ---- ${f} ---- */\n${code}`);
  }
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, parts.join("\n"), "utf8");
  console.log(`Built ${OUT_FILE} (${(performance.now() - start).toFixed(0)}ms, ${FILES.length} files)`);
}

async function main() {
  await build();
  if (process.argv.includes("--watch")) {
    console.log("Watching for changes (Ctrl-C to stop)...");
    let pending = false;
    const rebuild = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; build().catch((e) => console.error(e.message)); }, 80);
    };
    for (const f of FILES) watch(resolve(__dirname, f), { persistent: true }, rebuild);
  }
}

main().catch((err) => { console.error("build failed:", err.message); process.exit(1); });

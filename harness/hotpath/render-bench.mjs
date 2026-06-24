// Hotspot profiler for the JS render tier (`native.render` — deno_core V8). This is
// the path a JS-mode crawl pays per page: parse → fresh V8 isolate → ENV_BOOTSTRAP →
// run the page's own scripts → drain timers/event-loop → serialize. The sibling
// `rust-hotpath.mjs` only times the WARM `evaluate` isolate (no-JS path); this one
// targets the render hotspot the js-quotes / js crawler benchmarks actually hit.
//
//   node harness/hotpath/render-bench.mjs                 # default sample (quotes/js)
//   node harness/hotpath/render-bench.mjs --url=<U>       # any JS-gated page
//   node harness/hotpath/render-bench.mjs --file=<path>   # local fixture (offline)
//   node harness/hotpath/render-bench.mjs --iters=50
//
// Caches the resolved (html, concatenated-script) pair under /tmp so reruns are
// offline + comparable. The script is extracted the SAME way the competitive
// adapter does (inline + external classic <script>s, source order) so the bench
// runs the exact code the crawl benchmark feeds the render tier.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const native = require("../../rust/crates/turbo-surf-napi/index.js");

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.slice(k.length + 3) : d;
};
const URL_ARG = arg("url", "https://quotes.toscrape.com/js/");
const FILE_ARG = arg("file", null);
const ITERS = Number(arg("iters", "30"));

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function time(label, fn, iters = ITERS) {
  const ts = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const m = median(ts);
  const mean = ts.reduce((a, b) => a + b, 0) / ts.length;
  console.log(
    `  ${label.padEnd(34)} median ${m.toFixed(2).padStart(8)}ms  mean ${mean
      .toFixed(2)
      .padStart(8)}ms  min ${Math.min(...ts).toFixed(2)}`,
  );
  return m;
}

// --- faithful classic-<script> extraction (mirrors competitive/rust-engine.mjs) ---
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const CLASSIC_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);
function attrValue(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  return m ? (m[2] ?? m[3] ?? m[4]) : null;
}
async function pageScript(html, baseUrl) {
  const parts = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const type = (attrValue(m[1], "type") ?? "").toLowerCase();
    if (!CLASSIC_TYPES.has(type) || type === "module") continue; // modules not executed here
    const src = attrValue(m[1], "src");
    if (src) {
      let url = src;
      try {
        url = new URL(src, baseUrl).href;
      } catch {
        /* keep raw */
      }
      parts.push(JSON.parse(await native.fetchHtml(url)).html);
    } else {
      parts.push(m[2]);
    }
  }
  return parts.join("\n;\n");
}

// Resolve (html, code) once and cache offline so reruns need no network.
async function sample() {
  if (FILE_ARG) {
    const html = readFileSync(FILE_ARG, "utf8");
    return { html, code: await pageScript(html, URL_ARG), url: URL_ARG, src: FILE_ARG };
  }
  const key = createHash("sha1").update(URL_ARG).digest("hex").slice(0, 12);
  const cacheHtml = `/tmp/turbo-render-${key}.html`;
  const cacheCode = `/tmp/turbo-render-${key}.js`;
  if (existsSync(cacheHtml) && existsSync(cacheCode)) {
    return {
      html: readFileSync(cacheHtml, "utf8"),
      code: readFileSync(cacheCode, "utf8"),
      url: URL_ARG,
      src: URL_ARG,
    };
  }
  const r = JSON.parse(await native.fetchHtml(URL_ARG));
  const code = await pageScript(r.html, r.finalUrl ?? URL_ARG);
  writeFileSync(cacheHtml, r.html);
  writeFileSync(cacheCode, code);
  return { html: r.html, code, url: r.finalUrl ?? URL_ARG, src: URL_ARG };
}

const { html, code, url, src } = await sample();
console.log(
  `\n=== render bench (${src})\n    page ${(html.length / 1024) | 0} KB, script ${
    (code.length / 1024) | 0
  } KB, ${ITERS} iters, no network ===`,
);
if (!code.trim()) {
  console.log("  (no classic scripts on this page — nothing for the render tier to run)");
  process.exit(0);
}

// Warm-isolate baseline (reused thread-local isolate, no event loop) so the gap to
// `render` exposes the per-page isolate-boot + ENV_BOOTSTRAP + event-loop cost.
time("native.evaluate (warm isolate)", () => native.evaluate(html, "document.title"));
// The actual JS-crawl per-page cost: fresh isolate + bootstrap + run scripts + drain.
time("native.render (fresh isolate/page)", () => native.render(html, url, code));
// The fast path: one isolate reused across pages (boot paid once) + a cross-page global
// scrub so each render still behaves like a fresh navigation.
if (native.renderPooled) {
  time("native.renderPooled (reused)", () => native.renderPooled(html, url, code));
}

// Sanity: pooled output must byte-match the fresh render (no cross-page contamination).
if (native.renderPooled) {
  const fresh = native.render(html, url, code);
  const pooled = native.renderPooled(html, url, code);
  console.log(
    `\n  parity: ${pooled === fresh ? "OK" : "DIFF"} (${pooled.length} bytes), hydrated from ${
      html.length
    } in`,
  );
}
process.exit(0);

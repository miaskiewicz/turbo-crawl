// Hotspot profiler for the Rust napi engine. Two views:
//   1) micro — each napi op timed in isolation on a cached page (no network), so
//      compute hotspots (parse / evaluate / serialize) are visible without jitter.
//   2) e2e   — the no-JS wikipedia routine timed per stage (network vs compute).
//
//   node harness/hotpath/rust-hotpath.mjs            # both
//   node harness/hotpath/rust-hotpath.mjs --micro     # micro only (offline after 1 fetch)
//
// Caches the sample page under /tmp so reruns are offline + comparable.

import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const native = require("../../rust/crates/turbo-crawl-napi/index.js");

const SAMPLE_URL = "https://en.wikipedia.org/wiki/Web_crawler";
const CACHE = "/tmp/turbo-hotpath-sample.html";

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function time(label, fn, iters = 30) {
  const ts = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const m = median(ts);
  console.log(
    `  ${label.padEnd(34)} median ${m.toFixed(2).padStart(7)}ms  min ${Math.min(...ts).toFixed(2)}`,
  );
  return m;
}

async function sample() {
  if (existsSync(CACHE)) return readFileSync(CACHE, "utf8");
  const r = JSON.parse(await native.fetchHtml(SAMPLE_URL));
  writeFileSync(CACHE, r.html);
  return r.html;
}

const FIND_FIRST = `(() => {
  const links = [...document.querySelectorAll("#bodyContent a[href^='/wiki/']")];
  const a = links.find((el) => !el.getAttribute("href").includes(":"));
  return a ? a.getAttribute("href") : null;
})()`;

async function micro() {
  const html = await sample();
  console.log(`\n=== micro (cached page, ${(html.length / 1024) | 0} KB, no network) ===`);
  time("native.title (parse+select)", () => native.title(html));
  time("native.text (parse+walk)", () => native.text(html));
  time("native.links (parse+collect)", () => native.links(html, SAMPLE_URL));
  time("native.query a (parse+select)", () => native.query(html, "a", "auto"));
  time("native.html (parse+serialize)", () => native.html(html));
  time("native.markdown (parse+render)", () => native.markdown(html, SAMPLE_URL));
  time("native.evaluate firstHref (V8)", () =>
    native.evaluate(html, `JSON.stringify(${FIND_FIRST} ?? null)`),
  );
}

async function e2e() {
  const { loadTurboRust } = await import("../competitive/rust-engine.mjs");
  const wiki = (await import("../competitive/routines/wikipedia.mjs")).default;
  const b = await (await loadTurboRust(null)).launch();
  console.log("\n=== e2e (no-JS wikipedia routine, live network) ===");
  for (let i = 0; i < 5; i++) {
    const p = await b.newPage();
    const t0 = process.hrtime.bigint();
    await wiki.run(p);
    console.log(`  run ${i}  ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)}ms`);
  }
}

const onlyMicro = process.argv.includes("--micro");
await micro();
if (!onlyMicro) await e2e();
process.exit(0);

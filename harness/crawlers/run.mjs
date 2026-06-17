// Multi-page CRAWL benchmark: turbo-crawl vs other open-source crawlers on a real
// multi-page crawl. For each set we crawl the SAME live target, the SAME page cap,
// and count items with the SAME selector — then report throughput + correctness.
//
//   node harness/crawlers/run.mjs                 # both sets (nojs + js)
//   node harness/crawlers/run.mjs --set=nojs      # Set A only (vs no-js)
//   node harness/crawlers/run.mjs --set=js        # Set B only (vs js-fast/js-secure)
//   node harness/crawlers/run.mjs --pages=20 --iters=3
//   npm run crawl-bench        /  npm run crawl-bench:js
//
// Needs LIVE network. Competitors that aren't installed are auto-skipped (their
// rows read "skipped (not installed)"). turbo-crawl rows run with zero extra deps.

import { crawlersForSet } from "./crawlers.mjs";
import { targetForSet } from "./targets.mjs";

function flag(name, dflt) {
  const f = process.argv.find((a) => a.startsWith(`--${name}=`));
  return f ? f.split("=")[1] : dflt;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Warm once (not timed), then `iters` timed runs; report the median wall time and
// the item/page counts from the median-time run.
async function measure(entry, target, pages, iters) {
  try {
    await entry.crawl(target, { pages }); // warm-up (JIT, DNS, browser boot)
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
  const runs = [];
  for (let i = 0; i < iters; i++) {
    try {
      runs.push(await entry.crawl(target, { pages }));
    } catch (err) {
      return { error: String(err?.message ?? err) };
    }
  }
  const medMs = median(runs.map((r) => r.ms));
  const pick = runs.reduce((a, b) => (Math.abs(b.ms - medMs) < Math.abs(a.ms - medMs) ? b : a));
  return { ...pick, ms: medMs };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function lpad(s, n) {
  s = String(s);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function row(name, cells, turbo) {
  const mark = turbo ? "» " : "  ";
  return `${mark}${pad(name, 26)} ${cells}`;
}

async function runSet(set, pages, iters) {
  const target = targetForSet(set);
  const entries = crawlersForSet(set);
  console.log(`\n=== set: ${set}  target: ${target.name} ===`);
  console.log(`pages≤${pages}  iters=${iters}  start=${target.start}`);
  console.log(
    row(
      "crawler",
      `${lpad("pages", 6)} ${lpad("items", 7)} ${lpad("median ms", 11)} ${lpad("pages/s", 9)}`,
      false,
    ),
  );
  console.log("  " + "-".repeat(62));

  for (const entry of entries) {
    let available = false;
    try {
      available = await entry.available();
    } catch {
      available = false;
    }
    if (!available) {
      console.log(row(entry.name, "skipped (not installed)", entry.turbo));
      continue;
    }
    const r = await measure(entry, target, pages, iters);
    if (r.error) {
      console.log(row(entry.name, `ERROR: ${r.error}`, entry.turbo));
      continue;
    }
    const pps = r.ms > 0 ? ((r.pages / r.ms) * 1000).toFixed(2) : "—";
    const cells = `${lpad(r.pages, 6)} ${lpad(r.items, 7)} ${lpad(r.ms.toFixed(0), 11)} ${lpad(pps, 9)}`;
    console.log(row(entry.name, cells, entry.turbo));
  }
}

async function main() {
  const pages = Math.min(Number(flag("pages", 20)), 20); // politeness cap
  const iters = Number(flag("iters", 3));
  const setArg = flag("set", null);
  const sets = setArg ? [setArg] : ["nojs", "js"];

  console.log("turbo-crawl multi-page crawl benchmark");
  console.log("» = turbo-crawl row   (competitors auto-detected; missing ones skipped)");

  for (const set of sets) {
    if (set !== "nojs" && set !== "js") {
      console.log(`unknown set "${set}" (use nojs|js)`);
      continue;
    }
    await runSet(set, pages, iters);
  }
}

await main();

// Hot-path profiler: run the real routines (wikipedia / form / js-quotes) through
// turbo-crawl in each mode (no-js / fast / secure) and break down where the time
// goes per page-flow — network (HTTP+decode), render (JS-tier script exec + bundle
// + settle), and compute (turbo-dom parse + extraction/evaluate). Surfaces the
// bottleneck so you can see what makes a routine slow.
//
//   node harness/hotpath/run.mjs [routine ...] [--mode=no-js|fast|secure] [--iters=N]
//   npm run hotpath
//
// Needs live network. `secure` mode auto-skips without isolated-vm.

import { summarize } from "../../src/measure.mjs";
import form from "../competitive/routines/form.mjs";
import jsQuotes from "../competitive/routines/js-quotes.mjs";
import wikipedia from "../competitive/routines/wikipedia.mjs";

const ROUTINES = { wikipedia, form, "js-quotes": jsQuotes };
const MODES = ["no-js", "fast", "secure"];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

// Wrap a fetcher to push each call's duration (ms) into `acc`.
function timed(fn, acc) {
  return async (url, opts) => {
    const t0 = process.hrtime.bigint();
    try {
      return await fn(url, opts);
    } finally {
      acc.push(ms(t0));
    }
  };
}

// A turbo-crawl pseudo-browser for `mode`, instrumented to split network vs load.
async function launch(mode, phases) {
  const { chromium } = await import("../../playwright/index.mjs");
  const { fetchHtml: rawFetch } = await import("../../src/net.mjs");
  const inner = timed(
    (url, opts = {}) => rawFetch(url, { allowNonHtml: true, ...opts }),
    phases.network,
  );
  if (mode === "no-js") return chromium.launch({ fetchHtml: timed(inner, phases.load) });
  const { jsRenderer } = await import("../../src/index.mjs");
  const rendered = jsRenderer({ mode, fetchHtml: inner }).fetchHtml;
  return chromium.launch({ fetchHtml: timed(rendered, phases.load) });
}

// Run a routine `iters` times; per run record total + phase split.
async function profile(mode, routine, iters) {
  const phases = { network: [], load: [] };
  const browser = await launch(mode, phases);
  const runs = [];
  try {
    for (let i = 0; i < iters; i++) {
      phases.network.length = 0;
      phases.load.length = 0;
      const page = await browser.newPage();
      const t0 = process.hrtime.bigint();
      await routine.run(page);
      runs.push(breakdown(ms(t0), sum(phases.network), sum(phases.load)));
      await page.close?.();
    }
  } finally {
    await browser.close?.();
  }
  return runs;
}

function breakdown(total, network, load) {
  return {
    total,
    network,
    render: Math.max(0, load - network), // JS-tier: script exec + module bundle + settle
    compute: Math.max(0, total - load), // turbo-dom parse + extraction/evaluate
  };
}

function medians(runs) {
  const med = (key) => summarize(runs.map((r) => r[key])).median;
  return {
    total: med("total"),
    network: med("network"),
    render: med("render"),
    compute: med("compute"),
  };
}

function pct(part, total) {
  return total > 0 ? `${((100 * part) / total).toFixed(0)}%` : "0%";
}

function bottleneck(m) {
  const phases = [
    ["network", m.network],
    ["render", m.render],
    ["compute", m.compute],
  ];
  return phases.sort((a, b) => b[1] - a[1])[0][0];
}

function report(routine, mode, runs) {
  const m = medians(runs);
  const cols =
    `${`total ${m.total.toFixed(1)}ms`.padEnd(16)}` +
    `net ${m.network.toFixed(1)}ms(${pct(m.network, m.total)})`.padEnd(20) +
    `render ${m.render.toFixed(1)}ms(${pct(m.render, m.total)})`.padEnd(22) +
    `compute ${m.compute.toFixed(1)}ms(${pct(m.compute, m.total)})`.padEnd(22);
  console.log(`  ${mode.padEnd(8)} ${cols} → hot: ${bottleneck(m)}`);
}

function selected(list, all) {
  const picked = process.argv.slice(2).filter((a) => !a.startsWith("-") && all.includes(a));
  return picked.length ? picked : all;
}

function flag(name, fallback) {
  const f = process.argv.find((a) => a.startsWith(`--${name}=`));
  return f ? f.split("=")[1] : fallback;
}

async function main() {
  const iters = Number(flag("iters", process.env.HOTPATH_ITERS ?? 3));
  const modes = [flag("mode", "")].filter(Boolean);
  const useModes = modes.length ? modes : MODES;
  const routineNames = selected(Object.keys(ROUTINES), Object.keys(ROUTINES));
  console.log(`hot-path profiler — ${iters} iters · modes: ${useModes.join(", ")}\n`);

  for (const name of routineNames) {
    const routine = ROUTINES[name];
    console.log(`=== ${routine.name} ===`);
    for (const mode of useModes) {
      if (routine.requiresJs && mode === "no-js") {
        console.log(`  ${mode.padEnd(8)} — skipped (routine needs JS)`);
        continue;
      }
      try {
        report(routine, mode, await profile(mode, routine, iters));
      } catch (err) {
        console.log(`  ${mode.padEnd(8)} — ERROR: ${String(err && err.message).slice(0, 80)}`);
      }
    }
  }
}

await main();

// Competitive harness: run the SAME Playwright routine across every installed
// engine (turbo-surf no-JS / js-fast / js-secure, plus real Chromium/Firefox/
// WebKit and any stealth browsers), time each, and score output parity against the
// Chromium oracle.
//
//   node harness/competitive/run.mjs [routine ...]    # default: all routines
//   npm run harness                                   # all
//   npm run harness -- wikipedia form                 # selected
//
// Needs live network. Engines that aren't installed are skipped automatically.

import { availableEngines } from "./engines.mjs";
import form from "./routines/form.mjs";
import jsQuotes from "./routines/js-quotes.mjs";
import wikipedia from "./routines/wikipedia.mjs";

const ROUTINES = { wikipedia, form, "js-quotes": jsQuotes };

function selectedRoutines() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const names = args.length ? args : Object.keys(ROUTINES);
  return names.map((n) => ROUTINES[n]).filter(Boolean);
}

function isNoJs(engine) {
  return engine.name.includes("no-js");
}

function ms(t0) {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// One iteration: fresh page, time the routine, record obs (first run) or error.
async function oneRun(session, routine, capture) {
  const page = await session.newPage();
  const t0 = process.hrtime.bigint();
  let obs;
  let error;
  try {
    obs = await routine.run(page);
  } catch (err) {
    error = String(err && err.message);
  }
  const dt = ms(t0);
  await page.close?.().catch?.(() => {});
  return { time: dt, obs: capture ? obs : undefined, error };
}

// Run `iters` iterations on one engine (browser launched once); collect timings.
async function runOn(engine, routine, iters) {
  const session = await engine.launch();
  const times = [];
  let obs;
  let error;
  try {
    for (let i = 0; i < iters; i++) {
      const r = await oneRun(session, routine, i === 0);
      times.push(r.time);
      if (i === 0) obs = r.obs;
      if (r.error) error = r.error;
    }
  } finally {
    await session.close().catch(() => {});
  }
  return { obs, error, times };
}

function stats(times) {
  const s = [...times].sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { min: s[0], median, mean };
}

// Parity = fraction of compareSteps whose value matches the oracle's.
function parity(oracle, result, steps) {
  if (!oracle?.obs || !result?.obs) return null;
  const truth = byStep(oracle.obs);
  const got = byStep(result.obs);
  let match = 0;
  for (const s of steps) {
    if (JSON.stringify(truth[s]) === JSON.stringify(got[s])) match++;
  }
  return { match, total: steps.length };
}

function byStep(obs) {
  return Object.fromEntries(obs.map((o) => [o.step, o]));
}

function report(routine, engines, results, oracleName) {
  const oracle = results.get(oracleName);
  console.log(`\n=== routine: ${routine.name} ===`);
  for (const e of engines) {
    const r = results.get(e.name);
    if (!r) {
      console.log(`  ${e.name.padEnd(26)} — skipped (no-JS, routine needs JS)`);
      continue;
    }
    const p = e.name === oracleName ? null : parity(oracle, r, routine.compareSteps);
    console.log(`  ${e.name.padEnd(26)} ${fmt(r, p)}`);
  }
}

function fmt(r, p) {
  const t = stats(r.times);
  const time = `median ${t.median.toFixed(0).padStart(6)}ms  mean ${t.mean.toFixed(0).padStart(6)}ms  min ${t.min.toFixed(0).padStart(6)}ms`;
  if (r.error) return `${time}   ERROR: ${r.error}`;
  const par = p ? `parity ${p.match}/${p.total}${p.match === p.total ? " ✓" : " ✗"}` : "(oracle)";
  return `${time}   ${par}`;
}

function iterations() {
  const flag = process.argv.find((a) => a.startsWith("--iters="));
  return Number(flag?.split("=")[1] ?? process.env.HARNESS_ITERS ?? 10);
}

async function main() {
  const iters = iterations();
  const engines = await availableEngines();
  const oracle = engines.find((e) => e.oracle);
  console.log(`engines: ${engines.map((e) => e.name).join(", ")}`);
  console.log(`oracle:  ${oracle ? oracle.name : "(none — install playwright + chromium)"}`);
  console.log(`iterations per engine: ${iters}`);

  for (const routine of selectedRoutines()) {
    const results = new Map();
    for (const engine of engines) {
      if (routine.requiresJs && isNoJs(engine)) continue;
      results.set(engine.name, await runOn(engine, routine, iters));
    }
    report(routine, engines, results, oracle?.name);
  }
}

await main();

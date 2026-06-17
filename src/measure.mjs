// Microbenchmark helper: warm up, run a thunk N times, return timing samples and
// summary stats. Pure + deterministic (timing aside) so it's unit-testable; used
// by the hot-path harness and embeddable by callers.

// Nearest-rank percentile of a pre-sorted, non-empty array.
function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Summarize timing samples (milliseconds) → { n, min, max, mean, median, p95,
 * opsPerSec }. Empty input yields all-zero stats.
 */
export function summarize(samples) {
  if (samples.length === 0) {
    return { n: 0, min: 0, max: 0, mean: 0, median: 0, p95: 0, opsPerSec: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    opsPerSec: mean > 0 ? 1000 / mean : 0,
  };
}

/**
 * Run `thunk` (sync or async) `iters` times after `warmup` warmup runs, timing
 * each measured run with a high-resolution clock.
 * @param {() => unknown | Promise<unknown>} thunk
 * @param {{ iters?: number, warmup?: number, clock?: () => bigint }} [opts]
 * @returns {Promise<{ samples: number[], stats: object }>}
 */
function measureCfg(opts) {
  const iters = opts.iters ?? 50;
  return {
    iters,
    warmup: opts.warmup ?? Math.min(5, iters),
    clock: opts.clock ?? process.hrtime.bigint,
  };
}

export async function measure(thunk, opts = {}) {
  const cfg = measureCfg(opts);
  for (let i = 0; i < cfg.warmup; i++) await thunk();
  const samples = [];
  for (let i = 0; i < cfg.iters; i++) {
    const t0 = cfg.clock();
    await thunk();
    samples.push(Number(cfg.clock() - t0) / 1e6);
  }
  return { samples, stats: summarize(samples) };
}

/** One-line human report for a labeled stats object. */
export function formatStats(label, stats) {
  const median = stats.median.toFixed(3).padStart(9);
  const ops = Math.round(stats.opsPerSec).toString().padStart(8);
  return `${label.padEnd(26)} ${median} ms  ${ops} ops/s  (mean ${stats.mean.toFixed(3)}, p95 ${stats.p95.toFixed(3)}, n=${stats.n})`;
}

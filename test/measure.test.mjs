import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatStats, measure, summarize } from "../src/measure.mjs";

describe("summarize", () => {
  it("computes stats for samples", () => {
    const s = summarize([4, 1, 2, 3]); // mean 2.5
    assert.equal(s.n, 4);
    assert.equal(s.min, 1);
    assert.equal(s.max, 4);
    assert.equal(s.mean, 2.5);
    assert.equal(s.median, 3); // nearest-rank: sorted[floor(.5*4)=2] = 3
    assert.equal(s.p95, 4); // sorted[min(3, floor(.95*4)=3)] = 4
    assert.equal(s.opsPerSec, 1000 / 2.5);
  });

  it("returns all-zero stats for empty input", () => {
    assert.deepEqual(summarize([]), {
      n: 0,
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p95: 0,
      opsPerSec: 0,
    });
  });

  it("opsPerSec is 0 when mean is 0", () => {
    assert.equal(summarize([0, 0, 0]).opsPerSec, 0);
  });
});

describe("measure", () => {
  it("runs warmup + iters and returns one sample per measured run", async () => {
    let calls = 0;
    const { samples, stats } = await measure(() => calls++, { iters: 6, warmup: 2 });
    assert.equal(calls, 8); // 2 warmup + 6 measured
    assert.equal(samples.length, 6);
    assert.equal(stats.n, 6);
  });

  it("uses an injectable clock (deterministic timing)", async () => {
    let t = 0n;
    const clock = () => (t += 1_000_000n); // +1ms each read
    const { samples } = await measure(async () => {}, { iters: 3, warmup: 0, clock });
    assert.equal(samples.length, 3);
    assert.ok(samples.every((ms) => ms === 1)); // (end - start) = 1ms per run
  });

  it("defaults to 50 iterations when iters is omitted", async () => {
    const { samples } = await measure(() => {}, { warmup: 0 });
    assert.equal(samples.length, 50);
  });

  it("applies defaults when opts omitted (warmup ≤ iters)", async () => {
    let calls = 0;
    const { samples } = await measure(() => calls++, { iters: 3 });
    // default warmup = min(5,3) = 3 → 3 warmup + 3 measured
    assert.equal(calls, 6);
    assert.equal(samples.length, 3);
  });
});

describe("formatStats", () => {
  it("produces a one-line report containing the label and units", () => {
    const line = formatStats("no-js", summarize([1, 2, 3]));
    assert.match(line, /no-js/);
    assert.match(line, /ms/);
    assert.match(line, /ops\/s/);
    assert.match(line, /n=3/);
  });
});

// Virtual clock + owned timer queue for the "fast" render backend.
//
// React 19 drives its work loop through MessageChannel; MUI transitions gate on
// (now() - start) / duration via setTimeout/requestAnimationFrame. turbo-dom
// (>=0.2.4) routes BOTH its requestAnimationFrame and its MessageChannel delivery
// through the live `globalThis.setTimeout`, and reads its page clock through
// `setClock(fn)`. So to render React/MUI headless under a deterministic virtual
// clock, we only need to (a) own the sandbox's setTimeout — every rAF frame and
// scheduler hop then lands in our queue — and (b) point the clock at our virtual
// time. We drain the queue in bounded rounds, advancing virtual time each round,
// so finite transitions reach progress>=1 and stop, while a frame cap + the
// backend's wall-clock deadline bound genuinely-infinite animations.

import { setClock } from "@miaskiewicz/turbo-dom/runtime";

const FRAME_MS = 16;
// Virtual time advances a hair on every clock READ. React's time-sliced work loop
// polls the clock and yields once its ~5ms budget elapses; without this, the clock
// is constant within a callback, shouldYield() never trips, and React runs the
// whole (possibly self-rescheduling) tree synchronously in one uninterruptible
// callback — a spin our pump can't break. Bumping per read makes React yield back
// to us between slices, so the frame cap + deadline bound it.
const READ_EPSILON = 0.05;

function cancel(timers, id) {
  const i = timers.findIndex((t) => t.id === id);
  if (i >= 0) timers.splice(i, 1);
}

/**
 * Own the sandbox's timers + point turbo-dom's clock at a virtual clock.
 * @returns {{ timers: Array, clock: {now:number} }} the queue + clock to drain.
 */
export function installVirtualClock(sandbox) {
  const timers = [];
  const clock = { now: 0 };
  let seq = 0;
  sandbox.setTimeout = (cb, d) => {
    timers.push({ id: ++seq, cb, due: clock.now + (Number(d) || 0) });
    return seq;
  };
  sandbox.clearTimeout = (id) => cancel(timers, id);
  sandbox.setInterval = () => 0; // intervals would never settle; no-op
  sandbox.clearInterval = () => {};
  // turbo-dom's requestAnimationFrame + MessageChannel post through globalThis.
  // setTimeout (= our queue above); its performance.now()/rAF timestamps read this.
  setClock(() => {
    clock.now += READ_EPSILON; // make React's time-sliced loop yield (see above)
    return clock.now;
  });
  return { timers, clock };
}

/** Restore turbo-dom's default (real) clock after a render. */
export function resetClock() {
  setClock(null);
}

function runCb(t) {
  try {
    t.cb(t.due);
  } catch {
    // a page timer/frame throwing must not abort the render
  }
}

function earliestDue(timers) {
  let min = Number.POSITIVE_INFINITY;
  for (const t of timers) if (t.due < min) min = t.due;
  return min;
}

/**
 * Drain one round: advance the clock to the next due task (min one frame),
 * run everything now due. Returns how many tasks ran (0 = queue empty).
 */
export function drainRound(timers, clock) {
  if (!timers.length) return 0;
  clock.now = Math.max(clock.now + FRAME_MS, earliestDue(timers));
  const due = timers.filter((t) => t.due <= clock.now);
  for (const t of due) cancel(timers, t.id);
  for (const t of due) runCb(t);
  return due.length;
}

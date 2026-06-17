// Virtual clock + owned scheduler queue for the "fast" render backend.
//
// React 19 drives its work loop through MessageChannel; MUI transitions gate on
// (now() - start) / duration via setTimeout/requestAnimationFrame. If page time
// is frozen (or runs on the real event loop outside our control), finite
// transitions never reach progress>=1 and reschedule forever, and React's
// scheduler runs un-bounded. We fix that by routing ALL page scheduling — setTimeout,
// requestAnimationFrame, MessageChannel — and the page clock (Date.now/performance.now)
// through ONE queue we drain in bounded rounds, advancing a virtual clock each
// round. Pull-based draining means an infinite-animation rAF storm can't starve
// us: we decide when to stop (frame cap + the backend's wall-clock deadline).

const FRAME_MS = 16;
const CLOCK_BASE = 1700000000000;

// Deliver a posted message to the paired port (React scheduler + general use).
function deliver(target, data) {
  const ev = { data, type: "message", target };
  if (typeof target.onmessage === "function") target.onmessage(ev);
  if (typeof target._l === "function") target._l(ev);
}

function makePort(schedule, other) {
  return {
    onmessage: null,
    _l: null,
    start() {},
    close() {},
    addEventListener(type, fn) {
      if (type === "message") this._l = fn;
    },
    removeEventListener() {},
    postMessage(data) {
      schedule(() => deliver(other(), data), 0, false);
    },
  };
}

// A MessageChannel whose delivery is scheduled into our queue (not the host's),
// so it exists everywhere and is drivable by the virtual clock.
function makeMessageChannel(schedule) {
  return class MessageChannel {
    constructor() {
      this.port1 = makePort(schedule, () => this.port2);
      this.port2 = makePort(schedule, () => this.port1);
    }
  };
}

function cancel(timers, id) {
  const i = timers.findIndex((t) => t.id === id);
  if (i >= 0) timers.splice(i, 1);
}

// Point page-visible Date.now/performance.now at the virtual clock (bridged via a
// host function so the values track our advancing `clock.now`).
const CLOCK_PATCH = `(() => {
  globalThis.Date.now = () => ${CLOCK_BASE} + globalThis.__vnow();
  globalThis.performance = { now: () => globalThis.__vnow(), timeOrigin: 0,
    mark(){}, measure(){}, getEntriesByName: () => [], getEntriesByType: () => [],
    clearMarks(){}, clearMeasures(){} };
})();`;

/**
 * Install the virtual clock + owned scheduler onto a vm sandbox.
 * @returns {{ timers: Array, clock: {now:number} }} the queue + clock to drain.
 */
export function installVirtualClock(sandbox, vm) {
  const timers = [];
  const clock = { now: 0 };
  let seq = 0;
  const schedule = (cb, delay, raf) => {
    timers.push({ id: ++seq, cb, due: clock.now + delay, raf });
    return seq;
  };
  sandbox.setTimeout = (cb, d) => schedule(cb, Number(d) || 0, false);
  sandbox.clearTimeout = (id) => cancel(timers, id);
  sandbox.setInterval = () => 0; // intervals would never settle; no-op
  sandbox.clearInterval = () => {};
  sandbox.requestAnimationFrame = (cb) => schedule(() => cb(clock.now), FRAME_MS, true);
  sandbox.cancelAnimationFrame = (id) => cancel(timers, id);
  sandbox.MessageChannel = makeMessageChannel(schedule);
  sandbox.__vnow = () => clock.now;
  vm.runInContext(CLOCK_PATCH, sandbox);
  return { timers, clock };
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

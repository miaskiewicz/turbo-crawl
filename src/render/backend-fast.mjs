// "fast" render backend (v1): runs page scripts in an in-process node:vm context
// backed by the NATIVE turbo-dom parser. Fastest path; NO hostile-code isolation
// (the vm shares the host heap). Intended for local testing / trusted targets —
// for open-web crawling use the "secure" (isolated-vm) backend.

import vm from "node:vm";

import { installGlobals } from "@miaskiewicz/turbo-dom/install";

import { assertSafeEval } from "../eval-guard.mjs";
import { makePageFetch, makeXHR } from "./page-fetch.mjs";
import { drainRound, installVirtualClock, resetClock } from "./virtual-clock.mjs";

export function createFastBackend() {
  // The last render's live sandbox is kept so eval() can re-enter the page's actual
  // heap (window globals, handlers) — not a re-parsed snapshot. `history` records a
  // serialized DOM entry per navigation and per mutating eval (never clobbered).
  let live = null;
  const history = [];
  return {
    /**
     * @param {string} html
     * @param {Array<{code?:string, module:boolean}>} scripts
     * @param {{ url?:string, hostFetch?:Function, timeoutMs?:number,
     *   renderDeadlineMs?:number, maxFrames?:number }} [opts]
     * @returns {Promise<string>} rendered outerHTML
     */
    async render(html, scripts, opts = {}) {
      const sandbox = {};
      installGlobals(sandbox, { html, url: opts.url });
      vm.createContext(sandbox);
      // Own time + scheduling BEFORE any page script runs (React/MUI read them).
      const ctl = installVirtualClock(sandbox);
      const state = { pending: 0 };
      installNet(sandbox, opts, state);
      installStorage(sandbox, opts.storage);
      installConsole(sandbox, opts.hooks?.onConsole);
      shimDocWrite(sandbox.document);
      try {
        // sync → defer → DOMContentLoaded → async → load (browser order)
        runLifecycle(sandbox, scripts, opts);
        await settle(ctl, state, opts);
      } finally {
        resetClock(); // restore turbo-dom's real clock for any other consumer
      }
      live = sandbox;
      const out = snapshotOf(sandbox);
      pushIfChanged(history, out);
      return out;
    },
    // Re-enter the live render heap and append the post-eval DOM to history (writer).
    // NOT a security sandbox — assertSafeEval is a best-effort guard; use the secure
    // backend for untrusted code.
    eval(code, args = []) {
      if (!live) throw new Error("turbo-crawl: no rendered page to eval against");
      live.__tcArgs = args;
      const value = vm.runInContext(
        `(function(){ ${assertSafeEval(code)}\n}).apply(null, __tcArgs)`,
        live,
      );
      pushIfChanged(history, snapshotOf(live));
      return value;
    },
    // Getters over the DOM history.
    latestDom() {
      return history.length ? history[history.length - 1] : "";
    },
    domHistory() {
      return [...history];
    },
    async close() {
      live = null;
      history.length = 0;
    },
  };
}

function snapshotOf(sandbox) {
  const root = sandbox.document?.documentElement;
  return root ? `<!DOCTYPE html>\n${root.outerHTML}` : "";
}

// Append a DOM snapshot only when it differs from the last (read-only evals don't
// grow the history).
function pushIfChanged(history, html) {
  if (history[history.length - 1] !== html) history.push(html);
}

// Wire host-net-backed fetch + XHR (with façade event/route hooks) into the page.
function installNet(sandbox, opts, state) {
  if (!opts.hostFetch) return;
  sandbox.fetch = makePageFetch(opts.hostFetch, opts.url, state, opts.netHooks);
  sandbox.XMLHttpRequest = makeXHR(opts.hostFetch, opts.url, state, opts.netHooks);
}

// Override turbo-dom's per-env Web Storage with the context-persistent stores so
// localStorage/sessionStorage survive across navigations (auth tokens, etc.).
// defineProperty (not plain assignment) so a read-only `window.localStorage` is
// still replaced.
function setProp(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: true, configurable: true });
}

function installStorage(sandbox, storage) {
  if (!storage) return;
  for (const key of ["localStorage", "sessionStorage"]) {
    setProp(sandbox, key, storage[key]);
    if (sandbox.window) setProp(sandbox.window, key, storage[key]);
  }
}

// Page console is absent in the bare sandbox; install one that forwards to the
// façade's `console` event (and keeps page `console.*` calls from throwing).
const CONSOLE_TYPES = { log: "log", info: "info", warn: "warning", error: "error", debug: "debug" };

function installConsole(sandbox, onConsole) {
  const con = {};
  for (const [method, type] of Object.entries(CONSOLE_TYPES)) {
    con[method] = (...args) => onConsole?.(type, args);
  }
  sandbox.console = con;
  if (sandbox.window) sandbox.window.console = con;
}

// Make `document.write`/`writeln` append to the body (legacy builders that emit
// markup at script time — turbo-dom no-ops write post-parse).
function shimDocWrite(doc) {
  const sink = (s) => {
    const t = doc.body || doc.documentElement;
    if (t) t.insertAdjacentHTML("beforeend", String(s));
  };
  doc.write = sink;
  doc.writeln = (s) => sink(`${s}\n`);
}

function dispatchEv(target, Ev, type) {
  try {
    target.dispatchEvent(new Ev(type));
  } catch {
    // a listener throwing must not abort the render
  }
}

function fireDomContentLoaded(doc, win) {
  const Ev = win.Event;
  if (!Ev) return;
  dispatchEv(doc, Ev, "readystatechange");
  dispatchEv(doc, Ev, "DOMContentLoaded");
}

function fireWindowLoad(win) {
  const Ev = win.Event;
  if (!Ev) return;
  dispatchEv(win, Ev, "load");
  dispatchEv(win, Ev, "pageshow");
}

const isAsync = (s) => s.async === true;
const isDefer = (s) => s.defer === true && s.async !== true;
const isSync = (s) => s.async !== true && s.defer !== true;

// Execute scripts in BROWSER order, not DOM order: classic sync scripts first
// ("during parse"), then deferred (defer + bundled modules), then
// DOMContentLoaded, then async, then load. Critical for App Router — the async
// `_R_` RSC bootstrap must run AFTER every inline `__next_f.push` flight row has
// buffered, so it replays the whole stream and closes it on load. Running it at
// its DOM position (mid-stream) leaves the RSC stream unterminated → no commit.
function runLifecycle(sandbox, scripts, opts) {
  const ctx = { timeoutMs: opts.timeoutMs ?? 2000, onError: opts.hooks?.onPageError };
  // addInitScript: runs before any page script, on this navigation.
  runPhase(sandbox, (opts.initScripts ?? []).map(initScript), ctx);
  runPhase(sandbox, scripts.filter(isSync), ctx);
  runPhase(sandbox, scripts.filter(isDefer), ctx);
  fireDomContentLoaded(sandbox.document, sandbox.window);
  runPhase(sandbox, scripts.filter(isAsync), ctx);
  fireWindowLoad(sandbox.window);
}

const initScript = (code) => ({ code });

function runPhase(sandbox, scripts, ctx) {
  const doc = sandbox.document;
  for (const s of scripts) {
    if (s.code == null) continue; // external fetch failed (modules are pre-bundled)
    runOne(sandbox, doc, s, ctx);
  }
}

// Run one classic script as a REAL turbo-dom <script> element. This gives bundler
// runtimes a proper document.currentScript (they read .src/.getAttribute('src')
// for the chunk base URL — bug #1) AND fires the element's `load` event, which the
// dev runtimes (Turbopack/webpack) gate entrypoint execution on: they don't build
// until every chunk has signalled loaded. Inject + run + ring the doorbell.
function runOne(sandbox, doc, s, ctx) {
  const el = injectScript(doc, s);
  setCurrentScript(doc, el);
  try {
    vm.runInContext(s.code, sandbox, { timeout: ctx.timeoutMs });
  } catch (err) {
    ctx.onError?.(err); // surface as a `pageerror` event; never abort the render
  } finally {
    setCurrentScript(doc, null);
  }
  if (s.url) fireLoad(sandbox.window, el);
}

// Append a real <script> element. Set the RAW src attribute (as authored), not
// the resolved absolute URL — runtimes do currentScript.getAttribute('src') and a
// `.startsWith("/_next/")`-style test that an absolute URL would break.
function injectScript(doc, s) {
  const el = doc.createElement("script");
  if (s.url) el.setAttribute("src", s.rawSrc || s.url);
  (doc.head || doc.documentElement)?.appendChild(el);
  return el;
}

function setCurrentScript(doc, el) {
  try {
    Object.defineProperty(doc, "currentScript", { value: el, configurable: true });
  } catch {
    // read-only DOM impl — best effort
  }
}

// Fire the script's load event: dispatchEvent, and also call an el.onload set
// directly (some runtimes assign el.onload = fn instead of addEventListener).
function fireLoad(win, el) {
  try {
    el.dispatchEvent(new win.Event("load"));
  } catch {
    // a listener throwing must not abort the render
  }
  if (typeof el.onload === "function") {
    try {
      el.onload();
    } catch {
      // best effort
    }
  }
}

// Real (host) macrotask tick — lets in-flight host fetch/XHR promises resolve
// between virtual drain rounds. NOTE: `setTimeout` here is the host's (this module
// runs outside the sandbox); the page's setTimeout is the virtual one.
function realTick() {
  return new Promise((r) => setTimeout(r, 0));
}

// Real macrotasks to keep ticking after the queue looks empty: the bundler entry
// + each React continuation resolve on microtasks/awaited host fetches, so the
// queue is momentarily empty between bursts. Only stop once it's stayed quiet.
const QUIET_TICKS = 10;

// Stop when we hit the frame cap (cuts infinite animations), the wall-clock
// deadline (ultimate backstop), or the page has been quiet for QUIET_TICKS.
function pumpDone(frames, max, deadline, quiet) {
  return frames >= max || Date.now() >= deadline || quiet >= QUIET_TICKS;
}

function stillActive(ctl, state) {
  return ctl.timers.length > 0 || state.pending > 0;
}

// Drive the page's own scheduler (setTimeout/rAF/MessageChannel → our queue) in
// virtual time until it quiesces, interleaving real ticks so the async bootstrap
// + host fetches settle. Pull-based: an infinite-animation rAF storm can't starve
// us — we stop at the frame cap. (A purely SYNCHRONOUS infinite loop inside one
// callback still can't be cut from JS; turbo-dom geometry realism prevents those.)
function settleBounds(opts) {
  return { deadline: Date.now() + (opts.renderDeadlineMs ?? 5000), max: opts.maxFrames ?? 2000 };
}

async function settle(ctl, state, opts) {
  const { deadline, max } = settleBounds(opts);
  let frames = 0;
  let quiet = 0;
  while (!pumpDone(frames, max, deadline, quiet)) {
    if (drainRound(ctl.timers, ctl.clock)) frames++;
    quiet = stillActive(ctl, state) ? 0 : quiet + 1;
    await realTick();
  }
}

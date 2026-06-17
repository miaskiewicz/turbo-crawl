// "fast" render backend (v1): runs page scripts in an in-process node:vm context
// backed by the NATIVE turbo-dom parser. Fastest path; NO hostile-code isolation
// (the vm shares the host heap). Intended for local testing / trusted targets —
// for open-web crawling use the "secure" (isolated-vm) backend.

import vm from "node:vm";

import { installGlobals } from "@miaskiewicz/turbo-dom/install";

import { makePageFetch, makeXHR } from "./page-fetch.mjs";

export function createFastBackend() {
  return {
    /**
     * @param {string} html
     * @param {Array<{code?:string, module:boolean}>} scripts
     * @param {{ url?:string, hostFetch?:Function, timeoutMs?:number, settleMs?:number,
     *   settleRounds?:number, maxRounds?:number }} [opts]
     * @returns {Promise<string>} rendered outerHTML
     */
    async render(html, scripts, opts = {}) {
      const sandbox = {};
      installGlobals(sandbox, { html, url: opts.url });
      vm.createContext(sandbox);
      const state = { pending: 0 };
      if (opts.hostFetch) {
        sandbox.fetch = makePageFetch(opts.hostFetch, opts.url, state);
        sandbox.XMLHttpRequest = makeXHR(opts.hostFetch, opts.url, state);
      }
      shimDocWrite(sandbox.document);
      runScripts(sandbox, scripts, opts.timeoutMs ?? 2000);
      fireReady(sandbox.document, sandbox.window); // readystatechange/DOMContentLoaded/load
      await settle(state, opts);
      const root = sandbox.document?.documentElement;
      return root ? `<!DOCTYPE html>\n${root.outerHTML}` : "";
    },
    async close() {},
  };
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

// Fire the page-render lifecycle so jQuery `$(ready)` / onload builders run.
// readystatechange + DOMContentLoaded on document; load + pageshow on window.
function fireReady(doc, win) {
  const Ev = win.Event;
  if (!Ev) return;
  dispatchEv(doc, Ev, "readystatechange");
  dispatchEv(doc, Ev, "DOMContentLoaded");
  dispatchEv(win, Ev, "load");
  dispatchEv(win, Ev, "pageshow");
}

function runScripts(sandbox, scripts, timeoutMs) {
  const doc = sandbox.document;
  for (const s of scripts) {
    if (s.module || s.code == null) continue; // ESM modules unsupported in v1
    runOne(sandbox, doc, s, timeoutMs);
  }
}

// Run one classic script as a REAL turbo-dom <script> element. This gives bundler
// runtimes a proper document.currentScript (they read .src/.getAttribute('src')
// for the chunk base URL — bug #1) AND fires the element's `load` event, which the
// dev runtimes (Turbopack/webpack) gate entrypoint execution on: they don't build
// until every chunk has signalled loaded. Inject + run + ring the doorbell.
function runOne(sandbox, doc, s, timeoutMs) {
  const el = injectScript(doc, s);
  setCurrentScript(doc, el);
  try {
    vm.runInContext(s.code, sandbox, { timeout: timeoutMs });
  } catch {
    // a page script throwing must not abort the render
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

function settleCfg(opts) {
  return { min: opts.settleRounds ?? 5, max: opts.maxRounds ?? 50, ms: opts.settleMs ?? 1 };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Let microtasks + host-backed timers run, and wait for in-flight page fetches to
// settle (state.pending), bounded by max rounds so a hung request can't stall.
async function settle(state, opts) {
  const cfg = settleCfg(opts);
  for (let i = 0; i < cfg.min || state.pending > 0; i++) {
    if (i >= cfg.max) break;
    await sleep(cfg.ms);
  }
}

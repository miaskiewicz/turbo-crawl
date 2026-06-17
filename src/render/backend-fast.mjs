// "fast" render backend (v1): runs page scripts in an in-process node:vm context
// backed by the NATIVE turbo-dom parser. Fastest path; NO hostile-code isolation
// (the vm shares the host heap). Intended for local testing / trusted targets —
// for open-web crawling use the "secure" (isolated-vm) backend.

import vm from "node:vm";

import { installGlobals } from "@miaskiewicz/turbo-dom/install";

import { makePageFetch } from "./page-fetch.mjs";

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
      if (opts.hostFetch) sandbox.fetch = makePageFetch(opts.hostFetch, opts.url, state);
      runScripts(sandbox, scripts, opts.timeoutMs ?? 2000);
      await settle(state, opts);
      const root = sandbox.document?.documentElement;
      return root ? `<!DOCTYPE html>\n${root.outerHTML}` : "";
    },
    async close() {},
  };
}

function runScripts(sandbox, scripts, timeoutMs) {
  for (const s of scripts) {
    if (s.module || s.code == null) continue; // ESM modules unsupported in v1
    try {
      vm.runInContext(s.code, sandbox, { timeout: timeoutMs });
    } catch {
      // a page script throwing must not abort the render
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

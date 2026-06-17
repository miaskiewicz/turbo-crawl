// "fast" render backend (v1): runs page scripts in an in-process node:vm context
// backed by the NATIVE turbo-dom parser. Fastest path; NO hostile-code isolation
// (the vm shares the host heap). Intended for local testing / trusted targets —
// for open-web crawling use the "secure" (isolated-vm) backend.

import vm from "node:vm";

import { installGlobals } from "@miaskiewicz/turbo-dom/install";

export function createFastBackend() {
  return {
    /**
     * @param {string} html
     * @param {Array<{code?:string, module:boolean}>} scripts
     * @param {{ url?:string, timeoutMs?:number, settleMs?:number, settleRounds?:number }} [opts]
     * @returns {Promise<string>} rendered outerHTML
     */
    async render(html, scripts, opts = {}) {
      const sandbox = {};
      installGlobals(sandbox, { html, url: opts.url });
      vm.createContext(sandbox);
      runScripts(sandbox, scripts, opts.timeoutMs ?? 2000);
      await settle(opts.settleMs ?? 1, opts.settleRounds ?? 5);
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

// Let queued microtasks + host-backed timers (turbo-dom's setTimeout) run.
async function settle(settleMs, rounds) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, settleMs));
  }
}

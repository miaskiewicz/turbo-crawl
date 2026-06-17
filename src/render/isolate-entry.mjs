// Runs INSIDE the isolated-vm isolate (bare V8 — no Node, no host objects).
// esbuild bundles this + turbo-dom's runtime + the WASM parser glue into one IIFE
// that the host evaluates in the isolate. It exposes a few globals the host calls
// over the ivm boundary to drive a render. The host only ever gets a string back.

import { installGlobals } from "@miaskiewicz/turbo-dom/install";
import { parse, parseBuffer, parseFragment, initSync } from "@miaskiewicz/turbo-dom/parser-wasm";
import { setParser } from "@miaskiewicz/turbo-dom/runtime";

// Pending-timer queue: a bare isolate has no setTimeout; we capture callbacks and
// let the host drain them in bounded rounds (delay used only for ordering).
const timers = [];

// Initialize the WASM parser from injected bytes, then register it with turbo-dom.
globalThis.__tcInit = (wasmBytes) => {
  initSync({ module: wasmBytes });
  setParser({ parse, parseBuffer, parseFragment });
};

// A page-script fetch that bridges to the host net layer. __tcHostFetch is an
// isolated-vm Reference set by the host; applySyncPromise blocks the isolate
// thread until the host request resolves, so `await fetch()` settles in-band.
function fetchArgs(url, init) {
  return [url, (init && init.method) || "GET", (init && init.body) || null];
}

function fetchResponse(r, url) {
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    url,
    text: () => Promise.resolve(r.body),
    json: () => Promise.resolve(JSON.parse(r.body)),
  };
}

function isolateFetch(input, init) {
  const url = resolveUrl(input);
  const raw = globalThis.__tcHostFetch.applySyncPromise(undefined, fetchArgs(url, init));
  return Promise.resolve(fetchResponse(JSON.parse(raw), url));
}

function resolveUrl(input) {
  try {
    return new URL(String(input), globalThis.__tcBase || undefined).href;
  } catch {
    return String(input);
  }
}

// Build the DOM + install window/document globals, then shim timers + fetch.
globalThis.__tcSetup = (html, url) => {
  installGlobals(globalThis, { html, url: url || undefined });
  globalThis.__tcBase = url || undefined;
  globalThis.setTimeout = (cb, delay) => {
    timers.push({ cb, delay: Number(delay) || 0 });
    return timers.length;
  };
  globalThis.clearTimeout = () => {};
  globalThis.setInterval = () => 0; // intervals would never settle; no-op
  globalThis.clearInterval = () => {};
  if (globalThis.__tcHostFetch) globalThis.fetch = isolateFetch;
};

// Execute one page script source in the isolate's global scope (sees document).
globalThis.__tcRun = (src) => {
  // biome-ignore lint: indirect eval runs page JS against the installed globals.
  (0, eval)(src);
};

// Run all currently-queued timer callbacks (one round); returns how many were
// queued *during* this round so the host can decide whether to drain again.
globalThis.__tcDrainTimers = () => {
  const due = timers.splice(0).sort((a, b) => a.delay - b.delay);
  for (const t of due) {
    try {
      t.cb();
    } catch {
      // a page timer throwing must not abort the render
    }
  }
  return timers.length;
};

// Serialize the (possibly mutated) DOM back to the host as an HTML string.
globalThis.__tcSnapshot = () => {
  const root = globalThis.document.documentElement;
  return root ? `<!DOCTYPE html>\n${root.outerHTML}` : "";
};

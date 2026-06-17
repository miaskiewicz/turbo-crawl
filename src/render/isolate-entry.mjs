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
  shimDocWrite(globalThis.document);
  if (globalThis.__tcHostFetch) {
    globalThis.fetch = isolateFetch;
    globalThis.XMLHttpRequest = makeIsolateXHR();
  }
};

// document.write/writeln → append to body (legacy markup-at-script-time builders).
function shimDocWrite(doc) {
  const sink = (s) => {
    const t = doc.body || doc.documentElement;
    if (t) t.insertAdjacentHTML("beforeend", String(s));
  };
  doc.write = sink;
  doc.writeln = (s) => sink(`${s}\n`);
}

// Host-net-backed XMLHttpRequest inside the isolate (synchronous bridge via
// applySyncPromise; completion callbacks fire on a microtask).
function makeIsolateXHR() {
  return class XMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.responseText = "";
    }
    open(method, url) {
      this._method = method || "GET";
      this._url = resolveUrl(url);
      this.readyState = 1;
    }
    setRequestHeader() {}
    getResponseHeader() {
      return null;
    }
    send(body) {
      const raw = globalThis.__tcHostFetch.applySyncPromise(undefined, [
        this._url,
        this._method,
        body || null,
      ]);
      const r = JSON.parse(raw);
      this.status = r.status;
      this.responseText = r.body;
      this.response = r.body;
      const self = this;
      Promise.resolve().then(() => finishXhr(self));
    }
  };
}

function finishXhr(xhr) {
  xhr.readyState = 4;
  if (xhr.onreadystatechange) xhr.onreadystatechange();
  if (xhr.onload) xhr.onload();
}

// Execute one page script source in the isolate's global scope (sees document).
globalThis.__tcRun = (src) => {
  // biome-ignore lint: indirect eval runs page JS against the installed globals.
  (0, eval)(src);
};

function dispatchEv(target, type) {
  try {
    target.dispatchEvent(new globalThis.Event(type));
  } catch {
    /* a listener throwing must not abort the render */
  }
}

// Fire the page-render lifecycle so jQuery `$(ready)`/`onload` builders run.
globalThis.__tcFireReady = () => {
  if (!globalThis.Event) return;
  dispatchEv(globalThis.document, "readystatechange");
  dispatchEv(globalThis.document, "DOMContentLoaded");
  dispatchEv(globalThis, "load");
  dispatchEv(globalThis, "pageshow");
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

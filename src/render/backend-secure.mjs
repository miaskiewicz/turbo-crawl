// "secure" render backend (v2): runs page scripts in a true V8 isolate
// (isolated-vm) where turbo-dom runs on its WASM parser. Hostile-code safe — the
// guest isolate cannot reach the host heap; only HTML strings cross the boundary.
// For open-web crawling. `esbuild` is a dependency; `isolated-vm` is an OPTIONAL
// native dep — loadIvm() errors actionably if it's absent (never downgrades).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { POLYFILLS } from "./isolate-polyfills.mjs";

const require = createRequire(import.meta.url);
const ENTRY = fileURLToPath(new URL("./isolate-entry.mjs", import.meta.url));

// Resolve turbo-dom's WASM parser bytes (the web build, isolate-loadable).
function wasmBytes() {
  const pkg = require.resolve("@miaskiewicz/turbo-dom/package.json");
  return readFileSync(new URL("./pkg-web/turbo_dom_parser_bg.wasm", `file://${pkg}`));
}

// Bundle the in-isolate entry (+ turbo-dom runtime + WASM glue) into one ESM
// string the isolate can compile. Built once, cached.
let bundlePromise = null;
async function isolateBundle() {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const esbuild = await import("esbuild");
      const out = await esbuild.build({
        entryPoints: [ENTRY],
        bundle: true,
        format: "esm",
        platform: "neutral",
        external: ["node:module"], // a guarded dynamic import that no-ops in a bare isolate
        write: false,
        logLevel: "silent",
      });
      return out.outputFiles[0].text;
    })();
  }
  return bundlePromise;
}

// isolated-vm is an optional (native) dependency. If it's missing, fail with an
// actionable message — NEVER silently fall back to the unsandboxed "fast" backend
// (that would run untrusted page JS in the host process).
async function loadIvm() {
  try {
    return (await import("isolated-vm")).default;
  } catch {
    throw new Error(
      'turbo-crawl: jsRenderer({ mode: "secure" }) needs the optional "isolated-vm" ' +
        'dependency (a native module). Run `npm i isolated-vm`, or use mode:"fast" ' +
        "for local/trusted targets only (no sandbox).",
    );
  }
}

async function bootIsolate(ivm, bundle, wasm, memoryLimit) {
  const isolate = new ivm.Isolate({ memoryLimit });
  const context = await isolate.createContext();
  await context.global.set("globalThis", context.global.derefInto());
  await context.eval(POLYFILLS); // web globals (TextEncoder/Decoder) the bundle needs
  const mod = await isolate.compileModule(bundle);
  await mod.instantiate(context, () => {
    throw new Error("turbo-crawl: unexpected import in isolate bundle");
  });
  await mod.evaluate();
  const init = await context.global.get("__tcInit", { reference: true });
  await init.apply(undefined, [wasm], { arguments: { copy: true } });
  return { isolate, context, ivm };
}

// Host-side fetch bridge: the isolate calls this (applySyncPromise) for page
// fetches; we run the request via the host net layer and return a JSON string.
function fetchBridge(ivm, hostFetch) {
  return new ivm.Reference(async (url, method, body) => {
    try {
      const res = await hostFetch(url, { allowNonHtml: true, method, body });
      return JSON.stringify({ status: res.status, body: res.html ?? "" });
    } catch {
      return JSON.stringify({ status: 0, body: "" });
    }
  });
}

async function callGlobal(context, name, args) {
  const ref = await context.global.get(name, { reference: true });
  return ref.apply(undefined, args, { arguments: { copy: true }, result: { copy: true } });
}

export function createSecureBackend(opts = {}) {
  const memoryLimit = opts.memoryLimit ?? 256;
  let ready = null;

  async function ensure() {
    if (!ready) {
      ready = (async () => {
        const ivm = await loadIvm();
        const [bundle, wasm] = await Promise.all([isolateBundle(), wasmBytes()]);
        return bootIsolate(ivm, bundle, wasm, memoryLimit);
      })();
    }
    return ready;
  }

  return {
    async render(html, scripts, renderOpts = {}) {
      const { context, ivm } = await ensure();
      if (renderOpts.hostFetch) {
        await context.global.set("__tcHostFetch", fetchBridge(ivm, renderOpts.hostFetch));
      }
      await callGlobal(context, "__tcSetup", [html, renderOpts.url ?? null]);
      await runScripts(context, scripts);
      await callGlobal(context, "__tcFireReady", []);
      await drainTimers(context, renderOpts.settleRounds ?? 5);
      return callGlobal(context, "__tcSnapshot", []);
    },
    async close() {
      if (ready) (await ready).isolate.dispose();
      ready = null;
    },
  };
}

async function runScripts(context, scripts) {
  for (const s of scripts) {
    if (s.module || s.code == null) continue; // modules are pre-bundled to classic by render/index
    try {
      await callGlobal(context, "__tcRun", [s.code]);
    } catch {
      // a page script throwing must not abort the render (browser semantics)
    }
  }
}

async function drainTimers(context, rounds) {
  for (let i = 0; i < rounds; i++) {
    const remaining = await callGlobal(context, "__tcDrainTimers", []);
    if (!remaining) return;
  }
}

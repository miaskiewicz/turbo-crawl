// Opt-in drop-in installer: run a Playwright suite on the napi-backed Rust engine
// with NO @playwright/test or Chromium —
//
//   node --import ./register.mjs --test 'e2e/**/*.spec.mjs'
//
// Every `import … from "@playwright/test"` then resolves to the turbo-surf shim.
// Toggle off without dropping the flag: TURBO_PLAYWRIGHT_SHIM=0.

import { registerHooks } from "node:module";
import { resolveHook } from "./loader-hooks.mjs";

if (process.env.TURBO_PLAYWRIGHT_SHIM !== "0") {
  registerHooks({ resolve: resolveHook });
}

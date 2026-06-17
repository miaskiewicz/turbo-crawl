// Opt-in shim installer. Run a Playwright suite with NO @playwright/test or
// chromium by passing this to node's --import flag:
//
//   node --import @miaskiewicz/turbo-crawl/playwright/register --test 'e2e/**/*.spec.mjs'
//
// Every `import … from "@playwright/test"` (and "playwright"/"playwright-core")
// then resolves to turbo-crawl's façade. Toggle off without dropping the flag:
//
//   TURBO_PLAYWRIGHT_SHIM=0 node --import …/playwright/register --test …
//
// ESM only — the engine graph uses turbo-dom's top-level-await parser, so specs
// run under `node --test` (ESM), not the `playwright` CLI or a CJS require.

import { registerHooks } from "node:module";

import { resolveHook } from "./loader-hooks.mjs";

if (process.env.TURBO_PLAYWRIGHT_SHIM !== "0") {
  registerHooks({ resolve: resolveHook });
}

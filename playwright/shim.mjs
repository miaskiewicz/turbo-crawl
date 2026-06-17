// `@playwright/test`-shaped surface backed by turbo-crawl. The resolution hook in
// `./loader-hooks.mjs` redirects `import … from "@playwright/test"` here, so a spec
// (or shared harness) that imports `test`/`expect`/`defineConfig`/`devices` from
// `@playwright/test` gets the no-browser engine instead. Exports a superset of what
// specs commonly pull from `@playwright/test`; running is owned by `node --test`.

import { chromium, expect, firefox, test, webkit } from "./index.mjs";
import { __internals } from "./test.mjs";

/** `defineConfig` is identity — the playwright CLI/config is unused under node:test. */
export const defineConfig = (config) => config;

/** Any `devices["…"]` lookup yields an empty descriptor (no real device emulation). */
export const devices = new Proxy({}, { get: () => ({}) });

/** Minimal `request` (APIRequest): `request.newContext()` → a real-HTTP client. */
export const request = {
  newContext: async (opts = {}) => __internals.makeRequestContext(opts.baseURL),
};

export { test, expect, chromium, firefox, webkit };
export default { test, expect, chromium, firefox, webkit, defineConfig, devices, request };

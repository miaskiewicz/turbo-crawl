// Module-resolution redirect: rewrite bare `@playwright/test` / `playwright` /
// `playwright-core` imports to turbo-crawl's façade, so existing specs that import
// straight from `@playwright/test` transparently run on the no-browser engine —
// no spec edits. Installed (opt-in) by `./register.mjs`.

const SHIM = new URL("./shim.mjs", import.meta.url).href;
const ENGINE = new URL("./index.mjs", import.meta.url).href;

const REDIRECTS = new Map([
  ["@playwright/test", SHIM],
  ["playwright", ENGINE],
  ["playwright-core", ENGINE],
]);

/** Target façade URL for a redirected specifier, or null to resolve normally. */
export function redirectTarget(specifier) {
  return REDIRECTS.get(specifier) ?? null;
}

/** Synchronous `module.registerHooks` resolve hook. */
export function resolveHook(specifier, context, nextResolve) {
  const url = redirectTarget(specifier);
  if (url) return { url, shortCircuit: true };
  return nextResolve(specifier, context);
}

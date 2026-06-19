// Module-resolution redirect: rewrite bare `@playwright/test` / `playwright` /
// `playwright-core` imports to the napi-backed turbo-surf shim, so existing
// Playwright specs run on the no-browser Rust engine with no spec edits.
// Installed (opt-in) by `./register.mjs`.

const SHIM = new URL("./index.mjs", import.meta.url).href;

const REDIRECTS = new Map([
  ["@playwright/test", SHIM],
  ["playwright", SHIM],
  ["playwright-core", SHIM],
]);

export function redirectTarget(specifier) {
  return REDIRECTS.get(specifier) ?? null;
}

export function resolveHook(specifier, context, nextResolve) {
  const url = redirectTarget(specifier);
  if (url) return { url, shortCircuit: true };
  return nextResolve(specifier, context);
}

// Competitive-harness adapter for the **Rust** engine (the napi addon in
// `rust/crates/turbo-crawl-napi`). Exposes the same Playwright-shaped Page the
// routines drive, but every operation lands in Rust: fetch + parse + view via
// turbo-dom, JS hydration via deno_core. Two modes:
//   - no-js : Lane A — fetch + parse, scripts never run.
//   - js    : after each navigation, extract the page's <script>s and run them
//             through the Rust render tier (deno_core) to hydrate the DOM.
//
// The native require is lazy (inside `loadTurboRust`) so a missing/unbuilt addon
// makes the engine skip cleanly instead of crashing the whole harness.

import { createRequire } from "node:module";
import { extractScriptsFromHtml } from "../../src/render/scripts.mjs";

const require = createRequire(import.meta.url);

// Concatenate the page's executable classic scripts (inline code + fetched
// external `src`) in source order — mirrors `src/render` so the deno_core tier
// runs the same code a browser would. Module scripts are not executed.
async function pageScript(native, html, baseUrl) {
  const parts = [];
  for (const item of extractScriptsFromHtml(html, baseUrl)) {
    if (item.module) continue;
    if (item.code != null) parts.push(item.code);
    else if (item.url) parts.push(await fetchText(native, item.url));
  }
  return parts.join("\n;\n");
}

async function fetchText(native, url) {
  const r = JSON.parse(await native.fetchHtml(url));
  return r.html;
}

// Wrap a routine's `evaluate` argument (function or expression) so the result
// crosses the napi boundary JSON-typed (number/bool/string/object), matching the
// real-browser oracle — `native.evaluate` itself returns the raw completion value.
function evalSource(fnOrStr) {
  const body = typeof fnOrStr === "function" ? `(${fnOrStr.toString()})()` : `(${fnOrStr})`;
  return `JSON.stringify((${body}) ?? null)`;
}

class RustPage {
  constructor(native, jsMode) {
    this._native = native;
    this._js = jsMode;
    this._html = "";
    this._url = "about:blank";
    this._cookies = "[]";
    this._history = [];
  }

  _apply(r) {
    this._html = r.html;
    this._url = r.finalUrl;
    this._cookies = r.cookies;
  }

  async _render() {
    const code = await pageScript(this._native, this._html, this._url);
    if (code.trim()) this._html = this._native.render(this._html, this._url, code);
  }

  async _navigate(r, track) {
    this._apply(r);
    if (this._js) await this._render();
    // History holds full page snapshots (like a browser's back-forward cache), so
    // goBack restores instantly instead of re-fetching — matching a real browser.
    if (track) this._history.push({ html: this._html, url: this._url, cookies: this._cookies });
    return { status: () => r.status, url: () => r.finalUrl };
  }

  async goto(url) {
    const r = JSON.parse(await this._native.fetchWithCookies(url, this._cookies, null, null));
    return this._navigate(r, true);
  }

  async goBack() {
    this._history.pop(); // drop current
    const prev = this._history[this._history.length - 1];
    if (!prev) return null;
    this._html = prev.html;
    this._url = prev.url;
    this._cookies = prev.cookies;
    return { status: () => 200, url: () => this._url };
  }

  async evaluate(fnOrStr) {
    const raw = this._native.evaluate(this._html, evalSource(fnOrStr));
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  async title() {
    // Via evaluate so it shares the persistent isolate's install with the routine's
    // other page.evaluate calls (one parse per page, not one per napi read).
    return this.evaluate("document.title");
  }

  url() {
    return this._url;
  }

  async fill(selector, value) {
    this._html = this._native.fill(this._html, selector, value);
  }

  async click(selector) {
    const intent = JSON.parse(this._native.click(this._html, selector, this._url));
    return this._followIntent(intent);
  }

  async _followIntent(intent) {
    if (intent.action === "navigate") return this.goto(intent.url);
    if (intent.action === "submit") return this._submit(intent);
    return null; // inert (JS-only handler — nothing to fire without JS)
  }

  async _submit(intent) {
    const method = intent.method === "GET" ? null : intent.method;
    const r = JSON.parse(
      await this._native.fetchWithCookies(intent.url, this._cookies, method, intent.body ?? null),
    );
    return this._navigate(r, true);
  }

  async close() {}
}

// `{ launch() → { newPage, close } }` — the shape `engines.mjs` expects.
export async function loadTurboRust(jsMode) {
  const native = require("../../rust/crates/turbo-crawl-napi/index.js");
  native.version(); // probe: throws here (→ engine skipped) if the addon is absent
  return {
    launch: async () => ({
      newPage: async () => new RustPage(native, jsMode),
      close: async () => {},
    }),
  };
}

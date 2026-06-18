//! Render runtime (tier 3). Page JS runs on a `deno_core` V8 isolate. The DOM is
//! a real rtdom↔V8 binding ([`crate::browser_env`], vendored from turbo-test) so
//! jQuery / React / hand-rolled bundles see a genuine `document`/Element. deno_core
//! supplies the rest: the async event loop, `fetch`/cookies over the tier-1 net
//! stack (`#[op2]` ops below), virtual timers, and the runaway-execution budget.
//!
//! Flow per render: build the runtime → graft the DOM binding onto its context with
//! the fetched page parsed in ([`install_dom`]) → run the page script → drain the
//! event loop + virtual timers → serialize the hydrated tree back to HTML.
//!
//! The binding stores V8 `Global` handles in thread-locals; they MUST be cleared
//! (`browser_env::reset()`) while the isolate is still alive, before the runtime
//! drops — otherwise a later drop on a dead isolate crashes. Every entry point
//! resets on the way out.

use deno_core::{op2, v8, JsRuntime, OpState, RuntimeOptions};
use std::cell::RefCell;
use std::rc::Rc;
use turbo_crawl_core::cookies::CookieJar;
use turbo_crawl_core::net::{fetch_html, FetchOptions};
use turbo_crawl_core::url::resolve;

/// Page base URL (the `location.href`): the base for relative `fetch` and the
/// scope for the `document.cookie` bridge. Stored in op state.
struct Base(String);

/// Shared cookie jar backing `document.cookie` (and page `fetch`). Stored in op
/// state behind `Rc<RefCell<…>>` since ops borrow it across the isolate.
type Jar = Rc<RefCell<CookieJar>>;

/// `fetch` result marshaled back to JS as a `Response`-like object.
#[derive(serde::Serialize)]
struct FetchOut {
    status: u16,
    ok: bool,
    body: String,
}

// `document.cookie` getter: cookies applicable to the page's base URL.
#[op2]
#[string]
fn op_cookie_get(state: &mut OpState) -> String {
    let base = state.borrow::<Base>().0.clone();
    state.borrow::<Jar>().borrow().cookie_header(&base, 0.0)
}

// `document.cookie` setter: ingest a `name=value; attrs` line against the base.
#[op2(fast)]
fn op_cookie_set(state: &mut OpState, #[string] line: &str) {
    let base = state.borrow::<Base>().0.clone();
    state
        .borrow::<Jar>()
        .borrow_mut()
        .set_from_response(&base, &[line.to_string()], 0.0);
}

// `fetch(url)` over the tier-1 net stack. Relative URLs resolve against the
// page base. Never throws across the boundary: a transport/parse failure comes
// back as `{ status: 0, ok: false }` so page code sees a real (failed) Response.
#[op2]
#[serde]
async fn op_fetch(state: Rc<RefCell<OpState>>, #[string] url: String) -> FetchOut {
    let base = state.borrow().borrow::<Base>().0.clone();
    let target = resolve(&base, &url).unwrap_or(url);
    let opts = FetchOptions {
        allow_non_html: true, // fetch pulls JSON/text too
        ..Default::default()
    };
    match fetch_html(&target, opts).await {
        Ok(r) => FetchOut {
            status: r.status,
            ok: (200..300).contains(&r.status),
            body: r.html,
        },
        Err(_) => FetchOut {
            status: 0,
            ok: false,
            body: String::new(),
        },
    }
}

deno_core::extension!(turbo_dom, ops = [op_cookie_get, op_cookie_set, op_fetch],);

// Non-DOM browser globals, layered over the ops AFTER the native DOM binding is
// installed (`browser_env` owns document/Element/window/navigator/Event/etc.; this
// adds what a network-free test env lacks and overrides a few brand/host values).
// Virtual timers are queued and drained synchronously by `__runTimers`, ordered by
// delay — no wall-clock waits. `fetch`/XHR go over the tier-1 net stack.
//
// Wrapped in an IIFE so it is RE-RUNNABLE on a reused isolate: a persistent
// runtime (see `run_with_dom`) re-installs the page per call, which re-runs this;
// top-level `const`/`let` would throw "already declared" the second time, but
// inside the IIFE they're per-invocation. Globals are assigned to `globalThis`
// (idempotent) and the cookie bridge re-applies to the current `document`.
const ENV_BOOTSTRAP: &str = r##"(() => {
const ops = Deno.core.ops;
globalThis.self = globalThis;
// turbo-crawl brand UA (browser_env.js seeds a generic one; override it here).
globalThis.navigator = { userAgent: "turbo-crawl", language: "en-US", languages: ["en-US"] };
globalThis.location = globalThis.location || { href: "about:blank", protocol: "about:", host: "", pathname: "blank" };
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
})();
const __log = (...a) => Deno.core.print(a.map(String).join(" ") + "\n");
globalThis.console = { log: __log, info: __log, warn: __log, error: __log, debug: () => {} };
const __timers = [];
let __tid = 1;
globalThis.setTimeout = (fn, delay = 0, ...args) => {
  __timers.push({ id: __tid, fn, delay: +delay || 0, args });
  return __tid++;
};
globalThis.setInterval = globalThis.setTimeout; // one-shot here (no event loop)
globalThis.clearTimeout = (id) => {
  const i = __timers.findIndex((t) => t.id === id);
  if (i >= 0) __timers.splice(i, 1);
};
globalThis.clearInterval = globalThis.clearTimeout;
globalThis.requestAnimationFrame = (fn) => globalThis.setTimeout(fn, 16);
globalThis.cancelAnimationFrame = globalThis.clearTimeout;
globalThis.queueMicrotask = (fn) => globalThis.setTimeout(fn, 0);
globalThis.__runTimers = (max = 100000) => {
  let n = 0;
  while (__timers.length && n < max) {
    n++;
    __timers.sort((a, b) => a.delay - b.delay);
    const t = __timers.shift();
    try { t.fn(...t.args); } catch (e) { Deno.core.print("timer error: " + e + "\n"); }
  }
  return n; // count fired — lets the hydration pump detect quiescence
};
// NOTE: getElementsByTagName/ClassName/Name, lastChild/previous*/nextElementSibling,
// and document.write/writeln are provided by the vendored binding (browser_env.js,
// turbo-test ≥ 71477ba) — real-world bundles (jQuery's load-time support probe,
// document.write-driven pages) depend on them. They live upstream, not here.
//
// document.cookie bridge → the shared CookieJar (scoped to the page base URL). An
// OWN accessor on the document instance, shadowing browser_env.js's pure-JS jar.
Object.defineProperty(globalThis.document, "cookie", {
  configurable: true,
  get() { return ops.op_cookie_get(); },
  set(v) { ops.op_cookie_set(String(v)); },
});
// fetch over the tier-1 net stack → a minimal Response.
globalThis.fetch = async (url) => {
  const r = await ops.op_fetch(String(url));
  return {
    status: r.status,
    ok: r.ok,
    url: String(url),
    text: async () => r.body,
    json: async () => JSON.parse(r.body),
  };
};
// XMLHttpRequest over fetch (async; resolves in the event loop).
globalThis.XMLHttpRequest = class {
  constructor() { this.readyState = 0; this.status = 0; this.responseText = ""; }
  open(method, url) { this._m = method || "GET"; this._u = url; this.readyState = 1; }
  setRequestHeader() {}
  send(body) {
    const self = this;
    globalThis
      .fetch(this._u, { method: this._m, body })
      .then(async (r) => {
        self.status = r.status;
        self.responseText = await r.text();
        self.response = self.responseText;
        self.readyState = 4;
        if (self.onreadystatechange) self.onreadystatechange();
        if (self.onload) self.onload();
      });
  }
};
// Observers: no live mutation notifications over the static tree → no-op stubs.
class __NoopObserver {
  constructor(cb) { this._cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}
globalThis.MutationObserver = __NoopObserver;
globalThis.IntersectionObserver = __NoopObserver;
globalThis.ResizeObserver = __NoopObserver;
// History API (single virtual entry; updates location.href).
globalThis.history = {
  state: null,
  length: 1,
  pushState(s, _t, u) { this.state = s; if (u != null) globalThis.location.href = String(u); },
  replaceState(s, _t, u) { this.state = s; if (u != null) globalThis.location.href = String(u); },
  back() {}, forward() {}, go() {},
};
globalThis.requestIdleCallback = (fn) => globalThis.setTimeout(fn, 0);
globalThis.cancelIdleCallback = (id) => globalThis.clearTimeout(id);

// WHATWG URL + URLSearchParams — deno_core ships neither, but app bundles (Next.js,
// the PropelAuth SDK, …) use `new URL(...)` while hydrating, so without these the
// page crashes with "URL is not defined" before rendering. Regex-parsed: covers the
// http(s) shapes hydration reads (protocol/host/port/path/query/hash + searchParams).
if (typeof globalThis.URLSearchParams === "undefined") {
  globalThis.URLSearchParams = class URLSearchParams {
    constructor(init = "") {
      this._d = [];
      if (init instanceof URLSearchParams) { this._d = init._d.map((p) => [p[0], p[1]]); return; }
      if (init && typeof init === "object") {
        for (const k of Object.keys(init)) this._d.push([String(k), String(init[k])]);
        return;
      }
      let s = String(init);
      if (s[0] === "?") s = s.slice(1);
      if (!s) return;
      for (const pair of s.split("&")) {
        if (!pair) continue;
        const i = pair.indexOf("=");
        const k = i === -1 ? pair : pair.slice(0, i);
        const v = i === -1 ? "" : pair.slice(i + 1);
        const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, " ")); } catch { return x; } };
        this._d.push([dec(k), dec(v)]);
      }
    }
    append(k, v) { this._d.push([String(k), String(v)]); }
    delete(k) { this._d = this._d.filter((p) => p[0] !== k); }
    get(k) { const p = this._d.find((p) => p[0] === k); return p ? p[1] : null; }
    getAll(k) { return this._d.filter((p) => p[0] === k).map((p) => p[1]); }
    has(k) { return this._d.some((p) => p[0] === k); }
    set(k, v) { this.delete(k); this._d.push([String(k), String(v)]); }
    sort() { this._d.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); }
    forEach(cb, t) { for (const p of this._d) cb.call(t, p[1], p[0], this); }
    keys() { return this._d.map((p) => p[0])[Symbol.iterator](); }
    values() { return this._d.map((p) => p[1])[Symbol.iterator](); }
    entries() { return this._d.map((p) => [p[0], p[1]])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    get size() { return this._d.length; }
    toString() {
      return this._d.map((p) => encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1])).join("&");
    }
  };
}
if (typeof globalThis.URL === "undefined") {
  const ABS = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
  globalThis.URL = class URL {
    constructor(url, base) {
      let input = String(url);
      if (!ABS.test(input)) {
        if (base == null) throw new TypeError("Invalid URL: " + url);
        const b = base instanceof URL ? base : new URL(String(base));
        if (input.startsWith("//")) input = b.protocol + input;
        else if (input.startsWith("/")) input = b.protocol + "//" + b.host + input;
        else if (input.startsWith("#")) input = b.protocol + "//" + b.host + b.pathname + b.search + input;
        else if (input.startsWith("?")) input = b.protocol + "//" + b.host + b.pathname + input;
        else {
          const dir = b.pathname.slice(0, b.pathname.lastIndexOf("/") + 1) || "/";
          input = b.protocol + "//" + b.host + dir + input;
        }
      }
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/\/(([^/?#@]*)@)?([^/?#:]*)(:(\d+))?)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(input);
      if (!m) throw new TypeError("Invalid URL: " + url);
      this.protocol = m[1];
      const ui = (m[4] || "").split(":");
      this.username = ui[0] || "";
      this.password = ui[1] || "";
      this.hostname = m[5] || "";
      this.port = m[7] || "";
      this.pathname = m[8] || (m[2] ? "/" : "");
      this.hash = m[10] || "";
      this.searchParams = new URLSearchParams(m[9] || "");
    }
    get host() { return this.port ? this.hostname + ":" + this.port : this.hostname; }
    get origin() { return this.protocol + "//" + this.host; }
    get search() { const q = this.searchParams.toString(); return q ? "?" + q : ""; }
    set search(v) { this.searchParams = new URLSearchParams(String(v)); }
    get href() {
      const auth = this.username ? this.username + (this.password ? ":" + this.password : "") + "@" : "";
      return this.protocol + "//" + auth + this.host + this.pathname + this.search + this.hash;
    }
    set href(v) { Object.assign(this, new URL(v)); }
    toString() { return this.href; }
    toJSON() { return this.href; }
  };
  globalThis.URL.createObjectURL = () => "blob:turbo-crawl";
  globalThis.URL.revokeObjectURL = () => {};
}

// Next.js's webpack runtime reads `document.currentScript` to resolve chunk paths
// (getPathFromScript → `currentScript.getAttribute('src').replace(...)`). The tier
// runs the page's scripts as one concatenated bundle, so there's no "current" script
// element — expose a detached one whose `src` is the page URL (a string, so the
// `.replace` is safe) to keep that read working.
try {
  if (globalThis.document && !globalThis.document.currentScript) {
    const __cs = globalThis.document.createElement("script");
    const __href = (globalThis.location && globalThis.location.href) || "";
    __cs.setAttribute("src", __href);
    try { __cs.src = __href; } catch (_e) {}
    globalThis.document.currentScript = __cs;
  }
} catch (_e) {}

// --- hydration pump: the browser's script-loading model -----------------------
// Real SPAs (Next.js/webpack) don't ship their code inline — they BOOT a tiny
// runtime that injects more <script src> chunks at runtime and waits for each
// chunk's `onload` before continuing (webpack's `__webpack_require__.e`). A node
// DOM that merely *appends* the <script> node never runs it, so the loader
// promise hangs and the app never mounts. So: execute each <script> element once
// (inline → eval in global scope; external → fetch its src then eval), and fire
// load/error so the loader resolves. `__hydrate()` drives this to quiescence.
const __EXECUTABLE_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);
function __fireScriptEvent(el, kind, err) {
  const ev = { type: kind, target: el, currentTarget: el, error: err };
  try { const h = kind === "load" ? el.onload : el.onerror; if (typeof h === "function") h.call(el, ev); } catch (_e) {}
  try { if (typeof el.dispatchEvent === "function") el.dispatchEvent(ev); } catch (_e) {}
}
globalThis.__execScriptEl = async function (el) {
  if (!el || el.__tcDone) return;
  el.__tcDone = true; // mark before await so a re-entrant pump round can't double-run
  const get = (n) => (typeof el.getAttribute === "function" ? el.getAttribute(n) : null);
  if (!__EXECUTABLE_TYPES.has((get("type") || "").toLowerCase())) return; // JSON/data blocks etc.
  const src = get("src");
  try {
    let code;
    if (src) {
      const abs = new URL(src, globalThis.location.href).href;
      const res = await fetch(abs);
      if (!res.ok) { __fireScriptEvent(el, "error"); return; }
      code = await res.text();
    } else {
      code = el.textContent || el.text || "";
    }
    // Set document.currentScript to THIS element during execution, like a browser.
    // Turbopack/webpack chunk runtimes do `TURBOPACK.push([document.currentScript, …])`
    // to correlate each chunk with the element that loaded it — a single static
    // currentScript makes every chunk look identical and the module graph never
    // resolves. Restore the prior value after (nested injects during eval).
    let __prevCs;
    try { __prevCs = globalThis.document.currentScript; globalThis.document.currentScript = el; } catch (_e) {}
    try {
      (0, eval)(code); // classic-script semantics: run in global scope
    } finally {
      try { globalThis.document.currentScript = __prevCs; } catch (_e) {}
    }
    __fireScriptEvent(el, "load");
  } catch (e) {
    __fireScriptEvent(el, "error", e);
    Deno.core.print("script error (" + (src || "inline") + "): " + e + "\n");
  }
};
// Run every not-yet-run <script> in DOM order, drain timers, repeat while new
// scripts appear or timers keep firing. Bounded by maxRounds (+ the render budget).
globalThis.__hydrate = async function (maxRounds = 300) {
  for (let round = 0; round < maxRounds; round++) {
    let ranScript = false;
    for (const el of Array.prototype.slice.call(document.querySelectorAll("script"))) {
      if (!el.__tcDone) { ranScript = true; await globalThis.__execScriptEl(el); }
    }
    const ranTimers = globalThis.__runTimers(100000) > 0;
    if (!ranScript && !ranTimers) break;
  }
};
})();"##;

fn make_runtime(base: &str) -> JsRuntime {
    let rt = JsRuntime::new(RuntimeOptions {
        extensions: vec![turbo_dom::init()],
        ..Default::default()
    });
    let state = rt.op_state();
    let mut state = state.borrow_mut();
    state.put::<Base>(Base(base.to_string()));
    state.put::<Jar>(Rc::new(RefCell::new(CookieJar::new())));
    drop(state);
    rt
}

/// Graft the native DOM binding onto the runtime's context (parsing `html` into the
/// tree), then layer the non-DOM env globals over the ops. After this the page
/// script runs against a real `document`.
fn install_dom(rt: &mut JsRuntime, html: &str, base: &str) -> Result<(), String> {
    let context = rt.main_context();
    {
        let scope = v8::HandleScope::new(rt.v8_isolate());
        let scope = std::pin::pin!(scope);
        let mut scope = scope.init();
        let context = v8::Local::new(&scope, context);
        let mut scope = v8::ContextScope::new(&mut scope, context);
        crate::browser_env::install_html(&mut scope, html);
    }
    rt.execute_script("<env>", ENV_BOOTSTRAP)
        .map_err(|e| e.to_string())?;
    rt.execute_script("<location>", format!("location.href = {base:?}"))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn read_string(rt: &mut JsRuntime, global: v8::Global<v8::Value>) -> Result<String, String> {
    let context = rt.main_context();
    let scope = v8::HandleScope::new(rt.v8_isolate());
    let scope = std::pin::pin!(scope);
    let mut scope = scope.init();
    let context = v8::Local::new(&scope, context);
    let scope = v8::ContextScope::new(&mut scope, context);
    let local = v8::Local::new(&scope, global);
    Ok(local.to_rust_string_lossy(&scope))
}

thread_local! {
    /// Persistent evaluate runtime, reused across `run_with_dom` calls (i.e. across
    /// pages) so the ~20ms V8-isolate boot is paid ONCE per thread, not per call —
    /// the dominant per-page cost for a no-JS crawler whose link/field extraction
    /// goes through `page.evaluate`. Safe to reuse across pages: each call reinstalls
    /// a fresh DOM from the page's HTML, and the binding's V8 globals are cleared
    /// (`browser_env::reset`) after every call, so the thread-local DOM is empty at
    /// thread exit (no dangling handles when the isolate finally drops). Page-JS
    /// isolation across pages is intentionally relaxed here — a crawl doesn't need it.
    static EVAL_RT: RefCell<Option<(JsRuntime, String)>> = const { RefCell::new(None) };
}

/// Evaluate `script` against `html`'s DOM, returning its result as a string
/// (Playwright `page.evaluate`-ish; synchronous, no event loop). Reuses a
/// thread-persistent isolate AND the installed DOM across calls on the SAME page
/// (see [`EVAL_RT`]): the page is parsed + installed once, then repeated
/// `page.evaluate`s on it just run script (~0.5 ms) instead of re-parsing the
/// document (~5 ms). The DOM is re-installed only when the HTML changes (a new
/// page). Same-page evaluates share the page's globals/DOM, which matches
/// Playwright's page-scoped `evaluate` semantics.
pub fn run_with_dom(html: &str, script: &str) -> Result<String, String> {
    EVAL_RT.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some((make_runtime("about:blank"), String::new()));
        }
        let (rt, installed) = slot.as_mut().expect("eval runtime present");
        if installed != html {
            crate::browser_env::reset(); // drop the previous page's binding (isolate still alive)
            install_dom(rt, html, "about:blank")?;
            installed.clear();
            installed.push_str(html);
        }
        let global = rt
            .execute_script("<page>", script.to_string())
            .map_err(|e| e.to_string())?;
        read_string(rt, global)
    })
}

/// Run page `script` against `html`, drain virtual timers, and return the hydrated
/// document HTML. The Lane B render contract: JS-gated page in, HTML after the
/// page's own scripts ran out. (Sync; no event loop — see [`render_page`].)
pub fn render_html(html: &str, script: &str) -> Result<String, String> {
    let mut rt = make_runtime("about:blank");
    let out = run_sync(&mut rt, html, script);
    crate::browser_env::reset();
    out
}

fn run_sync(rt: &mut JsRuntime, html: &str, script: &str) -> Result<String, String> {
    install_dom(rt, html, "about:blank")?;
    rt.execute_script("<page>", script.to_string())
        .map_err(|e| e.to_string())?;
    rt.execute_script("<timers>", "__runTimers()")
        .map_err(|e| e.to_string())?;
    Ok(crate::browser_env::document_html())
}

async fn drain_event_loop(rt: &mut JsRuntime) -> Result<(), String> {
    rt.run_event_loop(deno_core::PollEventLoopOptions::default())
        .await
        .map_err(|e| e.to_string())
}

/// Like [`render_html`] but drives deno_core's event loop, so a page script that
/// hydrates asynchronously (`Promise`/`async`-`await`/microtasks, and timer
/// callbacks that themselves await) resolves before serialization. This is the
/// fidelity step real SPA frameworks need.
pub async fn render_html_async(html: &str, script: &str) -> Result<String, String> {
    render_page(html, "about:blank", script).await
}

/// Default render execution budget (eval-guard). A page script that loops forever
/// (sync) or never settles (async) is terminated past this.
pub const DEFAULT_RENDER_BUDGET_MS: u64 = 10_000;

/// Async render with a page base URL — relative `fetch` resolves against it and
/// the `document.cookie` bridge is scoped to it. Drives the event loop so
/// `fetch`-driven and promise-based hydration completes before serialization.
/// Bounded by [`DEFAULT_RENDER_BUDGET_MS`].
pub async fn render_page(html: &str, base: &str, script: &str) -> Result<String, String> {
    render_page_with_budget(html, base, script, DEFAULT_RENDER_BUDGET_MS).await
}

/// `render_page` with an explicit execution budget (ms). The V8 isolate is a true
/// isolate (host heap unreachable from guest); this adds a runaway-execution guard:
/// a watchdog thread terminates the isolate if the script exceeds `budget_ms`.
pub async fn render_page_with_budget(
    html: &str,
    base: &str,
    script: &str,
    budget_ms: u64,
) -> Result<String, String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let mut rt = make_runtime(base);
    let handle = rt.v8_isolate().thread_safe_handle();
    let done = Arc::new(AtomicBool::new(false));
    let watch = done.clone();
    let watchdog = std::thread::spawn(move || {
        let start = std::time::Instant::now();
        while !watch.load(Ordering::Relaxed) {
            if start.elapsed() >= std::time::Duration::from_millis(budget_ms) {
                handle.terminate_execution();
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    });

    let result = run_async(&mut rt, html, base, script).await;
    done.store(true, Ordering::Relaxed);
    let _ = watchdog.join();
    let out = result.map_err(|e| budget_msg(&e, budget_ms));
    crate::browser_env::reset();
    out
}

async fn run_async(
    rt: &mut JsRuntime,
    html: &str,
    base: &str,
    script: &str,
) -> Result<String, String> {
    install_dom(rt, html, base)?;
    rt.execute_script("<page>", script.to_string())
        .map_err(|e| e.to_string())?;
    drain_event_loop(rt).await?; // promises/microtasks + fetch from the page
    rt.execute_script("<timers>", "__runTimers()")
        .map_err(|e| e.to_string())?;
    drain_event_loop(rt).await?; // promises queued by timer callbacks
    Ok(crate::browser_env::document_html())
}

/// Hydrate a page by running ITS OWN scripts the way a browser does — execute each
/// `<script>` (inline + dynamically-injected chunks), fetching + running external
/// `src` and firing `onload` so a webpack-style chunk loader resolves and the app
/// mounts. No bundle concatenation by the caller, no framework runtime from us: the
/// page's own bundle drives itself. Bounded by [`DEFAULT_RENDER_BUDGET_MS`].
pub async fn render_hydrate(html: &str, base: &str) -> Result<String, String> {
    render_hydrate_with_budget(html, base, DEFAULT_RENDER_BUDGET_MS).await
}

/// [`render_hydrate`] with an explicit execution budget (ms) + runaway watchdog.
pub async fn render_hydrate_with_budget(
    html: &str,
    base: &str,
    budget_ms: u64,
) -> Result<String, String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let mut rt = make_runtime(base);
    let handle = rt.v8_isolate().thread_safe_handle();
    let done = Arc::new(AtomicBool::new(false));
    let watch = done.clone();
    let watchdog = std::thread::spawn(move || {
        let start = std::time::Instant::now();
        while !watch.load(Ordering::Relaxed) {
            if start.elapsed() >= std::time::Duration::from_millis(budget_ms) {
                handle.terminate_execution();
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    });

    let result = run_hydrate(&mut rt, html, base).await;
    done.store(true, Ordering::Relaxed);
    let _ = watchdog.join();
    let out = result.map_err(|e| budget_msg(&e, budget_ms));
    crate::browser_env::reset();
    out
}

async fn run_hydrate(rt: &mut JsRuntime, html: &str, base: &str) -> Result<String, String> {
    install_dom(rt, html, base)?;
    // __hydrate() returns a promise that resolves once scripts + timers quiesce;
    // the event loop pumps the chunk fetches it awaits.
    rt.execute_script("<hydrate>", "globalThis.__tcHydrate = __hydrate();")
        .map_err(|e| e.to_string())?;
    drain_event_loop(rt).await?;
    rt.execute_script("<timers>", "__runTimers()")
        .map_err(|e| e.to_string())?;
    drain_event_loop(rt).await?;
    Ok(crate::browser_env::document_html())
}

// A terminated isolate surfaces as a generic execution error; relabel it.
fn budget_msg(e: &str, budget_ms: u64) -> String {
    if e.contains("terminated") || e.contains("execution") {
        format!("render budget exceeded ({budget_ms}ms)")
    } else {
        e.to_string()
    }
}

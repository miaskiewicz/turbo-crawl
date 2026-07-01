//! Fingerprint **debug/probe mode**: run a page's JS in the render isolate with
//! `navigator` / `screen` / `window.chrome` / canvas wrapped in logging proxies,
//! then report every property a script *touched* and which ones came back
//! `undefined` — i.e. exactly what an anti-bot check read and what we still need
//! to shim to satisfy it.
//!
//! This is the reconnaissance step for getting past consistency-only gates (and
//! the groundwork for any in-house solver): point it at a WAF's collector script
//! and it tells you the surface to fill in. It does NOT execute the network — feed
//! it the page HTML + the script you want to observe.

use serde::Serialize;
use std::collections::BTreeMap;

/// What a script touched on the instrumented globals.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProbeAccess {
    /// Instrumented object: `navigator`, `screen`, `chrome`, `canvas`, `document`.
    pub target: String,
    /// Property / method name.
    pub prop: String,
    /// `"get"` (read) or `"call"` (invoked as a function).
    pub kind: String,
    /// Whether the value was defined (a `get` returning `undefined` is a shim gap).
    pub defined: bool,
    /// How many times it was touched.
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeReport {
    /// Distinct accesses, sorted by `target.prop`.
    pub accesses: Vec<ProbeAccess>,
    /// `target.prop` reads that returned `undefined` — the shim to-do list.
    pub shim_needed: Vec<String>,
}

// Wraps the fingerprint surfaces in logging Proxies. Runs in the page-script slot
// AFTER ENV_BOOTSTRAP, so it re-wraps the real (already-installed) globals — no
// ENV_BOOTSTRAP edit or op plumbing needed. Records into `globalThis.__probe`.
const PROBE_INSTALL: &str = r#"(() => {
  const log = (globalThis.__probe = []);
  const rec = (target, prop, kind, defined) => {
    try { log.push({ target, prop: String(prop), kind, defined }); } catch (e) {}
  };
  const wrap = (name, obj) => {
    if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return obj;
    return new Proxy(obj, {
      get(o, p) {
        const v = Reflect.get(o, p);
        rec(name, p, "get", v !== undefined);
        if (typeof v === "function") {
          return function (...a) {
            rec(name, p, "call", true);
            return v.apply(this === undefined ? o : this, a);
          };
        }
        return v;
      },
    });
  };
  if (globalThis.navigator) globalThis.navigator = wrap("navigator", globalThis.navigator);
  globalThis.screen = wrap("screen", globalThis.screen || {});
  if (globalThis.chrome) globalThis.chrome = wrap("chrome", globalThis.chrome);
  // Canvas / WebGL fingerprint surface: tag context creation + pixel readback.
  try {
    const doc = globalThis.document;
    if (doc && doc.createElement) {
      const orig = doc.createElement.bind(doc);
      doc.createElement = (tag) => {
        const el = orig(tag);
        if (String(tag).toLowerCase() === "canvas") {
          rec("document", "createElement(canvas)", "call", true);
          return wrap("canvas", el);
        }
        return el;
      };
    }
  } catch (e) {}
})();"#;

#[derive(serde::Deserialize)]
struct RawAccess {
    target: String,
    prop: String,
    kind: String,
    defined: bool,
}

/// Run `script` against `html` with the fingerprint globals instrumented, and
/// report what it touched. Aggregates duplicate touches and surfaces the reads
/// that returned `undefined` as the shim to-do list.
pub fn probe_globals(html: &str, script: &str) -> Result<ProbeReport, String> {
    // PROBE_INSTALL, then the (guarded) script, then serialise the log.
    let wrapped = format!(
        "{PROBE_INSTALL}\ntry {{\n{script}\n}} catch (e) {{}}\n;JSON.stringify(globalThis.__probe || [])"
    );
    let json = crate::runtime::run_with_dom(html, &wrapped)?;
    let raw: Vec<RawAccess> =
        serde_json::from_str(&json).map_err(|e| format!("probe log parse: {e}"))?;

    // Aggregate by (target, prop, kind); a prop is a shim gap if every read of it
    // came back undefined.
    let mut agg: BTreeMap<(String, String, String), (bool, u32)> = BTreeMap::new();
    for a in raw {
        let entry = agg.entry((a.target, a.prop, a.kind)).or_insert((false, 0));
        entry.0 |= a.defined;
        entry.1 += 1;
    }

    let mut accesses: Vec<ProbeAccess> = agg
        .into_iter()
        .map(|((target, prop, kind), (defined, count))| ProbeAccess {
            target,
            prop,
            kind,
            defined,
            count,
        })
        .collect();
    accesses.sort_by(|a, b| (&a.target, &a.prop).cmp(&(&b.target, &b.prop)));

    let mut shim_needed: Vec<String> = accesses
        .iter()
        .filter(|a| a.kind == "get" && !a.defined)
        .map(|a| format!("{}.{}", a.target, a.prop))
        .collect();
    shim_needed.sort();
    shim_needed.dedup();

    Ok(ProbeReport {
        accesses,
        shim_needed,
    })
}

// Tests for `probe_globals` live in `tests/probe.rs`, a separate test process:
// they boot a deno_core runtime (which initializes the V8 platform), and the
// lib unit-test binary must stay deno_core-free so it never collides with
// `browser_env`'s standalone-V8 smoke test (see browser_env.rs header).

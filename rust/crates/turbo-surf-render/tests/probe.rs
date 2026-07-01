//! `probe_globals` tests in their own test process. These boot a deno_core
//! runtime (which initializes the V8 platform), so they must NOT share a binary
//! with the `browser_env` standalone-V8 smoke test (the lib unit-test binary).
//! A separate integration-test binary = a separate process = its own one-time
//! V8 init, so the two never collide (same split as `tests/render.rs`).

use turbo_surf_render::probe_globals;

#[test]
fn reports_touched_props_and_shim_gaps() {
    // A script that profiles the browser the way an anti-bot collector would.
    let script = r#"
        const _ = [navigator.userAgent, navigator.platform, navigator.webdriver,
                   navigator.hardwareConcurrency, navigator.languages,
                   navigator.thisDoesNotExist, screen.width, window.chrome];
        navigator.plugins;
        ''
    "#;
    let r = probe_globals("<body></body>", script).unwrap();
    let touched = |t: &str, p: &str| {
        r.accesses
            .iter()
            .any(|a| a.target == t && a.prop == p && a.kind == "get")
    };
    assert!(touched("navigator", "userAgent"));
    assert!(touched("navigator", "webdriver"));
    assert!(touched("navigator", "platform"));
    // The real Chrome profile is present → not a shim gap.
    assert!(!r.shim_needed.iter().any(|s| s == "navigator.userAgent"));
    // The bogus prop returned undefined → flagged as a gap to shim.
    assert!(r
        .shim_needed
        .iter()
        .any(|s| s == "navigator.thisDoesNotExist"));
}

#[test]
fn flags_canvas_fingerprinting() {
    let script = r#"
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d');
        try { c.toDataURL(); } catch (e) {}
        ''
    "#;
    let r = probe_globals("<body></body>", script).unwrap();
    assert!(r
        .accesses
        .iter()
        .any(|a| a.target == "document" && a.prop == "createElement(canvas)"));
    assert!(r
        .accesses
        .iter()
        .any(|a| a.target == "canvas" && a.prop == "getContext"));
}

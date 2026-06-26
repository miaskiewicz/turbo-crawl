//! Probe a REAL captured anti-bot script: run it in the render isolate with the
//! fingerprint globals instrumented and print what it read + the shim gaps.
//!
//!   cargo run -p turbo-surf-render --example probe-script -- path/to/akamai.js
//!
//! This is the recon step for building an in-house solver: point it at a live
//! `_abck` / `_cf_chl` script you captured and it tells you exactly which
//! `navigator`/`screen`/`window.chrome`/canvas surface the script touches and
//! which reads came back `undefined` (the shim to-do list).

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: probe-script <script.js> [html]");
        std::process::exit(2);
    });
    let script = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        eprintln!("read {path}: {e}");
        std::process::exit(2);
    });
    let html = std::env::args()
        .nth(2)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| "<html><body></body></html>".to_string());

    println!("probing {} ({} bytes)\n", path, script.len());
    match turbo_surf_render::probe_globals(&html, &script) {
        Ok(report) => {
            println!("== touched ({}) ==", report.accesses.len());
            for a in &report.accesses {
                let mark = if a.defined { "ok " } else { "GAP" };
                println!(
                    "  [{mark}] {}.{} ({}, x{})",
                    a.target, a.prop, a.kind, a.count
                );
            }
            println!("\n== shim_needed ({}) ==", report.shim_needed.len());
            for s in &report.shim_needed {
                println!("  - {s}");
            }
        }
        Err(e) => {
            // A real obfuscated script often throws before finishing — the probe
            // still reports everything it touched up to the throw, which is the
            // useful part. Surface the error too.
            eprintln!("probe error (partial telemetry may still be useful): {e}");
            std::process::exit(1);
        }
    }
}

//! DOM-view differential parity (G13): the Rust view modules must match the JS
//! implementation for the same HTML. Golden is generated from `src/*.mjs` over
//! the turbo-dom JS runtime by `rust/parity/gen-golden.mjs` (the `dom` section).
//! Skip-gated on `golden.json` having a `dom` block (needs the turbo-dom JS pkg).

use serde_json::Value;
use turbo_crawl_view as view;
use turbo_dom_parser::rtdom::Tree;

fn dom_golden() -> Option<Value> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../parity/golden.json");
    let g: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    g.get("dom").filter(|d| !d.is_null()).cloned()
}

#[test]
fn rust_views_match_js_golden() {
    let Some(d) = dom_golden() else {
        eprintln!("parity: golden.dom absent — skipping (npm i + gen-golden.mjs)");
        return;
    };
    let html = d["html"].as_str().unwrap();
    let base = d["base"].as_str().unwrap();
    let tree = Tree::parse(html);
    let root = tree.root();

    assert_eq!(view::text(&tree, root), d["text"], "text parity");
    assert_eq!(
        view::markdown(&tree, root, base),
        d["markdown"],
        "markdown parity"
    );

    let links: Vec<String> = view::links(&tree, base);
    let want_links: Vec<String> = d["links"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert_eq!(links, want_links, "links parity");

    let det = view::detect_js_required(&tree, None, None);
    assert_eq!(
        det.js_required, d["detect"]["jsRequired"],
        "detect.js_required"
    );
    assert_eq!(
        det.scripts as u64,
        d["detect"]["scripts"].as_u64().unwrap(),
        "detect.scripts"
    );
    assert_eq!(det.reason, d["detect"]["reason"], "detect.reason");

    let hyd = view::extract_hydration_state(&tree);
    assert_eq!(
        hyd.next,
        Some(d["hydrationNext"].clone()),
        "hydration.next parity"
    );

    let schema = std::collections::BTreeMap::from([(
        "title".to_string(),
        view::Field {
            selector: Some("h1".to_string()),
            ..Default::default()
        },
    )]);
    let extracted = view::extract_schema(&tree, &schema, base);
    assert_eq!(extracted["title"], d["extractTitle"], "extract parity");
}

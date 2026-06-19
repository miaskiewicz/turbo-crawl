//! Rust-level hotspot microbench (no napi boundary): isolates the cost of
//! `Tree::parse` vs each view pass over a realistic ~250 KB document, so we can
//! see whether the per-call cost is parsing or the pass itself.
//!
//!   cargo bench -p turbo-surf-view

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use turbo_dom_parser::rtdom::Tree;
use turbo_surf_view as view;
use view::QueryType;

// A synthetic article-shaped page (~250 KB) — many links/paragraphs/list items,
// like the Wikipedia page the e2e harness crawls.
fn sample_html() -> String {
    let mut s = String::with_capacity(260_000);
    s.push_str("<!DOCTYPE html><html><head><title>Bench Article</title></head><body><div id='bodyContent'>");
    for i in 0..1500 {
        s.push_str(&format!(
            "<p class='para'>Paragraph {i} with <a href='/wiki/Topic_{i}'>link {i}</a> and \
             <a href='/wiki/Other:{i}'>ns {i}</a> text text text words words.</p>\
             <ul><li>item {i} a</li><li>item {i} b</li></ul>"
        ));
    }
    s.push_str("</div></body></html>");
    s
}

fn bench(c: &mut Criterion) {
    let html = sample_html();
    let base = "https://en.wikipedia.org/wiki/Web_crawler";

    c.bench_function("parse", |b| b.iter(|| Tree::parse(black_box(&html))));

    // Parse once, then bench each pass over the existing tree (excludes parse cost).
    let tree = Tree::parse(&html);
    let root = tree.root();
    c.bench_function("text", |b| b.iter(|| view::text(black_box(&tree), root)));
    c.bench_function("links", |b| b.iter(|| view::links(black_box(&tree), base)));
    c.bench_function("markdown", |b| {
        b.iter(|| view::markdown(black_box(&tree), root, base))
    });
    c.bench_function("query_a", |b| {
        b.iter(|| view::query(black_box(&tree), root, "a", QueryType::Auto))
    });

    // Full per-call cost as the stateless napi surface pays it (parse + pass).
    c.bench_function("parse+links (napi per-call)", |b| {
        b.iter(|| {
            let t = Tree::parse(black_box(&html));
            view::links(&t, base)
        })
    });
}

criterion_group!(benches, bench);
criterion_main!(benches);

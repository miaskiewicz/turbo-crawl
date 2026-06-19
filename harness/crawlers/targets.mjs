// Crawl targets for the multi-page crawl benchmark. Each target names a live
// site, a same-host start URL, and a single CSS selector that every crawler uses
// to count items — so "correctness" is the SAME metric across all engines, not
// each crawler's own idea of what it extracted.
//
// Two sets:
//   nojs — books.toscrape.com: server-rendered, paginated catalog. Every crawler
//          (turbo-surf no-js, CheerioCrawler, got+cheerio, node-crawler, …) can
//          fetch+parse it. itemSelector counts product titles.
//   js   — quotes.toscrape.com/js: quotes are written client-side via
//          document.write + jQuery, so a NON-JS crawler sees ~0 quotes and a
//          JS-executing crawler (or turbo-surf js-fast/js-secure) sees 10/page.
//          That gap is the point of the JS set.

// Restrict the JS crawl to the client-rendered catalog so every JS engine walks
// the same paginated /js/page/N/ chain and we don't wander onto /login etc.
function onJsCatalog(url) {
  return url.includes("/js/") || url.endsWith("/js");
}

export const TARGETS = {
  nojs: {
    name: "books.toscrape.com (SSR catalog)",
    set: "nojs",
    start: "https://books.toscrape.com/",
    host: "books.toscrape.com",
    // Each product card's <h3><a title="…"> — the book title.
    itemSelector: ".product_pod h3 a",
    // How a crawler reads one item's text from a matched node (cheerio/turbo-dom
    // both expose a `title` attr on this anchor; fall back to text).
    itemAttr: "title",
    allow: null,
  },
  js: {
    name: "quotes.toscrape.com/js (client-rendered)",
    set: "js",
    start: "https://quotes.toscrape.com/js/",
    host: "quotes.toscrape.com",
    // Each quote's text span — only present after JS runs.
    itemSelector: ".quote .text",
    itemAttr: "text",
    allow: onJsCatalog,
  },
};

export function targetForSet(set) {
  return set === "js" ? TARGETS.js : TARGETS.nojs;
}

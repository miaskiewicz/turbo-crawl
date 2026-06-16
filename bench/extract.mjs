// Bench: per-page parse + agent-view extraction throughput on an SSR-shaped
// corpus (SPEC §14). Measures the no-JS hot path — fetch is excluded; this is the
// "HTTP fetch + a cheap parse" cost model minus the network.
//
//   node bench/extract.mjs [iterations]

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { accessibilityTree } from "../src/ax.mjs";
import { interactiveElements, links } from "../src/extract.mjs";
import { markdown } from "../src/markdown.mjs";

// A representative server-rendered page: nav, article, a form, a product list.
function makePage(n) {
  const items = Array.from(
    { length: 40 },
    (_, i) =>
      `<li><a href="/p/${i}">Product ${i}</a> <span class="price">$${(i + 1) * 3}.99</span></li>`,
  ).join("");
  return `<!doctype html><html><head><title>Catalog ${n}</title>
  <style>.hidden{display:none}</style></head><body>
  <nav><a href="/">Home</a><a href="/cart">Cart</a><a href="/account">Account</a></nav>
  <main>
    <h1>Catalog page ${n}</h1>
    <p>A <strong>fast</strong> server-rendered listing with a <a href="/about">link</a> and prose
       that an agent would actually want to read and summarize for context.</p>
    <form action="/search" method="get">
      <input name="q" placeholder="Search products">
      <select name="sort"><option value="price">Price</option><option value="name">Name</option></select>
      <button type="submit">Go</button>
    </form>
    <ul class="products">${items}</ul>
    <div class="hidden"><a href="/promo">hidden promo</a></div>
  </main>
  <footer>© Example, boilerplate to be stripped.</footer></body></html>`;
}

const ITER = Number(process.argv[2] ?? 2000);
const CORPUS = Array.from({ length: 20 }, (_, i) => makePage(i));

function bench(label, fn) {
  // warmup
  for (let i = 0; i < 50; i++) fn(CORPUS[i % CORPUS.length], i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITER; i++) fn(CORPUS[i % CORPUS.length], i);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const persec = (ITER / ms) * 1000;
  console.log(
    `${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms   ${persec.toFixed(0).padStart(8)} pages/s`,
  );
}

console.log(`turbo-crawl extract bench — ${ITER} iterations, ${CORPUS.length} distinct pages\n`);

bench("parse only (createEnvironment)", (html) => {
  createEnvironment(html);
});
bench("parse + interactiveElements", (html, i) => {
  const env = createEnvironment(html);
  interactiveElements(env.document, `https://shop.test/c/${i}`, env.window);
});
bench("parse + links", (html, i) => {
  const env = createEnvironment(html);
  links(env.document, `https://shop.test/c/${i}`);
});
bench("parse + markdown", (html, i) => {
  const env = createEnvironment(html);
  markdown(env.document, `https://shop.test/c/${i}`);
});
bench("parse + accessibilityTree", (html) => {
  const env = createEnvironment(html);
  accessibilityTree(env.document);
});
bench("full agent view (els+links+md+ax)", (html, i) => {
  const env = createEnvironment(html);
  const base = `https://shop.test/c/${i}`;
  interactiveElements(env.document, base, env.window);
  links(env.document, base);
  markdown(env.document, base);
  accessibilityTree(env.document);
});

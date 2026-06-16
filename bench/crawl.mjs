// Bench: end-to-end crawl throughput over an in-memory SSR site (SPEC §14). Fetch
// is a zero-latency in-memory map, so this isolates frontier + Page-pool + reset
// + extraction overhead — "memory flat across a long crawl" via env reuse.
//
//   node bench/crawl.mjs [pages]

import { Crawler } from "../src/crawl.mjs";

const PAGES = Number(process.argv[2] ?? 500);

// A connected site: page i links to i+1, i+2, and a couple of back-links → a real
// frontier with dedupe pressure, capped at PAGES.
function site(n) {
  const links = [];
  for (let i = 0; i < n; i++) {
    const out = [i + 1, i + 2, Math.floor(i / 2)]
      .filter((j) => j >= 0 && j < n)
      .map((j) => `<a href="https://bench.test/p/${j}">p${j}</a>`)
      .join("");
    links[i] = `<!doctype html><title>Page ${i}</title><body><main>
      <h1>Page ${i}</h1><p>Body text for page ${i} with a <strong>link</strong> set.</p>
      ${out}</main></body>`;
  }
  return links;
}

const HTML = site(PAGES);
const fetchHtml = async (url) => {
  const i = Number(url.split("/p/")[1]);
  return { html: HTML[i], finalUrl: url, status: 200, headers: new Headers() };
};

const t0 = process.hrtime.bigint();
let count = 0;
for await (const _rec of new Crawler({
  start: "https://bench.test/p/0",
  maxPages: PAGES,
  maxDepth: Number.POSITIVE_INFINITY,
  concurrency: 8,
  fetchHtml,
})) {
  count++;
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const mem = process.memoryUsage().heapUsed / 1024 / 1024;
console.log(
  `crawled ${count} pages in ${ms.toFixed(1)} ms  (${((count / ms) * 1000).toFixed(0)} pages/s, heap ${mem.toFixed(1)} MiB)`,
);

// Differential parity: run the real JS implementation (turbo-crawl/src/*.mjs)
// over a fixed input set and emit golden.json. The Rust ports are asserted equal
// to this golden by `crates/turbo-crawl-core/tests/parity.rs`.
//
// Pure-logic modules (url / robots / cookies) need no turbo-dom and always run.
// The DOM-view modules (text/markdown/ax/...) need the turbo-dom JS package; when
// it is installed this script also emits their golden (TODO marker below).
//
//   node rust/parity/gen-golden.mjs   # regenerates rust/parity/golden.json

import { writeFileSync } from "node:fs";
import { CookieJar } from "../../src/cookies.mjs";
import { RobotsCache } from "../../src/robots.mjs";
import { canonicalize, isHttpUrl, resolve } from "../../src/url.mjs";

// --- url --------------------------------------------------------------------
const CANON = [
  "https://X.test/p?b=2&utm_source=g&a=1#h",
  "https://x.test",
  "http://x.test:80/a",
  "https://x.test/a/../b",
  "https://x.test/p?z=1&a=2&a=1",
];
const RESOLVE = [
  ["https://x.test/a/b", "../c"],
  ["https://x.test/", "https://y.test/z"],
  ["https://x.test/", ""],
];
const HTTP = ["http://x.test", "https://x.test", "mailto:a@b.test", "not a url"];

const url = {
  canonicalize: CANON.map((u) => canonicalize(u)),
  resolve: RESOLVE.map(([b, h]) => resolve(b, h)),
  isHttpUrl: HTTP.map((u) => isHttpUrl(u)),
};

// --- robots -----------------------------------------------------------------
const ROBOTS = "User-agent: *\nDisallow: /private\nAllow: /private/ok\nCrawl-delay: 3\n";
const rc = new RobotsCache({ fetchText: async () => ({ status: 200, text: ROBOTS }) });
const ROBOT_PATHS = ["/private/x", "/private/ok/y", "/public", "/private"];
const allowed = [];
for (const p of ROBOT_PATHS) allowed.push(await rc.allowed(`https://x.test${p}`, "turbo-crawl", 0));
const robots = {
  allowed,
  crawlDelay: (await rc.crawlDelay("https://x.test", "turbo-crawl", 0)) ?? null,
};

// --- cookies ----------------------------------------------------------------
const jar = new CookieJar();
jar.setFromResponse("https://x.test/app", ["a=1; Path=/", "b=2; Path=/app; Secure"], 0);
const cookies = {
  root: jar.cookieHeader("https://x.test/", 0),
  appHttps: jar.cookieHeader("https://x.test/app/x", 0),
  appHttp: jar.cookieHeader("http://x.test/app/x", 0),
};

// --- DOM views (needs the turbo-dom JS package) -----------------------------
let dom = null;
try {
  const { createEnvironment } = await import("@miaskiewicz/turbo-dom/runtime");
  const { text } = await import("../../src/text.mjs");
  const { markdown } = await import("../../src/markdown.mjs");
  const { links } = await import("../../src/extract.mjs");
  const { detectJsRequired } = await import("../../src/detect.mjs");
  const { extractHydrationState } = await import("../../src/hydration.mjs");
  const { extractSchema } = await import("../../src/schema.mjs");

  const HTML = `<html><head><title>Shop</title></head><body>
<main><h1>Widget</h1><p>Buy the <a href="/buy">widget</a> now.</p></main>
<a href="/a">A</a><a href="https://o.test/b">B</a>
<div id="root"></div><script src="/app.js"></script>
<script id="__NEXT_DATA__" type="application/json">{"p":1}</script>
</body></html>`;
  const BASE = "https://x.test/";
  const doc = createEnvironment(HTML).document;
  const det = detectJsRequired(doc);
  dom = {
    html: HTML,
    base: BASE,
    text: text(doc),
    markdown: markdown(doc, BASE),
    links: links(doc, BASE),
    detect: { jsRequired: det.jsRequired, scripts: det.scripts, reason: det.reason },
    hydrationNext: extractHydrationState(doc).next,
    extractTitle: extractSchema(doc, { title: { selector: "h1" } }, BASE).title,
  };
} catch (e) {
  console.error("DOM golden skipped (turbo-dom JS absent):", e.message);
}

const golden = { url, robots, cookies, dom };
writeFileSync(new URL("./golden.json", import.meta.url), `${JSON.stringify(golden, null, 2)}\n`);
console.log("wrote golden.json (dom:", dom ? "yes" : "no", ")");

// JS-execution render tier. The "fast" backend (in-process node:vm + native
// turbo-dom) needs no optional deps and always runs. The "secure" backend
// (isolated-vm + WASM) runs only when those optional deps are installed.

import assert from "node:assert/strict";
import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";
import { describe, it } from "node:test";

import { Page } from "../src/page.mjs";
import { jsRenderer } from "../src/render/index.mjs";
import { extractScripts } from "../src/render/scripts.mjs";

let secureOk = true;
try {
  await import("isolated-vm");
  await import("esbuild");
} catch {
  secureOk = false;
}

const SHELL = `<!doctype html><html><head><script src="/app.js"></script>
  <script type="application/json" id="d">{"k":1}</script></head>
  <body><div id="root"></div></body></html>`;
const APP_JS = `
  var root = document.getElementById("root");
  var h = document.createElement("h1"); h.textContent = "Rendered";
  var a = document.createElement("a"); a.setAttribute("href", "/p/1"); a.textContent = "Product";
  root.appendChild(h); root.appendChild(a);
  setTimeout(function () {
    var p = document.createElement("p"); p.textContent = "deferred"; root.appendChild(p);
  }, 0);
`;

function stub() {
  return async (url) =>
    url.endsWith("/app.js")
      ? { html: APP_JS, finalUrl: url, status: 200, headers: new Headers() }
      : { html: SHELL, finalUrl: url, status: 200, headers: new Headers() };
}

describe("extractScripts", () => {
  it("collects inline + external classic scripts, skips json/module", () => {
    const { document } = createEnvironment(
      `<head><script src="/a.js"></script><script>var x=1</script>
       <script type="application/json">{}</script><script type="module">import x</script></head>`,
    );
    const items = extractScripts(document, "https://s/");
    // json/ld+json dropped; module kept but flagged (renderers skip it at exec time).
    assert.equal(items.length, 3);
    assert.equal(items[0].url, "https://s/a.js");
    assert.equal(items[1].code, "var x=1");
    assert.equal(items[2].module, true);
  });
});

// One shared behavioural suite, run against each available backend.
for (const mode of ["fast", "secure"]) {
  describe(`jsRenderer — ${mode} backend`, { skip: mode === "secure" && !secureOk }, () => {
    it("renders a JS-only SPA shell into a populated DOM", async () => {
      const { fetchHtml, close } = jsRenderer({ mode, fetchHtml: stub() });
      const page = new Page({ fetchHtml });
      await page.goto("https://spa.test/");

      assert.equal(page.query("h1", { first: true })?.text, "Rendered");
      assert.ok(page.links().includes("https://spa.test/p/1"));
      assert.ok(page.text().includes("deferred")); // setTimeout content settled
      await close();
    });

    it("a throwing page script does not abort the render", async () => {
      const html = `<body><div id="root"></div><script src="/a.js"></script></body>`;
      const broken = `throw new Error("boom"); root.innerHTML = "never";`;
      const good = `document.getElementById("root").textContent = "survived";`;
      const { fetchHtml, close } = jsRenderer({
        mode,
        fetchHtml: async (u) =>
          u.endsWith("/a.js")
            ? { html: `${broken}\n${good}`, finalUrl: u, status: 200, headers: new Headers() }
            : { html, finalUrl: u, status: 200, headers: new Headers() },
      });
      const page = new Page({ fetchHtml });
      await page.goto("https://x.test/");
      // first statement throws; the render still completes and snapshots the DOM
      assert.equal(typeof page.text(), "string");
      await close();
    });

    it("bridges page-initiated fetch to the host net layer", async () => {
      const shell = `<body><div id="root"></div><script src="/app.js"></script></body>`;
      const app = `fetch("/api").then(function(r){return r.json();}).then(function(d){
        var root = document.getElementById("root");
        d.items.forEach(function(it){
          var a = document.createElement("a"); a.setAttribute("href", "/p/" + it); root.appendChild(a);
        });
      });`;
      const { fetchHtml, close } = jsRenderer({
        mode,
        fetchHtml: async (u) => {
          if (u.endsWith("/app.js"))
            return { html: app, finalUrl: u, status: 200, headers: new Headers() };
          if (u.endsWith("/api"))
            return { html: '{"items":[1,2]}', finalUrl: u, status: 200, headers: new Headers() };
          return { html: shell, finalUrl: u, status: 200, headers: new Headers() };
        },
      });
      const page = new Page({ fetchHtml });
      await page.goto("https://api-spa.test/");
      assert.deepEqual(page.links(), ["https://api-spa.test/p/1", "https://api-spa.test/p/2"]);
      await close();
    });

    it("works as a Crawler fallback for shell-only pages", async () => {
      const { Crawler } = await import("../src/crawl.mjs");
      const { fetchHtml } = jsRenderer({ mode, fetchHtml: stub() });
      const recs = [];
      for await (const rec of new Crawler({
        start: "https://spa.test/",
        maxDepth: 0,
        concurrency: 1,
        fetchHtml: async (u) => ({
          html: SHELL,
          finalUrl: u,
          status: 200,
          headers: new Headers(),
        }),
        fallback: fetchHtml,
        sleep: async () => {},
        now: () => 0,
      })) {
        recs.push(rec);
      }
      assert.equal(recs[0].lane, "B");
      assert.ok(recs[0].links.includes("https://spa.test/p/1"));
    });
  });
}

if (secureOk) {
  describe("secure backend isolation", () => {
    it("hostile script cannot reach the host (process/require undefined)", async () => {
      const evil =
        'document.getElementById("root").textContent = (typeof process)+"|"+(typeof require);';
      const { fetchHtml, close } = jsRenderer({
        mode: "secure",
        fetchHtml: async (u) =>
          u.endsWith("/app.js")
            ? { html: evil, finalUrl: u, status: 200, headers: new Headers() }
            : { html: SHELL, finalUrl: u, status: 200, headers: new Headers() },
      });
      const page = new Page({ fetchHtml });
      await page.goto("https://evil.test/");
      assert.equal(page.text(), "undefined|undefined");
      await close();
    });
  });
}

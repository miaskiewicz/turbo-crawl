// JS-execution render tier. The "fast" backend (in-process node:vm + native
// turbo-dom) needs no optional deps and always runs. The "secure" backend
// (isolated-vm + WASM) runs only when those optional deps are installed.

import assert from "node:assert/strict";
import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";
import { describe, it } from "node:test";

import { Page } from "../src/page.mjs";
import { jsRenderer } from "../src/render/index.mjs";
import { extractScripts } from "../src/render/scripts.mjs";

let esbuildOk = true;
try {
  await import("esbuild");
} catch {
  esbuildOk = false;
}
let secureOk = esbuildOk;
try {
  await import("isolated-vm");
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

    it("currentScript.getAttribute('src') returns the RAW attribute, not the absolute URL", async () => {
      // Bundler runtimes (Turbopack/webpack/Vite) read currentScript.getAttribute('src')
      // and do a `.startsWith("/_next/")`-style check to derive the chunk path — an
      // absolute URL breaks it, so the raw root-relative attribute must survive.
      const shell = `<body data-cs="none"><script src="/_next/runtime.js"></script></body>`;
      const runtime = `document.body.setAttribute("data-cs", document.currentScript.getAttribute("src"));`;
      const { fetchHtml, close } = jsRenderer({
        mode,
        fetchHtml: async (u) =>
          u.endsWith("/_next/runtime.js")
            ? { html: runtime, finalUrl: u, status: 200, headers: new Headers() }
            : { html: shell, finalUrl: u, status: 200, headers: new Headers() },
      });
      const page = new Page({ fetchHtml });
      await page.goto("https://app.test/");
      const html = page.html();
      assert.ok(html.includes('data-cs="/_next/runtime.js"'), "raw src preserved");
      assert.ok(
        !html.includes("https://app.test/_next/runtime.js"),
        "must not be the absolute URL",
      );
      await close();
    });

    it("fires the script's load event (the chunk-loaded doorbell)", async () => {
      // Dev bundler runtimes gate entrypoint execution on each chunk's `load` event.
      const shell = `<body><div id="root"></div><script src="/chunk.js"></script></body>`;
      const chunk = `document.currentScript.addEventListener("load", function () {
        var a = document.createElement("a"); a.setAttribute("href", "/loaded");
        document.getElementById("root").appendChild(a);
      });`;
      const { fetchHtml, close } = jsRenderer({
        mode,
        fetchHtml: async (u) =>
          u.endsWith("/chunk.js")
            ? { html: chunk, finalUrl: u, status: 200, headers: new Headers() }
            : { html: shell, finalUrl: u, status: 200, headers: new Headers() },
      });
      const page = new Page({ fetchHtml });
      await page.goto("https://dl.test/");
      assert.ok(page.links().includes("https://dl.test/loaded"), "load event fired");
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

    it("supports document.write builders + the DOMContentLoaded lifecycle", async () => {
      const shell = `<body><div id="anchor"></div><script src="/app.js"></script></body>`;
      const app = `document.write("<a href='/written'>w</a>");
        document.addEventListener("DOMContentLoaded", function(){
          var a = document.createElement("a"); a.setAttribute("href","/ready"); document.body.appendChild(a);
        });`;
      const { fetchHtml, close } = jsRenderer({
        mode,
        fetchHtml: async (u) =>
          u.endsWith("/app.js")
            ? { html: app, finalUrl: u, status: 200, headers: new Headers() }
            : { html: shell, finalUrl: u, status: 200, headers: new Headers() },
      });
      const page = new Page({ fetchHtml });
      await page.goto("https://dw.test/");
      const hrefs = page.links();
      assert.ok(hrefs.includes("https://dw.test/written"), "document.write output");
      assert.ok(hrefs.includes("https://dw.test/ready"), "DOMContentLoaded handler ran");
      await close();
    });

    it("executes ESM-module scripts (bundled import graph)", { skip: !esbuildOk }, async () => {
      const shell = `<body><div id="root"></div><script type="module" src="/main.js"></script></body>`;
      const main = `import { render } from "/render.js"; render(document.getElementById("root"));`;
      const renderMod = `export function render(root){
        var a = document.createElement("a"); a.setAttribute("href", "/p/9"); root.appendChild(a);
      }`;
      const { fetchHtml, close } = jsRenderer({
        mode,
        fetchHtml: async (u) => {
          if (u.endsWith("/main.js"))
            return { html: main, finalUrl: u, status: 200, headers: new Headers() };
          if (u.endsWith("/render.js"))
            return { html: renderMod, finalUrl: u, status: 200, headers: new Headers() };
          return { html: shell, finalUrl: u, status: 200, headers: new Headers() };
        },
      });
      const page = new Page({ fetchHtml });
      await page.goto("https://esm.test/");
      assert.deepEqual(page.links(), ["https://esm.test/p/9"]);
      await close();
    });

    it("bridges page-initiated XMLHttpRequest to the host net layer", async () => {
      const shell = `<body><div id="root"></div><script src="/app.js"></script></body>`;
      const app = `var x = new XMLHttpRequest(); x.open("GET", "/api"); x.onload = function () {
        var d = JSON.parse(x.responseText); var root = document.getElementById("root");
        d.ids.forEach(function (i) {
          var a = document.createElement("a"); a.setAttribute("href", "/p/" + i); root.appendChild(a);
        });
      }; x.send();`;
      const { fetchHtml, close } = jsRenderer({
        mode,
        fetchHtml: async (u) => {
          if (u.endsWith("/app.js"))
            return { html: app, finalUrl: u, status: 200, headers: new Headers() };
          if (u.endsWith("/api"))
            return { html: '{"ids":[7,8]}', finalUrl: u, status: 200, headers: new Headers() };
          return { html: shell, finalUrl: u, status: 200, headers: new Headers() };
        },
      });
      const page = new Page({ fetchHtml });
      await page.goto("https://xhr.test/");
      assert.deepEqual(page.links(), ["https://xhr.test/p/7", "https://xhr.test/p/8"]);
      await close();
    });

    it("resolves bare specifiers via an import map", { skip: !esbuildOk }, async () => {
      const shell = `<body><div id="root"></div>
        <script type="importmap">{"imports":{"widgets":"/lib/w.js"}}</script>
        <script type="module" src="/main.js"></script></body>`;
      const main = `import { mk } from "widgets"; mk(document.getElementById("root"));`;
      const w = `export function mk(root){ var a=document.createElement("a"); a.setAttribute("href","/p/3"); root.appendChild(a); }`;
      const { fetchHtml, close } = jsRenderer({
        mode,
        fetchHtml: async (u) => {
          if (u.endsWith("/main.js"))
            return { html: main, finalUrl: u, status: 200, headers: new Headers() };
          if (u.endsWith("/lib/w.js"))
            return { html: w, finalUrl: u, status: 200, headers: new Headers() };
          return { html: shell, finalUrl: u, status: 200, headers: new Headers() };
        },
      });
      const page = new Page({ fetchHtml });
      await page.goto("https://imap.test/");
      assert.deepEqual(page.links(), ["https://imap.test/p/3"]);
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

describe("render tier — script-loading edge cases (fast)", () => {
  it("runs async scripts AFTER inline/sync ones (browser order, not DOM order)", async () => {
    // Mirrors App Router: an async bootstrap (<script async>) must run after every
    // inline `__next_f.push` row has buffered, even though it appears first in the
    // DOM. In DOM order the bootstrap would see an empty buffer.
    const shell = `<body><div id="root"></div>
      <script async src="/boot.js"></script>
      <script>globalThis.__rows = (globalThis.__rows || []); globalThis.__rows.push("a");</script>
      <script>globalThis.__rows.push("b");</script></body>`;
    const boot = `var seen = (globalThis.__rows || []).join(",");
      var el = document.createElement("a"); el.setAttribute("href", "/seen/" + seen);
      document.getElementById("root").appendChild(el);`;
    const { fetchHtml, close } = jsRenderer({
      mode: "fast",
      fetchHtml: async (u) =>
        u.endsWith("/boot.js")
          ? { html: boot, finalUrl: u, status: 200, headers: new Headers() }
          : { html: shell, finalUrl: u, status: 200, headers: new Headers() },
    });
    const page = new Page({ fetchHtml });
    await page.goto("https://order.test/");
    // async boot saw both inline rows buffered → ran after them
    assert.ok(page.links().includes("https://order.test/seen/a,b"), "async ran after inline");
    await close();
  });

  it("tolerates a malformed import map and a failing external script", async () => {
    const shell = `<body><div id="root"></div>
      <script type="importmap">{ this is not json</script>
      <script src="/missing.js"></script>
      <script src="/app.js"></script></body>`;
    const app = `var a=document.createElement("a"); a.setAttribute("href","/ok"); document.getElementById("root").appendChild(a);`;
    const { fetchHtml, close } = jsRenderer({
      mode: "fast",
      fetchHtml: async (u) => {
        if (u.endsWith("/missing.js")) throw new Error("404");
        if (u.endsWith("/app.js"))
          return { html: app, finalUrl: u, status: 200, headers: new Headers() };
        return { html: shell, finalUrl: u, status: 200, headers: new Headers() };
      },
    });
    const page = new Page({ fetchHtml });
    await page.goto("https://edge.test/");
    // malformed importmap ignored, missing script skipped, app.js still ran
    assert.ok(page.links().includes("https://edge.test/ok"));
    await close();
  });
});

describe("Crawler followRequests — discovered URLs reach the frontier", () => {
  it("enqueues page-fetched URLs when followRequests is set", async () => {
    const { Crawler } = await import("../src/crawl.mjs");
    const H = "https://disc.test";
    const shell = `<body><div id="root"></div><script src="/app.js"></script></body>`;
    const app = `fetch("/api/data").then(function(){ var a=document.createElement("a");
      a.setAttribute("href","/dom-link"); document.getElementById("root").appendChild(a); });`;
    const fb = jsRenderer({
      mode: "fast",
      fetchHtml: async (u) =>
        u.endsWith("/app.js")
          ? { html: app, finalUrl: u, status: 200, headers: new Headers() }
          : u.endsWith("/api/data")
            ? { html: "{}", finalUrl: u, status: 200, headers: new Headers() }
            : { html: shell, finalUrl: u, status: 200, headers: new Headers() },
    }).fetchHtml;

    const seen = [];
    for await (const rec of new Crawler({
      start: `${H}/`,
      maxDepth: 1,
      maxPages: 10,
      concurrency: 1,
      fetchHtml: async (u) => ({ html: shell, finalUrl: u, status: 200, headers: new Headers() }),
      fallback: fb,
      followRequests: true,
      sleep: async () => {},
      now: () => 0,
    })) {
      seen.push(rec.url);
    }
    assert.ok(seen.includes(`${H}/api/data`), "discovered fetch URL should be crawled");
    assert.ok(seen.includes(`${H}/dom-link`), "rendered DOM link should be crawled");
  });
});

if (secureOk) {
  describe("secure backend — fetch bridge error path", () => {
    it("a failing host fetch yields status 0 inside the isolate", async () => {
      const shell = `<body><div id="root"></div><script src="/app.js"></script></body>`;
      const app = `fetch("/api").then(function(r){
        document.getElementById("root").textContent = "status:" + r.status;
      });`;
      const { fetchHtml, close } = jsRenderer({
        mode: "secure",
        fetchHtml: async (u) => {
          if (u.endsWith("/app.js"))
            return { html: app, finalUrl: u, status: 200, headers: new Headers() };
          if (u.endsWith("/api")) throw new Error("net down");
          return { html: shell, finalUrl: u, status: 200, headers: new Headers() };
        },
      });
      const page = new Page({ fetchHtml });
      await page.goto("https://fail.test/");
      assert.equal(page.text(), "status:0");
      await close();
    });
  });

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

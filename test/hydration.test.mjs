import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { extractHydrationState } from "../src/hydration.mjs";
import { Page } from "../src/page.mjs";
import { stubFetch } from "./helpers.mjs";

const doc = (html) => createEnvironment(html).document;

describe("extractHydrationState", () => {
  it("parses __NEXT_DATA__ JSON", () => {
    const h = extractHydrationState(
      doc(
        `<head><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"title":"Hi","price":9}}}</script></head>`,
      ),
    );
    assert.deepEqual(h.next.props.pageProps, { title: "Hi", price: 9 });
  });

  it("collects all JSON-LD blocks", () => {
    const h = extractHydrationState(
      doc(
        `<script type="application/ld+json">{"@type":"Product","name":"W"}</script>
         <script type="application/ld+json">[{"@type":"Org"}]</script>`,
      ),
    );
    assert.equal(h.jsonLd.length, 2);
    assert.equal(h.jsonLd[0].name, "W");
    assert.deepEqual(h.jsonLd[1], [{ "@type": "Org" }]);
  });

  it("maps typed application/json scripts by id (excluding __NEXT_DATA__)", () => {
    const h = extractHydrationState(
      doc(`<script type="application/json" id="sk">{"k":1}</script>`),
    );
    assert.deepEqual(h.json, { sk: { k: 1 } });
  });

  it("extracts window.__APOLLO_STATE__ / __INITIAL_STATE__ assignments", () => {
    const h = extractHydrationState(
      doc(
        `<script>window.__APOLLO_STATE__ = {"Product:1":{"name":"G","tags":["a","b"]}};
         window.__INITIAL_STATE__={"user":{"name":"has { brace } and \\"quote\\""}};</script>`,
      ),
    );
    assert.deepEqual(h.states.__APOLLO_STATE__["Product:1"], { name: "G", tags: ["a", "b"] });
    assert.equal(h.states.__INITIAL_STATE__.user.name, 'has { brace } and "quote"');
  });

  it("ignores invalid JSON and absent sources", () => {
    const h = extractHydrationState(
      doc(`<script>window.__NUXT__=(function(){return 1})()</script>`),
    );
    assert.equal(h.next, null);
    assert.deepEqual(h.jsonLd, []);
    assert.deepEqual(h.json, {});
    assert.equal(h.states.__NUXT__, undefined); // not plain JSON → skipped
  });

  it("skips a global assigned a non-object/array value", () => {
    const h = extractHydrationState(doc(`<script>window.__APOLLO_STATE__ = 42;</script>`));
    assert.equal(h.states.__APOLLO_STATE__, undefined);
  });

  it("skips an unterminated object (no matching close brace)", () => {
    const h = extractHydrationState(
      doc(`<script>window.__APOLLO_STATE__ = {"a":1,"b":[2,3</script>`),
    );
    assert.equal(h.states.__APOLLO_STATE__, undefined);
  });

  it("Page.hydrationState() reads the current page", async () => {
    const page = new Page({
      fetchHtml: stubFetch({
        "https://app.test/": `<head><script id="__NEXT_DATA__" type="application/json">{"build":"abc"}</script></head><body></body>`,
      }),
    });
    await page.goto("https://app.test/");
    assert.equal(page.hydrationState().next.build, "abc");
  });
});

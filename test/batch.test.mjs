import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { batch } from "../src/batch.mjs";
import { stubFetch } from "./helpers.mjs";

function routes() {
  return stubFetch({
    "https://s/a": "<title>A</title><body><main><h1>Alpha</h1><a href='/x'>x</a></main></body>",
    "https://s/b": "<title>B</title><body><main><h2>Beta</h2></main></body>",
  });
}

describe("batch", () => {
  it("crawls a list (no-js) returning a result per URL in order", async () => {
    const fetchHtml = routes();
    const out = await batch(["https://s/a", "https://s/b"], { fetchHtml, view: "text" });
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((r) => [r.url, r.ok, r.title]),
      [
        ["https://s/a", true, "A"],
        ["https://s/b", true, "B"],
      ],
    );
    assert.match(out[0].data, /Alpha/);
  });

  it("each view dispatches to the right page method", async () => {
    const fetchHtml = routes();
    const view = (v) => batch(["https://s/a"], { fetchHtml, view: v });
    assert.match((await view("markdown"))[0].data, /Alpha/);
    assert.match((await view("html"))[0].data, /<h1/);
    assert.deepEqual((await view("links"))[0].data, ["https://s/x"]);
    assert.ok(Array.isArray((await view("interactive"))[0].data));
    assert.equal(typeof (await view("ax"))[0].data.role, "string");
    assert.equal(typeof (await view("hydration"))[0].data, "object");
  });

  it("captures per-URL failures without aborting", async () => {
    const fetchHtml = stubFetch({ "https://s/ok": "<body>ok</body>" });
    const out = await batch(["https://s/ok", "https://s/missing"], { fetchHtml, view: "text" });
    assert.equal(out[0].ok, true);
    assert.equal(out[1].ok, false);
    assert.match(out[1].error, /no route/);
  });

  it("rejects unknown mode / view", async () => {
    await assert.rejects(() => batch([], { mode: "turbo" }), /unknown mode/);
    await assert.rejects(() => batch([], { view: "pixels" }), /unknown view/);
  });

  it("mode aliases normalize; fast-js runs page scripts", async () => {
    const fetchHtml = stubFetch({
      "https://s/a":
        "<title>A</title><body><div id='r'></div><script>document.getElementById('r').textContent='HYDRATED'</script></body>",
    });
    const out = await batch(["https://s/a"], { fetchHtml, mode: "fast js", view: "text" });
    assert.match(out[0].data, /HYDRATED/);
  });

  it("honors concurrency for no-js (empty list is a no-op)", async () => {
    assert.deepEqual(await batch([], { mode: "no-js", concurrency: 8 }), []);
  });
});

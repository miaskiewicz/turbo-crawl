import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makePageFetch, makeXHR } from "../src/render/page-fetch.mjs";

const ok = async (url) => ({ html: '{"v":1}', status: 200, finalUrl: url });
const boom = async () => {
  throw new Error("net down");
};

describe("makePageFetch", () => {
  it("resolves relative URLs, exposes ok/status/text/json", async () => {
    const state = { pending: 0 };
    const fetch = makePageFetch(ok, "https://s/a/", state);
    const res = await fetch("../b.json");
    assert.equal(res.url, "https://s/b.json");
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"v":1}');
    assert.deepEqual(await res.json(), { v: 1 });
    assert.equal(state.pending, 0); // decremented in finally
  });

  it("returns a status-0 response when the host fetch throws", async () => {
    const res = await makePageFetch(boom, "https://s/", { pending: 0 })("/x");
    assert.equal(res.ok, false);
    assert.equal(res.status, 0);
    assert.equal(await res.text(), "");
  });

  it("falls back to the raw input when the URL can't be resolved", async () => {
    let got;
    const rec = async (u) => {
      got = u;
      return { html: "", status: 200 };
    };
    await makePageFetch(rec, "", { pending: 0 })("not a url");
    assert.equal(got, "not a url");
  });
});

describe("makeXHR", () => {
  it("fires onload with status/responseText on success", async () => {
    const XHR = makeXHR(ok, "https://s/", { pending: 0 });
    const x = new XHR();
    x.open("GET", "/data");
    const done = new Promise((r) => {
      x.onload = r;
    });
    x.send();
    await done;
    assert.equal(x.status, 200);
    assert.equal(x.responseText, '{"v":1}');
    assert.equal(x.readyState, 4);
  });

  it("fires onload with status 0 when the host fetch throws", async () => {
    const XHR = makeXHR(boom, "https://s/", { pending: 0 });
    const x = new XHR();
    x.open("GET", "/data");
    const done = new Promise((r) => {
      x.onreadystatechange = () => {
        if (x.readyState === 4) r();
      };
    });
    x.send();
    await done;
    assert.equal(x.status, 0);
    assert.equal(x.getResponseHeader("x"), null);
  });
});

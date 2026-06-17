import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ContextState, runRoutes } from "../playwright/context-state.mjs";
import {
  documentRequest,
  PWConsoleMessage,
  PWRequest,
  PWResponse,
  urlMatcher,
} from "../playwright/net-events.mjs";
import { makeStorage, storageEntries } from "../playwright/storage.mjs";

describe("storage proxy", () => {
  it("spec API + property access share one backing map", () => {
    const s = makeStorage([{ name: "seed", value: "1" }]);
    assert.equal(s.getItem("seed"), "1");
    s.setItem("a", "x");
    s.b = "y"; // property write
    assert.equal(s.a, "x"); // property read of an item
    assert.equal(s.getItem("b"), "y");
    assert.equal(s.length, 3);
    assert.ok([...Array(s.length).keys()].map((i) => s.key(i)).includes("a"));
    assert.equal("a" in s, true);
    assert.equal("nope" in s, false);
    delete s.a;
    assert.equal(s.getItem("a"), null);
    assert.equal(s.key(99), null);
  });

  it("clear + storageEntries dump", () => {
    const s = makeStorage();
    s.setItem("k", "v");
    assert.deepEqual(storageEntries(s), [{ name: "k", value: "v" }]);
    s.clear();
    assert.deepEqual(storageEntries(s), []);
  });
});

describe("net-events shapes", () => {
  it("PWRequest / PWResponse expose Playwright fields", async () => {
    const req = new PWRequest({
      url: "https://s/api",
      method: "post",
      headers: { a: "1" },
      postData: "b=2",
    });
    assert.equal(req.method(), "post");
    assert.deepEqual(req.headers(), { a: "1" });
    assert.equal(req.postData(), "b=2");
    assert.equal(req.resourceType(), "other");

    const res = new PWResponse({
      url: "https://s/api",
      status: 201,
      headers: new Headers({ "x-y": "z" }),
      body: '{"n":1}',
      request: { url: "https://s/api" },
    });
    assert.equal(res.url(), "https://s/api");
    assert.equal(res.status(), 201);
    assert.equal(res.ok(), true);
    assert.deepEqual(res.headers(), { "x-y": "z" });
    assert.equal(await res.text(), '{"n":1}');
    assert.deepEqual(await res.json(), { n: 1 });
    assert.ok(res.request() instanceof PWRequest);
    assert.equal(new PWResponse({ status: 404 }).ok(), false);
    assert.equal(new PWResponse({ status: 200 }).request(), null);
  });

  it("PWConsoleMessage + defaults", () => {
    const m = new PWConsoleMessage("warning", ["hi", 7]);
    assert.equal(m.type(), "warning");
    assert.equal(m.text(), "hi 7");
    assert.deepEqual(m.args(), ["hi", 7]);
    assert.deepEqual(new PWConsoleMessage("log").args(), []);
    assert.equal(new PWRequest({ url: "u" }).method(), "GET");
  });

  it("urlMatcher: glob / regexp / predicate; documentRequest defaults", () => {
    assert.equal(urlMatcher("**/api/*")("https://s/v1/api/x"), true);
    assert.equal(urlMatcher("**/api/*")("https://s/api/x/y"), false);
    assert.equal(urlMatcher(/api/)("https://s/api"), true);
    assert.equal(urlMatcher((u) => u.endsWith("z"))("abz"), true);
    const r = documentRequest("https://s/", {});
    assert.equal(r.method, "GET");
    assert.equal(r.resourceType, "document");
  });
});

describe("ContextState", () => {
  it("per-origin storage is created lazily and reused", () => {
    const ctx = new ContextState();
    const a = ctx.storageFor("https://s/a");
    const b = ctx.storageFor("https://s/b");
    assert.equal(ctx.storageFor("https://s/c"), b === a ? a : ctx.storageFor("https://s/c"));
    assert.equal(a, ctx.storageFor("https://s/a")); // same origin → same store
  });

  it("addCookies / cookies / storageState dump + seed round-trip", () => {
    const ctx = new ContextState();
    ctx.addCookies([{ name: "sid", value: "abc", domain: "s", path: "/", expires: -1 }]);
    ctx.storageFor("https://s/").localStorage.setItem("tok", "T");
    const state = ctx.storageState();
    assert.equal(state.cookies[0].name, "sid");
    assert.equal(state.cookies[0].expires, -1);
    assert.deepEqual(state.origins, [
      { origin: "https://s", localStorage: [{ name: "tok", value: "T" }] },
    ]);

    const seeded = new ContextState(state);
    assert.equal(seeded.cookies()[0].value, "abc");
    assert.equal(seeded.storageFor("https://s/").localStorage.getItem("tok"), "T");
  });

  it("setExtraHTTPHeaders + addInitScript accumulate", () => {
    const ctx = new ContextState();
    ctx.setExtraHTTPHeaders({ "x-a": "1" });
    ctx.addInitScript("window.__x=1");
    assert.deepEqual(ctx.extraHeaders, { "x-a": "1" });
    assert.deepEqual(ctx.initScripts, ["window.__x=1"]);
  });

  it("routes: fulfill / abort / continue + unroute", async () => {
    const ctx = new ContextState();
    const handler = (route) => route.fulfill({ json: { mocked: true }, status: 201 });
    ctx.route("**/api/**", handler);
    const make = (r) => new PWRequest(r);

    const hit = await runRoutes(ctx.routes, { url: "https://s/api/x" }, make);
    assert.deepEqual(hit, { status: 201, body: '{"mocked":true}', headers: undefined });

    ctx.route("**/abort/**", (route) => route.abort());
    assert.equal(await runRoutes(ctx.routes, { url: "https://s/abort/y" }, make), "abort");

    ctx.route("**/pass/**", (route) => route.continue());
    assert.equal(await runRoutes(ctx.routes, { url: "https://s/pass/z" }, make), null);

    assert.equal(await runRoutes(ctx.routes, { url: "https://s/none" }, make), null); // no match

    ctx.unroute("**/api/**", handler);
    assert.equal(await runRoutes(ctx.routes, { url: "https://s/api/x" }, make), null);
    ctx.unroute("**/abort/**"); // remove without handler arg
    assert.equal(await runRoutes(ctx.routes, { url: "https://s/abort/y" }, make), null);
  });

  it("fulfill body option + request() handed to handler", async () => {
    const ctx = new ContextState();
    let seenUrl;
    ctx.route("**", (route, request) => {
      seenUrl = request.url();
      return route.fulfill({ body: "plain" });
    });
    const out = await runRoutes(ctx.routes, { url: "https://s/q" }, (r) => new PWRequest(r));
    assert.equal(out.body, "plain");
    assert.equal(out.status, 200);
    assert.equal(seenUrl, "https://s/q");
  });
});

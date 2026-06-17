import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CookieJar } from "../src/cookies.mjs";
import { chromium } from "../playwright/index.mjs";
import { stubFetch } from "./helpers.mjs";

// A page whose inline script POSTs to /api/data and titles the page from the reply.
const FETCH_PAGE =
  "<title>start</title><body><script>" +
  "fetch('/api/data',{method:'POST',body:'q=1'}).then(r=>r.json())" +
  ".then(d=>{document.title=d.ok?'GOT':'NO'});" +
  "</script></body>";

function fastBrowser(extra = {}) {
  const fetchHtml = stubFetch({
    "https://s/": FETCH_PAGE,
    "https://s/api/data": '{"ok":true}',
    ...extra,
  });
  return { opts: { mode: "fast", fetchHtml }, fetchHtml };
}

describe("playwright façade — events", () => {
  it("emits request/response for page-initiated fetch (fast render)", async () => {
    const { opts } = fastBrowser();
    const page = await (await chromium.launch(opts)).newPage();
    const responses = [];
    page.on("response", (r) => responses.push(r));
    let reqMethod;
    page.on("request", (r) => {
      if (r.url().endsWith("/api/data")) reqMethod = r.method();
    });
    await page.goto("https://s/");
    assert.equal(await page.title(), "GOT");
    const api = responses.find((r) => r.url().endsWith("/api/data"));
    assert.ok(api, "api response emitted");
    assert.equal(api.status(), 200);
    assert.deepEqual(await api.json(), { ok: true });
    assert.equal(reqMethod, "POST");
    assert.ok(responses.some((r) => r.url() === "https://s/")); // navigation response too
  });

  it("waitForResponse resolves on the matching backend call", async () => {
    const { opts } = fastBrowser();
    const page = await (await chromium.launch(opts)).newPage();
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/data") && r.request().method() === "POST"),
      page.goto("https://s/"),
    ]);
    assert.deepEqual(await resp.json(), { ok: true });
  });

  it("waitForRequest + glob; waitForEvent timeout rejects", async () => {
    const { opts } = fastBrowser();
    const page = await (await chromium.launch(opts)).newPage();
    const [req] = await Promise.all([page.waitForRequest("**/api/data"), page.goto("https://s/")]);
    assert.equal(req.url(), "https://s/api/data");
    await assert.rejects(() => page.waitForEvent("response", { timeout: 10 }), /timed out/);
  });

  it("console + pageerror events", async () => {
    const { opts } = fastBrowser({
      "https://s/":
        "<body><script>console.warn('hey',1); throw new Error('kaboom');</script></body>",
    });
    const page = await (await chromium.launch(opts)).newPage();
    const logs = [];
    const errors = [];
    page.on("console", (m) => logs.push([m.type(), m.text()]));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("https://s/");
    assert.deepEqual(logs[0], ["warning", "hey 1"]);
    assert.match(errors[0], /kaboom/);
  });

  it("XMLHttpRequest is host-net backed and emits a response", async () => {
    const { opts } = fastBrowser({
      "https://s/":
        "<title>x</title><body><script>" +
        "var x=new XMLHttpRequest();x.open('GET','/api/data');" +
        "x.setRequestHeader('a','b');x.getResponseHeader('a');" +
        "x.onreadystatechange=function(){};" +
        "x.onload=function(){document.title=x.responseText};x.send();</script></body>",
    });
    const page = await (await chromium.launch(opts)).newPage();
    await page.goto("https://s/");
    assert.equal(await page.title(), '{"ok":true}');
  });
});

describe("playwright façade — routing", () => {
  it("route().fulfill mocks the response", async () => {
    const { opts } = fastBrowser();
    const page = await (await chromium.launch(opts)).newPage();
    page.route("**/api/**", (route) => route.fulfill({ json: { ok: false } }));
    await page.goto("https://s/");
    assert.equal(await page.title(), "NO");
  });

  it("route().abort surfaces a requestfailed", async () => {
    const fetchHtml = stubFetch({
      "https://s/":
        "<title>x</title><body><script>fetch('/api/data').catch(()=>{})</script></body>",
      "https://s/api/data": '{"ok":true}',
    });
    const page = await (await chromium.launch({ mode: "fast", fetchHtml })).newPage();
    const failed = [];
    page.on("requestfailed", (r) => failed.push(r.url()));
    page.route("**/api/**", (route) => route.abort());
    await page.goto("https://s/");
    assert.ok(failed.some((u) => u.endsWith("/api/data")));
  });

  it("route().continue + unroute fall through to the network", async () => {
    const { opts } = fastBrowser();
    const page = await (await chromium.launch(opts)).newPage();
    const handler = (route) => route.continue();
    page.route("**/api/**", handler);
    await page.goto("https://s/");
    assert.equal(await page.title(), "GOT");
    page.unroute("**/api/**", handler);
    await page.goto("https://s/");
    assert.equal(await page.title(), "GOT");
  });
});

describe("playwright façade — context state", () => {
  it("addInitScript runs before page scripts (page + context)", async () => {
    const { opts, fetchHtml } = fastBrowser({
      "https://s/":
        "<title>x</title><body><script>document.title=String(window.__a)+window.__b</script></body>",
    });
    const browser = await chromium.launch(opts);
    const ctx = await browser.newContext({ fetchHtml });
    await ctx.addInitScript("window.__a=1");
    const page = await ctx.newPage();
    page.addInitScript(() => {
      window.__b = "Z";
    });
    await page.goto("https://s/");
    assert.equal(await page.title(), "1Z");
  });

  it("localStorage persists across goto + storageState dump", async () => {
    const { opts, fetchHtml } = fastBrowser({
      "https://s/set":
        "<title>x</title><body><script>localStorage.setItem('t','1')</script></body>",
      "https://s/get":
        "<title>x</title><body><script>if(localStorage.getItem('t')==='1')document.title='OK'</script></body>",
    });
    const ctx = await (await chromium.launch(opts)).newContext({ fetchHtml });
    const page = await ctx.newPage();
    await page.goto("https://s/set");
    await page.goto("https://s/get");
    assert.equal(await page.title(), "OK");
    const state = await ctx.storageState();
    assert.deepEqual(state.origins[0].localStorage, [{ name: "t", value: "1" }]);
  });

  it("context aggregates page events; addCookies/cookies", async () => {
    const { opts, fetchHtml } = fastBrowser();
    const ctx = await (await chromium.launch(opts)).newContext({ fetchHtml });
    await ctx.addCookies([{ name: "sid", value: "z", domain: "s", path: "/" }]);
    assert.equal((await ctx.cookies())[0].name, "sid");
    const seen = [];
    ctx.on("response", (r) => seen.push(r.url()));
    const page = await ctx.newPage();
    await page.goto("https://s/");
    assert.ok(seen.some((u) => u.endsWith("/api/data")));
    ctx.off("response", () => {});
  });

  it("setExtraHTTPHeaders + jar threaded into in-render requests", async () => {
    const { opts, fetchHtml } = fastBrowser();
    const page = await (await chromium.launch(opts)).newPage();
    await page.setExtraHTTPHeaders({ "x-test": "1" });
    await page.goto("https://s/");
    const apiCall = fetchHtml.calls.find(([u]) => u.endsWith("/api/data"));
    assert.equal(apiCall[1].headers["x-test"], "1");
    assert.ok(apiCall[1].jar instanceof CookieJar, "session jar threaded to in-render fetch");
  });

  it("seeded storageState carries cookies into a new context", async () => {
    const { opts, fetchHtml } = fastBrowser();
    const browser = await chromium.launch(opts);
    const storageState = {
      cookies: [{ name: "auth", value: "tok", domain: "s", path: "/", expires: -1 }],
      origins: [{ origin: "https://s", localStorage: [{ name: "k", value: "v" }] }],
    };
    const ctx = await browser.newContext({ fetchHtml, storageState });
    assert.equal((await ctx.cookies())[0].value, "tok");
    const page = await ctx.newPage();
    await page.goto("https://s/");
    assert.deepEqual((await ctx.storageState()).origins[0].localStorage, [
      { name: "k", value: "v" },
    ]);
  });

  it("Lane-A (no mode) still emits navigation response; close fires", async () => {
    const fetchHtml = stubFetch({ "https://s/": "<title>L</title><body>hi</body>" });
    const page = await (await chromium.launch({ fetchHtml })).newPage();
    const seen = [];
    page.on("response", (r) => seen.push(r.status()));
    let closed = false;
    page.on("close", () => {
      closed = true;
    });
    await page.goto("https://s/");
    assert.deepEqual(seen, [200]);
    await page.close();
    assert.equal(closed, true);
  });
});

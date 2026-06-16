import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CookieJar } from "../src/cookies.mjs";
import { Page } from "../src/page.mjs";
import { stubFetch } from "./helpers.mjs";

const HOME = "https://shop.test/";
const POST_ACTION = "https://shop.test/login";

describe("Page coverage", () => {
  // cookies getter (page.mjs 46-47) + status getter (61-62).
  it("exposes the cookie jar and the (pre-goto) status", () => {
    const jar = new CookieJar();
    const page = new Page({ jar });
    assert.equal(page.cookies, jar);
    assert.equal(page.status, 0);
    assert.equal(page.url, null);
  });

  // status getter reflects the last navigation.
  it("reports the navigation status after a goto", async () => {
    const page = new Page({ fetchHtml: stubFetch({ [HOME]: "<title>H</title>" }) });
    await page.goto(HOME);
    assert.equal(page.status, 200);
  });

  // window getter throws before any goto (page.mjs 71-74).
  it("throws on the window getter before the first goto", () => {
    assert.throws(() => new Page().window, /no page loaded/);
  });

  // window getter resolves after a goto.
  it("exposes the window after a goto", async () => {
    const page = new Page({ fetchHtml: stubFetch({ [HOME]: "<title>H</title>" }) });
    await page.goto(HOME);
    assert.ok(page.window);
  });

  // interactiveElements with the options path (visibility:false).
  it("accepts interactiveElements options", async () => {
    const page = new Page({
      fetchHtml: stubFetch({
        [HOME]: `<!doctype html><body><a href="/x">L</a></body>`,
      }),
    });
    await page.goto(HOME);
    const els = page.interactiveElements({ visibility: false });
    assert.ok(Array.isArray(els));
  });

  // follow() success path (page.mjs 102-105).
  it("follows a relative href against the current page", async () => {
    const page = new Page({
      fetchHtml: stubFetch({
        [HOME]: `<title>Home</title>`,
        "https://shop.test/next": `<title>Next</title>`,
      }),
    });
    await page.goto(HOME);
    const res = await page.follow("/next");
    assert.equal(res.url, "https://shop.test/next");
    assert.equal(res.title, "Next");
  });

  // follow() rejects a non-navigable href (page.mjs 103 throw branch).
  it("throws when following a non-navigable href", async () => {
    const page = new Page({ fetchHtml: stubFetch({ [HOME]: "<title>H</title>" }) });
    await page.goto(HOME);
    await assert.rejects(() => page.follow("mailto:x@y.test"), /not a navigable URL/);
  });

  // submit() with no form present → throws (page.mjs 226).
  it("throws when submitting with no form present", async () => {
    const page = new Page({
      fetchHtml: stubFetch({ [HOME]: `<!doctype html><body><p>no form</p></body>` }),
    });
    await page.goto(HOME);
    await assert.rejects(() => page.submit(), /no form to submit/);
  });

  // submit(i): submit by control index → owning form + submitter (page.mjs 221-225)
  // and POST body/header path (234-237).
  it("submits a POST form by control index with submitter", async () => {
    const fetchHtml = stubFetch({
      [HOME]: `<!doctype html><body>
        <form action="/login" method="post">
          <input name="u" value="alice">
          <button type="submit">Sign in</button>
        </form></body>`,
      [POST_ACTION]: `<title>Welcome</title>`,
    });
    const page = new Page({ fetchHtml });
    await page.goto(HOME);
    const btn = page.interactiveElements().find((e) => e.tag === "button");
    const res = await page.submit(btn.i);
    assert.equal(res.url, POST_ACTION);
    const [url, opts] = fetchHtml.last();
    assert.equal(url, POST_ACTION);
    assert.equal(opts.method, "POST");
    assert.match(opts.body, /u=alice/);
    assert.equal(opts.headers["content-type"], "application/x-www-form-urlencoded");
  });
});

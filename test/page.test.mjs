import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Page } from "../src/page.mjs";
import { fixture, stubFetch } from "./helpers.mjs";

const PAGE_ONE = "https://shop.test/catalog/";
const PAGE_TWO = "https://shop.test/about";

function makePage() {
  return new Page({
    fetchHtml: stubFetch({
      [PAGE_ONE]: fixture("sample.html"),
      [PAGE_TWO]: "<!doctype html><title>About Us</title><body><a href='/'>home</a></body>",
    }),
  });
}

describe("Page", () => {
  it("throws when queried before the first goto", () => {
    assert.throws(() => new Page().interactiveElements(), /no page loaded/);
  });

  it("goto() returns status, final url, and title", async () => {
    const page = makePage();
    const res = await page.goto(PAGE_ONE);
    assert.deepEqual(res, { status: 200, url: PAGE_ONE, title: "Sample Page" });
    assert.equal(page.url, PAGE_ONE);
  });

  it("exposes interactive elements and links for the loaded page", async () => {
    const page = makePage();
    await page.goto(PAGE_ONE);
    assert.ok(page.links().includes("https://shop.test/products/1"));
    assert.ok(page.interactiveElements().some((e) => e.name === "Blue Widget"));
  });

  it("bridges the session jar into document.cookie", async () => {
    const { CookieJar } = await import("../src/cookies.mjs");
    const jar = new CookieJar();
    const page = new Page({
      jar,
      fetchHtml: async (url) => {
        jar.setFromResponse(url, ["sess=1; Path=/"]);
        return { html: "<body>x</body>", finalUrl: url, status: 200, headers: new Headers() };
      },
    });
    await page.goto("https://a.test/");
    assert.equal(page.document.cookie, "sess=1");
  });

  it("reuses one env across hops (reset), reflecting the new page", async () => {
    const page = makePage();
    await page.goto(PAGE_ONE);
    const second = await page.goto(PAGE_TWO);
    assert.equal(second.title, "About Us");
    assert.equal(page.url, PAGE_TWO);
    // old page's elements are gone after reset
    assert.ok(!page.interactiveElements().some((e) => e.name === "Blue Widget"));
  });

  it("evalJs runs a statement body with args; injectJs mutates + persists", async () => {
    const page = makePage();
    await page.goto(PAGE_TWO);
    assert.equal(page.evalJs("return document.title + arguments[0]", "!"), "About Us!");
    page.injectJs("document.querySelector('a').textContent = 'HOME'");
    assert.equal(page.document.querySelector("a").textContent, "HOME");
    assert.match(page.html(), /<script>/);
  });

  it("setExtraHeaders merges into every fetch; setFetchHtml swaps the fetcher", async () => {
    const calls = [];
    const stub = async (url, opts = {}) => {
      calls.push(opts.headers);
      return {
        html: "<title>H</title><body>x</body>",
        finalUrl: url,
        status: 200,
        headers: new Headers(),
      };
    };
    const page = new Page({ fetchHtml: stub });
    page.setExtraHeaders({ authorization: "Bearer t" });
    await page.goto("https://h.test/");
    assert.equal(calls[0].authorization, "Bearer t");

    let swapped = false;
    page.setFetchHtml(async (url, o) => {
      swapped = true;
      return stub(url, o);
    });
    assert.equal(typeof page.fetchHtml, "function");
    await page.goto("https://h.test/");
    assert.equal(swapped, true);
  });
});

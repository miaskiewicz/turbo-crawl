import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { byLabel } from "../src/locator.mjs";
import { Page } from "../src/page.mjs";
import { stubFetch } from "./helpers.mjs";

const HTML = `<body><main>
  <h1>Shop</h1>
  <form action="/search" method="get">
    <label for="q">Search</label><input id="q" name="q" placeholder="find products">
    <button type="submit">Go</button>
  </form>
  <select name="sort"><option value="price">Price</option><option value="name">Name</option></select>
  <input type="checkbox" name="agree">
  <a href="/p/1">Blue Widget</a><a href="/p/2">Red Widget</a>
  <img src="/i.png" alt="hero image">
  <span title="tt" data-testid="count">2 items</span>
  <p><em>nested</em> text here</p>
  <button disabled>Off</button>
</main></body>`;

async function page() {
  const p = new Page({
    fetchHtml: stubFetch({
      "https://s/": HTML,
      "https://s/p/1": "<title>P1</title><body>one</body>",
      "https://s/search": "<title>Results</title><body>r</body>",
    }),
  });
  await p.goto("https://s/");
  return p;
}

describe("locators — resolution", () => {
  it("getByRole + name filter", async () => {
    const p = await page();
    assert.equal(p.getByRole("button", { name: "Go" }).count(), 1);
    assert.equal(p.getByRole("link").count(), 2);
    assert.equal(p.getByRole("checkbox").count(), 1);
  });
  it("getByText returns the innermost match", async () => {
    const p = await page();
    assert.equal(p.getByText("Blue Widget").first().textContent(), "Blue Widget");
    assert.equal(p.getByText("nested").first().textContent(), "nested"); // <em>, not <p>
  });
  it("getByLabel resolves the associated control", async () => {
    const p = await page();
    assert.equal(p.getByLabel("Search").getAttribute("name"), "q");
  });
  it("getByLabel resolves a wrapping label (no for=)", async () => {
    const p = new Page({
      fetchHtml: stubFetch({ "https://w/": "<body><label>Name <input name='nm'></label></body>" }),
    });
    await p.goto("https://w/");
    assert.equal(p.getByLabel("Name").getAttribute("name"), "nm");
  });
  it("getByLabel handles colon useId() ids (MUI/React) via getElementById", async () => {
    const p = new Page({
      fetchHtml: stubFetch({
        "https://m/": '<body><label for=":r0:">Title</label><input id=":r0:" name="t"></body>',
      }),
    });
    await p.goto("https://m/");
    assert.equal(p.getByLabel("Title").count(), 1);
    assert.equal(p.getByLabel("Title").getAttribute("name"), "t");
  });
  it("byLabel falls back to CSS.escape when the root lacks getElementById", async () => {
    const p = new Page({
      fetchHtml: stubFetch({
        "https://e/":
          '<body><label for=":r0:">Email</label><input id=":r0:" name="e">' +
          '<label for=":gone:">Ghost</label></body>',
      }),
    });
    await p.goto("https://e/");
    // A root that exposes querySelector/querySelectorAll but no getElementById.
    const real = p.document;
    const root = { querySelectorAll: (s) => real.querySelectorAll(s) };
    const found = byLabel("Email")(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].getAttribute("name"), "e");
    // a `for=` pointing at a missing id resolves to nothing (scan returns null)
    assert.equal(byLabel("Ghost")(root).length, 0);
  });
  it("getByPlaceholder / getByTestId / getByAltText / getByTitle", async () => {
    const p = await page();
    assert.equal(p.getByPlaceholder("find products").count(), 1);
    assert.equal(p.getByTestId("count").textContent(), "2 items");
    assert.equal(p.getByAltText("hero image").count(), 1);
    assert.equal(p.getByTitle("tt").count(), 1);
  });
  it("exact vs substring name matching", async () => {
    const p = await page();
    assert.equal(p.getByText("Blue", { exact: true }).count(), 0);
    assert.equal(p.getByText("Blue").count(), 1);
  });
});

describe("locators — chaining + accessors", () => {
  it("first/last/nth/count/filter", async () => {
    const p = await page();
    const links = p.getByRole("link");
    assert.equal(links.first().textContent(), "Blue Widget");
    assert.equal(links.last().textContent(), "Red Widget");
    assert.equal(links.nth(1).textContent(), "Red Widget");
    assert.equal(links.filter({ hasText: "Red" }).count(), 1);
  });
  it("scoped .locator()", async () => {
    const p = await page();
    assert.equal(p.locator("main").locator("a").count(), 2);
  });
  it("accessors: getAttribute/inputValue/innerHTML/isEnabled/isChecked/isVisible", async () => {
    const p = await page();
    assert.equal(p.locator("a").first().getAttribute("href"), "/p/1");
    assert.equal(p.getByRole("button", { name: "Off" }).isEnabled(), false);
    assert.equal(p.getByRole("button", { name: "Go" }).isEnabled(), true);
    assert.match(p.locator("p").first().innerHTML(), /<em>nested<\/em>/);
    assert.equal(p.locator(".absent").isVisible(), false); // empty → not visible
    assert.equal(p.getByRole("checkbox").isChecked(), false);
  });
  it("throws on action against a zero-match locator", async () => {
    const p = await page();
    assert.throws(() => p.locator(".nope").textContent(), /matched no elements/);
  });
});

describe("locators — actions", () => {
  it("fill / check / uncheck / selectOption mutate the DOM", async () => {
    const p = await page();
    p.getByLabel("Search").fill("widgets");
    assert.equal(p.getByLabel("Search").inputValue(), "widgets");
    p.getByRole("checkbox").check();
    assert.equal(p.getByRole("checkbox").isChecked(), true);
    p.getByRole("checkbox").uncheck();
    assert.equal(p.getByRole("checkbox").isChecked(), false);
    p.locator("select").selectOption("name");
    assert.equal(p.locator("select").inputValue(), "name");
  });
  it("type() sets value; innerText() reads text", async () => {
    const p = await page();
    p.getByLabel("Search").type("typed");
    assert.equal(p.getByLabel("Search").inputValue(), "typed");
    assert.equal(p.getByText("Blue Widget").first().innerText(), "Blue Widget");
  });
  it("click(i) on a submit button by index submits its form", async () => {
    const p = await page();
    const i = p.interactiveElements().find((e) => e.name === "Go").i;
    const nav = await p.click(i);
    assert.equal(nav.title, "Results");
  });
  it("click on an inert element (onclick, no form) throws inert", async () => {
    const p = new Page({
      fetchHtml: stubFetch({ "https://j/": "<body><div onclick='x()' tabindex=0>JS</div></body>" }),
    });
    await p.goto("https://j/");
    const i = p.interactiveElements().find((e) => e.jsHandler).i;
    await assert.rejects(() => p.click(i), /inert in Lane A/);
  });
  it("click on a link navigates", async () => {
    const p = await page();
    const nav = await p.getByText("Blue Widget").click();
    assert.equal(nav.url, "https://s/p/1");
    assert.equal(nav.title, "P1");
  });
  it("press submits the owning form", async () => {
    const p = await page();
    p.getByLabel("Search").fill("hi");
    const nav = await p.getByRole("button", { name: "Go" }).press();
    assert.equal(nav.title, "Results");
  });
});

describe("evaluate / $eval / $$eval", () => {
  it("evaluate runs a function or expression against the DOM", async () => {
    const p = await page();
    assert.equal(
      p.evaluate(() => document.querySelectorAll("a").length),
      2,
    );
    assert.equal(p.evaluate("document.querySelectorAll('a').length"), 2);
    assert.equal(
      p.evaluate((n) => document.querySelectorAll("a").length + n, 3),
      5,
    );
  });
  it("$eval passes the first match; $$eval passes all matches", async () => {
    const p = await page();
    assert.equal(
      p.$eval("a", (el) => el.getAttribute("href")),
      "/p/1",
    );
    assert.deepEqual(
      p.$$eval("a", (els) => els.map((e) => e.getAttribute("href"))),
      ["/p/1", "/p/2"],
    );
  });
  it("$eval throws when nothing matches", async () => {
    const p = await page();
    assert.throws(() => p.$eval(".nope", (el) => el), /found no element/);
  });
});

describe("history — goBack / goForward / reload", () => {
  it("navigates the back/forward stack", async () => {
    const p = await page(); // at https://s/
    await p.goto("https://s/p/1");
    const back = await p.goBack();
    assert.equal(back.url, "https://s/");
    const fwd = await p.goForward();
    assert.equal(fwd.url, "https://s/p/1");
    assert.equal(await p.goForward(), null); // at the end
  });
  it("goBack at the start returns null", async () => {
    const p = await page();
    assert.equal(await p.goBack(), null);
  });
  it("reload re-fetches the current url", async () => {
    const p = await page();
    const r = await p.reload();
    assert.equal(r.url, "https://s/");
  });
});

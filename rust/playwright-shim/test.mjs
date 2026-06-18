// Offline test of the napi-backed Playwright shim (node --test). Uses
// setContent for the read/locator/expect surface; a localhost server exercises
// goto. Skips cleanly if the native addon isn't built.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

let shim;
try {
  shim = await import("./index.mjs");
} catch (e) {
  console.log("shim: native addon not built, skipping —", e.message);
  process.exit(0);
}
const { chromium, expect, newPage } = shim;

const PAGE = `<html><head><title>Shop</title></head><body>
  <main><h1>Widget</h1><p class="d">A nice widget</p></main>
  <button>Add to cart</button><button>Wishlist</button>
  <label for="q">Search</label><input id="q">
  <a href="/p">product</a>
</body></html>`;

test("locator count + text", async () => {
  const page = newPage();
  await page.setContent(PAGE);
  assert.equal(await page.locator("button").count(), 2);
  assert.equal(await page.locator(".d").textContent(), "A nice widget");
  assert.equal(await page.locator("button").first().textContent(), "Add to cart");
  assert.equal(await page.locator("button").nth(1).textContent(), "Wishlist");
});

test("getByRole / getByText / getByLabel", async () => {
  const page = newPage();
  await page.setContent(PAGE);
  assert.equal(await page.getByRole("button").count(), 2);
  assert.equal(await page.getByRole("button", { name: "Wishlist" }).count(), 1);
  assert.equal(await page.getByText("nice widget").count(), 1);
  assert.equal(await page.getByLabel("Search").count(), 1); // the labelled <input>
});

test("expect matchers + .not", async () => {
  const page = newPage();
  await page.setContent(PAGE);
  await expect(page.locator("button")).toHaveCount(2);
  await expect(page.locator("h1")).toHaveText("Widget");
  await expect(page.locator(".d")).toContainText("widget");
  await expect(page.locator("button")).not.toHaveCount(5);
  await assert.rejects(() => expect(page.locator("h1")).toHaveText("Nope"));
});

test("page views", async () => {
  const page = newPage();
  await page.setContent(PAGE);
  assert.equal(await page.title(), "Shop");
  assert.match(page.markdown(), /# Widget/);
  assert.ok((await page.innerText()).includes("Widget"));
});

test("evaluate + render (JS execution, no browser)", async () => {
  const page = newPage();
  await page.setContent("<body><h1 id='t'>Hi</h1><div id='app'></div></body>");
  // evaluate: read the DOM via page JS
  assert.equal(await page.evaluate("document.querySelector('#t').textContent"), "Hi");
  // render: the page's own script hydrates the DOM (incl. a virtual timer)
  await page.render(
    "document.getElementById('app').innerHTML='<p>hi</p>'; setTimeout(()=>{document.querySelector('p').textContent='late'},5)",
  );
  assert.match(await page.content(), /<p>late<\/p>/);
  // the locator surface now sees the hydrated DOM
  assert.equal(await page.locator("p").textContent(), "late");
});

test("actions: fill / check / selectOption mutate the DOM", async () => {
  const page = newPage();
  await page.setContent(
    "<input id='t'><input id='c' type='checkbox'><select id='s'><option value='a'>A</option><option value='b'>B</option></select>",
  );
  await page.fill("#t", "hello");
  await page.check("#c");
  await page.selectOption("#s", "b");
  assert.match(await page.content(), /value="hello"/);
  assert.match(await page.content(), /id="c"[^>]*checked|checked[^>]*id="c"/);
  // the select now has b selected (serialized)
  assert.match(await page.content(), /value="b"[^>]*selected|selected[^>]*value="b"/);
});

test("click follows a link to a new page", async () => {
  const linked = "<html><head><title>Dest</title></head><body><p>arrived</p></body></html>";
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(linked);
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const page = newPage();
  // base URL is the server so the relative href resolves there
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.setContent(`<a href="http://127.0.0.1:${port}/next">go</a>`);
  await page.click("a");
  assert.equal(await page.title(), "Dest");
  server.close();
});

test("click submits a GET form", async () => {
  let seen = "";
  const server = createServer((req, res) => {
    seen = req.url;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head><title>Results</title></head><body>ok</body></html>");
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const page = newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.setContent(
    `<form action="http://127.0.0.1:${port}/search" method="get"><input name="q" value="rust"><button>Go</button></form>`,
  );
  await page.click("button");
  assert.equal(await page.title(), "Results");
  assert.match(seen, /\/search\?q=rust/);
  server.close();
});

test("goto over localhost via chromium.launch", async () => {
  const body = "<html><head><title>Live</title></head><body><p>hello</p></body></html>";
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const resp = await page.goto(`http://127.0.0.1:${port}/`);
  assert.equal(resp.status(), 200);
  assert.equal(await page.title(), "Live");
  assert.ok((await page.innerText()).includes("hello"));
  await browser.close();
  server.close();
});

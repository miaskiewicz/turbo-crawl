// Exhaustive surface coverage of the napi-backed Playwright shim — one assertion
// cluster per Locator method, per expect matcher (all 5 assertion classes), per
// Page method, plus BrowserContext, fixtures, waiters, events, and the honest
// "can't do that" throws. Offline (setContent / a localhost server). Skips
// cleanly if the native addon isn't built.

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
const { BrowserContext, chromium, devices, expect, newPage, request, test: pw } = shim;

// A tiny site so navigation/forms/headers/cookies are exercised end to end.
function site() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/login") {
      res.writeHead(200, { "set-cookie": "sid=abc; Path=/", "content-type": "text/html" });
      return res.end("<title>in</title><a href='/home'>home</a>");
    }
    if (url.pathname === "/echo") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(
        `<title>echo</title><p id='c'>${req.headers.cookie ?? ""}</p><p id='h'>${req.headers["x-test"] ?? ""}</p>`,
      );
    }
    if (url.pathname === "/search") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<title>results</title><p>q=${url.searchParams.get("q")}</p>`);
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>${url.pathname}</title><main><h1>Page ${url.pathname}</h1></main>`);
  });
  return server;
}
async function listen(server) {
  await new Promise((r) => server.listen(0, r));
  return `http://127.0.0.1:${server.address().port}`;
}

const DOC = `<html><head><title>Doc</title></head><body>
  <main>
    <h1>Title</h1>
    <p class="lead">lead text</p>
    <ul id="list"><li>one</li><li>two</li><li>three</li></ul>
    <button class="btn primary" id="go">Go</button>
    <button disabled>Off</button>
    <input id="name" value="init" placeholder="your name">
    <input id="agree" type="checkbox">
    <select id="sel"><option value="a">A</option><option value="b">B</option></select>
    <label for="email">Email</label><input id="email">
    <a href="/next" title="goto">link</a>
    <img alt="logo" src="/l.png">
    <div id="hidden" style="display:none">secret</div>
    <nav><a href="/">Home</a></nav>
  </main>
</body></html>`;

async function fresh() {
  const page = newPage();
  await page.setContent(DOC);
  return page;
}

// --- Locator: composition (pure JS) ---------------------------------------
test("Locator composition: count/first/last/nth/all", async () => {
  const p = await fresh();
  assert.equal(await p.locator("#list li").count(), 3);
  assert.equal(await p.locator("#list li").first().textContent(), "one");
  assert.equal(await p.locator("#list li").last().textContent(), "three");
  assert.equal(await p.locator("#list li").nth(1).textContent(), "two");
  assert.equal(await p.locator("#list li").nth(-1).textContent(), "three");
  assert.equal((await p.locator("#list li").all()).length, 3);
});

test("Locator filter / and / or", async () => {
  const p = await fresh();
  assert.equal(await p.locator("#list li").filter({ hasText: "tw" }).count(), 1);
  assert.equal(await p.locator("#list li").filter({ hasNotText: "two" }).count(), 2);
  assert.equal(await p.locator("button").and(p.locator(".primary")).count(), 1);
  assert.equal(await p.locator("h1").or(p.locator(".lead")).count(), 2);
});

test("Locator text reads: textContent/innerText/innerHTML/allTextContents/allInnerTexts", async () => {
  const p = await fresh();
  assert.equal(await p.locator(".lead").textContent(), "lead text");
  assert.equal(await p.locator(".lead").innerText(), "lead text");
  assert.match(await p.locator("#list").innerHTML(), /<li>one<\/li>/);
  assert.deepEqual(await p.locator("#list li").allTextContents(), ["one", "two", "three"]);
  assert.deepEqual(await p.locator("#list li").allInnerTexts(), ["one", "two", "three"]);
});

// --- Locator: accessors (cross to Rust) -----------------------------------
test("Locator accessors: attr/value/role/name/visible/checked/enabled/editable/empty/css", async () => {
  const p = await fresh();
  assert.equal(await p.locator("a[title]").getAttribute("href"), "/next");
  assert.equal(await p.locator("#name").inputValue(), "init");
  assert.equal(await p.locator("a[title]").ariaRole(), "link");
  assert.equal(await p.locator("#go").isVisible(), true);
  assert.equal(await p.locator("#hidden").isVisible(), false);
  assert.equal(await p.locator("#hidden").isHidden(), true);
  assert.equal(await p.locator("button[disabled]").isEnabled(), false);
  assert.equal(await p.locator("button[disabled]").isDisabled(), true);
  assert.equal(await p.locator("#name").isEditable(), true);
  assert.equal(typeof (await p.locator("#go").accessibleName()), "string");
  assert.equal(typeof (await p.locator("#go").cssValue("display")), "string");
});

test("Locator selectedValues + selectOption", async () => {
  const p = await fresh();
  await p.locator("#sel").selectOption("b");
  assert.deepEqual(await p.locator("#sel").selectedValues(), ["b"]);
});

// --- Locator: actions ------------------------------------------------------
test("Locator actions: fill/clear/type/pressSequentially/check/uncheck/setChecked", async () => {
  const p = await fresh();
  await p.locator("#name").fill("alice");
  assert.equal(await p.locator("#name").inputValue(), "alice");
  await p.locator("#name").clear();
  assert.equal(await p.locator("#name").inputValue(), "");
  await p.locator("#name").type("bob");
  assert.equal(await p.locator("#name").inputValue(), "bob");
  await p.locator("#agree").check();
  assert.equal(await p.locator("#agree").isChecked(), true);
  await p.locator("#agree").setChecked(false);
  assert.equal(await p.locator("#agree").isChecked(), false);
});

test("Locator no-op actions resolve quietly (focus/blur/scroll/dispatch/waitFor/highlight)", async () => {
  const p = await fresh();
  await p.locator("#go").focus();
  await p.locator("#go").blur();
  await p.locator("#go").scrollIntoViewIfNeeded();
  await p.locator("#go").dispatchEvent("click");
  await p.locator("#go").highlight();
  await p.locator("#go").waitFor();
  assert.ok(true);
});

test("Locator.evaluate runs page JS for a CSS-backed locator", async () => {
  const p = await fresh();
  const len = await p.locator("#list").evaluate((el) => el.querySelectorAll("li").length);
  assert.equal(Number(len), 3);
  await assert.rejects(() => p.getByText("one").evaluate((el) => el), /selector-backed/);
});

// --- Locator: getBy* -------------------------------------------------------
test("Page getBy*: role/text/label/testid/placeholder/alt/title", async () => {
  const p = newPage();
  await p.setContent(
    "<button>Save</button><span>hello</span><label for='q'>Q</label><input id='q'>" +
      "<div data-testid='card'>c</div><input placeholder='search'><img alt='pic'><a title='tip'>t</a>",
  );
  assert.equal(await p.getByRole("button", { name: "Save" }).count(), 1);
  assert.equal(await p.getByText("hello").count(), 1);
  assert.equal(await p.getByLabel("Q").count(), 1);
  assert.equal(await p.getByTestId("card").count(), 1);
  assert.equal(await p.getByPlaceholder("search").count(), 1);
  assert.equal(await p.getByAltText("pic").count(), 1);
  assert.equal(await p.getByTitle("tip").count(), 1);
});

test("getByTestId honours a custom testIdAttribute", async () => {
  const ctx = new BrowserContext({ testIdAttribute: "data-test-id" });
  const p = await ctx.newPage();
  await p.setContent("<button data-test-id='submit'>S</button>");
  assert.equal(await p.getByTestId("submit").count(), 1);
});

// --- LocatorAssertions -----------------------------------------------------
test("LocatorAssertions: visibility / state matchers", async () => {
  const p = await fresh();
  await expect(p.locator("#go")).toBeVisible();
  await expect(p.locator("#hidden")).toBeHidden();
  await expect(p.locator("#go")).toBeAttached();
  await expect(p.locator("#go")).toBeEnabled();
  await expect(p.locator("button[disabled]")).toBeDisabled();
  await expect(p.locator("#name")).toBeEditable();
  await expect(p.locator("#go")).toBeInViewport();
  await expect(p.locator("#missing")).not.toBeVisible();
});

test("LocatorAssertions: text / value / count matchers", async () => {
  const p = await fresh();
  await expect(p.locator("h1")).toHaveText("Title");
  await expect(p.locator("h1")).toHaveText(/Tit/);
  await expect(p.locator(".lead")).toContainText("lead");
  await expect(p.locator(".lead")).toContainText(/lead/);
  await expect(p.locator("#list li")).toHaveCount(3);
  await expect(p.locator("#name")).toHaveValue("init");
  await expect(p.locator("#name")).toHaveValue(/ini/);
});

test("LocatorAssertions: attribute / class / role / id / aria-name matchers", async () => {
  const p = await fresh();
  await expect(p.locator("a[title]")).toHaveAttribute("href", "/next");
  await expect(p.locator("a[title]")).toHaveAttribute("href");
  await expect(p.locator("#go")).toHaveClass("primary");
  await expect(p.locator("#go")).toContainClass("btn");
  await expect(p.locator("#go")).toHaveId("go");
  await expect(p.locator("a[title]")).toHaveRole("link");
  await expect(p.locator("#go")).toHaveAccessibleName(/Go/);
});

test("LocatorAssertions: toHaveValues / toMatchAriaSnapshot", async () => {
  const p = await fresh();
  await p.locator("#sel").selectOption("b");
  await expect(p.locator("#sel")).toHaveValues(["b"]);
  await expect(p.locator("nav")).toMatchAriaSnapshot('- link "Home"');
});

test("LocatorAssertions: toHaveScreenshot throws (unsupported)", async () => {
  const p = await fresh();
  await assert.rejects(() => expect(p.locator("#go")).toHaveScreenshot(), /unavailable/);
});

// --- PageAssertions --------------------------------------------------------
test("PageAssertions: toHaveURL / toHaveTitle", async () => {
  const server = site();
  const base = await listen(server);
  const p = newPage();
  await p.goto(`${base}/abc`);
  await expect(p).toHaveURL(/\/abc$/);
  await expect(p).toHaveURL(`${base}/abc`);
  await expect(p).toHaveTitle("/abc");
  await expect(p).not.toHaveTitle("nope");
  server.close();
});

// --- GenericAssertions -----------------------------------------------------
test("GenericAssertions: equality / membership / numeric / type", async () => {
  expect(1).toBe(1);
  expect({ a: [1, 2] }).toEqual({ a: [1, 2] });
  expect({ a: 1 }).toStrictEqual({ a: 1 });
  expect("abc").toContain("b");
  expect([1, 2, 3]).toContain(2);
  expect([{ x: 1 }]).toContainEqual({ x: 1 });
  expect("hello").toMatch(/ell/);
  expect({ a: 1, b: 2 }).toMatchObject({ a: 1 });
  expect(null).toBeNull();
  expect(undefined).toBeUndefined();
  expect(1).toBeDefined();
  expect(1).toBeTruthy();
  expect(0).toBeFalsy();
  expect(Number.NaN).toBeNaN();
  expect(5).toBeGreaterThan(4);
  expect(5).toBeGreaterThanOrEqual(5);
  expect(3).toBeLessThan(4);
  expect(3).toBeLessThanOrEqual(3);
  expect(3.14159).toBeCloseTo(3.14, 2);
  expect([]).toBeInstanceOf(Array);
  expect([1, 2]).toHaveLength(2);
  expect({ a: { b: 1 } }).toHaveProperty("a.b", 1);
  expect(() => {
    throw new Error("x");
  }).toThrow();
  expect(() => {
    throw new Error("boom");
  }).toThrowError("boom");
  expect(1).not.toBe(2);
});

test("GenericAssertions: jest-mock matchers + toMatchSnapshot throws", async () => {
  const calls = [];
  const spy = (...a) => calls.push(a);
  spy.mock = { calls };
  spy(1, 2);
  expect(spy).toHaveBeenCalled();
  expect(spy).toHaveBeenCalledWith(1, 2);
  await assert.rejects(async () => expect("x").toMatchSnapshot(), /unavailable/);
});

test("expect.poll / expect.soft", async () => {
  expect.poll(() => 7).toBe(7);
  await expect.soft(newPage().locator("nothing")).not.toBeVisible();
});

// --- Page: navigation + history -------------------------------------------
test("Page navigation: goto / reload / goBack / goForward", async () => {
  const server = site();
  const base = await listen(server);
  const p = newPage();
  await p.goto(`${base}/a`);
  await p.goto(`${base}/b`);
  assert.equal(await p.title(), "/b");
  await p.reload();
  assert.equal(await p.title(), "/b");
  await p.goBack();
  assert.equal(await p.title(), "/a");
  await p.goForward();
  assert.equal(await p.title(), "/b");
  server.close();
});

test("Page baseURL: relative goto resolves against context baseURL", async () => {
  const server = site();
  const base = await listen(server);
  const ctx = new BrowserContext({ baseURL: base });
  const p = await ctx.newPage();
  await p.goto("/xyz");
  assert.equal(await p.title(), "/xyz");
  server.close();
});

test("Page setExtraHTTPHeaders sends real headers (not a no-op)", async () => {
  const server = site();
  const base = await listen(server);
  const p = newPage();
  await p.setExtraHTTPHeaders({ "x-test": "wired" });
  await p.goto(`${base}/echo`);
  assert.equal(await p.locator("#h").textContent(), "wired");
  server.close();
});

test("Page cookies persist across navigations (storageState shape)", async () => {
  const server = site();
  const base = await listen(server);
  const p = newPage();
  await p.goto(`${base}/login`);
  await p.goto(`${base}/echo`);
  assert.match(await p.locator("#c").textContent(), /sid=abc/);
  assert.equal(p.storageState().cookies.length, 1);
  server.close();
});

// --- Page: read selector-shortcuts ----------------------------------------
test("Page selector shortcuts: innerText/innerHTML/textContent/getAttribute/inputValue/is*", async () => {
  const p = await fresh();
  assert.equal(await p.innerText("h1"), "Title");
  assert.match(await p.innerHTML("#list"), /<li>/);
  assert.equal(await p.textContent(".lead"), "lead text");
  assert.equal(await p.getAttribute("a[title]", "href"), "/next");
  assert.equal(await p.inputValue("#name"), "init");
  assert.equal(await p.isVisible("#go"), true);
  assert.equal(await p.isHidden("#hidden"), true);
  assert.equal(await p.isEnabled("#go"), true);
  assert.equal(await p.isDisabled("button[disabled]"), true);
});

// --- Page: actions submit forms -------------------------------------------
test("Page click submits a GET form to the server", async () => {
  const server = site();
  const base = await listen(server);
  const p = newPage();
  await p.goto(`${base}/`);
  await p.setContent(
    `<form action="${base}/search" method="get"><input name="q" value="rust"><button>Go</button></form>`,
  );
  await p.click("button");
  assert.match(await p.content(), /q=rust/);
  server.close();
});

// --- Page: frames + waiters ------------------------------------------------
test("Page frames collapse to self", async () => {
  const p = await fresh();
  assert.equal(p.mainFrame(), p);
  assert.deepEqual(p.frames(), [p]);
  assert.equal(p.frame(), p);
  assert.ok(p.frameLocator("main"));
});

test("Page waiters resolve on the static DOM", async () => {
  const p = await fresh();
  await p.waitForLoadState("networkidle");
  await p.waitForTimeout(1);
  assert.ok(await p.waitForSelector("h1"));
  assert.equal(await p.waitForSelector("nope", { state: "hidden" }), null);
  assert.equal(Number(await p.waitForFunction(() => 1 + 1)), 2);
  assert.ok((await p.waitForResponse()).status);
  assert.ok((await p.waitForRequest()).url());
  await p.waitForURL(/Doc|about/);
});

// --- Page: events ----------------------------------------------------------
test("Page events: on/once/off load + close", async () => {
  const p = newPage();
  let loads = 0;
  let closed = 0;
  const onLoad = () => loads++;
  p.on("load", onLoad);
  p.once("close", () => closed++);
  await p.setContent("<p>x</p>"); // fires load
  p.off("load", onLoad);
  await p.setContent("<p>y</p>"); // load no longer counted
  assert.equal(loads, 1);
  await p.close();
  assert.equal(closed, 1);
  assert.equal(p.isClosed(), true);
});

// --- Page: config / state --------------------------------------------------
test("Page config: viewport / context / video / workers / no-op emulateMedia", async () => {
  const ctx = new BrowserContext({ viewport: { width: 800, height: 600 } });
  const p = await ctx.newPage();
  assert.deepEqual(p.viewportSize(), { width: 800, height: 600 });
  await p.setViewportSize({ width: 1024, height: 768 });
  assert.deepEqual(p.viewportSize(), { width: 1024, height: 768 });
  assert.equal(p.context(), ctx);
  assert.equal(p.video(), null);
  assert.deepEqual(p.workers(), []);
  await p.emulateMedia({ media: "print" });
  p.setDefaultTimeout(1000);
  p.setDefaultNavigationTimeout(1000);
});

test("Page evaluate (string + function + arg) and render hydrate the DOM", async () => {
  const p = newPage();
  await p.setContent("<div id='n'>40</div><div id='app'></div>");
  assert.equal(await p.evaluate("document.querySelector('#n').textContent"), "40");
  assert.equal(
    Number(await p.evaluate((s) => Number(document.querySelector(s).textContent) + 2, "#n")),
    42,
  );
  await p.render("document.getElementById('app').innerHTML='<b>hi</b>'");
  assert.match(await p.content(), /<b>hi<\/b>/);
});

// --- BrowserContext --------------------------------------------------------
test("BrowserContext: pages / cookies / storageState / addCookies / clearCookies", async () => {
  const ctx = new BrowserContext();
  const p = await ctx.newPage();
  assert.deepEqual(ctx.pages(), [p]);
  ctx.addCookies([{ name: "a", value: "1", domain: "x", path: "/" }]);
  assert.equal((await ctx.cookies()).length, 1);
  assert.equal(ctx.storageState().cookies.length, 1);
  await ctx.clearCookies();
  assert.equal((await ctx.cookies()).length, 0);
});

test("BrowserContext: browser()/request() + no-op permission/geo/offline", async () => {
  const ctx = new BrowserContext();
  assert.equal(ctx.browser().version(), "turbo-surf");
  assert.ok(ctx.request());
  await ctx.grantPermissions(["clipboard-read"]);
  await ctx.clearPermissions();
  await ctx.setGeolocation({ latitude: 0, longitude: 0 });
  await ctx.setOffline(true);
  await ctx.close();
});

test("chromium.launch → browser → context → page (drop-in shape)", async () => {
  const browser = await chromium.launch();
  assert.equal(browser.isConnected(), true);
  const ctx = await browser.newContext({ baseURL: "http://x" });
  const p = await ctx.newPage();
  assert.ok(p);
  await browser.close();
  assert.equal(chromium.name(), "chromium");
});

// --- @playwright/test surface ---------------------------------------------
test("devices proxy returns an empty descriptor", () => {
  assert.deepEqual(devices["iPhone 13"], {});
});

test("request.newContext().get/post/fetch", async () => {
  const server = site();
  const base = await listen(server);
  const ctx = await request.newContext();
  const r = await ctx.get(`${base}/abc`);
  assert.equal(r.status(), 200);
  assert.match(await r.text(), /Page \/abc/);
  await ctx.dispose();
  server.close();
});

test("request methods pass the HTTP method + body through", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, body });
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<title>${req.method}</title>`);
    });
  });
  const base = await listen(server);
  const ctx = await request.newContext();
  assert.equal(
    (await (await ctx.post(`${base}/`, { data: { a: 1 } })).text()).match(/POST/)?.[0],
    "POST",
  );
  await ctx.put(`${base}/`);
  await ctx.delete(`${base}/`);
  assert.deepEqual(
    seen.map((s) => s.method),
    ["POST", "PUT", "DELETE"],
  );
  assert.match(seen[0].body, /"a":1/);
  server.close();
});

test("request.newContext baseURL resolves relative paths + JSON content-type for object data", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, ctype: req.headers["content-type"], body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"ok":true}`);
    });
  });
  const base = await listen(server);
  // baseURL set on the context → a relative path must resolve against it (was a
  // reqwest "builder error" before). Object `data` → JSON body + content-type.
  const ctx = await request.newContext({ baseURL: base });
  const res = await ctx.post("/api/thing?x=1", { data: { user: "greg" } });
  assert.equal(res.status(), 200);
  assert.equal(seen[0].url, "/api/thing?x=1");
  assert.equal(seen[0].ctype, "application/json");
  assert.match(seen[0].body, /"user":"greg"/);
  // per-request header overrides, string body sent as-is
  await ctx.post("/raw", { data: "plain", headers: { "content-type": "text/plain" } });
  assert.equal(seen[1].ctype, "text/plain");
  assert.equal(seen[1].body, "plain");
  server.close();
});

test("BrowserContext reads baseURL/testIdAttribute from env (config use{} mapping)", () => {
  process.env.TURBO_SHIM_BASE_URL = "http://env.example";
  process.env.TURBO_SHIM_TESTID_ATTR = "data-qa";
  try {
    const ctx = new BrowserContext();
    assert.equal(ctx._baseURL, "http://env.example");
    assert.equal(ctx._testIdAttribute, "data-qa");
    // explicit opts still win over env
    const ctx2 = new BrowserContext({ baseURL: "http://opt", testIdAttribute: "data-x" });
    assert.equal(ctx2._baseURL, "http://opt");
    assert.equal(ctx2._testIdAttribute, "data-x");
  } finally {
    process.env.TURBO_SHIM_BASE_URL = undefined;
    process.env.TURBO_SHIM_TESTID_ATTR = undefined;
  }
});

test("GenericAssertions: .resolves / .rejects", async () => {
  await expect(Promise.resolve(5)).resolves.toBe(5);
  await expect(Promise.resolve([1, 2])).resolves.toEqual([1, 2]);
  await expect(Promise.reject(new Error("boom"))).rejects.toThrow(/boom/);
  await expect(Promise.reject(new Error("boom"))).rejects.toThrow("boom");
});

pw("fixture { page } is injected and isolated", async ({ page }) => {
  await page.setContent("<h1>fx</h1>");
  await expect(page.locator("h1")).toHaveText("fx");
});

pw("fixtures: context + request injected", async ({ context, request: req }) => {
  assert.ok(context instanceof BrowserContext);
  assert.ok(req);
});

const extended = pw.extend({
  greeting: async (_f, use) => use("hi"),
  named: async ({ page }, use) => {
    await page.setContent("<h2>custom</h2>");
    await use(page);
  },
});
extended("test.extend injects custom fixtures", async ({ greeting, named }) => {
  assert.equal(greeting, "hi");
  await expect(named.locator("h2")).toHaveText("custom");
});

// The payroll pattern: override `page` with a fixture that depends on the base
// `page` (same name). The override must SEE the base page, not undefined.
const wrapped = pw.extend({
  page: async ({ page }, use) => {
    page._wrapped = true; // tag the base page the override received
    await page.setContent("<h4>wrapped</h4>");
    await use(page);
  },
});
wrapped("page-override fixture receives + wraps the base page", async ({ page }) => {
  assert.equal(page._wrapped, true);
  await expect(page.locator("h4")).toHaveText("wrapped");
});

pw.describe("describe + hooks", () => {
  let order = [];
  pw.beforeAll(() => order.push("beforeAll"));
  pw.afterAll(() => order.push("afterAll"));
  pw.beforeEach(() => order.push("beforeEach"));
  pw.afterEach(() => order.push("afterEach"));
  pw("a nested test with steps + testInfo", async ({ page }, info) => {
    assert.ok(page);
    assert.equal(typeof info.outputPath(), "string");
    assert.equal(info.project.name, "turbo-surf");
    await pw.step("a step", async () => assert.ok(true));
    order.push("test");
  });
});

pw.skip("skipped test does not run", async () => {
  throw new Error("should not execute");
});

// --- honest "can't do that" throws ----------------------------------------
test("honest throws: pixel / input / network-interception", async () => {
  const p = await fresh();
  await assert.rejects(() => p.screenshot(), /unavailable/);
  await assert.rejects(() => p.pdf(), /unavailable/);
  await assert.rejects(() => p.locator("#go").screenshot(), /unavailable/);
  await assert.rejects(() => p.locator("#go").boundingBox(), /unavailable/);
  await assert.rejects(() => p.locator("#go").hover(), /input/);
  await assert.rejects(() => p.locator("#go").dragTo(p.locator("h1")), /input/);
  await assert.rejects(() => p.locator("#name").selectText(), /input/);
  await assert.rejects(() => p.mouse.click(0, 0), /input/);
  await assert.rejects(() => p.keyboard.press("a"), /input/);
  await assert.rejects(() => p.touchscreen.tap(0, 0), /input/);
  await assert.rejects(() => p.route("**"), /interception/);
  await assert.rejects(() => p.exposeFunction("f", () => {}), /binding/);
});

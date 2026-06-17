import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __internals, test } from "../playwright/test.mjs";

const { FixtureScope, fixtureNames, absoluteUrl, headersOf, bodyOf, runtimeSkip, isStaticDef } =
  __internals;

// --- pure helpers -----------------------------------------------------------

describe("playwright/test — fixture name extraction", () => {
  it("reads the destructured first parameter", () => {
    assert.deepEqual(
      fixtureNames(async ({ page, baseURL }) => page + baseURL),
      ["page", "baseURL"],
    );
    assert.deepEqual(
      fixtureNames(({ a: renamed, b = 1 }) => renamed + b),
      ["a", "b"],
    );
    assert.deepEqual(
      fixtureNames(({ page }, _info) => page),
      ["page"],
    );
  });
  it("returns [] for a non-destructured / non-function arg", () => {
    assert.deepEqual(
      fixtureNames((info) => info),
      [],
    );
    assert.deepEqual(fixtureNames("nope"), []);
  });
  it("honors an explicit __fixtures override", () => {
    const fn = () => {};
    fn.__fixtures = ["page"];
    assert.deepEqual(fixtureNames(fn), ["page"]);
  });
});

describe("playwright/test — request helpers", () => {
  it("absoluteUrl joins relative paths onto baseURL, leaves absolute untouched", () => {
    assert.equal(absoluteUrl("http://h", "/a"), "http://h/a");
    assert.equal(absoluteUrl("http://h", "https://o/x"), "https://o/x");
    assert.equal(absoluteUrl(undefined, "/a"), "/a");
  });
  it("headersOf/bodyOf encode JSON data, else pass body through", () => {
    assert.deepEqual(headersOf({ data: { x: 1 } }), { "content-type": "application/json" });
    assert.equal(headersOf({ headers: { a: "b" } }).a, "b");
    assert.equal(bodyOf({ data: { x: 1 } }), '{"x":1}');
    assert.equal(bodyOf({ body: "raw" }), "raw");
  });
});

describe("playwright/test — runtime skip", () => {
  it("throws a skip signal when the condition holds (or is omitted)", () => {
    assert.throws(() => runtimeSkip(undefined, "r"), /r/);
    assert.throws(() => runtimeSkip(true, "yep"), /yep/);
    assert.doesNotThrow(() => runtimeSkip(false, "no"));
  });
  it("isStaticDef distinguishes (title, fn) from runtime forms", () => {
    assert.equal(
      isStaticDef("t", () => {}),
      true,
    );
    assert.equal(isStaticDef(true, "reason"), false);
  });
});

// --- fixture scope engine ---------------------------------------------------

describe("playwright/test — FixtureScope", () => {
  it("resolves constants and use()-style fixtures with dependency injection", async () => {
    const scope = new FixtureScope(
      {
        port: 8080,
        url: async ({ port }, use) => use(`http://h:${port}`),
      },
      {},
    );
    assert.equal(await scope.get("port"), 8080);
    assert.equal(await scope.get("url"), "http://h:8080");
    await scope.dispose();
  });
  it("options override definitions", async () => {
    const scope = new FixtureScope({ baseURL: undefined }, { baseURL: "http://over" });
    assert.equal(await scope.get("baseURL"), "http://over");
  });
  it("builds each fixture once (cached) and tears down in reverse order", async () => {
    const order = [];
    const mk = (name) => async (_deps, use) => {
      await use(name);
      order.push(`teardown:${name}`);
    };
    const scope = new FixtureScope({ a: mk("a"), b: async ({ a }, use) => use(`${a}b`) }, {});
    assert.equal(await scope.get("b"), "ab");
    assert.equal(await scope.get("b"), "ab"); // cached, no re-run
    await scope.dispose();
    assert.deepEqual(order, ["teardown:a"]); // b has no post-use code; a torn down once
  });
  it("argsFor injects only the fixtures a function destructures", async () => {
    const scope = new FixtureScope({ a: 1, b: 2, c: 3 }, {});
    assert.deepEqual(await scope.argsFor(({ a, c }) => a + c), { a: 1, c: 3 });
  });
  it("surfaces a fixture that throws before use()", async () => {
    const scope = new FixtureScope(
      {
        boom: async () => {
          throw new Error("setup failed");
        },
      },
      {},
    );
    await assert.rejects(() => scope.get("boom"), /setup failed/);
    await scope.dispose();
  });
});

// --- integration: real subtests on the turbo engine (no chromium) -----------

describe("playwright/test — integration (turbo page fixture, no browser)", () => {
  test("the page fixture is a turbo-crawl page", async ({ page, browserName }) => {
    assert.equal(typeof page.goto, "function");
    assert.equal(typeof page.getByRole, "function");
    assert.equal(browserName, "chromium");
  });

  const extended = test.extend({
    greeting: async ({ baseURL }, use) => use(`hi ${baseURL ?? "world"}`),
  });
  extended(
    "test.extend adds a custom fixture alongside the built-ins",
    async ({ greeting, page }) => {
      assert.equal(greeting, "hi world");
      assert.equal(typeof page.goto, "function");
    },
  );

  test.describe("hooks share the test's fixtures", () => {
    let seenInHook;
    test.beforeEach(async ({ page }) => {
      seenInHook = page;
    });
    test("beforeEach got the same page instance", async ({ page }) => {
      assert.equal(seenInHook, page);
    });
  });

  test.skip("static skip never runs", async () => {
    assert.fail("should not execute");
  });

  test("runtime test.skip() marks the test skipped", async () => {
    test.skip();
    assert.fail("should not reach here");
  });
});

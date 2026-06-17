// A from-scratch, browserless `@playwright/test`-style runner: `test` + fixtures,
// executed on `node:test` over turbo-crawl's engine. Import `{ test, expect }`
// from here INSTEAD of `@playwright/test` and no playwright/chromium ever loads —
// the `page` fixture is a turbo-crawl page. Run specs with `node --test` (ESM),
// not the `playwright` CLI (the CLI only sees its own `test`).
//
//   import { test, expect } from "@miaskiewicz/turbo-crawl/playwright";
//   test.use({ mode: "fast" });            // turbo JS tier (omit for Lane A)
//   test("logs in", async ({ page }) => {
//     await page.goto("/login");
//     await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
//   });
//
// Supported: test(), test.describe (+.serial/.parallel/.only/.skip/.configure),
// before/after Each/All, test.skip/only/fixme (static + runtime), test.fail,
// test.use, test.step, test.extend, and the fixtures page/context/browser/request/
// baseURL/storageState/mode/browserName/launchOptions. Playwright's worker-scoped
// fixtures, projects, and reporter/CLI surface are out of scope (node:test owns
// running). afterEach errors surface only when the test itself passed.

import {
  after as nodeAfter,
  before as nodeBefore,
  describe as nodeDescribe,
  it as nodeIt,
} from "node:test";

import { expect } from "./expect.mjs";
import { chromium } from "./index.mjs";

// --- runtime skip/fixme signalling -----------------------------------------

const SKIP = Symbol("turbo-crawl/test:skip");

class SkipSignal extends Error {
  constructor(reason) {
    super(reason ?? "test skipped");
    this.reason = reason;
    this[SKIP] = true;
  }
}

function isSkip(err) {
  return Boolean(err) && err[SKIP] === true;
}

// --- fixture name extraction (Playwright reads the destructured 1st param) --

function fixtureNames(fn) {
  if (typeof fn !== "function") return [];
  if (fn.__fixtures) return fn.__fixtures;
  const m = /^[^(]*\(?\s*\{([^}]*)\}/.exec(fn.toString());
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.split(/[:=]/)[0].trim())
    .filter(Boolean);
}

// --- fixture scope: lazy build, dependency injection, use()-style teardown --

function defOf(defs, options, name) {
  if (name in options) return options[name];
  const d = defs[name];
  return Array.isArray(d) ? d[0] : d;
}

class FixtureScope {
  constructor(defs, options) {
    this.defs = defs;
    this.options = options;
    this.cache = new Map();
    this.teardowns = [];
  }

  async get(name) {
    if (!this.cache.has(name)) this.cache.set(name, await this.#build(name));
    return this.cache.get(name);
  }

  async argsFor(fn) {
    const out = {};
    for (const n of fixtureNames(fn)) out[n] = await this.get(n);
    return out;
  }

  async #build(name) {
    const def = defOf(this.defs, this.options, name);
    if (typeof def !== "function") return def;
    return this.#activate(def, await this.argsFor(def));
  }

  // Run a `(deps, use) => {...}` fixture: resolve to the value it passes to use(),
  // and defer everything after use() to teardown (reverse order, on dispose()).
  #activate(def, deps) {
    let publish;
    let release;
    let value;
    const ready = new Promise((r) => (publish = r));
    const released = new Promise((r) => (release = r));
    const useFixture = async (v) => {
      value = v;
      publish();
      await released;
    };
    const done = (async () => def(deps, useFixture))();
    this.teardowns.push(() => teardownFixture(release, done));
    return Promise.race([ready, done]).then(() => value);
  }

  async dispose() {
    for (let i = this.teardowns.length - 1; i >= 0; i--) await this.teardowns[i]();
  }
}

async function teardownFixture(release, done) {
  release();
  try {
    await done;
  } catch {
    // A fixture that threw already surfaced via the test's get(); don't double-throw.
  }
}

// --- built-in fixtures (all turbo-crawl; no real browser) -------------------

const BUILTIN_FIXTURES = {
  browserName: "chromium",
  baseURL: undefined,
  storageState: undefined,
  mode: undefined,
  launchOptions: undefined,
  browser: async ({ mode, launchOptions }, use) => {
    const browser = await chromium.launch({ mode, ...launchOptions });
    await use(browser);
    await browser.close();
  },
  context: async ({ browser, baseURL, storageState }, use) => {
    const context = await browser.newContext({ baseURL, storageState });
    await use(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    await use(await context.newPage());
  },
  request: async ({ baseURL }, use) => {
    await use(makeRequestContext(baseURL));
  },
};

// --- minimal APIRequestContext (real HTTP, for e2e seeding/asserts) ---------

function absoluteUrl(base, url) {
  return /^https?:/i.test(url) || !base ? url : new URL(url, base).href;
}

function headersOf(opts) {
  if (opts.data === undefined) return opts.headers;
  return { "content-type": "application/json", ...opts.headers };
}

function bodyOf(opts) {
  return opts.data === undefined ? opts.body : JSON.stringify(opts.data);
}

function wrapApiResponse(res) {
  return {
    ok: () => res.ok,
    status: () => res.status,
    statusText: () => res.statusText,
    headers: () => Object.fromEntries(res.headers),
    url: () => res.url,
    json: () => res.json(),
    text: () => res.text(),
  };
}

async function apiSend(base, method, url, opts = {}) {
  const res = await fetch(absoluteUrl(base, url), {
    method,
    headers: headersOf(opts),
    body: bodyOf(opts),
  });
  return wrapApiResponse(res);
}

function makeRequestContext(baseURL) {
  const verb = (method) => (url, opts) => apiSend(baseURL, method, url, opts);
  return {
    get: verb("GET"),
    post: verb("POST"),
    put: verb("PUT"),
    patch: verb("PATCH"),
    delete: verb("DELETE"),
    head: verb("HEAD"),
    fetch: (url, opts = {}) => apiSend(baseURL, (opts.method ?? "GET").toUpperCase(), url, opts),
  };
}

// --- per-test info object (2nd arg to a test fn) ----------------------------

function makeTestInfo(title) {
  const skip = (cond, reason) => runtimeSkip(cond, reason);
  return {
    title,
    annotations: [],
    skip,
    fixme: skip,
    slow: () => {},
    setTimeout: () => {},
    step: (_title, body) => body(),
  };
}

// --- scope frames (one per describe; root frame for top level) --------------

function makeFrame() {
  return { use: {}, beforeEach: [], afterEach: [], beforeAll: [], afterAll: [] };
}

function mergeUse(chain) {
  return Object.assign({}, ...chain.map((f) => f.use));
}

function gather(chain, key) {
  return chain.flatMap((f) => f[key]);
}

async function callWithFixtures(fn, scope, info) {
  return fn(await scope.argsFor(fn), info);
}

async function runHooks(hooks, scope, info) {
  for (const h of hooks) await callWithFixtures(h, scope, info);
}

// afterEach: run every hook even if one throws; report the first error.
async function runAfterEach(hooks, scope, info) {
  let firstErr = null;
  for (const h of hooks) {
    try {
      await callWithFixtures(h, scope, info);
    } catch (e) {
      firstErr = firstErr ?? e;
    }
  }
  return firstErr;
}

function finish(err, t) {
  if (!err) return;
  if (isSkip(err)) {
    t.skip(err.reason);
    return;
  }
  throw err;
}

// One node:test callback: build a fixture scope shared by beforeEach + the test +
// afterEach, then tear it down (Playwright's per-test fixture lifetime).
function makeRunner(defs, chain, fn) {
  return async (t) => {
    const scope = new FixtureScope(defs, mergeUse(chain));
    const info = makeTestInfo(t.name);
    let err = null;
    try {
      await runHooks(gather(chain, "beforeEach"), scope, info);
      await callWithFixtures(fn, scope, info);
    } catch (e) {
      err = e;
    }
    const afterErr = await runAfterEach(gather(chain, "afterEach").reverse(), scope, info);
    await scope.dispose();
    finish(err ?? afterErr, t);
  };
}

// --- *All hooks: a single fixture scope around a describe (or the file root) -

function wireAllHooks(frame, defs, chain) {
  const holder = {};
  nodeBefore(() => runBeforeAll(frame, defs, chain, holder));
  nodeAfter(() => runAfterAll(frame, defs, holder));
}

async function runBeforeAll(frame, defs, chain, holder) {
  holder.scope = new FixtureScope(defs, mergeUse(chain));
  await runHooks(frame.beforeAll, holder.scope, makeTestInfo("beforeAll"));
}

async function runAfterAll(frame, defs, holder) {
  const scope = holder.scope ?? new FixtureScope(defs, {});
  await runHooks(frame.afterAll, scope, makeTestInfo("afterAll"));
  await scope.dispose();
}

// --- describe + modifiers ---------------------------------------------------

function runDescribe(stack, defs, title, body, opts) {
  const frame = makeFrame();
  nodeDescribe(title, opts, () => {
    stack.push(frame);
    wireAllHooks(frame, defs, [...stack]);
    body();
    stack.pop();
  });
}

function makeDescribe(stack, defs) {
  const describe = (title, body) => runDescribe(stack, defs, title, body, {});
  describe.only = (title, body) => runDescribe(stack, defs, title, body, { only: true });
  describe.skip = (title, body) => runDescribe(stack, defs, title, body, { skip: true });
  describe.fixme = describe.skip;
  describe.configure = () => {};
  describe.serial = describe;
  describe.parallel = describe;
  return describe;
}

// --- test() modifiers -------------------------------------------------------

function runtimeSkip(cond, reason) {
  if (cond === undefined || cond) throw new SkipSignal(reason);
}

function isStaticDef(a, b) {
  return typeof a === "string" && typeof b === "function";
}

function makeSkip(register, nodeOpts) {
  return (a, b) => (isStaticDef(a, b) ? register(a, b, nodeOpts) : runtimeSkip(a, b));
}

function expectFailure(fn) {
  const wrapped = async (args, info) => {
    if (await ranWithoutThrowing(fn, args, info)) {
      throw new Error("test.fail: expected the test to fail, but it passed");
    }
  };
  wrapped.__fixtures = fixtureNames(fn);
  return wrapped;
}

async function ranWithoutThrowing(fn, args, info) {
  try {
    await fn(args, info);
    return true;
  } catch {
    return false;
  }
}

// --- the test factory (each test/extend instance carries its own fixtures) --

function makeTest(defs) {
  const root = makeFrame();
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let rootWired = false;

  const register = (title, fn, opts) => nodeIt(title, opts, makeRunner(defs, [...stack], fn));
  const wireRoot = () => {
    if (rootWired) return;
    rootWired = true;
    wireAllHooks(root, defs, [root]);
  };

  const test = (title, fn) => register(title, fn, {});
  test.describe = makeDescribe(stack, defs);
  test.beforeEach = (fn) => top().beforeEach.push(fn);
  test.afterEach = (fn) => top().afterEach.push(fn);
  test.beforeAll = (fn) => (top().beforeAll.push(fn), wireRoot());
  test.afterAll = (fn) => (top().afterAll.push(fn), wireRoot());
  test.use = (overrides) => Object.assign(top().use, overrides);
  test.step = (_title, body) => body();
  test.skip = makeSkip(register, { skip: true });
  test.fixme = makeSkip(register, { skip: true });
  test.only = (title, fn) => register(title, fn, { only: true });
  test.fail = (title, fn) => register(title, expectFailure(fn), {});
  test.extend = (more) => makeTest({ ...defs, ...more });
  test.expect = expect;
  return test;
}

const test = makeTest(BUILTIN_FIXTURES);

// Internals exposed for unit tests only (not part of the public API).
const __internals = {
  FixtureScope,
  fixtureNames,
  absoluteUrl,
  headersOf,
  bodyOf,
  makeRequestContext,
  runtimeSkip,
  isStaticDef,
  makeTest,
  BUILTIN_FIXTURES,
};

export { test, expect, __internals };

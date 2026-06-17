import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { redirectTarget, resolveHook } from "../playwright/loader-hooks.mjs";
import * as shim from "../playwright/shim.mjs";

const registerPath = fileURLToPath(new URL("../playwright/register.mjs", import.meta.url));

// --- redirect map -----------------------------------------------------------

describe("playwright/shim — redirect map", () => {
  it("maps @playwright/test to the shim, playwright(-core) to the engine", () => {
    assert.match(redirectTarget("@playwright/test"), /playwright\/shim\.mjs$/);
    assert.match(redirectTarget("playwright"), /playwright\/index\.mjs$/);
    assert.match(redirectTarget("playwright-core"), /playwright\/index\.mjs$/);
  });
  it("leaves unrelated specifiers alone", () => {
    assert.equal(redirectTarget("node:fs"), null);
    assert.equal(redirectTarget("../helpers/test"), null);
  });
  it("resolveHook short-circuits redirected specifiers, defers the rest", () => {
    assert.deepEqual(
      resolveHook("@playwright/test", {}, () => assert.fail("should not defer")),
      {
        url: redirectTarget("@playwright/test"),
        shortCircuit: true,
      },
    );
    assert.equal(
      resolveHook("lodash", { x: 1 }, (s) => `next:${s}`),
      "next:lodash",
    );
  });
});

// --- shim surface -----------------------------------------------------------

describe("playwright/shim — @playwright/test-shaped exports", () => {
  it("exposes test + expect from the turbo façade", () => {
    assert.equal(typeof shim.test, "function");
    assert.equal(typeof shim.test.describe, "function");
    assert.equal(typeof shim.expect, "function");
  });
  it("defineConfig is identity; devices yields empty descriptors", () => {
    const cfg = { projects: [] };
    assert.equal(shim.defineConfig(cfg), cfg);
    assert.deepEqual(shim.devices["Desktop Chrome"], {});
  });
  it("chromium launcher + request.newContext are present", async () => {
    assert.equal(typeof shim.chromium.launch, "function");
    const ctx = await shim.request.newContext({ baseURL: "http://h" });
    assert.equal(typeof ctx.get, "function");
  });
  it("default export bundles the named surface", () => {
    assert.equal(shim.default.test, shim.test);
    assert.equal(shim.default.defineConfig, shim.defineConfig);
  });
});

// --- end-to-end: the loader flag actually redirects a bare import -----------

function runImport(specifier, useFlag) {
  const args = useFlag ? ["--import", registerPath] : [];
  const code = `import('${specifier}').then(m=>process.stdout.write(typeof m.test+','+typeof m.expect),()=>process.exit(7))`;
  return execFileSync(process.execPath, [...args, "--input-type=module", "-e", code], {
    encoding: "utf8",
  });
}

describe("playwright/shim — loader redirect (child process)", () => {
  it("with --import register, a bare @playwright/test import resolves to turbo", () => {
    // @playwright/test is NOT installed here, so this only works via the redirect.
    assert.equal(runImport("@playwright/test", true), "function,function");
  });
  it("without the flag, @playwright/test is unresolved (proves it was the shim)", () => {
    assert.throws(() => runImport("@playwright/test", false));
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { isVisible } from "../src/visible.mjs";

const env = createEnvironment(`<!doctype html><html><head><style>
  .none { display: none }
  .invis { visibility: hidden }
</style></head><body>
  <a id="ok" href="/a">ok</a>
  <div class="none"><a id="anc" href="/b">hidden ancestor</a></div>
  <a id="self" class="none" href="/c">self none</a>
  <a id="inv" class="invis" href="/d">invisible</a>
  <a id="attr" href="/e" hidden>attr hidden</a>
  <a id="aria" href="/f" aria-hidden="true">aria</a>
  <input id="hid" type="hidden" name="x" />
</body></html>`);

const by = (id) => env.document.querySelector(`#${id}`);

describe("isVisible (cascade, geometry-free)", () => {
  it("visible element passes", () => assert.equal(isVisible(by("ok"), env.window), true));
  it("display:none on ancestor hides", () => assert.equal(isVisible(by("anc"), env.window), false));
  it("display:none on self hides", () => assert.equal(isVisible(by("self"), env.window), false));
  it("visibility:hidden hides", () => assert.equal(isVisible(by("inv"), env.window), false));
  it("hidden attribute hides", () => assert.equal(isVisible(by("attr"), env.window), false));
  it("aria-hidden hides", () => assert.equal(isVisible(by("aria"), env.window), false));
  it("type=hidden input hides", () => assert.equal(isVisible(by("hid"), env.window), false));
});

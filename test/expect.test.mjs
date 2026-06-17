import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chromium, expect } from "../playwright/index.mjs";
import { stubFetch } from "./helpers.mjs";

const HTML = `<title>My Page</title><body><main>
  <label for=":r0:">Title</label><input id=":r0:" value="hi" class="form a"/>
  <button class="btn primary"><span>Add employee</span></button>
  <button disabled>Off</button>
  <select multiple><option value="x" selected>X</option><option value="y" selected>Y</option><option value="z">Z</option></select>
  <input id="email" aria-invalid="true" aria-errormessage="err"/>
  <div id="err">Bad email</div>
  <input id="d" aria-describedby="dh"/>
  <div id="dh">Help text</div>
  <input id="ti" title="hover help"/>
  <input id="ro" value="locked" readonly/>
  <p></p>
  <p>filled</p>
  <div id="styled" style="color: rgb(255, 0, 0); display: block">red</div>
</main></body>`;

async function page() {
  const b = await chromium.launch({ fetchHtml: stubFetch({ "http://x/": HTML }) });
  const p = await b.newPage();
  await p.goto("http://x/", { waitUntil: "load" });
  return p;
}

const fails = (promise) => assert.rejects(promise, /failed/);

describe("expect — locator state matchers", () => {
  it("attached/visible/hidden/empty + .not", async () => {
    const p = await page();
    await expect(p.getByRole("button", { name: /add/i })).toBeAttached();
    await expect(p.locator("nope")).not.toBeAttached();
    await expect(p.locator("button").first()).toBeVisible();
    await expect(p.locator("nope")).toBeHidden();
    await expect(p.locator("p").first()).toBeEmpty();
    await expect(p.locator("p").last()).not.toBeEmpty();
    await fails(expect(p.locator("p").last()).toBeEmpty());
  });

  it("enabled/disabled/editable/checked", async () => {
    const p = await page();
    await expect(p.locator("input").first()).toBeEnabled();
    await expect(p.locator("button").last()).toBeDisabled();
    await expect(p.locator("input").first()).toBeEditable();
    await expect(p.locator("#ro")).not.toBeEditable();
    await expect(p.locator("button").first()).not.toBeEditable();
  });

  it("focused reflects activeElement", async () => {
    const p = await page();
    await expect(p.locator("input").first()).not.toBeFocused();
    p.locator("input").first().elements()[0].focus();
    await expect(p.locator("input").first()).toBeFocused();
  });
});

describe("expect — locator content matchers", () => {
  it("text: string, regex, and array forms", async () => {
    const p = await page();
    await expect(p.locator("button").first()).toHaveText("Add employee");
    await expect(p.locator("button").first()).toHaveText(/add/i);
    await expect(p.locator("button").first()).toContainText("employee");
    await expect(p.locator("p")).toHaveText(["", "filled"]);
    await fails(expect(p.locator("p")).toHaveText(["x"]));
  });

  it("value / values / id / role / count", async () => {
    const p = await page();
    await expect(p.locator("input").first()).toHaveValue("hi");
    await expect(p.locator("input").first()).toHaveValue(/h/);
    await expect(p.locator("select")).toHaveValues(["x", "y"]);
    await expect(p.locator("input").first()).toHaveId(":r0:");
    await expect(p.getByRole("button", { name: "Add employee" })).toHaveRole("button");
    await expect(p.locator("button")).toHaveCount(2);
  });

  it("class: exact, regex, array, contain", async () => {
    const p = await page();
    await expect(p.locator("button").first()).toHaveClass("btn primary");
    await expect(p.locator("button").first()).toHaveClass(/primary/);
    await expect(p.locator("button").first()).toContainClass("primary");
    await expect(p.locator("button").first()).toContainClass("btn primary");
    await expect(p.locator("button").first()).not.toContainClass("ghost");
    await expect(p.locator("input").first()).toHaveClass(["form a"]);
  });

  it("attribute presence and value", async () => {
    const p = await page();
    await expect(p.locator("input").first()).toHaveAttribute("value");
    await expect(p.locator("input").first()).toHaveAttribute("value", "hi");
    await expect(p.locator("input").first()).toHaveAttribute("value", /h/);
    await expect(p.locator("input").first()).not.toHaveAttribute("data-nope");
  });

  it("accessible name / description / error message", async () => {
    const p = await page();
    await expect(p.locator("button").first()).toHaveAccessibleName("Add employee");
    await expect(p.locator("#d")).toHaveAccessibleDescription("Help text");
    await expect(p.locator("#ti")).toHaveAccessibleDescription("hover help");
    await expect(p.locator("#email")).toHaveAccessibleErrorMessage("Bad email");
    await expect(p.locator("input").first()).toHaveAccessibleErrorMessage("");
  });

  it("jsProperty reads DOM IDL props", async () => {
    const p = await page();
    await expect(p.locator("input").first()).toHaveJSProperty("tagName", "INPUT");
  });

  it("aria snapshot subset (locator + page)", async () => {
    const p = await page();
    await expect(p.locator("main")).toMatchAriaSnapshot(`- button "Add employee"`);
    await expect(p.locator("main")).toMatchAriaSnapshot(`- button /add/i`);
    await expect(p).toMatchAriaSnapshot(`- button "Off"`);
    await fails(expect(p.locator("main")).toMatchAriaSnapshot(`- heading "Nope"`));
  });
});

describe("expect — page + render-only", () => {
  it("toHaveTitle / toHaveURL (string, regex, predicate)", async () => {
    const p = await page();
    await expect(p).toHaveTitle("My Page");
    await expect(p).toHaveTitle(/page/i);
    await expect(p).toHaveURL("http://x/");
    await expect(p).toHaveURL(/x/);
    await expect(p).toHaveURL((u) => u.protocol === "http:");
    await expect(p).not.toHaveURL("http://other/");
  });

  it("toHaveCSS reads the real cascade; toBeInViewport uses geometry", async () => {
    const p = await page();
    await expect(p.locator("#styled")).toHaveCSS("color", "rgb(255, 0, 0)");
    await expect(p.locator("#styled")).toHaveCSS("display", "block");
    await expect(p.locator("#styled")).toHaveCSS("color", /255/);
    await expect(p.locator("#styled")).not.toHaveCSS("color", "rgb(0, 0, 255)");
    await expect(p.locator("#styled")).toBeInViewport();
    await expect(p.locator("#styled")).toBeInViewport({ ratio: 0.5 });
  });

  it("screenshot matchers throw a pointed error (no pixel renderer)", async () => {
    const p = await page();
    const re = /pixel renderer/;
    await assert.rejects(() => expect(p.locator("button").first()).toHaveScreenshot(), re);
    await assert.rejects(() => expect(p).toHaveScreenshot(), re);
  });
});

describe("expect — generic value matchers", () => {
  it("equality + truthiness + numbers", () => {
    expect(2 + 2).toBe(4);
    expect({ a: 1 }).toEqual({ a: 1 });
    expect({ a: 1 }).toStrictEqual({ a: 1 });
    expect("x").toBeTruthy();
    expect("").toBeFalsy();
    expect(null).toBeNull();
    expect(undefined).toBeUndefined();
    expect(1).toBeDefined();
    expect(Number.NaN).toBeNaN();
    expect(3).toBeGreaterThan(2);
    expect(3).toBeGreaterThanOrEqual(3);
    expect(1).toBeLessThan(2);
    expect(1).toBeLessThanOrEqual(1);
    expect(0.1 + 0.2).toBeCloseTo(0.3);
    expect(0.1 + 0.2).toBeCloseTo(0.3, 5);
  });

  it("collections + strings + objects", () => {
    expect([1, 2, 3]).toContain(2);
    expect([{ a: 1 }]).toContainEqual({ a: 1 });
    expect([1, 2]).toHaveLength(2);
    expect("hello").toMatch(/ell/);
    expect("hello").toMatch("ell");
    expect([]).toBeInstanceOf(Array);
    expect({ a: { b: 1 }, c: 2 }).toHaveProperty("a.b", 1);
    expect({ a: 1 }).toHaveProperty("a");
    expect({ a: 1 }).not.toHaveProperty("z");
    expect({ a: { b: 1 }, c: 2 }).toMatchObject({ a: { b: 1 } });
    expect({ a: 1 }).not.toMatchObject({ a: 2 });
  });

  it("throwing + async resolves/rejects", async () => {
    expect(() => {
      throw new Error("boom");
    }).toThrow(/boom/);
    expect(() => {
      throw new Error("boom");
    }).toThrowError("boom");
    expect(() => 1).not.toThrow();
    await expect(Promise.resolve(5)).resolves.toBe(5);
    await expect(Promise.resolve(5)).resolves.not.toBe(6);
    await expect(Promise.reject(new Error("x"))).rejects.toThrow("x");
    await expect.poll(() => 7).toBeGreaterThan(5);
    await expect.poll(() => 7).not.toBeGreaterThan(99);
  });

  it("custom matchers via expect.extend; soft + configure", () => {
    expect.extend({
      toBeFortyTwo(received) {
        return { pass: received === 42, message: () => "not 42" };
      },
    });
    expect(42).toBeFortyTwo();
    assert.throws(() => expect(1).toBeFortyTwo(), /not 42/);
    expect.configure({ timeout: 1 });
    expect.soft(1).toBe(1);
  });
});

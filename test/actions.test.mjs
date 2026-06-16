import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { buildSubmission, fillValue, serializeForm } from "../src/actions.mjs";

const BASE = "https://shop.test/page";

function form(html) {
  return createEnvironment(`<!doctype html><body>${html}</body>`).document.querySelector("form");
}

describe("serializeForm — successful controls", () => {
  const f = form(`<form action="/s" method="get">
    <input name="q" value="hi">
    <input name="dis" value="x" disabled>
    <input name="noname-skip">
    <input type="checkbox" name="c1" value="a" checked>
    <input type="checkbox" name="c2" value="b">
    <input type="radio" name="r" value="r1">
    <input type="radio" name="r" value="r2" checked>
    <select name="s"><option value="o1">1<option value="o2" selected>2</select>
    <textarea name="t">body text</textarea>
    <input type="submit" name="go" value="Send">
  </form>`);
  const pairs = serializeForm(f);
  const map = new Map(pairs);

  it("includes text inputs", () => assert.equal(map.get("q"), "hi"));
  it("drops disabled controls", () => assert.equal(map.has("dis"), false));
  it("drops nameless controls", () =>
    assert.equal(
      pairs.some(([k]) => k === ""),
      false,
    ));
  it("includes only checked checkboxes", () => {
    assert.equal(map.get("c1"), "a");
    assert.equal(map.has("c2"), false);
  });
  it("includes only the checked radio", () => assert.equal(map.get("r"), "r2"));
  it("includes the selected option", () => assert.equal(map.get("s"), "o2"));
  it("includes textarea value", () => assert.equal(map.get("t"), "body text"));
  it("excludes submit buttons when not the submitter", () => assert.equal(map.has("go"), false));
});

describe("buildSubmission", () => {
  it("GET → query string on the action URL", () => {
    const f = form(
      `<form action="/search" method="get"><input name="q" value="blue widget"></form>`,
    );
    const sub = buildSubmission(f, BASE);
    assert.equal(sub.method, "GET");
    assert.equal(sub.url, "https://shop.test/search?q=blue+widget");
    assert.equal(sub.body, undefined);
  });

  it("POST → urlencoded body, no query", () => {
    const f = form(
      `<form action="/login" method="post"><input name="u" value="me"><input name="p" value="pw"></form>`,
    );
    const sub = buildSubmission(f, BASE);
    assert.equal(sub.method, "POST");
    assert.equal(sub.url, "https://shop.test/login");
    assert.equal(sub.body, "u=me&p=pw");
    assert.equal(sub.contentType, "application/x-www-form-urlencoded");
  });

  it("includes the activated submitter's name/value", () => {
    const f = form(
      `<form action="/s"><input name="q" value="x"><button name="act" value="save">Save</button></form>`,
    );
    const submitter = f.querySelector("button");
    const sub = buildSubmission(f, BASE, submitter);
    assert.match(sub.url, /act=save/);
  });
});

describe("fillValue", () => {
  it("sets a text input's live value", () => {
    const f = form(`<form><input name="q" value="old"></form>`);
    const el = f.querySelector("input");
    fillValue(el, "new");
    assert.equal(el.value, "new");
  });
  it("toggles a checkbox", () => {
    const f = form(`<form><input type="checkbox" name="c"></form>`);
    const el = f.querySelector("input");
    fillValue(el, true);
    assert.equal(el.checked, true);
  });
});

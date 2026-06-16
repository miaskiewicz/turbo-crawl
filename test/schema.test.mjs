import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { extractSchema } from "../src/schema.mjs";

const BASE = "https://shop.test/p/";
const env = createEnvironment(`<!doctype html><body>
  <h1>Blue Widget</h1>
  <span class="price">$ 9.99</span>
  <a class="more" href="/details">details</a>
  <img src="/img/1.png">
  <ul class="tags"><li>new</li><li>sale</li></ul>
  <div class="reviews">
    <div class="review"><span class="who">Ann</span><span class="stars">5</span></div>
    <div class="review"><span class="who">Bob</span><span class="stars">4</span></div>
  </div>
</body>`);

describe("extractSchema", () => {
  it("reads scalars, numbers, and resolved URLs", () => {
    const out = extractSchema(
      env.document,
      {
        name: { selector: "h1" },
        price: { selector: ".price", type: "number" },
        more: { selector: "a.more", attr: "href" },
        image: { selector: "img", attr: "src" },
      },
      BASE,
    );
    assert.equal(out.name, "Blue Widget");
    assert.equal(out.price, 9.99);
    assert.equal(out.more, "https://shop.test/details");
    assert.equal(out.image, "https://shop.test/img/1.png");
  });

  it("reads scalar lists", () => {
    const out = extractSchema(env.document, { tags: { selector: ".tags li", list: true } });
    assert.deepEqual(out.tags, ["new", "sale"]);
  });

  it("reads a list of nested objects", () => {
    const out = extractSchema(env.document, {
      reviews: {
        selector: ".review",
        list: true,
        fields: {
          who: { selector: ".who" },
          stars: { selector: ".stars", type: "number" },
        },
      },
    });
    assert.deepEqual(out.reviews, [
      { who: "Ann", stars: 5 },
      { who: "Bob", stars: 4 },
    ]);
  });

  it("missing selector → null", () => {
    const out = extractSchema(env.document, { nope: { selector: ".absent" } });
    assert.equal(out.nope, null);
  });

  it("applies a transform last", () => {
    const out = extractSchema(env.document, {
      name: { selector: "h1", transform: (s) => s.toUpperCase() },
    });
    assert.equal(out.name, "BLUE WIDGET");
  });
});

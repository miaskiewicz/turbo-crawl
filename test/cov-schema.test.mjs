import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { extractSchema } from "../src/schema.mjs";

const env = createEnvironment(`<!doctype html><body>
  <article data-id="42" class="card">
    <h2 class="title">Hello</h2>
    <span class="price">$ 3.50</span>
  </article>
</body>`);

describe("schema coverage", () => {
  it("reads a plain (non-url) attribute via readAttr", () => {
    // attr is not in URL_ATTRS → readAttr returns the raw value (line 38).
    const out = extractSchema(env.document, {
      id: { selector: "article", attr: "data-id" },
    });
    assert.equal(out.id, "42");
  });

  it("extracts a nested single object", () => {
    const out = extractSchema(env.document, {
      card: {
        selector: ".card",
        fields: {
          title: { selector: ".title" },
          price: { selector: ".price", type: "number" },
        },
      },
    });
    assert.deepEqual(out.card, { title: "Hello", price: 3.5 });
  });

  it("nested single object yields null when the container is missing", () => {
    const out = extractSchema(env.document, {
      card: {
        selector: ".missing",
        fields: { title: { selector: ".title" } },
      },
    });
    assert.equal(out.card, null);
  });
});

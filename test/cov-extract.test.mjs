import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { interactiveElements } from "../src/extract.mjs";

describe("extract coverage", () => {
  it("accessibleName returns empty string when no candidate yields text", () => {
    // A button with no aria-label, no text, no placeholder/value/title →
    // firstNonEmpty exhausts all getters and returns "" (line 57).
    const env = createEnvironment(`<!doctype html><body>
      <button></button>
    </body>`);
    const els = interactiveElements(env.document);
    const button = els.find((e) => e.tag === "button");
    assert.equal(button.name, "");
  });
});

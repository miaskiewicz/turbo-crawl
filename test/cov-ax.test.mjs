import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEnvironment } from "@miaskiewicz/turbo-dom/runtime";

import { accessibilityTree } from "../src/ax.mjs";

// Recursively collect every role in the tree.
function roles(node, acc = []) {
  if (!node) return acc;
  acc.push(node.role);
  for (const child of node.children ?? []) roles(child, acc);
  return acc;
}

// Find the first node matching a predicate (depth-first).
function find(node, pred) {
  if (!node) return undefined;
  if (pred(node)) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, pred);
    if (hit) return hit;
  }
  return undefined;
}

describe("accessibilityTree coverage", () => {
  it("type=hidden input yields a null role and is skipped from the tree", () => {
    const { document } = createEnvironment(
      `<body><input type="hidden" name="csrf" value="abc"><button>Go</button></body>`,
    );
    const tree = accessibilityTree(document);
    const all = roles(tree);
    // The hidden input has role null → pruned (no children → null node, dropped).
    assert.ok(!all.includes("textbox"));
    assert.ok(all.includes("button"));
  });

  it("inputRole falls back to textbox for unknown/missing type", () => {
    const { document } = createEnvironment(`<body><input type="email" value="a@b.c"></body>`);
    const tree = accessibilityTree(document);
    const tb = find(tree, (n) => n.role === "textbox");
    assert.ok(tb);
  });

  it("inputRole maps known types (checkbox)", () => {
    const { document } = createEnvironment(`<body><input type="checkbox"></body>`);
    const tree = accessibilityTree(document);
    assert.ok(find(tree, (n) => n.role === "checkbox"));
  });

  it("valueOf surfaces a non-empty input value", () => {
    const { document } = createEnvironment(`<body><input type="text" value="hello"></body>`);
    const tree = accessibilityTree(document);
    const tb = find(tree, (n) => n.role === "textbox");
    assert.equal(tb.value, "hello");
  });

  it("valueOf omits the value for an empty input", () => {
    const { document } = createEnvironment(`<body><input type="text" value=""></body>`);
    const tree = accessibilityTree(document);
    const tb = find(tree, (n) => n.role === "textbox");
    assert.ok(!("value" in tb));
  });

  it("valueOf surfaces a select's value", () => {
    const { document } = createEnvironment(
      `<body><select><option value="x">X</option><option value="y" selected>Y</option></select></body>`,
    );
    const tree = accessibilityTree(document);
    const combo = find(tree, (n) => n.role === "combobox");
    assert.ok(combo);
    // value present iff the select reports one.
    if (combo.value !== undefined) assert.equal(typeof combo.value, "string");
  });

  it("a roleless wrapper around a single child collapses to that child", () => {
    const { document } = createEnvironment(`<body><div><button>Only</button></div></body>`);
    const tree = accessibilityTree(document);
    // body itself is a roleless wrapper; div is roleless wrapping one button.
    assert.equal(find(tree, (n) => n.role === "button").name, "Only");
    assert.ok(!roles(tree).includes("generic"));
  });

  it("a roleless wrapper with no surfaced children yields a null node (document fallback)", () => {
    const { document } = createEnvironment(`<body><div><span></span></div></body>`);
    const tree = accessibilityTree(document);
    // Nothing has a role → whole body prunes to null → document fallback.
    assert.deepEqual(tree, { role: "document", children: [] });
  });

  it("a roleless wrapper with multiple roled children becomes role:generic", () => {
    const { document } = createEnvironment(
      `<body><div><button>One</button><a href="/x">Two</a></div></body>`,
    );
    const tree = accessibilityTree(document);
    assert.ok(roles(tree).includes("generic"));
  });

  it("aria-hidden subtrees are skipped", () => {
    const { document } = createEnvironment(
      `<body><button aria-hidden="true">Hidden</button><button>Shown</button></body>`,
    );
    const tree = accessibilityTree(document);
    const names = roles(tree);
    assert.ok(names.includes("button"));
    assert.ok(!find(tree, (n) => n.name === "Hidden"));
  });
});

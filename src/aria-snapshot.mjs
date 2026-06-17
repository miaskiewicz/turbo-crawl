// ARIA snapshot (Playwright `toMatchAriaSnapshot` / `ariaSnapshot`): a YAML-ish
// text view of an element subtree's role/name structure, plus a subset matcher.
// Built on the accessibility tree (src/ax.mjs) so roles/names match the ax view.
//
// The matcher is a structural *subset* check: every line of the expected template
// must appear, in order, among the actual roled nodes. Names compare by exact
// string or a `/regex/` literal. Playwright YAML extras (level/selected/checked
// properties, strict child nesting) are not modeled — see docs/modules.

import { axSubtree } from "./ax.mjs";

function kidsOf(node) {
  return node.children ?? [];
}

// Flatten an ax tree to roled {role, name} nodes in document order. The synthetic
// "generic" wrapper ax emits for roleless containers is elided (its children stay).
function flatten(node, out) {
  if (!node) return;
  if (node.role !== "generic") out.push({ role: node.role, name: node.name ?? "" });
  for (const kid of kidsOf(node)) flatten(kid, out);
}

function line(node, depth) {
  const pad = "  ".repeat(depth);
  return node.name ? `${pad}- ${node.role} "${node.name}"` : `${pad}- ${node.role}`;
}

function serialize(node, depth, lines) {
  if (!node) return;
  const shown = node.role !== "generic";
  if (shown) lines.push(line(node, depth));
  for (const kid of kidsOf(node)) serialize(kid, shown ? depth + 1 : depth, lines);
}

/** Indented YAML-ish ARIA snapshot text for an element subtree. */
export function ariaSnapshot(root) {
  const lines = [];
  serialize(axSubtree(root), 0, lines);
  return lines.join("\n");
}

const LINE_RE = /^\s*-\s*([\w-]+)(?:\s+(?:"([^"]*)"|\/(.*)\/([a-z]*)))?\s*$/;

function entryFrom(m) {
  const [, role, name, reSrc, flags] = m;
  if (reSrc != null) return { role, re: new RegExp(reSrc, flags) };
  return { role, name };
}

function parseExpected(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const m = raw.trim() ? LINE_RE.exec(raw) : null;
    if (m) out.push(entryFrom(m));
  }
  return out;
}

function entryMatches(want, node) {
  if (want.role !== node.role) return false;
  if (want.re) return want.re.test(node.name);
  if (want.name == null) return true;
  return node.name === want.name;
}

function isSubsequence(want, have) {
  let i = 0;
  for (let j = 0; j < have.length && i < want.length; j++) {
    if (entryMatches(want[i], have[j])) i++;
  }
  return i === want.length;
}

/** True if `expectedText` is an ordered role/name subset of `root`'s subtree. */
export function matchesAriaSnapshot(root, expectedText) {
  const have = [];
  flatten(axSubtree(root), have);
  return isSubsequence(parseExpected(expectedText), have);
}

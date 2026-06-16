// Minimal XPath evaluator over a turbo-dom DOM (turbo-dom has no document.evaluate).
// A pragmatic subset covering what shows up in real scraping scripts — NOT a full
// XPath 1.0 engine. Supported:
//   - absolute `/a/b`, descendant `//a`, relative `a/b`, wildcard `*`
//   - predicates: [@attr='v'] [@attr="v"] [@attr] [contains(@attr,'v')]
//                 [text()='v'] [contains(text(),'v')] [n] (1-based position)
//   - trailing attribute step `//a/@href` → returns the attribute string(s)
// Positional predicates apply over the combined matched set for a step (a minor
// deviation from strict per-context numbering; documented).

const QUOTES = new Set(['"', "'"]);

function closeQuote(st, ch) {
  if (ch === st.quote) st.quote = null;
  return true;
}

function adjustDepth(st, ch) {
  if (ch === "[") st.depth++;
  else if (ch === "]") st.depth--;
}

// Scan one char while splitting steps; returns false at a top-level '/'.
function advanceScan(st, ch) {
  if (st.quote) return closeQuote(st, ch);
  if (QUOTES.has(ch)) {
    st.quote = ch;
    return true;
  }
  adjustDepth(st, ch);
  return st.depth !== 0 || ch !== "/";
}

// Advance past one step (until the next unbracketed, unquoted '/').
function scanStepEnd(expr, i) {
  const st = { depth: 0, quote: null };
  for (; i < expr.length; i++) {
    if (!advanceScan(st, expr[i])) break;
  }
  return i;
}

// Resolve a step's axis and the index just past the leading slashes.
function consumeAxis(expr, i, isFirst) {
  if (expr[i] !== "/") return { axis: isFirst ? "descendant" : "child", i };
  const dbl = expr[i + 1] === "/";
  return { axis: dbl ? "descendant" : "child", i: i + (dbl ? 2 : 1) };
}

// Split an XPath into steps, respecting `//`, quotes, and bracketed predicates.
function splitSteps(expr) {
  const steps = [];
  let i = 0;
  while (i < expr.length) {
    const a = consumeAxis(expr, i, steps.length === 0);
    const start = a.i;
    i = scanStepEnd(expr, start);
    const text = expr.slice(start, i);
    if (text) steps.push({ axis: a.axis, ...parseStep(text) });
  }
  return steps;
}

function parseStep(text) {
  if (text[0] === "@") return { attr: text.slice(1) };
  const m = /^([A-Za-z*][\w-]*)/.exec(text);
  const test = m ? m[1] : "*";
  const preds = [...text.slice(test.length).matchAll(/\[([^\]]*)\]/g)].map((p) =>
    compilePred(p[1].trim()),
  );
  return { test, preds };
}

function readTerm(term, el) {
  return term === "text()" ? (el.textContent ?? "").trim() : el.getAttribute(term.slice(1));
}

function equalsPred(term, want) {
  return { fn: (el) => readTerm(term, el) === want };
}

function containsPred(term, want) {
  return { fn: (el) => (readTerm(term, el) ?? "").includes(want) };
}

function existsPred(name) {
  return { fn: (el) => el.getAttribute(name) !== null };
}

// Compile one predicate body into a matcher. Positional `[n]` is flagged via `.pos`.
function compilePred(body) {
  if (/^\d+$/.test(body)) return { pos: Number(body) };
  const eq = /^(@[\w-]+|text\(\))\s*=\s*['"](.*)['"]$/.exec(body);
  if (eq) return equalsPred(eq[1], eq[2]);
  const has = /^contains\(\s*(@[\w-]+|text\(\))\s*,\s*['"](.*)['"]\s*\)$/.exec(body);
  if (has) return containsPred(has[1], has[2]);
  const attr = /^@([\w-]+)$/.exec(body);
  return attr ? existsPred(attr[1]) : { fn: () => false };
}

// Candidate elements for a step's node-test under one context node.
function childMatches(ctx, test) {
  const kids = ctx.children ?? [];
  const want = test.toUpperCase();
  const out = [];
  for (let i = 0; i < kids.length; i++) {
    if (test === "*" || kids[i].tagName === want) out.push(kids[i]);
  }
  return out;
}

function candidates(ctx, step) {
  return step.axis === "descendant"
    ? [...ctx.querySelectorAll(step.test)]
    : childMatches(ctx, step.test);
}

function applyPredicate(nodes, pred) {
  if (pred.pos) return nodes[pred.pos - 1] ? [nodes[pred.pos - 1]] : [];
  return nodes.filter((el) => pred.fn(el));
}

function dedupe(nodes) {
  const seen = new Set();
  return nodes.filter((el) => (seen.has(el) ? false : seen.add(el)));
}

function runStep(contextNodes, step) {
  const matched = [];
  for (const ctx of contextNodes) {
    for (const el of candidates(ctx, step)) matched.push(el);
  }
  let result = dedupe(matched);
  for (const pred of step.preds) result = applyPredicate(result, pred);
  return result;
}

/**
 * Evaluate an XPath subset against a document/element.
 * @returns {{ nodes: object[] } | { values: string[] }}  values for a trailing @attr step
 */
export function evaluateXPath(root, expr) {
  const steps = splitSteps(expr.trim());
  let ctx = [root];
  for (const step of steps) {
    if (step.attr) {
      return { values: ctx.map((el) => el.getAttribute(step.attr)).filter((v) => v != null) };
    }
    ctx = runStep(ctx, step);
  }
  return { nodes: ctx };
}

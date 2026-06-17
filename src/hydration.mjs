// Hydration-state extraction (the no-JS answer to "SPAs"). Most JS frameworks
// ship the page's data server-side inside inline <script> tags; we mine it with
// zero JS execution and zero browser:
//   - Next.js  : <script id="__NEXT_DATA__"> (pure JSON)
//   - JSON-LD  : <script type="application/ld+json">
//   - typed    : <script type="application/json" id="..."> (Remix/SvelteKit/etc.)
//   - globals  : window.__INITIAL_STATE__ / __APOLLO_STATE__ / __PRELOADED_STATE__
//                / __NUXT__ — `window.X = <json>` assignments (parsed without eval)
//
// Returns whatever it finds; fields are null/empty when absent. This recovers a
// large slice of the "needs a browser" web with no browser at all.

const GLOBAL_KEYS = [
  "__INITIAL_STATE__",
  "__APOLLO_STATE__",
  "__PRELOADED_STATE__",
  "__NUXT__",
  "__remixContext",
];

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Parse the JSON text content of the first element matching `selector`, or null.
function parseJsonScript(document, selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const data = tryParse((el.textContent ?? "").trim());
  return data === undefined ? null : data;
}

// All JSON-LD blocks (each script may hold an object or array).
function parseJsonLd(document) {
  const out = [];
  const nodes = document.querySelectorAll('script[type="application/ld+json"]');
  for (let i = 0; i < nodes.length; i++) {
    const data = tryParse((nodes[i].textContent ?? "").trim());
    if (data !== undefined) out.push(data);
  }
  return out;
}

// One typed-JSON script → [id, data], or null (no id, the Next blob, or bad JSON).
function typedEntry(node) {
  const id = node.getAttribute("id");
  if (!id || id === "__NEXT_DATA__") return null; // __NEXT_DATA__ is surfaced as `next`
  const data = tryParse((node.textContent ?? "").trim());
  return data === undefined ? null : [id, data];
}

// `<script type="application/json" id="x">` → { x: parsed }.
function parseTypedJson(document) {
  const out = {};
  const nodes = document.querySelectorAll('script[type="application/json"]');
  for (let i = 0; i < nodes.length; i++) {
    const entry = typedEntry(nodes[i]);
    if (entry) out[entry[0]] = entry[1];
  }
  return out;
}

// Inside a JSON string: consume escapes / detect the closing quote. Returns false
// (never a structural char).
function stepInString(st, ch) {
  if (ch === "\\") st.esc = true;
  else if (ch === '"') st.inStr = false;
  return false;
}

// Step the string/escape state machine; returns true when `ch` is a structural
// (non-string) char that may change bracket depth.
function stepJson(st, ch) {
  if (st.esc) {
    st.esc = false;
    return false;
  }
  if (st.inStr) return stepInString(st, ch);
  if (ch === '"') {
    st.inStr = true;
    return false;
  }
  return true;
}

// Apply a structural bracket to the depth; returns true when the top-level
// structure has just closed.
function applyBracket(st, ch, open, close) {
  if (ch === open) st.depth++;
  else if (ch === close) st.depth--;
  return st.depth === 0 && ch === close;
}

// Scan from `start` (which indexes a '{' or '[') to the matching close,
// respecting strings/escapes; returns the JSON substring or null.
function sliceBalanced(text, start) {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  const st = { depth: 0, inStr: false, esc: false };
  for (let i = start; i < text.length; i++) {
    if (!stepJson(st, text[i])) continue;
    if (applyBracket(st, text[i], open, close)) return text.slice(start, i + 1);
  }
  return null;
}

// Index of the next '{' or '[' at/after `from`, or -1 if none before end.
function findBracket(text, from) {
  let i = from;
  while (i < text.length && text[i] !== "{" && text[i] !== "[") i++;
  return i < text.length ? i : -1;
}

// Extract `window.<KEY> = <json>` (or `<KEY>=`) from a blob of inline script text.
function parseAssignment(text, key) {
  const m = new RegExp(`${key}\\s*=\\s*`).exec(text);
  if (!m) return undefined;
  const i = findBracket(text, m.index + m[0].length);
  if (i < 0) return undefined;
  const json = sliceBalanced(text, i);
  return json ? tryParse(json) : undefined;
}

// Concatenated text of all inline (no src) scripts — where global assignments live.
function inlineScriptText(document) {
  const nodes = document.querySelectorAll("script");
  let text = "";
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].getAttribute("src") === null) text += `\n${nodes[i].textContent ?? ""}`;
  }
  return text;
}

function parseGlobalStates(document) {
  const text = inlineScriptText(document);
  const out = {};
  for (const key of GLOBAL_KEYS) {
    const data = parseAssignment(text, key);
    if (data !== undefined) out[key] = data;
  }
  return out;
}

/**
 * Mine server-embedded hydration state from the document (no JS executed).
 * @param {object} document  turbo-dom Document
 * @returns {{ next: object|null, jsonLd: object[], json: Record<string,object>,
 *             states: Record<string,object> }}
 */
export function extractHydrationState(document) {
  return {
    next: parseJsonScript(document, "#__NEXT_DATA__"),
    jsonLd: parseJsonLd(document),
    json: parseTypedJson(document),
    states: parseGlobalStates(document),
  };
}

// Shared by both render backends: pull the executable <script>s out of a parsed
// document, in source order. Inline classic scripts carry their code; external
// ones carry a resolved URL the renderer fetches via the host net layer. Module
// scripts (type=module) and data scripts (json/ld+json) are NOT executed.

import { resolve } from "../url.mjs";

const CLASSIC_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);

/**
 * @param {object} document  turbo-dom Document
 * @param {string} [baseUrl]
 * @returns {Array<{ code?: string, url?: string, module: boolean }>}
 */
export function extractScripts(document, baseUrl) {
  const nodes = document.querySelectorAll("script");
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const item = scriptItem(nodes[i], baseUrl);
    if (item) out.push(item);
  }
  return out;
}

function scriptType(el) {
  return (el.getAttribute("type") ?? "").toLowerCase();
}

function scriptItem(el, baseUrl) {
  const type = scriptType(el);
  if (!CLASSIC_TYPES.has(type)) return null; // json / ld+json / importmap → skip
  const module = type === "module";
  const src = el.getAttribute("src");
  // rawSrc preserves the attribute exactly as authored: bundler runtimes read
  // currentScript.getAttribute('src') and expect the raw (often root-relative)
  // value, not the resolved absolute URL.
  if (src) {
    return {
      url: resolve(baseUrl, src) ?? src,
      rawSrc: src,
      module,
      async: el.hasAttribute("async"),
      defer: el.hasAttribute("defer"),
    };
  }
  return { code: el.textContent ?? "", module };
}

// --- string-scan variants (avoid a full parse just to LIST scripts; the render
// backend re-parses properly, so a tolerant regex is fine here) ----------------

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

function attrValue(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  return m ? (m[2] ?? m[3] ?? m[4]) : null;
}

function scriptItemFromAttrs(attrs, body, baseUrl) {
  const type = (attrValue(attrs, "type") ?? "").toLowerCase();
  if (!CLASSIC_TYPES.has(type)) return null;
  const module = type === "module";
  const src = attrValue(attrs, "src");
  if (src) {
    return {
      url: resolve(baseUrl, src) ?? src,
      rawSrc: src,
      module,
      async: /\basync\b/i.test(attrs),
      defer: /\bdefer\b/i.test(attrs),
    };
  }
  return { code: body, module };
}

/** Same as extractScripts, but over an HTML string (no DOM parse). */
export function extractScriptsFromHtml(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const item = scriptItemFromAttrs(m[1], m[2], baseUrl);
    if (item) out.push(item);
  }
  return out;
}

/** Read a `<script type="importmap">` JSON blob from an HTML string, or {}. */
export function readImportMapFromHtml(html) {
  for (const m of html.matchAll(SCRIPT_RE)) {
    if (!/\btype\s*=\s*["']?importmap/i.test(m[1])) continue;
    try {
      return JSON.parse(m[2]);
    } catch {
      return {};
    }
  }
  return {};
}

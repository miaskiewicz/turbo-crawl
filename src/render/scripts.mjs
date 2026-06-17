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
  if (src) return { url: resolve(baseUrl, src) ?? src, module };
  return { code: el.textContent ?? "", module };
}

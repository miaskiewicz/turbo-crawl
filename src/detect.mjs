// Lane B routing heuristic (SPEC §11): decide whether a page is JS-gated and
// should be escalated to the Chromium adapter. Geometry-free, cheap: near-empty
// rendered text + a heavy external script payload ⇒ "shell only".
//
// Tunable; §15.4 weighs false-positive (needless Chromium boot) vs false-negative
// (returning an empty SPA). Defaults lean conservative (escalate only on a clear
// shell) so the fast path stays the default.

const DEFAULTS = {
  minTextLength: 200, // body text below this looks empty
  minScripts: 1, // at least one external script to suspect a SPA
};

/**
 * @param {object} document  turbo-dom Document of the Lane-A (no-JS) parse
 * @param {object} [opts]
 * @returns {{ jsRequired: boolean, textLength: number, scripts: number, reason: string }}
 */
// True when a common SPA mount point exists but has no server-rendered content.
function hasEmptyMount(document) {
  return ["#root", "#app", "#__next", "[data-reactroot]"].some((sel) => {
    const el = document.querySelector(sel);
    return el && (el.textContent ?? "").trim().length === 0;
  });
}

// Human-readable explanation of the verdict.
function detectReason(jsRequired, emptyMount) {
  if (!jsRequired) return "server-rendered content present";
  return emptyMount ? "empty SPA mount + external scripts" : "near-empty body + external scripts";
}

export function detectJsRequired(document, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const body = document.querySelector("body");
  const text = (body?.textContent ?? "").replace(/\s+/g, " ").trim();
  const externalScripts = document.querySelectorAll("script[src]").length;

  const emptyMount = hasEmptyMount(document);
  const shellish = text.length < cfg.minTextLength && externalScripts >= cfg.minScripts;
  const jsRequired = shellish || (emptyMount && externalScripts >= cfg.minScripts);

  return {
    jsRequired,
    textLength: text.length,
    scripts: externalScripts,
    reason: detectReason(jsRequired, emptyMount),
  };
}

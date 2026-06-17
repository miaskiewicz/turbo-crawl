// Best-effort guard for code passed to the node:vm eval paths (Page.evalJs /
// injectJs and the "fast" render backend's eval).
//
// IMPORTANT: this is a SPEED BUMP, not a security boundary. node:vm does not
// sandbox hostile code — handing the context host objects (window/document) leaves
// a prototype-chain path to the host realm. For UNTRUSTED code use the "secure"
// (isolated-vm) backend, where eval runs inside a true V8 isolate that cannot reach
// the host heap. The guard below only blocks the obvious host-escape identifiers so
// a careless/templated string doesn't trivially reach Node internals.

const BLOCKED = [
  /\bprocess\b/,
  /\brequire\b/,
  /\bmodule\b/,
  /\bglobalThis\b/,
  /\bglobal\b/,
  /\b__proto__\b/,
  /\bReflect\b/,
  /\bProxy\b/,
  /\bimport\b/, // import() dynamic import / import.meta
  /constructor\s*[.([]/, // constructor.constructor / constructor[...] escape
  /\bFunction\s*\(/, // Function("return process")()
];

/**
 * Throw if `code` contains an obvious node:vm host-escape token. Best-effort.
 * @param {string} code
 */
export function assertSafeEval(code) {
  const src = String(code);
  for (const re of BLOCKED) {
    if (re.test(src)) {
      throw new Error(
        `turbo-crawl: eval blocked — code contains "${re.source}". The node:vm eval path ` +
          `is not a security sandbox; run untrusted JS with the secure (isolated-vm) render backend.`,
      );
    }
  }
  return src;
}

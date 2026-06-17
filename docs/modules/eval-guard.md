# `src/eval-guard.mjs` — best-effort guard for node:vm eval

## Responsibility
Block the obvious host-escape identifiers in code passed to the **node:vm** eval
paths (`Page.evalJs`/`injectJs` without a bound renderer, and the `fast` render
backend's `eval`).

> **Not a security boundary.** `node:vm` does not sandbox hostile code, and the
> context is handed host objects (`window`/`document`) whose prototype chain reaches
> the host realm. This guard is a SPEED BUMP only. For untrusted code use the
> `secure` (isolated-vm) backend, where eval runs inside a true V8 isolate that
> cannot reach the host heap — there the guard is unnecessary and is **not** applied.

## Exports / API
- `assertSafeEval(code) → string` — returns `String(code)` if it contains none of
  the blocked tokens; otherwise throws an `Error` naming the matched pattern and
  pointing at the secure backend.

## Key internals
- `BLOCKED` — a list of RegExps: `process`, `require`, `module`, `globalThis`,
  `global`, `__proto__`, `Reflect`, `Proxy`, `import`, plus the escape shapes
  `constructor[.([]` (e.g. `constructor.constructor`) and `Function(`.

## Depends on / used by
- Depends on: nothing.
- Used by: `src/page.mjs` (`evalJs`/`injectJs` node:vm path) and
  `src/render/backend-fast.mjs` (`eval`).

## Invariants & gotchas
- Defense-in-depth, bypassable by obfuscation (`['cons'+'tructor']`) — the real
  control is the isolate. Document/keep the secure-mode steering.
- The `secure` backend deliberately does **not** call this (the isolate contains
  full JS safely); only the node:vm paths do.

# CLAUDE.md — working rules for turbo-crawl

turbo-crawl is a **browserless, native-speed crawler for AI agents** built on
[turbo-dom](https://github.com/miaskiewicz/turbo-dom). It fetches + parses + acts
on pages with **no Chromium at runtime**. For JS-gated pages it runs the page's
own scripts on turbo-dom (a `node:vm` or an `isolated-vm` isolate), never a
browser. Playwright/Chromium appear **only as dev tooling** (oracle + harness).

Read this before changing code. Module-level reference docs live in
[`docs/modules/`](./docs/modules/) (one file per source module); architecture and
plans are in [`SPEC.md`](./SPEC.md), [`STATUS.md`](./STATUS.md), and
[`docs/js-execution-tier.md`](./docs/js-execution-tier.md).

## Stack & layout

- **Pure ESM, Node ≥ 20.** Source is `.mjs`. No TypeScript source — types live in
  the hand-written `index.d.ts`.
- **No native artifacts of our own.** The only native/wasm code is turbo-dom's
  parser (a dependency). `isolated-vm` + `esbuild` are **`optionalDependencies`**
  used only by the secure JS-render backend; nothing else may hard-depend on them.
- Layout: `src/` (library), `mcp/` (MCP server), `playwright/` (compat façade),
  `src/render/` (JS-execution tier), `test/` (node:test), `bench/`, `harness/`,
  `docs/`, `scripts/cc-check.cjs`.

## The gates (enforced on every commit)

`npm run check` = **lint → format:check → cc → typecheck → test**, and the
pre-commit hook (`.githooks/pre-commit`, wired by `npm install`/`prepare`) runs
the same on staged files. All must pass. Never bypass with `--no-verify`.

1. **oxlint** (`npm run lint`) — `.oxlintrc.json`. 0 warnings, 0 errors.
2. **biome** format (`npm run format` / `format:check`) — `biome.json` (2-space,
   100 col, double quotes, semicolons, trailing commas). Formatting is not a
   matter of taste; run biome.
3. **Cyclomatic complexity < 6** (`npm run cc`, `scripts/cc-check.cjs`, max 5) over
   `src/`, `mcp/`, `playwright/`. **Every function must be cc ≤ 5.** The checker
   counts `if`/`for`/`while`/ternary/`catch`/non-empty `case` and **each**
   `&&`/`||`/`??`. Stay under by extracting helpers and using lookup tables /
   dispatch maps instead of long `if`/`switch` ladders or `??`-chains. (Tests and
   bench/harness are not cc-gated.)
4. **tsgo** (`npm run typecheck`) — `tsgo --noEmit -p tsconfig.json` type-checks
   `index.d.ts`. Keep it in sync with the actual exports.
5. **node:test** (`npm test`) — see below.

## Testing rules

- Runner is **`node --test`** (`test/*.test.mjs`). No vitest/jest.
- Tests are **deterministic and offline**: inject `fetchHtml` (see
  `test/helpers.mjs` `stubFetch`), inject the clock (`now`/`sleep`) for the
  Crawler, use fixtures — **never hit the live network in the unit suite.**
- **~100% line coverage** of `src/**` (`npm run test:cov`). New code must be
  covered. The only accepted gap is one unreachable isolate-boot guard line in the
  optional secure backend.
- **Optional-dep tests skip-gate**: anything needing `isolated-vm`/`esbuild`/
  `playwright` must `try { await import(...) }` and `{ skip: !ok }` so CI stays
  green without them (see `test/js-render.test.mjs`, `test/differential.test.mjs`).
- Live-network checks (differential oracle, competitive harness) live outside the
  unit suite and auto-skip when their deps/browsers are absent.

## Code standards

- **Match the surrounding code**: comment density, naming, idiom. Comments explain
  *why*, not *what*.
- **Decompose for cc<6**, not just readability — table-dispatch over `switch`,
  small named helpers over nested branches, a `firstNonEmpty([...])`-style helper
  over `a ?? b ?? c`.
- **turbo-dom is consumed via its public/seam surface only** (`createEnvironment`,
  `env.reset`, `installGlobals`, the `./runtime`/`./install`/`./parser-wasm`
  exports, `document.__cookieJar`, `window.navigator`). Do not reach into
  internals. If a capability is missing, solve it here or request a small additive
  turbo-dom change.
- **Hot-path discipline** (`extract`/`visible`): single index loop over
  `querySelectorAll` results, no per-element allocation beyond the result record,
  no `classList`/regex per node.
- **Honest behavior**: surface what can't be done (e.g. JS-only handlers throw
  "inert in Lane A"; pixel/render-only Playwright APIs throw "no-JS engine") rather
  than silently no-op.
- **No hostile-input assumptions in Lane A**, and the secure render backend must
  keep the host heap unreachable from guest page JS (true isolate).

## Commits

- Conventional-commit style subject (`feat:`/`fix:`/`refactor:`/`docs:`/`chore:`).
- Work on a branch off `main` unless told otherwise; commit/push only when asked.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## Adding a module (checklist)

1. New `src/<name>.mjs`, pure ESM, functions cc ≤ 5.
2. Export from `src/index.mjs` (barrel) if public; add to `index.d.ts`.
3. Expose via MCP (`mcp/handlers.mjs` + a schema in `mcp/server.mjs`) if it's
   agent-facing.
4. Tests in `test/<name>.test.mjs`, offline, covering the new lines.
5. A reference doc in `docs/modules/<name>.md` (see existing files for the
   structure) and a pointer in `docs/README.md`.
6. `npm run check` green.

## Reference docs index

- **Per-module reference:** [`docs/modules/`](./docs/modules/) — networking
  (net/cookies/robots/url), orchestration (page/crawl/frontier/detect), extraction
  & interaction (extract/visible/actions/aria/dom-ops/locator), views
  (markdown/ax/text/schema/query/xpath/hydration), render tier
  (render-*), agent surfaces (mcp, playwright-compat).
- **Design / status:** [`SPEC.md`](./SPEC.md), [`STATUS.md`](./STATUS.md),
  [`docs/js-execution-tier.md`](./docs/js-execution-tier.md).
- **Harness:** [`harness/competitive/README.md`](./harness/competitive/README.md).

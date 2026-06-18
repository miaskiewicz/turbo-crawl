# CLAUDE.md — working rules for turbo-crawl

turbo-crawl is a **browserless, native-speed crawler for AI agents** built on
[turbo-dom](https://github.com/miaskiewicz/turbo-dom). It fetches + parses + acts
on pages with **no Chromium at runtime**. For JS-gated pages it runs the page's
own scripts on turbo-dom (a `node:vm` or an `isolated-vm` isolate), never a
browser. Playwright/Chromium appear **only as dev tooling** (oracle + harness).

Read this before changing code. Module-level reference docs live in
[`docs/modules/`](./docs/modules/) (one file per source module); architecture and
plans are in [`README.md`](./README.md), [`CHANGELOG.md`](./CHANGELOG.md), and the
Rust engine docs [`rust/README.md`](./rust/README.md) +
[`rust/HEADLESS-HYDRATION.md`](./rust/HEADLESS-HYDRATION.md).

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

## Releasing / publishing (checklist)

Releases are cut **on `main`** (the existing tag history lives there). SemVer:
patch for fixes/dep-bumps, minor for additive features (this repo has been using
patch bumps for features too — match the surrounding history unless told otherwise).

**Publishing is automated: pushing a `v*` tag IS the publish.**
`.github/workflows/release.yml` fires on any `v*` tag, runs `npm run check`, then
`npm publish --access public --provenance` using the repo's `NPM_TOKEN` secret.
There is **no manual `npm publish`** and no `npm login` — Claude just pushes the
tag; CI ships it. (`npm whoami` failing locally is irrelevant.) The published
version is whatever `package.json` says in the tagged commit, so the bump MUST be
committed **before** the tag.

1. **Bump the version in ALL these places** (keep them identical — there is no
   single source of truth, so a stale one ships a lie):
   - `package.json` → `"version"`
   - `src/index.mjs` → `export const version = "X.Y.Z"`
   - `mcp/server.mjs` → `new Server({ name: "turbo-crawl", version: "X.Y.Z" }, …)`
   - `README.md` → the `Status: **vX.Y.Z — working**` line (and any tool-count /
     feature wording that changed)
   - Sanity check: `grep -rn "<old-version>" package.json src/index.mjs mcp/server.mjs README.md`
     returns nothing.
2. **Green gate**: `npm run check` must pass locally (CI re-runs it before publish,
   and `prepublishOnly` runs it inside `npm publish` — a red tree can't ship).
3. **Commit**: `chore(release): vX.Y.Z` (a dep-only ship is `chore(deps): …`).
4. **Tag the release commit**: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
5. **Push commit + tag**: `git push origin main && git push origin vX.Y.Z`. The tag
   push triggers `release.yml` → publish. Only `files` in `package.json` ship
   (src/mcp/playwright `.mjs`, `index.d.ts`, LICENSE, README, SPEC) —
   no tests/bench/harness/docs.
6. **Verify** after CI finishes (`gh run watch` or the Actions tab):
   `npm view @miaskiewicz/turbo-crawl version` shows the new version.

Publishing is outward-facing + irreversible (npm versions can't be reused) — only
cut a release tag when the user explicitly asks to "ship"/"publish"/"release".

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
  (markdown/ax/aria-snapshot/text/schema/query/xpath/hydration), agent surfaces
  (mcp, playwright-compat).
- **Engine + status:** [`README.md`](./README.md), [`CHANGELOG.md`](./CHANGELOG.md),
  [`rust/README.md`](./rust/README.md), [`rust/HEADLESS-HYDRATION.md`](./rust/HEADLESS-HYDRATION.md).
- **Harness:** [`harness/competitive/README.md`](./harness/competitive/README.md).

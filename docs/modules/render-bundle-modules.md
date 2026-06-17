# `src/render/bundle-modules.mjs` — bundle a `<script type="module">` import graph to a classic IIFE

## Responsibility
Executes `<script type="module">` by bundling its import graph into one classic
IIFE (via **esbuild**) that the existing render path runs — uniform across both
backends. Module dependencies (relative + absolute URLs) are fetched through the
host net layer by an esbuild plugin. Needs the optional `esbuild` dep; without it
the import throws and the caller (`index.mjs`) treats that as "skip the module".

## Exports / API
- `bundleModule(entry, baseUrl, hostFetch, importMap = {}) → Promise<string>`
  - `entry` — module source to bundle (inline code, or `import "<url>";` for an
    external module script).
  - `baseUrl` — page URL; resolves the entry's relative imports
    (`stdin.sourcefile`).
  - `hostFetch` — host fetcher used to load each module dependency.
  - `importMap` — parsed import map (`{ imports: {...} }`); `imports` defaults to
    `{}`.
  - Returns the bundled classic JS (`format: "iife"`).

## Key internals
- `mapSpecifier(spec, imports)` — applies the import map: exact match first, then
  any `"/"`-suffixed key prefix match (`key.endsWith("/") && spec.startsWith(key)`
  → `imports[key] + spec.slice(key.length)`), else returns `spec` unchanged.
- `hostFetchPlugin(hostFetch, base, imports)` — esbuild plugin `tc-host-fetch`:
  - `onResolve` (filter `/.*/`): rewrites the specifier via the import map,
    resolves it to an absolute URL against the importer's base, and tags it
    namespace `http`.
  - `onLoad` (namespace `http`): `hostFetch(path, { allowNonHtml: true })` and
    returns `{ contents: res.html ?? "", loader: "js" }`.
- `importerBase(importer, base)` — uses the importer URL when it's a real module,
  else falls back to `base` (handles the `<stdin>` entry).
- esbuild config: `bundle: true`, `format: "iife"`, `platform: "browser"`,
  `write: false`, `logLevel: "silent"`; returns `outputFiles[0].text`.

## Depends on / used by
- Depends on (optional): `esbuild` (dynamic `import("esbuild")`).
- Used by: `src/render/index.mjs` (`resolveModule`).

## Invariants & gotchas
- **esbuild is optional.** If absent, `import("esbuild")` rejects; `index.mjs`
  catches it and skips the module script (the page still renders without it).
- All dependency loads go through `hostFetch` (the `recording` wrapper in
  `index.mjs`), so module deps are recorded as discovered URLs and use the host's
  cookies/UA.
- Every specifier is forced into the `http` namespace — there is no filesystem
  resolution; bare specifiers must be resolvable via the import map or they
  become a URL relative to the importer (likely a failed fetch).
- Output is a classic IIFE so both the vm and isolate backends run it the same
  way; module scripts never reach the backends as `type=module`.

## Example
```js
import { bundleModule } from "turbo-crawl/render/bundle-modules";

const classic = await bundleModule(
  `import { init } from "./app.mjs"; init();`,
  "https://example.com/page",
  hostFetch,
  { imports: { "lodash": "https://cdn/lodash.mjs" } },
);
// classic -> IIFE string, dependencies inlined
```

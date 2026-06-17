# Publishing `turbo-crawl`

turbo-crawl is **pure ESM JavaScript** — there is nothing to compile, no native
binaries, and no per-platform build matrix. Publishing is therefore a single
gate-then-publish step.

The package ships only:

- `src/**/*.mjs`, `mcp/**/*.mjs`, `playwright/**/*.mjs`
- `index.d.ts`, `LICENSE`, `README.md`, `SPEC.md`

Everything else (`test/`, `harness/`, `bench/`, `docs/`, `scripts/`,
`node_modules/`, lockfile) is excluded by the `files` allowlist in
`package.json`. Verify with `npm pack --dry-run` before any release.

## Automated release (recommended)

Releases are cut by the `Release` GitHub Actions workflow
(`.github/workflows/release.yml`), which fires on any `v*` tag.

1. Bump the version in `package.json` (e.g. `0.1.0` → `0.1.1`). Keep it in sync
   with the tag you are about to push.

   ```sh
   npm version patch   # or: minor | major — also creates the matching git tag
   ```

   (`npm version` updates `package.json`, commits, and creates the `vX.Y.Z`
   tag in one step. If you bump by hand, create the tag yourself.)

2. Push the commit and the tag:

   ```sh
   git push origin main
   git push origin vX.Y.Z
   ```

3. The `Release` workflow then:
   - checks out the tagged commit,
   - sets up Node 22 with the npm registry,
   - runs `npm ci`,
   - runs the full gate (`npm run check` — lint + format + cc + tsgo + test),
   - publishes with `npm publish --access public --provenance`.

   Authentication uses the **`NPM_TOKEN`** repository secret (already
   configured) via `NODE_AUTH_TOKEN`. Provenance is signed using the workflow's
   OIDC token (`id-token: write`).

You can also trigger the workflow manually from the Actions tab
(`workflow_dispatch`) — useful for re-running a failed publish on an existing
tag.

## Manual fallback

If CI is unavailable, publish locally:

```sh
npm run check                      # gate must be green
npm publish --access public        # prepublishOnly re-runs `npm run check`
```

You must be authenticated to npm (`npm whoami`) with publish rights to the
`@miaskiewicz` scope. `prepublishOnly` runs `npm run check` automatically, so a
broken tree cannot be published.

## Notes

- `publishConfig.access` is `public`, so the scoped package publishes publicly
  without extra flags.
- The heavy browser packages used only by the competitive harness
  (`playwright`, `patchright`, `playwright-extra`, `rebrowser-playwright`,
  `puppeteer-extra-plugin-stealth`) are **not** committed dependencies. Install
  them ad-hoc if you want to run `npm run harness`:

  ```sh
  npm i -D playwright patchright playwright-extra rebrowser-playwright puppeteer-extra-plugin-stealth
  ```

- `esbuild` is a regular dependency (pure-Go prebuilt; JS-render module bundling).
  `isolated-vm` is an `optionalDependency` (native; only the `secure` render
  backend needs it). Neither is required for the core fetch/parse/extract/crawl
  flow; `mode:"secure"` throws an actionable error if `isolated-vm` is absent.

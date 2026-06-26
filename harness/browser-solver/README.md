# browser-solver harness

A **reference hardened-headless sidecar** for turbo-surf's `BrowserSolver`
(`turbo-surf-core::challenge`). The engine stays browserless; this dev-only
harness drives a real Chromium to clear a JS-challenge / proof-of-work wall
(Kasada, active-canvas DataDome, Cloudflare managed) and returns the cleared
cookies over a tiny JSON contract. Solve once, replay the cookie on the fast
path for its TTL (~30 min).

`playwright` is already a **devDependency** of this repo — `solve.mjs` is test /
recon tooling and is **not** part of the shipped npm launcher (which only bundles
`cli.js` / `index.js`).

## Contract

```
stdin   {"url": "...", "vendor": "kasada|datadome|kasada|cloudflare",
         "userAgent": "...", "proxy": "http://user:pass@host:port" | null}
stdout  {"cookies": {name: value, ...}, "headers": {name: value, ...}}
exit 0  on success; non-zero + stderr on failure
```

## Run it (opt-in, never on by default)

```bash
TURBO_SURF_SOLVER=browser \
TURBO_SURF_BROWSER_CMD="node harness/browser-solver/solve.mjs" \
TURBO_SURF_PROXY="http://user:pass@residential-host:port" \
  npx turbo-surf-mcp        # the MCP session now auto-solves detected walls
```

`turbo-surf` writes the request to the sidecar's stdin, reads the token on
stdout, injects the cookies into the session jar, and re-fetches once.

## Caveats (the real ones)

1. **Vanilla headless is detected.** `solve.mjs` does only the floor of stealth
   (`navigator.webdriver`, `window.chrome`, permissions). For hard gates swap
   chromium for a hardened build behind the **same contract** — patchright,
   rebrowser-playwright, camoufox, or nodriver.
2. **Headless GPU = SwiftShader** → `RENDERER` is a VM tell. Run headful on a real
   GPU (Xvfb + GPU), or accept SwiftShader and don't *claim* a discrete GPU
   (consistency beats faking).
3. **Datacenter IP = dead.** The cookie is IP-bound — use a residential `proxy`,
   and the **same** one you replay through.
4. **JA3 binding.** `cf_clearance`/`datadome` bind to IP **+ TLS fingerprint**.
   Build turbo-surf with `--features impersonate` so wreq replays with a Chrome
   149 JA3 that matches the browser that minted the token.

## Local smoke

A real-browser round-trip (gating server → sidecar → cleared cookie) is exercised
manually; the Rust e2e (`turbo-surf-mcp` `e2e_solver_clears_wall_and_replays`)
covers the same pipeline deterministically with a `printf` stub sidecar so it runs
in CI without a browser.

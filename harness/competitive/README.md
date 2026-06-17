# Competitive harness

Run the **same Playwright script** across turbo-crawl and real browsers, scoring
output **parity** against a Chromium oracle and benchmarking **timing**. Proves
turbo-crawl drives the same routines as a browser, faster.

```sh
npm run harness                      # all routines, all installed engines, 10 iters
npm run harness -- wikipedia form    # selected routines
npm run harness -- --iters=20        # more samples
npm run harness:js                   # the JS-required routine only
```

Needs **live network**. Engines that aren't installed are auto-skipped.

## Engines (auto-detected)

One routine runs unmodified on every engine via the shared Playwright Page API.

| engine | what | needs |
|---|---|---|
| `turbo-crawl (no-js)` | Lane A — fetch + parse, no JS | always |
| `turbo-crawl (js-fast)` | JS render via in-process `node:vm` | `esbuild` |
| `turbo-crawl (js-secure)` | JS render via `isolated-vm` (true isolate) | `isolated-vm` + `esbuild` |
| `chromium` (**oracle**) | real headless Chromium | `playwright` + browser |
| `firefox`, `webkit` | real Playwright browsers | `playwright` + browser |
| `stealth` | `playwright-extra` + stealth plugin | those packages |
| `patchright`, `rebrowser` | patched/anti-detect Chromium | those packages |

Install more to battle-test against them, e.g.:

```sh
npm i -D playwright-extra puppeteer-extra-plugin-stealth patchright rebrowser-playwright
npx playwright install
```

## Routines (`routines/`)

Each routine exports `{ name, requiresJs, compareSteps, run(page) }`. `run` uses
only the Playwright API; `requiresJs: true` skips the no-JS engine; `compareSteps`
are the observations scored against the oracle.

- **`wikipedia`** — click through 3+ articles (href-driven, deterministic),
  `goBack`, scroll. Server-rendered → all engines.
- **`form`** — fill + submit a real multi-field form (httpbin), read the echoed
  result. Server-rendered → all engines (turbo-crawl synthesizes the POST).
- **`js-quotes`** — a client-rendered page (`quotes.toscrape.com/js`, builds via
  `document.write` + jQuery). `requiresJs: true` → no-JS skipped; the JS tiers and
  browsers should agree.

Add a routine: drop a module in `routines/`, register it in `run.mjs`.

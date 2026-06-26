#!/usr/bin/env node
// Reference hardened-headless **challenge-solver sidecar** for turbo-surf's
// `BrowserSolver` (turbo-surf-core::challenge). Chromium stays OUT of the engine;
// this dev-only harness drives a real browser to clear a JS/PoW wall, then hands
// the cleared cookies back over the JSON contract turbo-surf expects.
//
// Contract:
//   stdin  : {"url","vendor","userAgent","proxy"}
//   stdout : {"cookies":{name:value,...},"headers":{name:value,...}}
//   exit 0 on success; non-zero + stderr on failure.
//
// Wire it (opt-in, never on by default):
//   TURBO_SURF_SOLVER=browser \
//   TURBO_SURF_BROWSER_CMD="node harness/browser-solver/solve.mjs" \
//   turbo-surf-mcp
//
// playwright is a DEV dependency — this is test/recon tooling, not shipped. For
// the hardest gates swap chromium for a hardened build (patchright / rebrowser /
// camoufox / nodriver) behind the same contract; the only requirement is the
// stdin→stdout JSON shape below. Run the browser through the SAME proxy you
// replay through, and match its Chrome version to the `impersonate` profile so
// the token's IP/JA3 binding survives replay.

import { chromium } from "playwright";

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
    // No stdin piped (e.g. a manual run) → don't hang.
    if (process.stdin.isTTY) resolve("");
  });
}

// Minimal stealth: erase the headless tells a consistency check reads. (A real
// hardened build does much more; this is the floor.)
const STEALTH = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  window.chrome = window.chrome || { app: { isInstalled: false }, runtime: {} };
  const _q = navigator.permissions && navigator.permissions.query;
  if (_q) navigator.permissions.query = (p) =>
    p && p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : _q(p);
`;

async function main() {
  const req = JSON.parse((await readStdin()) || "{}");
  if (!req.url) throw new Error("missing url");

  const browser = await chromium.launch({
    headless: true,
    proxy: req.proxy ? { server: req.proxy } : undefined,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await browser.newContext({
      userAgent: req.userAgent || undefined,
      locale: "en-US",
      viewport: { width: 1920, height: 1080 },
    });
    await context.addInitScript(STEALTH);
    const page = await context.newPage();
    await page.goto(req.url, { waitUntil: "networkidle", timeout: 45_000 });
    // Give a PoW/interstitial a moment to run + re-issue the cleared cookie.
    await page.waitForTimeout(3_000);

    const cookies = {};
    for (const c of await context.cookies()) cookies[c.name] = c.value;
    process.stdout.write(JSON.stringify({ cookies, headers: {} }));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(String((e && e.stack) || e));
  process.exit(1);
});

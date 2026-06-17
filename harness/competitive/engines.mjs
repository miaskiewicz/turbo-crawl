// Engine registry for the competitive harness. Every engine exposes the SAME
// Playwright Page API (goto/getByRole/click/fill/evaluate/goBack/…), so one
// routine runs unmodified across all of them. Each engine is auto-detected — only
// the ones actually installed run. turbo-crawl needs no browser; the rest need
// their package + (for real browsers) a downloaded binary.

import { existsSync } from "node:fs";

// Real-browser engines need an executable on disk; check before claiming available.
async function browserAvailable(launcher) {
  try {
    return existsSync(launcher.executablePath());
  } catch {
    return false;
  }
}

// turbo-crawl façade — optionally render JS via the fast/secure tier. Fetches
// leniently (allowNonHtml) so a routine can read JSON/API responses like a browser.
async function loadTurboCrawl(jsMode) {
  const { chromium } = await import("../../playwright/index.mjs");
  const { fetchHtml: rawFetch } = await import("../../src/net.mjs");
  const lenient = (url, opts = {}) => rawFetch(url, { allowNonHtml: true, ...opts });
  let fetchHtml = lenient;
  if (jsMode) {
    const { jsRenderer } = await import("../../src/index.mjs");
    fetchHtml = jsRenderer({ mode: jsMode, fetchHtml: lenient }).fetchHtml;
  }
  // launch(opts) on the façade forwards opts to the Page (fetchHtml passthrough).
  return { launch: (opts) => chromium.launch({ ...opts, fetchHtml }) };
}

async function loadReal(name) {
  const pw = await import("playwright");
  const launcher = pw[name];
  if (!launcher || !(await browserAvailable(launcher))) return null;
  return launcher;
}

async function loadStealth() {
  const { chromium } = await import("playwright-extra");
  const stealth = (await import("puppeteer-extra-plugin-stealth")).default;
  chromium.use(stealth());
  if (!(await browserAvailable(chromium))) return null;
  return chromium;
}

async function loadPkgChromium(pkg) {
  const launcher = (await import(pkg)).chromium;
  if (!launcher || !(await browserAvailable(launcher))) return null;
  return launcher;
}

// Candidate engines, in report order. `headless` engines take launch opts.
// turbo-crawl runs in three modes — no-JS (Lane A), fast JS (in-proc vm), and
// secure JS (isolated-vm) — each a separate engine to compare against Chromium.
const CANDIDATES = [
  { name: "turbo-crawl (no-js)", oracle: false, load: () => loadTurboCrawl(null), headless: false },
  {
    name: "turbo-crawl (js-fast)",
    oracle: false,
    load: () => loadTurboCrawl("fast"),
    headless: false,
  },
  {
    name: "turbo-crawl (js-secure)",
    oracle: false,
    load: () => loadTurboCrawl("secure"),
    headless: false,
  },
  { name: "chromium", oracle: true, load: () => loadReal("chromium"), headless: true },
  { name: "firefox", oracle: false, load: () => loadReal("firefox"), headless: true },
  { name: "webkit", oracle: false, load: () => loadReal("webkit"), headless: true },
  { name: "stealth", oracle: false, load: () => loadStealth(), headless: true },
  { name: "patchright", oracle: false, load: () => loadPkgChromium("patchright"), headless: true },
  {
    name: "rebrowser",
    oracle: false,
    load: () => loadPkgChromium("rebrowser-playwright"),
    headless: true,
  },
];

// Resolve all installed engines to `{ name, oracle, newPage() }`.
export async function availableEngines(opts = {}) {
  const out = [];
  for (const c of CANDIDATES) {
    const launcher = await tryLoad(c, opts);
    if (launcher) out.push(toEngine(c, launcher));
  }
  return out;
}

async function tryLoad(candidate, opts) {
  try {
    return await candidate.load(opts);
  } catch {
    return null; // package not installed → engine skipped
  }
}

function toEngine(candidate, launcher) {
  return {
    name: candidate.name,
    oracle: candidate.oracle,
    // Launch the browser ONCE per engine; the runner opens a fresh page per
    // iteration so timings measure warm per-run cost, not repeated browser boot.
    async launch() {
      const browser = await launcher.launch(candidate.headless ? { headless: true } : {});
      return {
        newPage: () => browser.newPage(),
        close: () => browser.close(),
      };
    },
  };
}

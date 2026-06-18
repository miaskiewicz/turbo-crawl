"use strict";
// Programmatic entry: locate + spawn the native turbo-crawl MCP binary. The CLI
// (`cli.js`, the `turbo-crawl-mcp` bin) is the primary interface; this exists so
// `require("@miaskiewicz/turbo-crawl")` works in scripts. The engine is the
// standalone Rust binary — this package is only the platform-binary launcher.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function isMusl() {
  if (process.platform !== "linux") return false;
  try {
    return !process.report.getReport().header.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/** Absolute path to the platform's turbo-crawl-mcp binary, or null if absent. */
function binaryPath() {
  const ext = process.platform === "win32" ? ".exe" : "";
  const base = `turbo-crawl-mcp-${process.platform}-${process.arch}`;
  const names = isMusl() ? [`${base}-musl${ext}`, `${base}${ext}`] : [`${base}${ext}`];
  for (const name of names) {
    const p = path.join(__dirname, "bin", name);
    if (fs.existsSync(p)) return p;
  }
  const dev = path.join(__dirname, "rust", "target", "release", `turbo-crawl-mcp${ext}`);
  if (fs.existsSync(dev)) return dev;
  return null;
}

/** Spawn the MCP server (stdio JSON-RPC). Returns the ChildProcess. */
function spawnMcp(args = [], opts = {}) {
  const bin = binaryPath();
  if (!bin) throw new Error(`turbo-crawl: no binary for ${process.platform}-${process.arch}`);
  return spawn(bin, args, { stdio: "inherit", ...opts });
}

module.exports = { binaryPath, spawnMcp };

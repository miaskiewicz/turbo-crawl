// Platform loader for the turbo-crawl native (Rust) addon. Resolves the prebuilt
// `.node` for the current platform/arch (matching napi-rs binary naming), with a
// fallback to a locally-built `target/{release,debug}` cdylib for development.
//
// (napi-rs's `napi build` regenerates this file with full musl/abi detection;
// this hand-written loader covers the shipped targets + the dev build.)

const { existsSync, copyFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

// node platform/arch → napi-rs binary suffix
const SUFFIX = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "win32-x64": "win32-x64-msvc",
};

function suffix() {
  const key = `${process.platform}-${process.arch}`;
  const s = SUFFIX[key];
  if (!s) throw new Error(`turbo-crawl-native: unsupported platform ${key}`);
  return s;
}

// dev fallback: the cdylib name cargo emits, per platform
function devCandidates() {
  const lib =
    process.platform === "win32"
      ? "turbo_crawl_napi.dll"
      : process.platform === "darwin"
        ? "libturbo_crawl_napi.dylib"
        : "libturbo_crawl_napi.so";
  return [join(__dirname, "../../target/release", lib), join(__dirname, "../../target/debug", lib)];
}

// Node loads native addons only from a `.node` path, so copy a cargo-built
// cdylib to a sibling `.node` (refreshed when the dylib is newer) and require it.
function requireDev(dev) {
  const node = join(__dirname, "turbo-crawl.dev.node");
  const stale = !existsSync(node) || statSync(dev).mtimeMs > statSync(node).mtimeMs;
  if (stale) copyFileSync(dev, node);
  return require(node);
}

function load() {
  const packaged = join(__dirname, `turbo-crawl.${suffix()}.node`);
  if (existsSync(packaged)) return require(packaged);
  for (const dev of devCandidates()) {
    if (existsSync(dev)) return requireDev(dev);
  }
  throw new Error(
    "turbo-crawl-native: no prebuilt binary found and no local cargo build " +
      "(run `cargo build -p turbo-crawl-napi` or `napi build`)",
  );
}

module.exports = load();

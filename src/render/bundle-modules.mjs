// Execute `<script type="module">` by bundling its import graph into one classic
// IIFE (via esbuild) that the existing render path runs — uniform across both
// backends. Module dependencies (relative + absolute URLs) are fetched through the
// host net layer by an esbuild plugin. Needs the optional `esbuild` dep; without
// it, module scripts are skipped (caller treats a throw as "skip").

// esbuild plugin: resolve every import to an absolute URL and load it via host fetch.
function hostFetchPlugin(hostFetch, base) {
  return {
    name: "tc-host-fetch",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => ({
        path: new URL(args.path, importerBase(args.importer, base)).href,
        namespace: "http",
      }));
      build.onLoad({ filter: /.*/, namespace: "http" }, async (args) => {
        const res = await hostFetch(args.path, { allowNonHtml: true });
        return { contents: res.html ?? "", loader: "js" };
      });
    },
  };
}

function importerBase(importer, base) {
  return importer && importer !== "<stdin>" ? importer : base;
}

/**
 * Bundle one module entry (inline code or `import "<url>";`) to a classic IIFE.
 * @param {string} entry     module source to bundle
 * @param {string} baseUrl   page URL (resolves the entry's relative imports)
 * @param {Function} hostFetch
 * @returns {Promise<string>} bundled classic JS
 */
export async function bundleModule(entry, baseUrl, hostFetch) {
  const esbuild = await import("esbuild");
  const out = await esbuild.build({
    stdin: { contents: entry, sourcefile: baseUrl, loader: "js" },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    plugins: [hostFetchPlugin(hostFetch, baseUrl)],
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

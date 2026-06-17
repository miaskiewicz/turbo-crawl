// Execute `<script type="module">` by bundling its import graph into one classic
// IIFE (via esbuild) that the existing render path runs — uniform across both
// backends. Module dependencies (relative + absolute URLs) are fetched through the
// host net layer by an esbuild plugin. Needs the optional `esbuild` dep; without
// it, module scripts are skipped (caller treats a throw as "skip").

// Apply an import map's `imports` to a bare specifier (exact, then "/"-prefix).
function mapSpecifier(spec, imports) {
  if (imports[spec]) return imports[spec];
  for (const key of Object.keys(imports)) {
    if (key.endsWith("/") && spec.startsWith(key)) return imports[key] + spec.slice(key.length);
  }
  return spec;
}

// esbuild plugin: rewrite specifiers via the import map, resolve to an absolute
// URL, and load each module via the host net layer.
function hostFetchPlugin(hostFetch, base, imports) {
  return {
    name: "tc-host-fetch",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => ({
        path: new URL(mapSpecifier(args.path, imports), importerBase(args.importer, base)).href,
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
 * @param {object} [importMap]  parsed import map (`{ imports: {...} }`)
 * @returns {Promise<string>} bundled classic JS
 */
export async function bundleModule(entry, baseUrl, hostFetch, importMap = {}) {
  const esbuild = await import("esbuild");
  const out = await esbuild.build({
    stdin: { contents: entry, sourcefile: baseUrl, loader: "js" },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    plugins: [hostFetchPlugin(hostFetch, baseUrl, importMap.imports ?? {})],
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

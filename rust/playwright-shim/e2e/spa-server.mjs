// A client-rendered SPA shaped like a real bundler (Turbopack/webpack), to exercise
// the hydration pump end to end: the server ships an EMPTY shell (#root has no form);
// an inline bootstrap injects a runtime chunk; the runtime injects an app chunk; each
// chunk self-identifies via `document.currentScript` (the bug we fixed — a static
// currentScript makes every chunk look identical and nothing mounts); once the app
// chunk registers, the entry runs and mounts a login form into #root. No React in the
// repo — this mimics the exact DOM/script paths a real SPA bundle drives.
import { createServer } from "node:http";

const SHELL = `<!doctype html><html><head><title>SPA Login</title></head>
<body>
  <div id="root"><p data-testid="boot">Loading…</p></div>
  <script src="/runtime.js"></script>
</body></html>`;

// The "runtime" chunk: a tiny module registry keyed by chunk id, plus a loader that
// injects the next chunk. Mirrors a bundler runtime — and it injects the app chunk.
const RUNTIME = `
globalThis.__REG = globalThis.__REG || { mods: new Map() };
globalThis.__register = function (id, factory) {
  globalThis.__REG.mods.set(id, factory);
  if (id === 'app') globalThis.__run('app'); // entry chunk → mount
};
globalThis.__run = function (id) {
  const f = globalThis.__REG.mods.get(id);
  if (f) f({ root: document.getElementById('root') });
};
// dynamically load the app chunk (the differentiator: injected at runtime, awaited)
(function () {
  const s = document.createElement('script');
  s.src = '/chunk-app.js';
  s.onload = function () { globalThis.__appChunkLoaded = true; };
  document.head.appendChild(s);
})();
`;

// The "app" chunk: self-identifies via document.currentScript (must be THIS element,
// not a shared static one), registers under that id, and its factory mounts the form.
const APP_CHUNK = `
(function () {
  const cs = document.currentScript;
  const src = cs && cs.getAttribute ? (cs.getAttribute('src') || '') : '';
  const id = src.indexOf('chunk-app') >= 0 ? 'app' : 'WRONG-CURRENTSCRIPT';
  globalThis.__register(id, function (ctx) {
    const root = ctx.root;
    root.innerHTML = '';
    const form = document.createElement('form');
    form.setAttribute('data-testid', 'login-form');
    const email = document.createElement('input');
    email.setAttribute('data-testid', 'login-email-input');
    email.setAttribute('name', 'email');
    form.appendChild(email);
    const btn = document.createElement('button');
    btn.setAttribute('data-testid', 'login-submit');
    btn.setAttribute('type', 'submit');
    btn.textContent = 'Sign in';
    form.appendChild(btn);
    root.appendChild(form);
  });
})();
`;

const ROUTES = {
  "/": { type: "text/html", body: SHELL },
  "/runtime.js": { type: "text/javascript", body: RUNTIME },
  "/chunk-app.js": { type: "text/javascript", body: APP_CHUNK },
};

export async function startSpaServer() {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const r = ROUTES[path];
    if (!r) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<h1>404</h1>");
    }
    res.writeHead(200, { "content-type": r.type });
    res.end(r.body);
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

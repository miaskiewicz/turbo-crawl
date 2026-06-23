// Generates a self-contained hydration fixture: React 18 streaming SSR with a
// SUSPENDED boundary (streams late + a $RC completion script), React/ReactDOM UMD
// inlined, and a hydrateRoot client script whose button onClick sets window.__clicked.
// The render-tier test asserts the dehydrated boundary HYDRATES (the click fires) —
// the headless-hydration regression guard. Regenerate:
//   node tests/fixture-gen/gen-react-streaming.mjs <path-to-app-node_modules>
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
const APP = process.argv[2] || "/Users/grzegorzmiaskiewicz/github-flux/payroll-app-tc/";
const require = createRequire(APP.endsWith("/") ? APP : APP + "/");
const React = require("react");
const { renderToPipeableStream } = require("react-dom/server");
const h = React.createElement;
const reactUMD = fs.readFileSync(
  path.join(APP, "node_modules/react/umd/react.production.min.js"),
  "utf8",
);
const domUMD = fs.readFileSync(
  path.join(APP, "node_modules/react-dom/umd/react-dom.production.min.js"),
  "utf8",
);

let resolved = false,
  p = null;
function AsyncBox() {
  if (!resolved) {
    if (!p)
      p = new Promise((r) =>
        setTimeout(() => {
          resolved = true;
          r();
        }, 30),
      );
    throw p;
  }
  return h("button", { id: "btn", "data-test-id": "lazy-btn" }, "go");
}
function App() {
  return h(
    "div",
    { id: "root-app" },
    h("span", { id: "shell" }, "shell"),
    h(React.Suspense, { fallback: h("span", { id: "fb" }, "loading") }, h(AsyncBox)),
  );
}
const chunks = [];
const sink = new Writable({
  write(c, e, cb) {
    chunks.push(Buffer.from(c));
    cb();
  },
});
const ssr = await new Promise((res) => {
  sink.on("finish", () => res(Buffer.concat(chunks).toString("utf8")));
  const { pipe } = renderToPipeableStream(h(App), {
    onShellReady() {
      pipe(sink);
    },
  });
});
const splitAt = ssr.indexOf("</div>") + "</div>".length;
const shell = ssr.slice(0, splitAt),
  completion = ssr.slice(splitAt);
const clientApp =
  "var R=window.React,RD=window.ReactDOM,h=R.createElement;function AsyncBox(){return h('button',{id:'btn','data-test-id':'lazy-btn',onClick:function(){window.__clicked=true;}},'go');}function App(){return h('div',{id:'root-app'},h('span',{id:'shell'},'shell'),h(R.Suspense,{fallback:h('span',{id:'fb'},'loading')},h(AsyncBox)));}RD.hydrateRoot(document.getElementById('container'),h(App));";
const page = `<body><div id="container">${shell}</div>\n<script>${reactUMD}</script>\n<script>${domUMD}</script>\n<script>${clientApp}</script>\n${completion}\n</body>`;
const out = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "fixtures",
  "react-streaming-hydration.html",
);
fs.writeFileSync(out, page);
console.log("wrote", out, "(" + page.length + " bytes)");

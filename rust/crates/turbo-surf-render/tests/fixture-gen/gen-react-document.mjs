// Generates a hydration fixture that hydrates the WHOLE `document` — the Next.js App
// Router pattern (`ReactDOMClient.hydrateRoot(document, <App/>)`). React/ReactDOM UMD
// inlined, SSR markup is a full <html> document, and the client hydrates `document`. The
// render-tier test asserts the document-level root COMMITS (a client-only marker element
// appears + the button's onClick fires) — the regression guard for headless hydration of
// document-rooted apps. Regenerate:
//   node tests/fixture-gen/gen-react-document.mjs <path-to-app-node_modules>
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const APP = process.argv[2] || "/Users/grzegorzmiaskiewicz/github-flux/payroll-app-tc/";
const require = createRequire(APP.endsWith("/") ? APP : APP + "/");
const React = require("react");
const { renderToString } = require("react-dom/server");
const h = React.createElement;
const reactUMD = fs.readFileSync(
  path.join(APP, "node_modules/react/umd/react.production.min.js"),
  "utf8",
);
const domUMD = fs.readFileSync(
  path.join(APP, "node_modules/react-dom/umd/react-dom.production.min.js"),
  "utf8",
);

// A full-document app: <html><head/><body> … </body></html>. The button carries an
// onClick; SSR renders the static tree, the client hydrates `document`.
function App() {
  return h(
    "html",
    { lang: "en" },
    h("head", null, h("title", null, "doc")),
    h(
      "body",
      null,
      h("div", { id: "app" }, h("button", { id: "btn", "data-test-id": "doc-btn" }, "go")),
    ),
  );
}
const ssr = "<!DOCTYPE html>" + renderToString(h(App));
const clientApp =
  "var R=window.React,RD=window.ReactDOM,h=R.createElement;" +
  "function App(){return h('html',{lang:'en'},h('head',null,h('title',null,'doc')),h('body',null,h('div',{id:'app'},h('button',{id:'btn','data-test-id':'doc-btn',onClick:function(){window.__clicked=true;}},'go'))));}" +
  // Mark that hydrateRoot was reached and that the container got React's root marker.
  "try{RD.hydrateRoot(document,h(App));window.__hydrateCalled=true;}catch(e){window.__hydrateError=String(e);}" +
  "window.__containerMarked=Object.keys(document).some(function(k){return k.indexOf('__reactContainer')===0;});";
// The client script must run AFTER hydration markup. Put the UMD + client in <body> end;
// browsers tolerate scripts after </body> but keep it well-formed by injecting before </body>.
const injected =
  "<script>" +
  reactUMD +
  "</script>" +
  "<script>" +
  domUMD +
  "</script>" +
  "<script>" +
  clientApp +
  "</script>";
const page = ssr.replace("</body>", injected + "</body>");
const out = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "fixtures",
  "react-document-hydration.html",
);
fs.writeFileSync(out, page);
console.log("wrote", out, "(" + page.length + " bytes)");

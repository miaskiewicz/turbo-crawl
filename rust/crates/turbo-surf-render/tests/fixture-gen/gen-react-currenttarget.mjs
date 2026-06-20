// Minimal repro of React event dispatch to a PORTAL'd element under hydrateRoot(document)
// — the MUI Autocomplete/Dialog case (options portal to <body>; their onClick must fire).
// The portal is mounted POST-hydration (via useEffect → setState) so SSR and the initial
// client render match (renderToString ignores portals). After mount, a click on the
// portal'd <li> must run its onClick (records window.__ct = its data-option-index "2").
// Regenerate: node tests/fixture-gen/gen-react-currenttarget.mjs <path-to-app-node_modules>
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

function ServerApp() {
  return h(
    "html",
    { lang: "en" },
    h("head", null, h("title", null, "ct")),
    h("body", null, h("div", { id: "app" }, "shell")),
  );
}
const ssr = "<!DOCTYPE html>" + renderToString(h(ServerApp));

const client =
  "var R=window.React,RD=window.ReactDOM,h=R.createElement;" +
  "function Opt(){ var s=R.useState(false); var show=s[0],setShow=s[1];" +
  "  R.useEffect(function(){ setShow(true); }, []);" +
  "  if(!show) return null;" +
  "  return RD.createPortal( h('ul',{id:'lb',role:'listbox'}, h('li',{ 'data-option-index':'2', role:'option', tabIndex:-1, onClick:function(ev){ window.__ct = (ev.currentTarget && ev.currentTarget.getAttribute) ? ev.currentTarget.getAttribute('data-option-index') : 'no-ct'; } }, h('div',null,h('span',{id:'leaf'},'opt')) )), document.body ); }" +
  "function App(){ return h('html',{lang:'en'},h('head',null,h('title',null,'ct')),h('body',null,h('div',{id:'app', onClick:function(){window.__mainClick=true;}},h('span',{id:'mainleaf'},'shell')),h(Opt))); }" +
  "R.startTransition(function(){ RD.hydrateRoot(document, h(App)); });";
const page = ssr.replace(
  "</body>",
  "<script>" +
    reactUMD +
    "</script><script>" +
    domUMD +
    "</script><script>" +
    client +
    "</script></body>",
);
const out = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "fixtures",
  "react-currenttarget.html",
);
fs.writeFileSync(out, page);
console.log("wrote", out, "(" + page.length + " bytes)");

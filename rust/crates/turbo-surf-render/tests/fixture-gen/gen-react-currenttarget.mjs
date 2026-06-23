// Minimal repro of React event dispatch to a createPortal'd element — the MUI Autocomplete
// option case. ONE react-dom instance (createRoot), root container = document.body, and the
// option <li> is portaled INTO document.body (so the root container's delegated listener
// catches the bubbled click). After mount, a click on the portal'd <li>'s deep leaf must
// fire its onClick (records window.__ct = its data-option-index "2"). If this passes,
// single-instance portal dispatch works and the app failure is the duplicate-react-dom;
// if it fails, portal click-dispatch itself is broken in the headless env.
// Regenerate: node tests/fixture-gen/gen-react-currenttarget.mjs <path-to-app-node_modules>
import fs from "node:fs";
import path from "node:path";
const APP = process.argv[2] || "/Users/grzegorzmiaskiewicz/github-flux/payroll-app-tc/";
const reactUMD = fs.readFileSync(
  path.join(APP, "node_modules/react/umd/react.production.min.js"),
  "utf8",
);
const domUMD = fs.readFileSync(
  path.join(APP, "node_modules/react-dom/umd/react-dom.production.min.js"),
  "utf8",
);

const client =
  "var R=window.React,RD=window.ReactDOM,h=R.createElement;" +
  "function Opt(){ var s=R.useState(false); var show=s[0],setShow=s[1];" +
  "  R.useEffect(function(){ setShow(true); }, []);" +
  "  if(!show) return null;" +
  "  return RD.createPortal( h('ul',{id:'lb',role:'listbox'}, h('li',{ 'data-option-index':'2', role:'option', tabIndex:-1, onClick:function(ev){ window.__ct = (ev.currentTarget && ev.currentTarget.getAttribute) ? ev.currentTarget.getAttribute('data-option-index') : 'no-ct'; } }, h('div',null,h('span',{id:'leaf'},'opt')) )), document.body ); }" +
  "function App(){ return h('div',{id:'app', onClick:function(){window.__mainClick=true;}}, h('span',{id:'mainleaf'},'shell'), h(Opt)); }" +
  "RD.createRoot(document.body).render(h(App));";
const page = "<!DOCTYPE html><html><head><title>ct</title></head><body></body></html>".replace(
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

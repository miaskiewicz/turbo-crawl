// Mimics the Next.js App Router client hydration shape that was NOT committing in the
// headless turbopack run: hydrateRoot(document, …) called INSIDE React.startTransition,
// with a Suspense boundary whose child suspends on a thenable that only resolves later
// (like the RSC flight client awaiting a client-reference chunk load). If this commits +
// becomes interactive in the render tier, the transition+suspense+document path is sound
// and the real blocker is flight-client-specific. Regenerate:
//   node tests/fixture-gen/gen-react-transition-suspense.mjs <path-to-app-node_modules>
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

// SSR: a full document whose Suspense child renders its final content (server doesn't
// suspend here — we just need matching markup for hydration).
function ServerApp() {
  return h(
    "html",
    { lang: "en" },
    h("head", null, h("title", null, "tx")),
    h(
      "body",
      null,
      h("div", { id: "app" }, h("button", { id: "btn", "data-test-id": "tx-btn" }, "go")),
    ),
  );
}
const ssr = "<!DOCTYPE html>" + renderToString(h(ServerApp));

// Client: a Lazy child that THROWS a thenable (suspends) until a setTimeout resolves it —
// exactly how the flight client suspends on a pending chunk-load promise. hydrateRoot is
// called inside startTransition, on `document`, just like Next's app-index hydrate().
const clientApp =
  "var R=window.React,RD=window.ReactDOM,h=R.createElement;" +
  "var done=false,p=null;" +
  "function Lazy(){ if(!done){ if(!p){ p=new Promise(function(r){ setTimeout(function(){ done=true; r(); },20); }); } throw p; } return h('button',{id:'btn','data-test-id':'tx-btn',onClick:function(){window.__clicked=true;}},'go'); }" +
  "function App(){ return h('html',{lang:'en'},h('head',null,h('title',null,'tx')),h('body',null,h('div',{id:'app'},h(R.Suspense,{fallback:h('span',null,'...')},h(Lazy))))); }" +
  "try{ R.startTransition(function(){ RD.hydrateRoot(document,h(App)); }); window.__hydrateCalled=true; }catch(e){ window.__hydrateError=String(e); }";
const injected =
  "<script>" +
  reactUMD +
  "</script><script>" +
  domUMD +
  "</script><script>" +
  clientApp +
  "</script>";
const page = ssr.replace("</body>", injected + "</body>");
const out = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "fixtures",
  "react-transition-suspense.html",
);
fs.writeFileSync(out, page);
console.log("wrote", out, "(" + page.length + " bytes)");

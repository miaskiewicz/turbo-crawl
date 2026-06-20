// Runs the REAL react-server-dom-turbopack client (createFromReadableStream) in the
// render tier against a controlled flight payload that contains a CLIENT REFERENCE — the
// exact thing the Next App Router page suspends on. This isolates the flight-client
// resolution path (resolveClientReference → preloadModule(__turbopack_load_by_url__) →
// requireModule(__turbopack_require__)) from the giant app. If the rendered tree commits
// (the client component's button appears + onClick fires), the flight client works in our
// env. Regenerate:
//   node tests/fixture-gen/gen-flight-client.mjs <path-to-app-node_modules>
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const APP = process.argv[2] || "/Users/grzegorzmiaskiewicz/github-flux/payroll-app-tc/";
const require = createRequire(APP.endsWith("/") ? APP : APP + "/");
const reactUMD = fs.readFileSync(
  path.join(APP, "node_modules/react/umd/react.production.min.js"),
  "utf8",
);
const domUMD = fs.readFileSync(
  path.join(APP, "node_modules/react-dom/umd/react-dom.production.min.js"),
  "utf8",
);
// The dev cjs — unminified, uses __turbopack_require__/__turbopack_load_by_url__ as free
// globals and require("react"|"react-dom"). We wrap it in a CJS shim in the page.
const flightCjs = fs.readFileSync(
  path.join(
    APP,
    "node_modules/next/dist/compiled/react-server-dom-turbopack/cjs/react-server-dom-turbopack-client.browser.development.js",
  ),
  "utf8",
);

// A controlled flight payload: row 1 is a client reference (module "c1", no chunks),
// row 0 is the root element rendering that client component with a prop.
const flight = '1:I["c1",[],"default"]\n' + '0:["$","$L1",null,{"label":"go"}]\n';

const boot =
  "var R=window.React,RD=window.ReactDOM;" +
  // The dev cjs gates on process.env.NODE_ENV (turbopack polyfills process in the real
  // app); provide it here so the dev build runs.
  "globalThis.process=globalThis.process||{env:{NODE_ENV:'development'}};" +
  // require shim for the flight cjs.
  "function req(n){ if(n==='react')return R; if(n==='react-dom')return RD; throw new Error('no mod '+n); }" +
  // The client component the flight references. __turbopack_require__ returns its module.
  "function FlightButton(props){ window.__btnCalled=(window.__btnCalled||0)+1; return R.createElement('button',{id:'fb','data-test-id':'flight-ok',onClick:function(){window.__clicked=true;}}, props.label||'x'); }" +
  "globalThis.__turbopack_require__=function(id){ if(id==='c1')return {__esModule:true, default:FlightButton}; throw new Error('no turbopack mod '+id); };" +
  "globalThis.__turbopack_load_by_url__=function(url){ return Promise.resolve(); };" +
  // Instantiate the flight client cjs.
  "var m={exports:{}}; (function(module,exports,require){\n" +
  flightCjs +
  "\n})(m,m.exports,req);" +
  "var createFromReadableStream=m.exports.createFromReadableStream;" +
  // Feed the controlled flight payload as a byte stream.
  "var enc=new TextEncoder();" +
  "var stream=new ReadableStream({start:function(c){ c.enqueue(enc.encode(" +
  JSON.stringify(flight) +
  ")); c.close(); }});" +
  "try{" +
  "  var resp=createFromReadableStream(stream,{});" +
  "  window.__flightStarted=true;" +
  "  Promise.resolve(resp).then(function(rootEl){ try{ window.__rootElType=typeof rootEl; window.__rootElTag=(rootEl&&rootEl.type)?(typeof rootEl.type==='function'?(rootEl.type.name||'fn'):String(rootEl.type)):'none'; window.__rootElHas$$=!!(rootEl&&rootEl.$$typeof); RD.createRoot(document.getElementById('out')).render(rootEl); window.__flightRendered=true; }catch(e){ window.__renderError=String(e&&e.stack||e); } }, function(e){ window.__flightRejected=String(e&&e.stack||e); });" +
  "}catch(e){ window.__flightError=String(e&&e.stack||e); }";

const page =
  '<!DOCTYPE html><html><head><title>flight</title></head><body><div id="out"></div>' +
  "<script>" +
  reactUMD +
  "</script><script>" +
  domUMD +
  "</script><script>" +
  boot +
  "</script>" +
  "</body></html>";
const out = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "fixtures",
  "flight-client.html",
);
fs.writeFileSync(out, page);
console.log("wrote", out, "(" + page.length + " bytes)");

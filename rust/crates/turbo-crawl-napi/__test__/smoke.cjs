// Loads the addon through the platform loader (index.js) and exercises the
// surface end-to-end in Node. Skips cleanly if no binary is built yet.
const assert = require("node:assert");

let addon;
try {
  addon = require("../index.js");
} catch (e) {
  console.log("smoke: addon not built, skipping —", e.message);
  process.exit(0);
}

assert.strictEqual(typeof addon.version(), "string");
assert.strictEqual(
  addon.markdown("<body><h1>Hi</h1><p>yo</p></body>", "https://x.test/"),
  "# Hi\n\nyo",
);
assert.strictEqual(addon.text("<body><p>hello world</p></body>"), "hello world");
assert.deepStrictEqual(addon.links("<a href=/a>x</a>", "https://x.test/"), ["https://x.test/a"]);

// JSON-returning passes parse + carry the expected shape.
const det = JSON.parse(addon.detect("<body><div id=root></div><script src=/a.js></script></body>"));
assert.strictEqual(det.js_required, true);

const ie = JSON.parse(
  addon.interactiveElements("<a href=/p>l</a><button>Go</button>", "https://x.test/"),
);
assert.strictEqual(ie.length, 2);

const ex = JSON.parse(
  addon.extract("<h1>Widget</h1>", "https://x.test/", JSON.stringify({ name: { selector: "h1" } })),
);
assert.strictEqual(ex.name, "Widget");

console.log("smoke: OK — native addon loaded and all checks passed");

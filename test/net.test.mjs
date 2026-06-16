import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CookieJar } from "../src/cookies.mjs";
import { fetchHtml, HttpError } from "../src/net.mjs";

// Minimal fake fetch: builds a Response-like object from a spec.
function fakeFetch(spec) {
  return async (url, init) => {
    fakeFetch.lastInit = init;
    const headers = new Headers(spec.headers ?? { "content-type": "text/html" });
    const bytes = spec.bytes ?? new TextEncoder().encode(spec.body ?? "<html></html>");
    return {
      url: spec.finalUrl ?? url,
      status: spec.status ?? 200,
      headers: Object.assign(
        headers,
        spec.getSetCookie ? { getSetCookie: () => spec.getSetCookie } : {},
      ),
      body: (async function* () {
        yield bytes;
      })(),
    };
  };
}

describe("fetchHtml hardening", () => {
  it("decodes utf-8 by default", async () => {
    const { html } = await fetchHtml("https://a.test/", {
      fetch: fakeFetch({ body: "<h1>café</h1>" }),
    });
    assert.match(html, /café/);
  });

  it("rejects non-HTML content types", async () => {
    await assert.rejects(
      () =>
        fetchHtml("https://a.test/x.json", {
          fetch: fakeFetch({ headers: { "content-type": "application/json" } }),
        }),
      (e) => e instanceof HttpError && e.code === "NOT_HTML",
    );
  });

  it("allowNonHtml bypasses the content-type gate", async () => {
    const { status } = await fetchHtml("https://a.test/x.json", {
      allowNonHtml: true,
      fetch: fakeFetch({ headers: { "content-type": "application/json" }, body: "{}" }),
    });
    assert.equal(status, 200);
  });

  it("enforces maxBytes", async () => {
    const big = new Uint8Array(100);
    await assert.rejects(
      () => fetchHtml("https://a.test/", { maxBytes: 10, fetch: fakeFetch({ bytes: big }) }),
      (e) => e instanceof HttpError && e.code === "BODY_TOO_LARGE",
    );
  });

  it("sniffs charset from a meta tag", async () => {
    // 0xE9 is é in latin1; declared via meta, decoded accordingly.
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta charset="latin1"><body>caf'),
      0xe9,
      ...new TextEncoder().encode("</body>"),
    ]);
    const { html } = await fetchHtml("https://a.test/", {
      fetch: fakeFetch({ headers: { "content-type": "text/html" }, bytes }),
    });
    assert.match(html, /café/);
  });

  it("round-trips cookies through a jar", async () => {
    const jar = new CookieJar();
    await fetchHtml("https://a.test/", {
      jar,
      fetch: fakeFetch({ getSetCookie: ["sid=xyz; Path=/"] }),
    });
    assert.equal(jar.cookieHeader("https://a.test/"), "sid=xyz");

    await fetchHtml("https://a.test/next", { jar, fetch: fakeFetch({}) });
    assert.equal(fakeFetch.lastInit.headers.cookie, "sid=xyz");
  });
});

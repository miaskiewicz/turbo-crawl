import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchHtml, HttpError } from "../src/net.mjs";

function fakeFetch(spec) {
  return async (url) => {
    const headers = new Headers(spec.headers ?? { "content-type": "text/html" });
    const bytes = spec.bytes ?? new TextEncoder().encode(spec.body ?? "<html></html>");
    return {
      url: spec.finalUrl ?? url,
      status: spec.status ?? 200,
      headers,
      body: (async function* () {
        yield bytes;
      })(),
    };
  };
}

describe("fetchHtml coverage", () => {
  it("rejects up-front when content-length exceeds maxBytes (lines 40-41)", async () => {
    await assert.rejects(
      () =>
        fetchHtml("https://a.test/", {
          maxBytes: 10,
          fetch: fakeFetch({
            headers: { "content-type": "text/html", "content-length": "1000" },
          }),
        }),
      (e) => e instanceof HttpError && e.code === "BODY_TOO_LARGE",
    );
  });

  it("falls back to utf-8 when charset label is unknown (lines 80-81)", async () => {
    const { html } = await fetchHtml("https://a.test/", {
      fetch: fakeFetch({
        headers: { "content-type": "text/html; charset=x-unknown-99" },
        body: "<h1>café</h1>",
      }),
    });
    assert.match(html, /café/);
  });
});

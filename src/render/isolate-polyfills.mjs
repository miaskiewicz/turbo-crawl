// Minimal web globals a bare V8 isolate lacks but turbo-dom's WASM glue needs.
// Evaluated in the isolate BEFORE the bundle (wasm-bindgen builds a TextDecoder at
// module-init). UTF-8 only; enough for wasm-bindgen string marshalling + DOM text.
// Exported as a source string (it runs inside the isolate, not the host).

export const POLYFILLS = `
globalThis.TextEncoder = class {
  encode(s) {
    s = String(s); const u = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) u.push(c);
      else if (c < 0x800) u.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c < 0xdc00) {
        c = 0x10000 + ((c & 0x3ff) << 10) + (s.charCodeAt(++i) & 0x3ff);
        u.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else u.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(u);
  }
  encodeInto(s, arr) { const e = this.encode(s); arr.set(e); return { read: s.length, written: e.length }; }
};
globalThis.TextDecoder = class {
  decode(buf) {
    if (!buf) return "";
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf);
    let r = "";
    for (let i = 0; i < u.length;) {
      const c = u[i++];
      if (c < 0x80) r += String.fromCharCode(c);
      else if (c < 0xe0) r += String.fromCharCode(((c & 0x1f) << 6) | (u[i++] & 0x3f));
      else if (c < 0xf0) r += String.fromCharCode(((c & 0xf) << 12) | ((u[i++] & 0x3f) << 6) | (u[i++] & 0x3f));
      else {
        let cp = ((c & 0x7) << 18) | ((u[i++] & 0x3f) << 12) | ((u[i++] & 0x3f) << 6) | (u[i++] & 0x3f);
        cp -= 0x10000;
        r += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return r;
  }
};
`;

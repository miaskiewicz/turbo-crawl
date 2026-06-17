// Web Storage (localStorage / sessionStorage) for the Playwright façade, held at
// the BrowserContext level so it survives across `page.goto()` calls in the same
// context (auth tokens etc. — turbo-dom's per-render storage would not persist).
//
// `makeStorage()` returns a Proxy so page JS can use BOTH the spec API
// (`getItem`/`setItem`/`length`/`key`) AND property access (`localStorage.foo`),
// the way real apps do — both land in the same backing Map.

class MemStorage {
  #map = new Map();

  get length() {
    return this.#map.size;
  }
  key(i) {
    return [...this.#map.keys()][i] ?? null;
  }
  getItem(k) {
    const key = String(k);
    return this.#map.has(key) ? this.#map.get(key) : null;
  }
  setItem(k, v) {
    this.#map.set(String(k), String(v));
  }
  removeItem(k) {
    this.#map.delete(String(k));
  }
  clear() {
    this.#map.clear();
  }
  // [{name,value}] pairs (storageState dump/seed).
  entries() {
    return [...this.#map.entries()].map(([name, value]) => ({ name, value }));
  }
  load(pairs) {
    for (const { name, value } of pairs ?? []) this.#map.set(name, String(value));
  }
}

// Property reads/writes on the Proxy fall through to the Storage item API for any
// key that isn't a real method/field of the backing store.
const STORAGE_HANDLER = {
  get(target, prop) {
    if (prop in target) return bind(target, prop);
    return target.getItem(prop);
  },
  set(target, prop, value) {
    if (prop in target) target[prop] = value;
    else target.setItem(prop, value);
    return true;
  },
  has(target, prop) {
    return prop in target || target.getItem(prop) !== null;
  },
  deleteProperty(target, prop) {
    target.removeItem(prop);
    return true;
  },
};

function bind(target, prop) {
  const v = target[prop];
  return typeof v === "function" ? v.bind(target) : v;
}

export function makeStorage(pairs) {
  const store = new MemStorage();
  store.load(pairs);
  return new Proxy(store, STORAGE_HANDLER);
}

// The backing MemStorage of a proxy (entries/load live on it, not the proxy face).
export function storageEntries(proxy) {
  return proxy.entries();
}

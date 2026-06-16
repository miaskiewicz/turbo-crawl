// Frontier (SPEC §9): the URL queue with canonicalization + a visited set + a
// per-URL depth. Dedupe is on the canonical form so ?utm_*, fragments, and query
// order never re-fetch the same page.

import { canonicalize } from "./url.mjs";

export class Frontier {
  #queue = []; // { url, canon, depth }
  #visited = new Set(); // canonical URLs ever enqueued
  #head = 0; // ring-ish cursor to avoid O(n) shift on large crawls

  /**
   * Enqueue a URL at `depth` if not seen before. Returns true if newly added.
   */
  add(url, depth = 0) {
    const canon = canonicalize(url);
    if (!canon || this.#visited.has(canon)) return false;
    this.#visited.add(canon);
    this.#queue.push({ url, canon, depth });
    return true;
  }

  /** Re-enqueue a previously-claimed item (bypasses the visited gate). */
  requeue(item) {
    this.#queue.push(item);
  }

  /** Pop the next URL, or undefined when drained. */
  next() {
    if (this.#head >= this.#queue.length) return undefined;
    const item = this.#queue[this.#head++];
    if (this.#head > 1024 && this.#head * 2 > this.#queue.length) {
      this.#queue = this.#queue.slice(this.#head);
      this.#head = 0;
    }
    return item;
  }

  /** True if a canonical URL has ever been enqueued. */
  seen(url) {
    const canon = canonicalize(url);
    return canon ? this.#visited.has(canon) : false;
  }

  get pending() {
    return this.#queue.length - this.#head;
  }

  get size() {
    return this.#visited.size;
  }
}

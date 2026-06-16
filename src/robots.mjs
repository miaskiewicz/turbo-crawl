// robots.txt (SPEC §8): fetch once per host, cache with TTL, allow(url, ua).
// A pragmatic subset of the Robots Exclusion Protocol: User-agent grouping,
// Allow/Disallow with longest-match-wins, `*` and `$` wildcards. Crawl-delay is
// surfaced for the scheduler.

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

// Convert a robots path pattern to a matcher. `*` = any run, `$` = end anchor.
function compile(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") re += ".*";
    else if (ch === "$" && i === pattern.length - 1) re += "$";
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}`);
}

/** Parse robots.txt text into per-agent rule groups. */
export function parseRobots(text) {
  const groups = []; // { agents:Set, rules:[{allow, pattern, len, re}], crawlDelay }
  let current = null;
  let sawRuleSinceAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();

    if (field === "user-agent") {
      if (!current || sawRuleSinceAgent) {
        current = { agents: new Set(), rules: [], crawlDelay: undefined };
        groups.push(current);
        sawRuleSinceAgent = false;
      }
      current.agents.add(value.toLowerCase());
    } else if (current && (field === "allow" || field === "disallow")) {
      sawRuleSinceAgent = true;
      if (field === "disallow" && value === "") continue; // empty Disallow = allow all
      current.rules.push({
        allow: field === "allow",
        pattern: value,
        len: value.length,
        re: compile(value),
      });
    } else if (current && field === "crawl-delay") {
      sawRuleSinceAgent = true;
      const n = Number(value);
      if (!Number.isNaN(n)) current.crawlDelay = n;
    }
  }
  return groups;
}

function pickGroup(groups, ua) {
  const want = ua.toLowerCase();
  let star = null;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a === "*") star = star ?? g;
      else if (want.includes(a)) return g; // token match (e.g. "turbo-crawl")
    }
  }
  return star;
}

/** Decide allow/deny for a path against a parsed group (longest match wins). */
function groupAllows(group, path) {
  if (!group) return true;
  let best = null;
  for (const r of group.rules) {
    if (r.re.test(path) && (!best || r.len > best.len)) best = r;
  }
  return best ? best.allow : true;
}

export class RobotsCache {
  #cache = new Map(); // origin → { groups, fetchedAt }
  #fetchText;
  #ttl;

  /**
   * @param {object} [opts]
   * @param {(url:string)=>Promise<{status:number,text:string}>} [opts.fetchText]
   * @param {number} [opts.ttlMs]
   */
  constructor(opts = {}) {
    this.#fetchText = opts.fetchText ?? defaultFetchText;
    this.#ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async #groupsFor(origin, now) {
    const hit = this.#cache.get(origin);
    if (hit && now - hit.fetchedAt < this.#ttl) return hit.groups;
    let groups = [];
    try {
      const { status, text } = await this.#fetchText(`${origin}/robots.txt`);
      // 4xx → allow all; 5xx/unreachable → conservative allow all (avoid stalling).
      groups = status >= 200 && status < 300 ? parseRobots(text) : [];
    } catch {
      groups = [];
    }
    this.#cache.set(origin, { groups, fetchedAt: now });
    return groups;
  }

  /** @returns {Promise<boolean>} whether `ua` may fetch `url`. */
  async allowed(url, ua = "turbo-crawl", now = Date.now()) {
    const u = new URL(url);
    const groups = await this.#groupsFor(u.origin, now);
    const path = (u.pathname || "/") + (u.search || "");
    return groupAllows(pickGroup(groups, ua), path);
  }

  /** Crawl-delay (seconds) declared for `ua` at this origin, or undefined. */
  async crawlDelay(origin, ua = "turbo-crawl", now = Date.now()) {
    const groups = await this.#groupsFor(origin, now);
    return pickGroup(groups, ua)?.crawlDelay;
  }
}

async function defaultFetchText(url) {
  const res = await fetch(url, { headers: { accept: "text/plain" } });
  return { status: res.status, text: await res.text() };
}

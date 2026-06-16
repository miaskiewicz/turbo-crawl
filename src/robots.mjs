// robots.txt (SPEC §8): fetch once per host, cache with TTL, allow(url, ua).
// A pragmatic subset of the Robots Exclusion Protocol: User-agent grouping,
// Allow/Disallow with longest-match-wins, `*` and `$` wildcards. Crawl-delay is
// surfaced for the scheduler.

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

function isOk(status) {
  return status >= 200 && status < 300;
}

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

function parseLine(raw) {
  const line = raw.replace(/#.*/, "").trim();
  const i = line ? line.indexOf(":") : -1;
  if (i < 0) return null;
  return {
    field: line.slice(0, i).trim().toLowerCase(),
    value: line.slice(i + 1).trim(),
  };
}

function handleUserAgent(state, value) {
  if (!state.current || state.sawRuleSinceAgent) {
    state.current = { agents: new Set(), rules: [], crawlDelay: undefined };
    state.groups.push(state.current);
    state.sawRuleSinceAgent = false;
  }
  state.current.agents.add(value.toLowerCase());
}

function handleRule(state, field, value) {
  state.sawRuleSinceAgent = true;
  if (field === "disallow" && value === "") return; // empty Disallow = allow all
  state.current.rules.push({
    allow: field === "allow",
    pattern: value,
    len: value.length,
    re: compile(value),
  });
}

function handleCrawlDelay(state, value) {
  state.sawRuleSinceAgent = true;
  const n = Number(value);
  if (!Number.isNaN(n)) state.current.crawlDelay = n;
}

// Field handlers that require an open group (ignored before the first
// User-agent line). Keyed by lowercased field name.
const GROUP_FIELDS = {
  allow: (state, value) => handleRule(state, "allow", value),
  disallow: (state, value) => handleRule(state, "disallow", value),
  "crawl-delay": handleCrawlDelay,
};

function applyField(state, field, value) {
  if (field === "user-agent") return handleUserAgent(state, value);
  const handler = GROUP_FIELDS[field];
  if (handler && state.current) handler(state, value);
}

/** Parse robots.txt text into per-agent rule groups. */
export function parseRobots(text) {
  // groups: { agents:Set, rules:[{allow, pattern, len, re}], crawlDelay }
  const state = { groups: [], current: null, sawRuleSinceAgent: false };
  for (const raw of text.split(/\r?\n/)) {
    const parsed = parseLine(raw);
    if (parsed) applyField(state, parsed.field, parsed.value);
  }
  return state.groups;
}

// Does this group's agent list contain a non-`*` token present in `want`?
function groupMatchesUa(group, want) {
  for (const a of group.agents) {
    if (a !== "*" && want.includes(a)) return true; // token match (e.g. "turbo-crawl")
  }
  return false;
}

function pickGroup(groups, ua) {
  const want = ua.toLowerCase();
  let star = null;
  for (const g of groups) {
    if (groupMatchesUa(g, want)) return g;
    if (!star && g.agents.has("*")) star = g;
  }
  return star;
}

// Keep the longer (more specific) matching rule; ties keep the earlier one.
function moreSpecific(best, r) {
  return !best || r.len > best.len ? r : best;
}

/** Decide allow/deny for a path against a parsed group (longest match wins). */
function groupAllows(group, path) {
  if (!group) return true;
  let best = null;
  for (const r of group.rules) {
    if (r.re.test(path)) best = moreSpecific(best, r);
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

  #isFresh(hit, now) {
    return hit && now - hit.fetchedAt < this.#ttl;
  }

  async #fetchGroups(origin) {
    try {
      const { status, text } = await this.#fetchText(`${origin}/robots.txt`);
      // 4xx → allow all; 5xx/unreachable → conservative allow all (avoid stalling).
      return isOk(status) ? parseRobots(text) : [];
    } catch {
      return [];
    }
  }

  async #groupsFor(origin, now) {
    const hit = this.#cache.get(origin);
    if (this.#isFresh(hit, now)) return hit.groups;
    const groups = await this.#fetchGroups(origin);
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

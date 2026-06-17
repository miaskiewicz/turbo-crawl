//! robots.txt (port of `src/robots.mjs`, SPEC §8): parse + per-agent grouping +
//! longest-match Allow/Disallow with `*`/`$` wildcards, plus a TTL cache keyed
//! by origin. The matcher is a hand-rolled glob (no regex dep): patterns anchor
//! at the start, `*` = any run, a trailing `$` = end anchor.

use async_trait::async_trait;
use std::collections::{HashMap, HashSet};

const DEFAULT_TTL_MS: u64 = 60 * 60 * 1000; // 1h

fn is_ok(status: u16) -> bool {
    (200..300).contains(&status)
}

#[derive(Clone, Debug)]
struct Rule {
    allow: bool,
    pattern: String,
    len: usize,
}

#[derive(Clone, Debug, Default)]
struct Group {
    agents: HashSet<String>,
    rules: Vec<Rule>,
    crawl_delay: Option<f64>,
}

// Anchored-at-start glob match. `*` = any run; a trailing `$` = end anchor.
fn pattern_matches(pat: &str, path: &str) -> bool {
    let (core, anchored) = pat.strip_suffix('$').map_or((pat, false), |p| (p, true));
    let parts: Vec<&str> = core.split('*').collect();
    let mut pos = 0usize;
    let last = parts.len() - 1;
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            if !path[pos..].starts_with(part) {
                return false;
            }
            pos += part.len();
            if last == 0 {
                return !anchored || pos == path.len();
            }
        } else if i == last {
            return tail_matches(&path[pos..], part, anchored);
        } else {
            match path[pos..].find(part) {
                Some(idx) => pos += idx + part.len(),
                None => return false,
            }
        }
    }
    true
}

fn tail_matches(rest: &str, part: &str, anchored: bool) -> bool {
    if anchored {
        rest.ends_with(part)
    } else {
        rest.contains(part)
    }
}

struct ParseState {
    groups: Vec<Group>,
    current: Option<usize>,
    saw_rule_since_agent: bool,
}

fn strip_comment(raw: &str) -> &str {
    raw.split('#').next().unwrap_or("").trim()
}

fn parse_line(raw: &str) -> Option<(String, String)> {
    let line = strip_comment(raw);
    let i = line.find(':')?;
    Some((
        line[..i].trim().to_ascii_lowercase(),
        line[i + 1..].trim().to_string(),
    ))
}

fn handle_user_agent(state: &mut ParseState, value: &str) {
    let need_new = state.current.is_none() || state.saw_rule_since_agent;
    if need_new {
        state.groups.push(Group::default());
        state.current = Some(state.groups.len() - 1);
        state.saw_rule_since_agent = false;
    }
    let idx = state.current.unwrap();
    state.groups[idx].agents.insert(value.to_ascii_lowercase());
}

fn handle_rule(state: &mut ParseState, allow: bool, value: &str) {
    state.saw_rule_since_agent = true;
    if !allow && value.is_empty() {
        return; // empty Disallow = allow all
    }
    if let Some(idx) = state.current {
        state.groups[idx].rules.push(Rule {
            allow,
            pattern: value.to_string(),
            len: value.len(),
        });
    }
}

fn handle_crawl_delay(state: &mut ParseState, value: &str) {
    state.saw_rule_since_agent = true;
    if let (Some(idx), Ok(n)) = (state.current, value.parse::<f64>()) {
        state.groups[idx].crawl_delay = Some(n);
    }
}

fn apply_field(state: &mut ParseState, field: &str, value: &str) {
    match field {
        "user-agent" => handle_user_agent(state, value),
        "allow" => handle_rule(state, true, value),
        "disallow" => handle_rule(state, false, value),
        "crawl-delay" => handle_crawl_delay(state, value),
        _ => {}
    }
}

fn parse_robots(text: &str) -> Vec<Group> {
    let mut state = ParseState {
        groups: Vec::new(),
        current: None,
        saw_rule_since_agent: false,
    };
    for raw in text.split('\n') {
        if let Some((field, value)) = parse_line(raw) {
            apply_field(&mut state, field.as_str(), value.as_str());
        }
    }
    state.groups
}

fn group_matches_ua(group: &Group, want: &str) -> bool {
    group
        .agents
        .iter()
        .any(|a| a != "*" && want.contains(a.as_str()))
}

fn pick_group<'a>(groups: &'a [Group], ua: &str) -> Option<&'a Group> {
    let want = ua.to_ascii_lowercase();
    let mut star = None;
    for g in groups {
        if group_matches_ua(g, &want) {
            return Some(g);
        }
        if star.is_none() && g.agents.contains("*") {
            star = Some(g);
        }
    }
    star
}

// Longest matching rule wins; ties keep the earlier rule.
fn group_allows(group: Option<&Group>, path: &str) -> bool {
    let Some(group) = group else {
        return true;
    };
    let mut best: Option<&Rule> = None;
    for r in &group.rules {
        if pattern_matches(&r.pattern, path) && best.is_none_or(|b| r.len > b.len) {
            best = Some(r);
        }
    }
    best.is_none_or(|r| r.allow)
}

/// Injected fetcher for robots.txt — mirrors the JS `opts.fetchText` seam so the
/// cache stays offline-testable.
#[async_trait]
pub trait RobotsFetcher {
    async fn fetch_text(&self, url: &str) -> Result<(u16, String), ()>;
}

struct Cached {
    groups: Vec<Group>,
    fetched_at: u64,
}

pub struct RobotsCache<F: RobotsFetcher> {
    cache: HashMap<String, Cached>,
    fetcher: F,
    ttl: u64,
}

impl<F: RobotsFetcher> RobotsCache<F> {
    pub fn new(fetcher: F) -> Self {
        Self::with_ttl(fetcher, DEFAULT_TTL_MS)
    }

    pub fn with_ttl(fetcher: F, ttl_ms: u64) -> Self {
        Self {
            cache: HashMap::new(),
            fetcher,
            ttl: ttl_ms,
        }
    }

    fn is_fresh(&self, origin: &str, now: u64) -> bool {
        self.cache
            .get(origin)
            .is_some_and(|h| now - h.fetched_at < self.ttl)
    }

    async fn fetch_groups(&self, origin: &str) -> Vec<Group> {
        match self
            .fetcher
            .fetch_text(&format!("{origin}/robots.txt"))
            .await
        {
            // 4xx → allow all; 5xx/unreachable → conservative allow all.
            Ok((status, text)) if is_ok(status) => parse_robots(&text),
            _ => Vec::new(),
        }
    }

    async fn groups_for(&mut self, origin: &str, now: u64) -> &Vec<Group> {
        if !self.is_fresh(origin, now) {
            let groups = self.fetch_groups(origin).await;
            self.cache.insert(
                origin.to_string(),
                Cached {
                    groups,
                    fetched_at: now,
                },
            );
        }
        &self.cache.get(origin).unwrap().groups
    }

    /// Whether `ua` may fetch `url` at time `now` (epoch ms).
    pub async fn allowed(&mut self, url: &str, ua: &str, now: u64) -> bool {
        let Ok(u) = url::Url::parse(url) else {
            return true;
        };
        let origin = u.origin().ascii_serialization();
        let path = format!(
            "{}{}",
            u.path(),
            u.query().map_or(String::new(), |q| format!("?{q}"))
        );
        let groups = self.groups_for(&origin, now).await;
        group_allows(pick_group(groups, ua), &path)
    }

    /// Crawl-delay (seconds) declared for `ua` at this origin, or `None`.
    pub async fn crawl_delay(&mut self, origin: &str, ua: &str, now: u64) -> Option<f64> {
        let groups = self.groups_for(origin, now).await;
        pick_group(groups, ua).and_then(|g| g.crawl_delay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_wildcards_and_anchor() {
        assert!(pattern_matches("/a/", "/a/b"));
        assert!(!pattern_matches("/a/", "/b"));
        assert!(pattern_matches("/*.php", "/x/y.php"));
        assert!(pattern_matches("/x$", "/x"));
        assert!(!pattern_matches("/x$", "/xy"));
        assert!(pattern_matches("/p/*/q$", "/p/a/q"));
        assert!(!pattern_matches("/p/*/q$", "/p/a/q/r"));
    }

    #[test]
    fn longest_match_wins() {
        let groups = parse_robots("User-agent: *\nDisallow: /a\nAllow: /a/b\nCrawl-delay: 2\n");
        let g = pick_group(&groups, "turbo-crawl");
        assert!(!group_allows(g, "/a/x"));
        assert!(group_allows(g, "/a/b/c"));
        assert_eq!(g.unwrap().crawl_delay, Some(2.0));
    }

    #[test]
    fn specific_agent_beats_star() {
        let groups =
            parse_robots("User-agent: *\nDisallow: /\n\nUser-agent: turbo-crawl\nAllow: /\n");
        let g = pick_group(&groups, "turbo-crawl");
        assert!(group_allows(g, "/anything"));
    }

    struct StubFetcher(u16, String);
    #[async_trait]
    impl RobotsFetcher for StubFetcher {
        async fn fetch_text(&self, _url: &str) -> Result<(u16, String), ()> {
            Ok((self.0, self.1.clone()))
        }
    }

    #[tokio::test]
    async fn cache_allows_and_crawl_delay() {
        let mut c = RobotsCache::new(StubFetcher(
            200,
            "User-agent: *\nDisallow: /private\nCrawl-delay: 5\n".to_string(),
        ));
        assert!(
            !c.allowed("https://x.test/private/p", "turbo-crawl", 0)
                .await
        );
        assert!(c.allowed("https://x.test/public", "turbo-crawl", 0).await);
        assert_eq!(
            c.crawl_delay("https://x.test", "turbo-crawl", 0).await,
            Some(5.0)
        );
    }

    #[tokio::test]
    async fn non_2xx_allows_all() {
        let mut c = RobotsCache::new(StubFetcher(404, String::new()));
        assert!(c.allowed("https://x.test/anything", "turbo-crawl", 0).await);
    }
}

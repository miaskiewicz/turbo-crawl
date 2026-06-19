//! Frontier (port of `src/frontier.mjs`, SPEC §9): URL queue with canonical
//! dedupe, a visited set, and per-URL depth. A ring cursor avoids O(n) shifts.

use crate::url::canonicalize;
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub url: String,
    pub canon: String,
    pub depth: usize,
}

#[derive(Default)]
pub struct Frontier {
    queue: Vec<Item>,
    visited: HashSet<String>,
    head: usize,
}

impl Frontier {
    pub fn new() -> Self {
        Self::default()
    }

    /// Enqueue `url` at `depth` if its canonical form was never seen. Returns
    /// true if newly added.
    pub fn add(&mut self, url: &str, depth: usize) -> bool {
        let Some(canon) = canonicalize(url) else {
            return false;
        };
        if self.visited.contains(&canon) {
            return false;
        }
        self.visited.insert(canon.clone());
        self.queue.push(Item {
            url: url.to_string(),
            canon,
            depth,
        });
        true
    }

    /// Re-enqueue a previously-claimed item (bypasses the visited gate).
    pub fn requeue(&mut self, item: Item) {
        self.queue.push(item);
    }

    /// Pop the next item, or `None` when drained. Compacts the backing vec once
    /// the consumed prefix dominates, mirroring the JS ring cursor. Named `next`
    /// to match the JS `Frontier.next()`; it is not an `Iterator`.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Option<Item> {
        if self.head >= self.queue.len() {
            return None;
        }
        let item = self.queue[self.head].clone();
        self.head += 1;
        if self.head > 1024 && self.head * 2 > self.queue.len() {
            self.queue.drain(0..self.head);
            self.head = 0;
        }
        Some(item)
    }

    /// True if a canonical URL has ever been enqueued.
    pub fn seen(&self, url: &str) -> bool {
        canonicalize(url).is_some_and(|c| self.visited.contains(&c))
    }

    pub fn pending(&self) -> usize {
        self.queue.len() - self.head
    }

    pub fn size(&self) -> usize {
        self.visited.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupes_on_canonical_form() {
        let mut f = Frontier::new();
        assert!(f.add("https://x.test/p?a=1#h", 0));
        // same canonical form (fragment + tracking differ) → rejected
        assert!(!f.add("https://x.test/p?a=1&utm_source=g", 0));
        assert_eq!(f.pending(), 1);
        assert_eq!(f.size(), 1);
    }

    #[test]
    fn fifo_and_requeue() {
        let mut f = Frontier::new();
        f.add("https://x.test/a", 0);
        f.add("https://x.test/b", 1);
        let a = f.next().unwrap();
        assert_eq!(a.url, "https://x.test/a");
        f.requeue(a);
        let b = f.next().unwrap();
        assert_eq!(b.url, "https://x.test/b");
        assert_eq!(f.next().unwrap().url, "https://x.test/a");
        assert!(f.next().is_none());
    }

    #[test]
    fn seen_uses_canonical() {
        let mut f = Frontier::new();
        f.add("https://x.test/p", 0);
        assert!(f.seen("https://x.test/p#frag"));
        assert!(!f.seen("https://x.test/other"));
        assert!(!f.seen("not a url")); // uncanonicalizable → not seen
    }

    #[test]
    fn add_rejects_uncanonicalizable() {
        let mut f = Frontier::new();
        assert!(!f.add("", 0)); // empty → not canonicalizable
        assert!(!f.add("http://", 0)); // no host → parse error
    }

    #[test]
    fn ring_cursor_compacts_after_1024() {
        let mut f = Frontier::new();
        for i in 0..2100 {
            f.add(&format!("https://x.test/p{i}"), 0);
        }
        // Drain past the compaction threshold (head > 1024 && head*2 > len).
        for _ in 0..1100 {
            assert!(f.next().is_some());
        }
        // Still consistent after the internal drain/compaction.
        assert_eq!(f.pending(), 1000);
        assert_eq!(f.size(), 2100);
        assert!(f.next().is_some());
    }
}

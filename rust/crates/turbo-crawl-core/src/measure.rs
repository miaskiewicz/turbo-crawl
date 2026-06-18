//! Timing-sample summary (port of `src/measure.mjs` `summarize`): min/max/mean/
//! median/p95/ops-per-sec over millisecond samples. Pure + deterministic.

#[derive(Debug, Clone, PartialEq)]
pub struct Stats {
    pub n: usize,
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub median: f64,
    pub p95: f64,
    pub ops_per_sec: f64,
}

// Nearest-rank percentile of a pre-sorted, non-empty slice.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    let idx = ((p / 100.0) * sorted.len() as f64).floor() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

/// Summarize millisecond `samples`. Empty input → all-zero stats.
pub fn summarize(samples: &[f64]) -> Stats {
    if samples.is_empty() {
        return Stats {
            n: 0,
            min: 0.0,
            max: 0.0,
            mean: 0.0,
            median: 0.0,
            p95: 0.0,
            ops_per_sec: 0.0,
        };
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mean = sorted.iter().sum::<f64>() / sorted.len() as f64;
    Stats {
        n: sorted.len(),
        min: sorted[0],
        max: sorted[sorted.len() - 1],
        mean,
        median: percentile(&sorted, 50.0),
        p95: percentile(&sorted, 95.0),
        ops_per_sec: if mean > 0.0 { 1000.0 / mean } else { 0.0 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_is_zero() {
        assert_eq!(summarize(&[]).n, 0);
        assert_eq!(summarize(&[]).ops_per_sec, 0.0);
    }

    #[test]
    fn summary_stats() {
        let s = summarize(&[10.0, 20.0, 30.0, 40.0, 50.0]);
        assert_eq!(s.n, 5);
        assert_eq!(s.min, 10.0);
        assert_eq!(s.max, 50.0);
        assert_eq!(s.mean, 30.0);
        assert_eq!(s.median, 30.0); // nearest-rank: idx floor(0.5*5)=2 → 30
        assert_eq!(s.p95, 50.0); // idx floor(0.95*5)=4 → 50
        assert!((s.ops_per_sec - 1000.0 / 30.0).abs() < 1e-9);
    }

    #[test]
    fn unsorted_input_is_sorted() {
        let s = summarize(&[50.0, 10.0, 30.0]);
        assert_eq!(s.min, 10.0);
        assert_eq!(s.max, 50.0);
    }
}

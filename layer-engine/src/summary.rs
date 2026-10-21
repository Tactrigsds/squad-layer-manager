//! Aggregates over the rows that pass a filter, for describing a result set rather than paging through it.
//!
//! Each one walks blocks rather than rows. A block the filter keeps whole is answered from what the block or its
//! pattern already holds, and only a block the filter splits is read row by row. Pool filters are mostly made of a
//! layer's own columns, so most blocks come out whole.

use crate::ir::Hits;
use crate::store::{ColData, Store};
use crate::IntMap;

/// Counts into an array indexed by enum code, remembering the order codes were first met in.
struct Tally {
    counts: Vec<u32>,
    order: Vec<u32>,
}

impl Tally {
    fn new(slots: usize) -> Self {
        Tally { counts: vec![0; slots], order: Vec::new() }
    }

    #[inline]
    fn add(&mut self, code: usize, n: u32) {
        if self.counts[code] == 0 {
            self.order.push(code as u32);
        }
        self.counts[code] += n;
    }
}

/// Per column, each value among the matching rows with how many rows hold it, in the order values are first met.
pub fn value_counts(store: &Store, hits: &Hits, cols: &[usize]) -> Vec<Vec<(Option<i64>, u32)>> {
    let block_hits: Vec<u32> = (0..store.block_count())
        .map(|b| {
            let (start, end) = store.block_rows(b);
            hits.count_in(start, end) as u32
        })
        .collect();

    cols.iter()
        .map(|col| match store.col_data(*col) {
            ColData::PerBlock(values) => {
                let mut tally = Tally::new(values.slots());
                for (b, n) in block_hits.iter().enumerate() {
                    if *n > 0 {
                        tally.add(values.code(b), *n);
                    }
                }
                tally.order.iter().map(|c| (values.decode(*c as usize), tally.counts[*c as usize])).collect()
            }
            ColData::PerPattern(values) => {
                let per_pattern = store.pattern_counts(*col).expect("a per-pattern column has pattern counts");
                let mut tally = Tally::new(values.slots());
                for (b, n) in block_hits.iter().enumerate() {
                    if *n == 0 {
                        continue;
                    }
                    let (start, end) = store.block_rows(b);
                    let pattern = store.block_pattern(b);
                    if *n as usize == end - start {
                        let (codes, counts) = per_pattern.of(pattern);
                        for (code, count) in codes.iter().zip(counts) {
                            tally.add(*code as usize, *count);
                        }
                    } else {
                        let p_start = store.pattern_rows(pattern).0;
                        for row in hits.rows_in(start, end) {
                            tally.add(values.code(p_start + row - start), 1);
                        }
                    }
                }
                tally.order.iter().map(|c| (values.decode(*c as usize), tally.counts[*c as usize])).collect()
            }
            ColData::PerRow => {
                let reader = store.reader(*col);
                let mut order: Vec<Option<i64>> = Vec::new();
                let mut counts: IntMap<Option<i64>, u32> = IntMap::default();
                for (b, n) in block_hits.iter().enumerate() {
                    if *n == 0 {
                        continue;
                    }
                    let (start, end) = store.block_rows(b);
                    let p_start = store.pattern_rows(store.block_pattern(b)).0;
                    for row in hits.rows_in(start, end) {
                        let v = reader.read(b, p_start + row - start, row);
                        let count = counts.entry(v).or_insert(0);
                        if *count == 0 {
                            order.push(v);
                        }
                        *count += 1;
                    }
                }
                order.into_iter().map(|v| (v, counts[&v])).collect()
            }
        })
        .collect()
}

/// Per column, the min/max among the matching rows, or None when every one of them is null.
pub fn ranges(store: &Store, hits: &Hits, cols: &[usize]) -> Vec<Option<(i64, i64)>> {
    let readers: Vec<_> = cols.iter().map(|c| store.reader(*c)).collect();
    let mut out: Vec<Option<(i64, i64)>> = vec![None; cols.len()];
    let merge = |acc: &mut Option<(i64, i64)>, (lo, hi): (i64, i64)| {
        *acc = Some(acc.map_or((lo, hi), |(a, b)| (a.min(lo), b.max(hi))));
    };
    for b in 0..store.block_count() {
        let (start, end) = store.block_rows(b);
        let n = hits.count_in(start, end);
        if n == 0 {
            continue;
        }
        if n == end - start {
            for (i, reader) in readers.iter().enumerate() {
                if let Some(range) = store.block_range(cols[i], reader, b) {
                    merge(&mut out[i], range);
                }
            }
            continue;
        }
        let p_start = store.pattern_rows(store.block_pattern(b)).0;
        for row in hits.rows_in(start, end) {
            let p = p_start + row - start;
            for (i, reader) in readers.iter().enumerate() {
                if let Some(v) = reader.read(b, p, row) {
                    merge(&mut out[i], (v, v));
                }
            }
        }
    }
    out
}

/// How many matching rows each filter also matches.
pub fn match_counts(hits: &Hits, filters: &[&Hits]) -> Vec<u32> {
    filters
        .iter()
        .map(|f| hits.bits.iter().zip(&f.bits).map(|(h, f)| (h & f).count_ones()).sum())
        .collect()
}

/// Per conjunct, how many rows pass every other conjunct and fail this one: the rows that conjunct alone removes.
/// One pass over the words, with prefix and suffix intersections standing in for the n-1 others.
pub fn removed_counts(all: &[u64], conjuncts: &[&Hits]) -> Vec<u32> {
    let n = conjuncts.len();
    let mut removed = vec![0u32; n];
    let mut prefix = vec![0u64; n + 1];
    for (w, all_w) in all.iter().enumerate() {
        prefix[0] = *all_w;
        for i in 0..n {
            prefix[i + 1] = prefix[i] & conjuncts[i].bits[w];
        }
        let mut suffix = *all_w;
        for i in (0..n).rev() {
            let own = conjuncts[i].bits[w];
            removed[i] += (prefix[i] & suffix & !own).count_ones();
            suffix &= own;
        }
    }
    removed
}

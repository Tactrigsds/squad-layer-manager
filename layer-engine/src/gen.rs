//! Weighted layer generation.
//!
//! Generation walks a pick order: each step groups the candidates by something (a column, or a matchup between the two
//! teams) and picks one group weighted-randomly, narrowing the pool for the next step. The group universe is the one
//! that actually exists in the pool, not a sample of it, so a weight means what it says however rare the group is.
//!
//! The group tree is expanded lazily: only a prefix that actually gets drawn pays for its histogram. Capacity is
//! tracked as picks are taken (a group can't serve more picks than it holds layers), and an exhausted group drops out
//! of its parent, which is what keeps a page's layers distinct and what makes the weights renormalize the way the old
//! sampled algorithm's "filtered" set did.

use crate::ir::Tri;
use crate::store::{Col, Store};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WeightEntry {
    /// the packed group key, produced by the same packing the host uses (see LC.packStepKey)
    pub key: i64,
    pub weight: f64,
}

/// One pick step. A column step has only side 1; a matchup step has both, and its key is order-independent so a layer
/// and its team-swapped counterpart land in the same group.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StepSpec {
    pub cols1: Vec<usize>,
    pub radices1: Vec<i64>,
    pub cols2: Option<Vec<usize>>,
    pub radices2: Option<Vec<i64>>,
    pub weights: Vec<WeightEntry>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GenSpec {
    pub steps: Vec<StepSpec>,
    pub default_weight: f64,
    pub seed: u64,
    pub num_layers: usize,
}

impl StepSpec {
    fn side_key(&self, store: &Store, cols: &[usize], radices: &[i64], row: usize) -> i64 {
        let mut key = 0i64;
        for (i, col) in cols.iter().enumerate() {
            let v = store.value(store.col(*col), row).unwrap_or(-1);
            key = key * radices[i] + v + 1;
        }
        key
    }

    fn key_of(&self, store: &Store, row: usize) -> i64 {
        let side1 = self.side_key(store, &self.cols1, &self.radices1, row);
        match (&self.cols2, &self.radices2) {
            (Some(cols2), Some(radices2)) => {
                let side2 = self.side_key(store, cols2, radices2, row);
                let side_radix: i64 = radices2.iter().product();
                let (lo, hi) = if side1 <= side2 { (side1, side2) } else { (side2, side1) };
                lo * side_radix + hi
            }
            _ => side1,
        }
    }

    fn weight_map(&self) -> HashMap<i64, f64> {
        self.weights.iter().map(|w| (w.key, w.weight)).collect()
    }
}

/// splitmix64: small, deterministic, and identical on both hosts, which is all generation needs of an RNG.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed ^ 0x9e3779b97f4a7c15)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            return 0;
        }
        (self.next_u64() % n as u64) as usize
    }
}

struct Node {
    /// candidate rows under this node. Moved into the children when the node is expanded, so only leaves keep them.
    rows: Vec<u32>,
    children: Option<Children>,
}

struct Children {
    entries: Vec<(i64, Node)>,
    /// indices into `entries`, split by whether the admin configured a weight for the group
    listed: Vec<usize>,
    unlisted: Vec<usize>,
    weights: Vec<f64>,
}

impl Node {
    fn leaf(rows: Vec<u32>) -> Self {
        Node { rows, children: None }
    }

    fn expand(&mut self, store: &Store, step: &StepSpec, default_weight: f64) {
        let mut by_key: HashMap<i64, Vec<u32>> = HashMap::new();
        for row in self.rows.drain(..) {
            by_key.entry(step.key_of(store, row as usize)).or_default().push(row);
        }
        let weights = step.weight_map();
        let mut entries: Vec<(i64, Node)> = Vec::with_capacity(by_key.len());
        let mut listed = Vec::new();
        let mut unlisted = Vec::new();
        let mut weight_vec = Vec::with_capacity(by_key.len());
        // sorted so a given pool and seed always produce the same draw, whatever the hash map's iteration order
        let mut keys: Vec<i64> = by_key.keys().copied().collect();
        keys.sort_unstable();
        for key in keys {
            let rows = by_key.remove(&key).unwrap();
            let idx = entries.len();
            match weights.get(&key) {
                Some(w) => {
                    listed.push(idx);
                    weight_vec.push(*w);
                }
                None => {
                    unlisted.push(idx);
                    weight_vec.push(default_weight);
                }
            }
            entries.push((key, Node::leaf(rows)));
        }
        self.children = Some(Children { entries, listed, unlisted, weights: weight_vec });
    }
}

impl Children {
    /// Picks a group. Unlisted groups all weigh the same, so they collapse into one bucket of mass
    /// `default * count`: the draw is over (configured groups + 1) options no matter how many groups the pool holds.
    fn draw(&self, rng: &mut Rng, default_weight: f64) -> Option<usize> {
        let listed_mass: f64 = self.listed.iter().map(|i| self.weights[*i]).sum();
        let unlisted_mass = default_weight * self.unlisted.len() as f64;
        let total = listed_mass + unlisted_mass;
        if total <= 0.0 {
            return None;
        }
        let mut r = rng.next_f64() * total;
        for i in &self.listed {
            r -= self.weights[*i];
            if r < 0.0 {
                return Some(*i);
            }
        }
        if self.unlisted.is_empty() {
            // rounding can land past the last listed group; fall back to the heaviest one we have
            return self.listed.iter().copied().max_by(|a, b| self.weights[*a].total_cmp(&self.weights[*b]));
        }
        Some(self.unlisted[rng.below(self.unlisted.len())])
    }

    fn remove(&mut self, idx: usize) {
        // entries keep their positions (indices are referenced by listed/unlisted), so an exhausted group is dropped
        // by removing it from whichever bucket holds it and giving it zero mass
        self.listed.retain(|i| *i != idx);
        self.unlisted.retain(|i| *i != idx);
        self.weights[idx] = 0.0;
    }

    fn is_empty(&self) -> bool {
        self.listed.is_empty() && self.unlisted.is_empty()
    }
}

/// Takes one layer, walking the pick order from `node`. Returns the row, and whether the node is now exhausted.
fn take(
    store: &Store,
    node: &mut Node,
    steps: &[StepSpec],
    depth: usize,
    default_weight: f64,
    rng: &mut Rng,
) -> (Option<u32>, bool) {
    if depth == steps.len() {
        if node.rows.is_empty() {
            return (None, true);
        }
        let idx = rng.below(node.rows.len());
        let row = node.rows.swap_remove(idx);
        return (Some(row), node.rows.is_empty());
    }

    if node.children.is_none() {
        node.expand(store, &steps[depth], default_weight);
    }
    let children = node.children.as_mut().unwrap();
    let Some(idx) = children.draw(rng, default_weight) else {
        return (None, true);
    };
    let (row, exhausted) = take(store, &mut children.entries[idx].1, steps, depth + 1, default_weight, rng);
    if exhausted {
        children.remove(idx);
    }
    let empty = children.is_empty();
    (row, empty)
}

/// Generates `num_layers` distinct layers from the rows that passed the filter.
pub fn generate(store: &Store, matched: &Tri, spec: &GenSpec, exclude: &[u32]) -> Vec<u32> {
    let mut rows: Vec<u32> = matched.rows().map(|r| r as u32).collect();
    if !exclude.is_empty() {
        let excluded: std::collections::HashSet<u32> = exclude.iter().copied().collect();
        rows.retain(|r| !excluded.contains(r));
    }
    let mut rng = Rng::new(spec.seed);

    // nothing to weight: a uniform draw over the pool, which is what generation does when no pick order is configured
    if spec.steps.is_empty() {
        let mut picked = Vec::with_capacity(spec.num_layers.min(rows.len()));
        for _ in 0..spec.num_layers.min(rows.len()) {
            let idx = rng.below(rows.len());
            picked.push(rows.swap_remove(idx));
        }
        return picked;
    }

    let mut root = Node::leaf(rows);
    let mut picked = Vec::with_capacity(spec.num_layers);
    for _ in 0..spec.num_layers {
        let (row, exhausted) = take(store, &mut root, &spec.steps, 0, spec.default_weight, &mut rng);
        match row {
            Some(r) => picked.push(r),
            None => break,
        }
        if exhausted {
            break;
        }
    }
    picked
}

/// Distinct group counts for one step over the rows that passed the filter. Used by the settings editor to show what
/// share a weight actually buys, which is only meaningful against the real group universe.
pub fn group_counts(store: &Store, matched: &Tri, step: &StepSpec) -> HashMap<i64, u32> {
    let mut counts: HashMap<i64, u32> = HashMap::new();
    for row in matched.rows() {
        *counts.entry(step.key_of(store, row)).or_insert(0) += 1;
    }
    counts
}

/// min/max of a column over the rows that passed the filter, for the score-range sliders.
pub fn range(store: &Store, col: usize) -> Option<(i64, i64)> {
    let c = store.col(col);
    let mut min = i64::MAX;
    let mut max = i64::MIN;
    let mut any = false;
    for row in 0..store.row_count() {
        if let Some(v) = store.value(c, row) {
            any = true;
            min = min.min(v);
            max = max.max(v);
        }
    }
    if any {
        Some((min, max))
    } else {
        None
    }
}

#[allow(dead_code)]
fn unused(_: Col<'_>) {}

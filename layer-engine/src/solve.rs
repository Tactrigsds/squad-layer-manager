//! Rearranging a queue to clear repeat-rule violations.
//!
//! The host hands over the queue, the recent history that the rules look back into, and each layer's rule values
//! already interned to integers, so this module knows nothing about what a faction or a map is. It searches over
//! orderings of the queue and a team swap per item, and returns the arrangement with the fewest violations, breaking
//! ties by the smallest edit: `swap_cost` per swapped item plus `move_cost` per pair of items whose relative order
//! changed (the Kendall tau distance, which is also the number of adjacent exchanges the reorder takes).
//!
//! Orientation: a layer's two team slots are its team 1 and team 2. Which slot is normalized team A at queue position
//! `k` is `(parity(k) + swapped) % 2`, so moving an item by an odd number of places flips its teams just as swapping
//! does. Rules compare values across normalized teams, which is why the search treats position and swap together.
//!
//! The search is a depth-first branch and bound over positions, filling the queue front to back. Costs only grow as
//! items are placed, so a prefix that already costs at least the best complete arrangement is cut. Candidates are
//! tried cheapest first, which makes the first leaf a greedy solution and keeps the bound tight. A transposition
//! table records, per (set of placed items, the last `max within` placements), the cheapest prefix that has been fully
//! explored: what remains after that state depends on nothing else, so a dearer prefix reaching it again is cut.
//!
//! When some violations can't be avoided, cost alone never cuts a prefix early, so the violations still to come are
//! bounded from below by pigeonhole. Under a rule that compares one value for the whole layer (a map, say) with
//! `within` w, the unplaced items sharing a value can only avoid each other if they sit more than w apart, and only
//! ceil(slots / (w + 1)) of them fit that way in what is left of the queue. Every one beyond that breaks the rule.
//!
//! Once no more violations are affordable, edits are bounded too. Leaving the unplaced items in their original order
//! unswapped costs nothing more, and each repeat in that continuation persists unless an edit touches one of its two
//! items: a swap of either, or an inversion with either as a member. A repeat that holds whatever the orientations (a
//! shared map, say) also survives swaps. At distance d under `within` w it needs w + 1 - d items to cross one of its
//! ends, or d crossings for the two to trade places. Over repeats with no item in common these needs add up, and an
//! inversion, which touches two items, pays toward at most two of them. A greedy matching picks those repeats.

use crate::{IntHasher, IntMap};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::BuildHasherDefault;

/// Interned value meaning "this rule has nothing to compare here": the slot is empty, or targetValues excludes it.
pub const NO_VALUE: i32 = -1;
const MAX_RULES: usize = 64;
const MAX_QUEUE: usize = 128;
const DEFAULT_MAX_NODES: u64 = 2_000_000;
const MAX_MEMO_ENTRIES: usize = 1 << 17;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuleSpec {
    pub within: u32,
    /// compares per normalized team; otherwise only slot 0 of a layer's values is read
    pub team: bool,
    pub cross_team: bool,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QueueItemSpec {
    /// the layer the rules look back at when this item is earlier in the list (a vote's current choice)
    pub source: usize,
    /// the layers checked against what came before (a vote's choices). Empty for an item exempt from the rules.
    pub targets: Vec<usize>,
    pub swappable: bool,
    /// stays at its own position and keeps its teams
    pub pinned: bool,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SolveSpec {
    pub rules: Vec<RuleSpec>,
    /// per layer, per rule: the interned values in team slots 1 and 2
    pub layers: Vec<Vec<[i32; 2]>>,
    /// layers already played, oldest first, ending right before the queue
    pub history: Vec<usize>,
    pub queue: Vec<QueueItemSpec>,
    /// team parity of history[0], or of queue[0] when there is no history
    pub first_parity: u32,
    pub swap_cost: u32,
    pub move_cost: u32,
    pub max_nodes: Option<u64>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SolveStatus {
    Optimal,
    /// the node budget ran out; the arrangement is the best found, and no worse than the queue as it was
    BudgetExhausted,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SolveResponse {
    pub status: SolveStatus,
    /// original queue indices in their new order
    pub order: Vec<usize>,
    /// per original queue index
    pub swapped: Vec<bool>,
    pub violations: u32,
    pub baseline_violations: u32,
    pub swaps: u32,
    pub moves: u32,
    pub nodes: u64,
}

/// (violations, edit cost), compared lexicographically
type Cost = (u32, u32);

/// The queue items that repeat each other under one whole-layer rule, because they share its value.
struct Class {
    within: usize,
    members: u128,
}

#[derive(Clone, Copy)]
struct Cand {
    item: u8,
    swap: bool,
    cost: Cost,
}

struct Solver<'a> {
    spec: &'a SolveSpec,
    n: usize,
    h: usize,
    max_within: usize,
    /// rules whose `within` reaches a distance, indexed by distance
    within_mask: Vec<u64>,
    /// [src entity][src orient][target item][target orient] -> rules matched. Entities are history then queue.
    pair: Vec<u64>,
    /// [src entity][target item] -> rules matched in every orientation of the two
    fixed_pair: Vec<u64>,
    pinned_at: Vec<Option<u8>>,
    classes: Vec<Class>,
    /// [entity * rules + rule] -> the class its source value falls in, or NO_CLASS
    class_of: Vec<u32>,

    // search state
    placed: u128,
    order: Vec<(u8, bool)>,
    cost: Cost,
    baseline: u32,
    best: Cost,
    best_order: Vec<(u8, bool)>,
    nodes: u64,
    max_nodes: u64,
    exhausted: bool,
    cands: Vec<Vec<Cand>>,
    memo: HashMap<Box<[u8]>, Cost, BuildHasherDefault<IntHasher>>,
    key_buf: Vec<u8>,
    /// per class, the first position a member can take without breaking the rule; valid where the stamp is current
    class_start: Vec<(u64, usize)>,
    stamp: u64,
}

const NO_CLASS: u32 = u32::MAX;

pub fn solve(spec: &SolveSpec) -> Result<SolveResponse, String> {
    if spec.rules.len() > MAX_RULES {
        return Err(format!("at most {MAX_RULES} repeat rules"));
    }
    if spec.queue.len() > MAX_QUEUE {
        return Err(format!("at most {MAX_QUEUE} queue items"));
    }
    let layer_ok = |l: usize| spec.layers.get(l).is_some_and(|v| v.len() == spec.rules.len());
    let refs_ok = spec.history.iter().all(|&l| layer_ok(l))
        && spec.queue.iter().all(|q| layer_ok(q.source) && q.targets.iter().all(|&l| layer_ok(l)));
    if !refs_ok {
        return Err("layer reference out of range, or wrong number of rule values".into());
    }
    let mut solver = Solver::new(spec);
    solver.run();
    Ok(solver.response())
}

impl<'a> Solver<'a> {
    fn new(spec: &'a SolveSpec) -> Self {
        let n = spec.queue.len();
        let max_within = spec.rules.iter().map(|r| r.within as usize).max().unwrap_or(0);
        // history further back than any rule reaches can't matter
        let h_start = spec.history.len().saturating_sub(max_within);
        let h = spec.history.len() - h_start;

        let mut within_mask = vec![0u64; max_within + 1];
        for (d, mask) in within_mask.iter_mut().enumerate().skip(1) {
            for (r, rule) in spec.rules.iter().enumerate() {
                if rule.within as usize >= d {
                    *mask |= 1 << r;
                }
            }
        }

        let entities = h + n;
        let mut pair = vec![0u64; entities * 2 * n * 2];
        let mut fixed_pair = vec![!0u64; entities * n];
        for e in 0..entities {
            let (src, src_orients): (usize, &[u32]) = if e < h {
                // a played match keeps its teams: its orientation is its parity
                let parity = (spec.first_parity + h_start as u32 + e as u32) % 2;
                (spec.history[h_start + e], [&[0], &[1]][parity as usize])
            } else {
                (spec.queue[e - h].source, &[0, 1])
            };
            for &os in src_orients {
                for (t, item) in spec.queue.iter().enumerate() {
                    if t + h == e {
                        continue;
                    }
                    for ot in 0..2u32 {
                        let mut mask = 0u64;
                        for &target in &item.targets {
                            mask |= rules_matched(spec, src, os, target, ot);
                        }
                        pair[((e * 2 + os as usize) * n + t) * 2 + ot as usize] = mask;
                        fixed_pair[e * n + t] &= mask;
                    }
                }
            }
        }

        let mut pinned_at = vec![None; n];
        for (i, item) in spec.queue.iter().enumerate() {
            if item.pinned {
                pinned_at[i] = Some(i as u8);
            }
        }

        let rules = spec.rules.len();
        let mut classes: Vec<Class> = Vec::new();
        let mut class_of = vec![NO_CLASS; entities * rules];
        for (r, rule) in spec.rules.iter().enumerate() {
            if rule.team || rule.within == 0 {
                continue;
            }
            let mut by_value: IntMap<i32, u32> = IntMap::default();
            for e in 0..entities {
                let src = if e < h { spec.history[h_start + e] } else { spec.queue[e - h].source };
                let value = spec.layers[src][r][0];
                if value == NO_VALUE {
                    continue;
                }
                let class = *by_value.entry(value).or_insert_with(|| {
                    classes.push(Class { within: rule.within as usize, members: 0 });
                    (classes.len() - 1) as u32
                });
                class_of[e * rules + r] = class;
                // a vote only counts when every choice shares the value, so that it repeats wherever it goes
                if e >= h {
                    let item = &spec.queue[e - h];
                    if !item.targets.is_empty() && item.targets.iter().all(|&t| spec.layers[t][r][0] == value) {
                        classes[class as usize].members |= 1 << (e - h);
                    }
                }
            }
        }
        let class_count = classes.len();

        Solver {
            spec,
            n,
            h,
            max_within,
            within_mask,
            pair,
            fixed_pair,
            pinned_at,
            classes,
            class_of,
            placed: 0,
            order: Vec::with_capacity(n),
            cost: (0, 0),
            baseline: 0,
            best: (u32::MAX, u32::MAX),
            best_order: Vec::new(),
            nodes: 0,
            max_nodes: spec.max_nodes.unwrap_or(DEFAULT_MAX_NODES),
            exhausted: false,
            cands: (0..n).map(|_| Vec::with_capacity(2 * n)).collect(),
            memo: HashMap::default(),
            key_buf: Vec::with_capacity(16 + max_within),
            class_start: vec![(0, 0); class_count],
            stamp: 0,
        }
    }

    /// A lower bound on the edit cost of placing the rest of the queue without adding a violation.
    fn edit_floor(&self) -> u32 {
        let p = self.order.len();
        // the unplaced items in original order, as (item, orientation) at positions p, p + 1, ...
        let mut rest: [(u8, u32); MAX_QUEUE] = [(0, 0); MAX_QUEUE];
        let mut len = 0;
        for i in 0..self.n {
            if self.placed & (1u128 << i) == 0 {
                rest[len] = (i as u8, self.parity(p + len));
                len += 1;
            }
        }
        let mut touched = 0u128;
        // crossings or swaps still owed, and how many of those repeats a swap could clear instead
        let mut need = 0u32;
        let mut swappable = 0u32;
        for k in 0..len {
            let (item, ot) = rest[k];
            let item = item as usize;
            for back in 1..=self.max_within.min(p + self.h + k) {
                if touched & (1u128 << item) != 0 {
                    break;
                }
                let (entity, os, other) = if back <= k {
                    let (prev, os) = rest[k - back];
                    (self.h + prev as usize, os, Some(prev))
                } else if back <= k + p {
                    let (prev, prev_swap) = self.order[p + k - back];
                    (self.h + prev as usize, (self.parity(p + k - back) + prev_swap as u32) % 2, None)
                } else {
                    let e = self.h + p + k - back;
                    (e, self.history_orient(e), None)
                };
                let hit = self.pair_mask(entity, os, item, ot) & self.within_mask[back];
                if hit == 0 {
                    continue;
                }
                match other {
                    Some(prev) if touched & (1u128 << prev) != 0 => continue,
                    Some(prev) => touched |= 1u128 << prev,
                    None => {}
                }
                touched |= 1u128 << item;
                let fixed = hit & self.fixed_pair[entity * self.n + item];
                let mut crossings = 0;
                let mut rules = fixed;
                while rules != 0 {
                    let r = rules.trailing_zeros() as usize;
                    rules &= rules - 1;
                    crossings = crossings.max(self.spec.rules[r].within + 1 - back as u32);
                }
                // two unplaced items can also trade places, which takes `back` crossings, and need not repeat after
                if other.is_some() {
                    crossings = crossings.min(back as u32);
                }
                if crossings == 0 {
                    need += 1;
                    swappable += 1;
                } else {
                    need += crossings;
                }
            }
        }
        let (swap, inversion) = (self.spec.swap_cost, self.spec.move_cost);
        let by_inversions = need.div_ceil(2) * inversion;
        let with_swaps = swappable * swap + (need - swappable).div_ceil(2) * inversion;
        by_inversions.min(with_swaps)
    }

    /// A lower bound on the violations the unplaced items will add, however they are arranged.
    fn violation_floor(&mut self) -> u32 {
        if self.classes.is_empty() {
            return 0;
        }
        let p = self.order.len();
        let rules = self.spec.rules.len();
        self.stamp += 1;
        // a placed source blocks the next `within` positions for its class. Oldest first, so the latest one wins.
        let lo = (p + self.h).saturating_sub(self.max_within);
        for abs in lo..p + self.h {
            let entity = if abs < self.h { abs } else { self.h + self.order[abs - self.h].0 as usize };
            for r in 0..rules {
                let class = self.class_of[entity * rules + r];
                if class == NO_CLASS {
                    continue;
                }
                let start = (abs + self.classes[class as usize].within + 1).saturating_sub(self.h);
                self.class_start[class as usize] = (self.stamp, start.max(p));
            }
        }
        let mut floor = 0;
        for (c, class) in self.classes.iter().enumerate() {
            let remaining = (class.members & !self.placed).count_ones();
            if remaining == 0 {
                continue;
            }
            let (stamp, start) = self.class_start[c];
            let start = if stamp == self.stamp { start } else { p };
            let fit = if start >= self.n { 0 } else { (self.n - start).div_ceil(class.within + 1) as u32 };
            floor += remaining.saturating_sub(fit);
        }
        floor
    }

    /// parity of queue position `p`, before any swap
    #[inline]
    fn parity(&self, p: usize) -> u32 {
        (self.spec.first_parity + (self.spec.history.len() + p) as u32) % 2
    }

    #[inline]
    fn pair_mask(&self, entity: usize, os: u32, target: usize, ot: u32) -> u64 {
        self.pair[((entity * 2 + os as usize) * self.n + target) * 2 + ot as usize]
    }

    /// rules the item breaks if placed at position `p` with the given swap, against everything before it
    fn violations_at(&self, p: usize, item: usize, swap: bool) -> u32 {
        if self.max_within == 0 {
            return 0;
        }
        let ot = (self.parity(p) + swap as u32) % 2;
        let mut broken = 0u64;
        let lo = p.saturating_sub(self.max_within);
        for q in lo..p {
            let (prev, prev_swap) = self.order[q];
            let os = (self.parity(q) + prev_swap as u32) % 2;
            broken |= self.pair_mask(self.h + prev as usize, os, item, ot) & self.within_mask[p - q];
        }
        // history at negative queue positions: entity e sits at distance p + h - e
        let reach = self.max_within.saturating_sub(p);
        for e in self.h.saturating_sub(reach)..self.h {
            let d = p + self.h - e;
            broken |= self.pair_mask(e, self.history_orient(e), item, ot) & self.within_mask[d];
        }
        broken.count_ones()
    }

    #[inline]
    fn history_orient(&self, e: usize) -> u32 {
        let h_start = self.spec.history.len() - self.h;
        (self.spec.first_parity + (h_start + e) as u32) % 2
    }

    fn edit_cost(&self, rank: u32, swap: bool) -> u32 {
        rank * self.spec.move_cost + if swap { self.spec.swap_cost } else { 0 }
    }

    fn run(&mut self) {
        // the queue as it stands is always an answer, so the search only has to beat it
        for p in 0..self.n {
            self.baseline += self.violations_at(p, p, false);
            self.order.push((p as u8, false));
        }
        self.best = (self.baseline, 0);
        self.best_order = self.order.clone();
        self.order.clear();
        if self.baseline > 0 {
            self.dfs();
        }
    }

    fn dfs(&mut self) {
        let p = self.order.len();
        if p == self.n {
            if self.cost < self.best {
                self.best = self.cost;
                self.best_order.clone_from(&self.order);
            }
            return;
        }
        self.nodes += 1;
        if self.nodes > self.max_nodes {
            self.exhausted = true;
            return;
        }
        if self.memo_cut() {
            return;
        }
        if (self.cost.0 + self.violation_floor(), self.cost.1) >= self.best {
            return;
        }
        if self.cost.0 == self.best.0 && self.cost.1 + self.edit_floor() >= self.best.1 {
            return;
        }

        let mut cands = std::mem::take(&mut self.cands[p]);
        cands.clear();
        if let Some(item) = self.pinned_at[p] {
            let rank = self.unplaced_below(item as usize);
            let v = self.violations_at(p, item as usize, false);
            cands.push(Cand { item, swap: false, cost: (v, self.edit_cost(rank, false)) });
        } else {
            let mut rank = 0u32;
            for i in 0..self.n {
                if self.placed & (1u128 << i) != 0 {
                    continue;
                }
                let item = &self.spec.queue[i];
                // a pinned item can only go to its own position, which is still ahead
                if !item.pinned {
                    for swap in [false, true] {
                        if swap && !item.swappable {
                            continue;
                        }
                        let v = self.violations_at(p, i, swap);
                        cands.push(Cand { item: i as u8, swap, cost: (v, self.edit_cost(rank, swap)) });
                    }
                }
                rank += 1;
            }
            cands.sort_unstable_by_key(|c| c.cost);
        }

        let start_cost = self.cost;
        let mut complete = true;
        for c in cands.iter() {
            let next = (start_cost.0 + c.cost.0, start_cost.1 + c.cost.1);
            // sorted, so nothing after this one is cheaper either
            if next >= self.best {
                break;
            }
            self.placed |= 1u128 << c.item;
            self.order.push((c.item, c.swap));
            self.cost = next;
            self.dfs();
            self.cost = start_cost;
            self.order.pop();
            self.placed &= !(1u128 << c.item);
            if self.exhausted {
                complete = false;
                break;
            }
            if self.best.0 == 0 && self.best.1 == 0 {
                break;
            }
        }
        self.cands[p] = cands;

        if complete {
            self.memo_record(start_cost);
        }
    }

    /// unplaced items whose original index is below `i`: the pairs placing `i` next puts out of order
    fn unplaced_below(&self, i: usize) -> u32 {
        let below = if i == 0 { 0 } else { (1u128 << i) - 1 };
        (below & !self.placed).count_ones()
    }

    fn fill_key(&mut self) {
        self.key_buf.clear();
        self.key_buf.extend_from_slice(&self.placed.to_le_bytes());
        let p = self.order.len();
        for &(item, swap) in &self.order[p.saturating_sub(self.max_within)..] {
            self.key_buf.push(item << 1 | swap as u8);
        }
    }

    fn memo_cut(&mut self) -> bool {
        if self.max_within == 0 {
            return false;
        }
        self.fill_key();
        self.memo.get(&self.key_buf[..]).is_some_and(|&explored| explored <= self.cost)
    }

    fn memo_record(&mut self, cost: Cost) {
        if self.max_within == 0 || self.memo.len() >= MAX_MEMO_ENTRIES {
            return;
        }
        self.fill_key();
        let key: Box<[u8]> = self.key_buf.as_slice().into();
        let entry = self.memo.entry(key).or_insert(cost);
        if cost < *entry {
            *entry = cost;
        }
    }

    fn response(&self) -> SolveResponse {
        let mut swapped = vec![false; self.n];
        let mut swaps = 0;
        for &(item, swap) in &self.best_order {
            swapped[item as usize] = swap;
            swaps += swap as u32;
        }
        let order: Vec<usize> = self.best_order.iter().map(|&(i, _)| i as usize).collect();
        let mut moves = 0;
        for a in 0..order.len() {
            for b in a + 1..order.len() {
                moves += (order[a] > order[b]) as u32;
            }
        }
        SolveResponse {
            status: if self.exhausted { SolveStatus::BudgetExhausted } else { SolveStatus::Optimal },
            order,
            swapped,
            violations: self.best.0,
            baseline_violations: self.baseline,
            swaps,
            moves,
            nodes: self.nodes,
        }
    }
}

/// Rules under which `target` (oriented `ot`) repeats `src` (oriented `os`). An orientation names the slot that is
/// normalized team A.
fn rules_matched(spec: &SolveSpec, src: usize, os: u32, target: usize, ot: u32) -> u64 {
    let (sv, tv) = (&spec.layers[src], &spec.layers[target]);
    let mut mask = 0u64;
    for (r, rule) in spec.rules.iter().enumerate() {
        if rule.within == 0 {
            continue;
        }
        let (s, t) = (sv[r], tv[r]);
        let hit = if !rule.team {
            t[0] != NO_VALUE && t[0] == s[0]
        } else {
            (0..2u32).any(|team| {
                let value = t[((ot + team) % 2) as usize];
                if value == NO_VALUE {
                    return false;
                }
                if rule.cross_team {
                    value == s[0] || value == s[1]
                } else {
                    value == s[((os + team) % 2) as usize]
                }
            })
        };
        if hit {
            mask |= 1 << r;
        }
    }
    mask
}

#[cfg(test)]
mod tests {
    use super::*;

    /// splitmix64, so the instances are the same on every run
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            z ^ (z >> 31)
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// Scores an arrangement independently of the solver: every queue item against everything before it.
    fn score(spec: &SolveSpec, order: &[usize], swapped: &[bool]) -> Cost {
        let h = spec.history.len();
        let orient = |abs: usize, swap: bool| (spec.first_parity + abs as u32 + swap as u32) % 2;
        let mut violations = 0;
        for (p, &item) in order.iter().enumerate() {
            let abs = h + p;
            let ot = orient(abs, swapped[item]);
            let mut broken = 0u64;
            for prev_abs in 0..abs {
                let d = abs - prev_abs;
                let (src, os) = if prev_abs < h {
                    (spec.history[prev_abs], orient(prev_abs, false))
                } else {
                    let prev = order[prev_abs - h];
                    (spec.queue[prev].source, orient(prev_abs, swapped[prev]))
                };
                for &target in &spec.queue[item].targets {
                    let mut mask = rules_matched(spec, src, os, target, ot);
                    for (r, rule) in spec.rules.iter().enumerate() {
                        if (rule.within as usize) < d {
                            mask &= !(1 << r);
                        }
                    }
                    broken |= mask;
                }
            }
            violations += broken.count_ones();
        }
        let mut edits = 0;
        for a in 0..order.len() {
            for b in a + 1..order.len() {
                edits += (order[a] > order[b]) as u32 * spec.move_cost;
            }
        }
        edits += swapped.iter().filter(|&&s| s).count() as u32 * spec.swap_cost;
        (violations, edits)
    }

    fn brute_force(spec: &SolveSpec) -> Cost {
        let n = spec.queue.len();
        let mut order: Vec<usize> = (0..n).collect();
        let mut best = (u32::MAX, u32::MAX);
        permute(&mut order, 0, &mut |order| {
            if order.iter().enumerate().any(|(p, &i)| spec.queue[i].pinned && p != i) {
                return;
            }
            for bits in 0..(1u32 << n) {
                let swapped: Vec<bool> = (0..n).map(|i| bits & (1 << i) != 0).collect();
                let allowed = (0..n).all(|i| !swapped[i] || (spec.queue[i].swappable && !spec.queue[i].pinned));
                if allowed {
                    best = best.min(score(spec, order, &swapped));
                }
            }
        });
        best
    }

    fn permute(order: &mut Vec<usize>, k: usize, visit: &mut dyn FnMut(&[usize])) {
        if k == order.len() {
            visit(order);
            return;
        }
        for i in k..order.len() {
            order.swap(k, i);
            permute(order, k + 1, visit);
            order.swap(k, i);
        }
    }

    /// Few distinct values, so collisions (and instances with no violation-free answer) are common.
    fn random_spec(rng: &mut Rng) -> SolveSpec {
        let rules: Vec<RuleSpec> = (0..1 + rng.below(3))
            .map(|_| {
                let team = rng.below(2) == 0;
                RuleSpec { within: 1 + rng.below(4) as u32, team, cross_team: team && rng.below(2) == 0 }
            })
            .collect();
        let values = 2 + rng.below(4);
        let value = |rng: &mut Rng| if rng.below(8) == 0 { NO_VALUE } else { rng.below(values) as i32 };
        let layer_count = 10;
        let layers: Vec<Vec<[i32; 2]>> =
            (0..layer_count).map(|_| rules.iter().map(|_| [value(rng), value(rng)]).collect()).collect();
        let n = 2 + rng.below(5) as usize;
        let queue = (0..n)
            .map(|_| {
                let source = rng.below(layer_count) as usize;
                let targets = match rng.below(6) {
                    0 => vec![],
                    1 => vec![source, rng.below(layer_count) as usize],
                    _ => vec![source],
                };
                QueueItemSpec { source, targets, swappable: rng.below(6) != 0, pinned: rng.below(8) == 0 }
            })
            .collect();
        SolveSpec {
            rules,
            layers,
            history: (0..rng.below(4)).map(|_| rng.below(layer_count) as usize).collect(),
            queue,
            first_parity: rng.below(2) as u32,
            swap_cost: 1 + rng.below(3) as u32,
            move_cost: 1 + rng.below(3) as u32,
            max_nodes: None,
        }
    }

    #[test]
    fn matches_brute_force() {
        let mut rng = Rng(7);
        for case in 0..2000 {
            let spec = random_spec(&mut rng);
            let res = solve(&spec).unwrap();
            assert_eq!(res.status, SolveStatus::Optimal);
            let claimed = (res.violations, res.swaps * spec.swap_cost + res.moves * spec.move_cost);
            assert_eq!(
                score(&spec, &res.order, &res.swapped),
                claimed,
                "case {case}: reported cost is not the real one"
            );
            assert_eq!(claimed, brute_force(&spec), "case {case}: not optimal");
            assert!(res.violations <= res.baseline_violations);
            for (i, item) in spec.queue.iter().enumerate() {
                if item.pinned {
                    assert_eq!(res.order[i], i);
                    assert!(!res.swapped[i]);
                }
            }
        }
    }

    #[test]
    fn unfixable_violation_leaves_queue_alone() {
        let spec = SolveSpec {
            rules: vec![RuleSpec { within: 2, team: false, cross_team: false }],
            layers: vec![vec![[0, 0]], vec![[1, 1]]],
            history: vec![0],
            queue: vec![
                QueueItemSpec { source: 1, targets: vec![1], swappable: true, pinned: false },
                QueueItemSpec { source: 0, targets: vec![0], swappable: true, pinned: false },
            ],
            first_parity: 0,
            swap_cost: 1,
            move_cost: 1,
            max_nodes: None,
        };
        let res = solve(&spec).unwrap();
        // the history's map is within 2 of both queue positions, so no arrangement clears it
        assert_eq!((res.baseline_violations, res.violations, res.moves, res.swaps), (1, 1, 0, 0));
    }

    #[test]
    fn long_queue_respects_budget() {
        let mut rng = Rng(11);
        let n = 34;
        let rules = vec![
            RuleSpec { within: 4, team: false, cross_team: false },
            RuleSpec { within: 3, team: true, cross_team: false },
            RuleSpec { within: 2, team: true, cross_team: true },
        ];
        let layers: Vec<Vec<[i32; 2]>> = (0..n)
            .map(|_| {
                vec![
                    [rng.below(12) as i32; 2],
                    [rng.below(8) as i32, rng.below(8) as i32],
                    [rng.below(3) as i32, rng.below(3) as i32],
                ]
            })
            .collect();
        let spec = SolveSpec {
            rules,
            layers,
            history: vec![0, 1, 2, 3],
            queue: (4..n)
                .map(|l| QueueItemSpec { source: l, targets: vec![l], swappable: true, pinned: false })
                .collect(),
            first_parity: 1,
            swap_cost: 1,
            move_cost: 1,
            max_nodes: Some(200_000),
        };
        let res = solve(&spec).unwrap();
        assert!(res.violations <= res.baseline_violations);
        assert!(res.nodes <= 200_001);
        assert_eq!(score(&spec, &res.order, &res.swapped).0, res.violations);
    }
}

//! Filter IR and its evaluator.
//!
//! TypeScript lowers a filter tree into this IR (see src/models/layer-engine.ts): team columns are already expanded
//! over both teams, values are already db-encoded through LC.dbValue, and referenced filters are already inlined. So
//! this side only has to implement primitive comparisons and SQL's three-valued logic.
//!
//! Every scan walks the table block by block rather than row by row, which is what makes the factored store pay. A
//! predicate on a layer's own column is evaluated once per block (928 times, not 2.7M), and one on a per-team column
//! once per distinct availability pattern (364k pattern rows, not 2.7M rows) and then replayed across every block
//! sharing that pattern. Only the score scopes are genuinely per row, and blocks whose rows are all outside the
//! candidate are skipped before any of it.

use crate::store::{ColData, Enum, Store, NULL_I32, NULL_U16, NULL_U8};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Ir {
    And { children: Vec<Ir> },
    Or { children: Vec<Ir> },
    Not { child: Box<Ir> },
    True,
    False,
    IsNull { col: usize },
    EqVal { col: usize, val: i64 },
    InVals { col: usize, vals: Vec<i64> },
    LtVal { col: usize, val: i64 },
    GtVal { col: usize, val: i64 },
    GeVal { col: usize, val: i64 },
    LeVal { col: usize, val: i64 },
    EqCol { col: usize, other: usize },
    LtCol { col: usize, other: usize },
    GtCol { col: usize, other: usize },
}

/// A three-valued result: a row is TRUE if its `t` bit is set, UNKNOWN if its `u` bit is set, FALSE otherwise.
///
/// The unknown track is not decoration. SQL's WHERE keeps only TRUE, and NOT(NULL) is NULL rather than TRUE, so a
/// null row must stay excluded even under negation. A two-valued port would silently let nulls through every negated
/// comparison, which is exactly the class of bug that would make the engine disagree with the pool the UI shows.
#[derive(Clone)]
pub struct Tri {
    pub t: Vec<u64>,
    pub u: Vec<u64>,
}

impl Tri {
    pub fn empty(words: usize) -> Self {
        Tri { t: vec![0; words], u: vec![0; words] }
    }

    pub fn count(&self) -> usize {
        self.t.iter().map(|w| w.count_ones() as usize).sum()
    }

    /// Iterates the row indices that matched.
    pub fn rows(&self) -> impl Iterator<Item = usize> + '_ {
        self.t.iter().enumerate().flat_map(|(w, word)| {
            let mut bits = *word;
            std::iter::from_fn(move || {
                if bits == 0 {
                    return None;
                }
                let b = bits.trailing_zeros() as usize;
                bits &= bits - 1;
                Some(w * 64 + b)
            })
        })
    }

    #[inline]
    pub fn contains(&self, row: usize) -> bool {
        self.t[row / 64] & (1u64 << (row % 64)) != 0
    }

    /// Whether any row in [from, to) matched. Lets a caller ask about a whole block at once.
    pub fn any_in(&self, from: usize, to: usize) -> bool {
        range_any(&self.t, from, to)
    }

    /// Whether every row in [from, to) matched, which is the common case for a block under a pool filter built only
    /// from a layer's own columns.
    pub fn all_in(&self, from: usize, to: usize) -> bool {
        range_all(&self.t, from, to)
    }
}

#[inline]
pub fn words_for(rows: usize) -> usize {
    rows.div_ceil(64)
}

fn mask_tail(bits: &mut [u64], rows: usize) {
    let words = words_for(rows);
    let rem = rows % 64;
    if words > 0 && rem != 0 {
        bits[words - 1] &= (1u64 << rem) - 1;
    }
}

pub fn all_rows(rows: usize) -> Vec<u64> {
    let mut all = vec![!0u64; words_for(rows)];
    mask_tail(&mut all, rows);
    all
}

/// Sets [from, to) in a bitset, whole words at a time.
#[inline]
fn set_range(bits: &mut [u64], from: usize, to: usize) {
    if from >= to {
        return;
    }
    let (fw, lw) = (from / 64, (to - 1) / 64);
    if fw == lw {
        let mask = (!0u64 >> (64 - (to - from))) << (from % 64);
        bits[fw] |= mask;
        return;
    }
    bits[fw] |= !0u64 << (from % 64);
    for word in bits.iter_mut().take(lw).skip(fw + 1) {
        *word = !0u64;
    }
    let rem = to % 64;
    bits[lw] |= if rem == 0 { !0u64 } else { !0u64 >> (64 - rem) };
}

/// Whether any candidate bit is set in [from, to). Lets a scan skip a whole layer the pool filter already excluded.
#[inline]
fn range_any(bits: &[u64], from: usize, to: usize) -> bool {
    if from >= to {
        return false;
    }
    let (fw, lw) = (from / 64, (to - 1) / 64);
    for (w, word) in bits.iter().enumerate().take(lw + 1).skip(fw) {
        let mut value = *word;
        if w == fw {
            value &= !0u64 << (from % 64);
        }
        if w == lw {
            let rem = to % 64;
            value &= if rem == 0 { !0u64 } else { !0u64 >> (64 - rem) };
        }
        if value != 0 {
            return true;
        }
    }
    false
}

/// Whether every bit in [from, to) is set, word at a time.
#[inline]
fn range_all(bits: &[u64], from: usize, to: usize) -> bool {
    if from >= to {
        return true;
    }
    let (fw, lw) = (from / 64, (to - 1) / 64);
    for (w, word) in bits.iter().enumerate().take(lw + 1).skip(fw) {
        let mut mask = !0u64;
        if w == fw {
            mask &= !0u64 << (from % 64);
        }
        if w == lw {
            let rem = to % 64;
            mask &= if rem == 0 { !0u64 } else { !0u64 >> (64 - rem) };
        }
        if *word & mask != mask {
            return false;
        }
    }
    true
}

/// Cheap leaves first within an AND, so the candidate is already narrow when an expensive nested block runs. A
/// predicate on a layer's own column is the cheapest thing there is, since it runs once per block.
fn cost(store: &Store, ir: &Ir) -> u32 {
    match ir {
        Ir::True | Ir::False => 0,
        Ir::Not { child } => 1 + cost(store, child),
        Ir::And { children } | Ir::Or { children } => 1 + children.iter().map(|c| cost(store, c)).sum::<u32>(),
        Ir::IsNull { col }
        | Ir::EqVal { col, .. }
        | Ir::InVals { col, .. }
        | Ir::LtVal { col, .. }
        | Ir::GtVal { col, .. }
        | Ir::GeVal { col, .. }
        | Ir::LeVal { col, .. } => match store.col_data(*col) {
            ColData::PerBlock(_) => 1,
            ColData::PerPattern(_) => 2,
            ColData::PerRow => 4,
        },
        Ir::EqCol { .. } | Ir::LtCol { .. } | Ir::GtCol { .. } => 5,
    }
}

/// Runs a predicate over one column. Dispatches on how the column varies once, then runs the matching loop: this is
/// the whole point of the factored store, so nothing below re-examines the column spec per row.
fn scan_col<F>(store: &Store, col: usize, cand: &[u64], f: F) -> Tri
where
    F: Fn(Option<i64>) -> (bool, bool),
{
    let rows = store.row_count();
    let words = words_for(rows);
    let mut tri = Tri::empty(words);

    match store.col_data(col) {
        // one evaluation per block, then the block's whole row range is set at once
        ColData::PerBlock(values) => {
            for block in 0..store.block_count() {
                let (start, end) = store.block_rows(block);
                if start == end || !range_any(cand, start, end) {
                    continue;
                }
                let (t, u) = f(values.get(block));
                if t {
                    set_range(&mut tri.t, start, end);
                } else if u {
                    set_range(&mut tri.u, start, end);
                }
            }
        }
        // one evaluation per pattern row, replayed across every block that shares the pattern
        ColData::PerPattern(values) => {
            let mut memo = vec![0u8; store.manifest.pattern_row_count];
            let mut done = vec![false; store.manifest.pattern_count];
            for block in 0..store.block_count() {
                let (start, end) = store.block_rows(block);
                if start == end || !range_any(cand, start, end) {
                    continue;
                }
                let pattern = store.block_pattern(block);
                let (p_start, p_end) = store.pattern_rows(pattern);
                if !done[pattern] {
                    for p in p_start..p_end {
                        let (t, u) = f(values.get(p));
                        memo[p] = if t { 1 } else if u { 2 } else { 0 };
                    }
                    done[pattern] = true;
                }
                let mut p = p_start;
                for row in start..end {
                    match memo[p] {
                        1 => tri.t[row / 64] |= 1u64 << (row % 64),
                        2 => tri.u[row / 64] |= 1u64 << (row % 64),
                        _ => {}
                    }
                    p += 1;
                }
            }
        }
        // genuinely per row, but still walked block-major so the block and pattern row come for free
        ColData::PerRow => {
            let reader = store.reader(col);
            for block in 0..store.block_count() {
                let (start, end) = store.block_rows(block);
                if start == end || !range_any(cand, start, end) {
                    continue;
                }
                let mut p = store.pattern_rows(store.block_pattern(block)).0;
                for row in start..end {
                    if cand[row / 64] & (1u64 << (row % 64)) != 0 {
                        let (t, u) = f(reader.read(block, p, row));
                        if t {
                            tri.t[row / 64] |= 1u64 << (row % 64);
                        } else if u {
                            tri.u[row / 64] |= 1u64 << (row % 64);
                        }
                    }
                    p += 1;
                }
            }
        }
    }

    for w in 0..words {
        tri.t[w] &= cand[w];
        tri.u[w] &= cand[w];
    }
    tri
}

/// Two columns compared against each other. Always per row, since the pair can straddle scopes.
fn cmp_col(store: &Store, a: usize, b: usize, cand: &[u64], f: fn(i64, i64) -> bool) -> Tri {
    let rows = store.row_count();
    let words = words_for(rows);
    let mut tri = Tri::empty(words);
    let ra = store.reader(a);
    let rb = store.reader(b);
    for block in 0..store.block_count() {
        let (start, end) = store.block_rows(block);
        if start == end || !range_any(cand, start, end) {
            continue;
        }
        let mut p = store.pattern_rows(store.block_pattern(block)).0;
        for row in start..end {
            if cand[row / 64] & (1u64 << (row % 64)) != 0 {
                match (ra.read(block, p, row), rb.read(block, p, row)) {
                    (Some(x), Some(y)) => {
                        if f(x, y) {
                            tri.t[row / 64] |= 1u64 << (row % 64);
                        }
                    }
                    _ => tri.u[row / 64] |= 1u64 << (row % 64),
                }
            }
            p += 1;
        }
    }
    for w in 0..words {
        tri.t[w] &= cand[w];
        tri.u[w] &= cand[w];
    }
    tri
}

pub fn eval(store: &Store, ir: &Ir) -> Tri {
    eval_with(store, ir, &all_rows(store.row_count()))
}

pub fn eval_with(store: &Store, ir: &Ir, cand: &[u64]) -> Tri {
    let rows = store.row_count();
    let words = words_for(rows);
    match ir {
        Ir::True => {
            let mut tri = Tri::empty(words);
            tri.t.copy_from_slice(cand);
            tri
        }
        Ir::False => Tri::empty(words),
        Ir::Not { child } => {
            let inner = eval_with(store, child, cand);
            let mut tri = Tri::empty(words);
            for w in 0..words {
                tri.t[w] = !inner.t[w] & !inner.u[w] & cand[w];
                tri.u[w] = inner.u[w];
            }
            tri
        }
        Ir::And { children } => {
            let mut order: Vec<&Ir> = children.iter().collect();
            order.sort_by_key(|c| cost(store, c));
            let mut acc: Option<Tri> = None;
            let mut running: Vec<u64> = cand.to_vec();
            for child in order {
                if running.iter().all(|w| *w == 0) {
                    break;
                }
                let c = eval_with(store, child, &running);
                acc = Some(match acc {
                    None => c,
                    Some(a) => {
                        let mut tri = Tri::empty(words);
                        for w in 0..words {
                            let false_bits = (!a.t[w] & !a.u[w]) | (!c.t[w] & !c.u[w]);
                            let t = a.t[w] & c.t[w];
                            tri.t[w] = t;
                            tri.u[w] = !t & !false_bits & cand[w];
                        }
                        tri
                    }
                });
                // a row that's already false can never come back, so drop it from the candidate
                let a = acc.as_ref().unwrap();
                for w in 0..words {
                    running[w] &= a.t[w] | a.u[w];
                }
            }
            match acc {
                None => eval_with(store, &Ir::True, cand),
                Some(mut tri) => {
                    for w in 0..words {
                        tri.t[w] &= cand[w];
                        tri.u[w] &= cand[w];
                    }
                    tri
                }
            }
        }
        Ir::Or { children } => {
            // a false row can still turn true, so an OR can't narrow the candidate for its children. It can still
            // stop looking at rows that are already true.
            let mut acc: Option<Tri> = None;
            let mut remaining: Vec<u64> = cand.to_vec();
            for child in children {
                if remaining.iter().all(|w| *w == 0) {
                    break;
                }
                let c = eval_with(store, child, &remaining);
                acc = Some(match acc {
                    None => c,
                    Some(a) => {
                        let mut tri = Tri::empty(words);
                        for w in 0..words {
                            let false_bits = (!a.t[w] & !a.u[w]) & (!c.t[w] & !c.u[w]);
                            let t = a.t[w] | c.t[w];
                            tri.t[w] = t;
                            tri.u[w] = !t & !false_bits & cand[w];
                        }
                        tri
                    }
                });
                let a = acc.as_ref().unwrap();
                for w in 0..words {
                    remaining[w] &= !a.t[w];
                }
            }
            acc.unwrap_or_else(|| Tri::empty(words))
        }
        Ir::IsNull { col } => scan_col(store, *col, cand, |v| (v.is_none(), false)),
        // one membership pass rather than an OR of equalities: the real pool filters carry 60-value layer lists, and
        // as an OR chain each value would be its own scan
        Ir::InVals { col, vals } => match store.col_data(*col) {
            ColData::PerBlock(Enum::U8(_)) | ColData::PerPattern(Enum::U8(_)) => {
                let mut lut = [false; 256];
                for v in vals {
                    if (0..NULL_U8 as i64).contains(v) {
                        lut[*v as usize] = true;
                    }
                }
                scan_col(store, *col, cand, move |v| match v {
                    None => (false, true),
                    Some(x) => (x >= 0 && x < 256 && lut[x as usize], false),
                })
            }
            ColData::PerBlock(Enum::U16(_)) | ColData::PerPattern(Enum::U16(_)) => {
                let mut lut = vec![false; 65536];
                for v in vals {
                    if (0..NULL_U16 as i64).contains(v) {
                        lut[*v as usize] = true;
                    }
                }
                scan_col(store, *col, cand, move |v| match v {
                    None => (false, true),
                    Some(x) => (x >= 0 && x < 65536 && lut[x as usize], false),
                })
            }
            ColData::PerRow => {
                let mut sorted: Vec<i64> = vals.clone();
                sorted.sort_unstable();
                scan_col(store, *col, cand, move |v| match v {
                    None => (false, true),
                    Some(x) => (sorted.binary_search(&x).is_ok(), false),
                })
            }
        },
        Ir::EqVal { col, val } => cmp_val(store, *col, *val, cand, |a, b| a == b),
        Ir::LtVal { col, val } => cmp_val(store, *col, *val, cand, |a, b| a < b),
        Ir::GtVal { col, val } => cmp_val(store, *col, *val, cand, |a, b| a > b),
        Ir::GeVal { col, val } => cmp_val(store, *col, *val, cand, |a, b| a >= b),
        Ir::LeVal { col, val } => cmp_val(store, *col, *val, cand, |a, b| a <= b),
        Ir::EqCol { col, other } => cmp_col(store, *col, *other, cand, |a, b| a == b),
        Ir::LtCol { col, other } => cmp_col(store, *col, *other, cand, |a, b| a < b),
        Ir::GtCol { col, other } => cmp_col(store, *col, *other, cand, |a, b| a > b),
    }
}

/// A comparison against null is null, which is what keeps null rows out of both a predicate and its negation.
fn cmp_val(store: &Store, col: usize, val: i64, cand: &[u64], f: fn(i64, i64) -> bool) -> Tri {
    scan_col(store, col, cand, move |v| match v {
        None => (false, true),
        Some(x) => (f(x, val), false),
    })
}

// keeps NULL_I32 referenced for the store's null contract even though every read now returns Option
const _: i32 = NULL_I32;

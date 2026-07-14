//! Filter IR and its evaluator.
//!
//! TypeScript lowers a filter tree into this IR (see src/models/layer-engine.ts): team columns are already expanded
//! over both teams, values are already db-encoded through LC.dbValue, and referenced filters are already inlined. So
//! this side only has to implement primitive comparisons and SQL's three-valued logic.

use crate::store::{Col, Store, NULL_I32, NULL_U8};
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

/// Predicates only look at rows whose candidate bit is set. Rows outside the candidate get garbage, which is safe
/// because the candidate only narrows inside an AND chain and the chain ANDs the result back against it.
macro_rules! scan {
    ($rows:expr, $words:expr, $cand:expr, $body:expr) => {{
        let mut tri = Tri::empty($words);
        let f = $body;
        for w in 0..$words {
            let cw = $cand[w];
            if cw == 0 {
                continue;
            }
            let base = w * 64;
            let limit = core::cmp::min(64, $rows - base);
            let mut tw: u64 = 0;
            let mut uw: u64 = 0;
            for b in 0..limit {
                if cw & (1u64 << b) == 0 {
                    continue;
                }
                let (t, u) = f(base + b);
                tw |= (t as u64) << b;
                uw |= (u as u64) << b;
            }
            tri.t[w] = tw;
            tri.u[w] = uw;
        }
        tri
    }};
}

/// Cheap leaves first within an AND, so the candidate is already narrow when an expensive nested block runs.
fn cost(ir: &Ir) -> u32 {
    match ir {
        Ir::True | Ir::False => 0,
        Ir::Not { child } => 1 + cost(child),
        Ir::And { children } | Ir::Or { children } => 1 + children.iter().map(cost).sum::<u32>(),
        _ => 1,
    }
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
            order.sort_by_key(|c| cost(c));
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
        Ir::IsNull { col } => match store.col(*col) {
            Col::U8(c) => scan!(rows, words, cand, |i: usize| (c[i] == NULL_U8, false)),
            Col::I32(c) => scan!(rows, words, cand, |i: usize| (c[i] == NULL_I32, false)),
        },
        // one membership pass rather than an OR of equalities: the real pool filters carry 60-value layer lists, and
        // as an OR chain each value would be its own scan
        Ir::InVals { col, vals } => match store.col(*col) {
            Col::U8(c) => {
                let mut lut = [false; 256];
                for v in vals {
                    if (0..255).contains(v) {
                        lut[*v as usize] = true;
                    }
                }
                scan!(rows, words, cand, |i: usize| {
                    let v = c[i];
                    if v == NULL_U8 { (false, true) } else { (lut[v as usize], false) }
                })
            }
            Col::I32(c) => {
                let mut sorted: Vec<i64> = vals.clone();
                sorted.sort_unstable();
                scan!(rows, words, cand, |i: usize| {
                    let v = c[i];
                    if v == NULL_I32 { (false, true) } else { (sorted.binary_search(&(v as i64)).is_ok(), false) }
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
    let rows = store.row_count();
    let words = words_for(rows);
    match store.col(col) {
        Col::U8(c) => scan!(rows, words, cand, |i: usize| {
            let v = c[i];
            if v == NULL_U8 { (false, true) } else { (f(v as i64, val), false) }
        }),
        Col::I32(c) => scan!(rows, words, cand, |i: usize| {
            let v = c[i];
            if v == NULL_I32 { (false, true) } else { (f(v as i64, val), false) }
        }),
    }
}

fn cmp_col(store: &Store, a: usize, b: usize, cand: &[u64], f: fn(i64, i64) -> bool) -> Tri {
    let rows = store.row_count();
    let words = words_for(rows);
    let ca = store.col(a);
    let cb = store.col(b);
    scan!(rows, words, cand, |i: usize| {
        match (store.value(ca, i), store.value(cb, i)) {
            (Some(x), Some(y)) => (f(x, y), false),
            _ => (false, true),
        }
    })
}

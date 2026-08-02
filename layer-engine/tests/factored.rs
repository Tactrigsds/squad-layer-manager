//! Cross-checks the factored store against a naive row-wise evaluation of the same IR.
//!
//! The scans in ir.rs no longer touch rows one at a time: a layer's own column is evaluated once per block and a
//! per-team column once per availability pattern, then replayed. That is the whole speed argument and also the whole
//! risk, because a block or pattern offset that is off by one produces plausible bitsets rather than a crash. These
//! tests run every predicate shape over columns of every scope and compare bit for bit against `store.value`, which
//! resolves a row independently through `block_of`.

use layer_engine::ir::{self, all_rows, words_for, Ir, Tri};
use layer_engine::store::Store;

fn load() -> Store {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../assets/layers/layers_v10.5.0.bin");
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e} (run pnpm tsx src/scripts/convert-artifact.ts 10.5.0)"));
    Store::load(bytes).expect("artifact loads")
}

/// The same three-valued logic as ir.rs, but resolving every row through `store.value`.
fn naive(store: &Store, ir: &Ir) -> Tri {
    let rows = store.row_count();
    let mut tri = Tri::empty(words_for(rows));
    for row in 0..rows {
        let (t, u) = naive_row(store, ir, row);
        if t {
            tri.t[row / 64] |= 1u64 << (row % 64);
        } else if u {
            tri.u[row / 64] |= 1u64 << (row % 64);
        }
    }
    tri
}

fn naive_row(store: &Store, ir: &Ir, row: usize) -> (bool, bool) {
    let cmp = |col: &usize, f: &dyn Fn(i64) -> bool| match store.value(*col, row) {
        None => (false, true),
        Some(v) => (f(v), false),
    };
    match ir {
        Ir::True => (true, false),
        Ir::False => (false, false),
        Ir::Not { child } => {
            let (t, u) = naive_row(store, child, row);
            (!t && !u, u)
        }
        Ir::And { children } => {
            let mut t = true;
            let mut u = false;
            for child in children {
                let (ct, cu) = naive_row(store, child, row);
                if !ct && !cu {
                    return (false, false);
                }
                t &= ct;
                u |= cu;
            }
            (t && !u, !(t && !u) && u)
        }
        Ir::Or { children } => {
            let mut t = false;
            let mut u = false;
            for child in children {
                let (ct, cu) = naive_row(store, child, row);
                t |= ct;
                u |= cu;
            }
            (t, !t && u)
        }
        Ir::IsNull { col } => (store.value(*col, row).is_none(), false),
        Ir::EqVal { col, val } => cmp(col, &|v| v == *val),
        Ir::LtVal { col, val } => cmp(col, &|v| v < *val),
        Ir::GtVal { col, val } => cmp(col, &|v| v > *val),
        Ir::GeVal { col, val } => cmp(col, &|v| v >= *val),
        Ir::LeVal { col, val } => cmp(col, &|v| v <= *val),
        Ir::InVals { col, vals } => cmp(col, &|v| vals.contains(&v)),
        Ir::EqCol { col, other } => match (store.value(*col, row), store.value(*other, row)) {
            (Some(a), Some(b)) => (a == b, false),
            _ => (false, true),
        },
        Ir::LtCol { col, other } => match (store.value(*col, row), store.value(*other, row)) {
            (Some(a), Some(b)) => (a < b, false),
            _ => (false, true),
        },
        Ir::GtCol { col, other } => match (store.value(*col, row), store.value(*other, row)) {
            (Some(a), Some(b)) => (a > b, false),
            _ => (false, true),
        },
    }
}

fn assert_same(store: &Store, ir: &Ir, label: &str) {
    let got = ir::eval(store, ir);
    let want = naive(store, ir);
    for w in 0..words_for(store.row_count()) {
        assert_eq!(got.t[w], want.t[w], "{label}: true bits differ at word {w}");
        assert_eq!(got.u[w], want.u[w], "{label}: unknown bits differ at word {w}");
    }
}

fn col(store: &Store, name: &str) -> usize {
    store.column_index(name).unwrap_or_else(|| panic!("no column {name}"))
}

#[test]
fn every_scope_scans_like_a_row_walk() {
    let store = load();
    // one column per scope the artifact actually uses: block, pattern, alliance, id, score, diff, dict, bitmap
    for name in ["Map", "Gamemode", "Faction_1", "Unit_2", "Alliance_1", "UnitRecord_1", "ZERO_Score_1", "Logistics_Diff", "Asymmetry_Score", "Z_Pool"] {
        let c = col(&store, name);
        assert_same(&store, &Ir::IsNull { col: c }, &format!("{name} is_null"));
        assert_same(&store, &Ir::EqVal { col: c, val: 3 }, &format!("{name} == 3"));
        assert_same(&store, &Ir::LtVal { col: c, val: 5 }, &format!("{name} < 5"));
        assert_same(&store, &Ir::GeVal { col: c, val: 2 }, &format!("{name} >= 2"));
        assert_same(&store, &Ir::InVals { col: c, vals: vec![1, 4, 9, 17] }, &format!("{name} in vals"));
        assert_same(&store, &Ir::Not { child: Box::new(Ir::EqVal { col: c, val: 3 }) }, &format!("not {name} == 3"));
    }
}

#[test]
fn composition_matches_a_row_walk() {
    let store = load();
    let map = col(&store, "Map");
    let gamemode = col(&store, "Gamemode");
    let faction1 = col(&store, "Faction_1");
    let score = col(&store, "ZERO_Score_1");

    // an AND spanning all three scopes, which is the shape a pool filter takes
    assert_same(
        &store,
        &Ir::And {
            children: vec![
                Ir::InVals { col: map, vals: vec![0, 1, 2, 5, 9] },
                Ir::EqVal { col: gamemode, val: 2 },
                Ir::GtVal { col: faction1, val: 4 },
            ],
        },
        "and across scopes",
    );
    assert_same(
        &store,
        &Ir::Or {
            children: vec![Ir::EqVal { col: gamemode, val: 0 }, Ir::LtVal { col: score, val: 80000 }],
        },
        "or with a score column",
    );
    // negation over a nullable column is where a two-valued port would leak nulls
    assert_same(
        &store,
        &Ir::And {
            children: vec![
                Ir::Not { child: Box::new(Ir::LtVal { col: score, val: 80000 }) },
                Ir::EqVal { col: map, val: 3 },
            ],
        },
        "not over nulls",
    );
    assert_same(&store, &Ir::EqCol { col: faction1, other: col(&store, "Faction_2") }, "faction_1 == faction_2");
    assert_same(&store, &Ir::GtCol { col: score, other: col(&store, "ZERO_Score_2") }, "score_1 > score_2");
}

#[test]
fn candidate_narrowing_does_not_change_the_result() {
    let store = load();
    let map = col(&store, "Map");
    let score = col(&store, "ZERO_Score_1");
    // evaluating against a narrowed candidate must agree with evaluating wide and intersecting afterwards
    let wide = ir::eval(&store, &Ir::LtVal { col: score, val: 82000 });
    let cand = ir::eval(&store, &Ir::EqVal { col: map, val: 4 });
    let narrow = ir::eval_with(&store, &Ir::LtVal { col: score, val: 82000 }, &cand.t);
    for w in 0..words_for(store.row_count()) {
        assert_eq!(narrow.t[w], wide.t[w] & cand.t[w], "narrowed scan differs at word {w}");
    }
}

#[test]
fn ids_round_trip_through_the_row_space() {
    let store = load();
    let id = col(&store, "id");
    let rows = store.row_count();
    // ids must ascend, because row_of_id binary-searches them and preprocess relies on the ordering
    let mut previous = i64::MIN;
    for row in 0..rows {
        let value = store.value(id, row).expect("every row has an id");
        assert!(value > previous, "ids are not strictly ascending at row {row}");
        previous = value;
    }
    for row in (0..rows).step_by(9973) {
        let value = store.value(id, row).unwrap();
        assert_eq!(store.row_of_id(value as i32), Some(row), "id {value} did not resolve back to row {row}");
    }
    assert_eq!(store.row_of_id(-1), None);
}

#[test]
fn all_rows_covers_every_block() {
    let store = load();
    let cand = all_rows(store.row_count());
    let hits = ir::eval_with(&store, &Ir::True, &cand);
    assert_eq!(hits.count(), store.row_count());
    // blocks must tile the row space exactly, or a scan would silently skip or double-count rows
    let mut covered = 0usize;
    for block in 0..store.block_count() {
        let (start, end) = store.block_rows(block);
        assert_eq!(start, covered, "block {block} does not start where the previous one ended");
        covered = end;
    }
    assert_eq!(covered, store.row_count());
}

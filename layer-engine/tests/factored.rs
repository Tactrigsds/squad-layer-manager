//! Cross-checks the factored store, and the queries built on it, against a naive row-wise evaluation.
//!
//! The scans in ir.rs no longer touch rows one at a time: a layer's own column is evaluated once per block and a
//! per-team column once per availability pattern, then replayed. That is the whole speed argument and also the whole
//! risk, because a block or pattern offset that is off by one produces plausible bitsets rather than a crash. These
//! tests run every predicate shape over columns of every scope and compare bit for bit against `store.value`, which
//! resolves a row independently through `block_of`.

use layer_engine::gen::{self, StepSpec};
use layer_engine::ir::{self, all_rows, words_for, Ir, Tri};
use layer_engine::query::{self, FilterCache};
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
    let hits = ir::eval_with(&store, &Ir::True, &cand).into_hits();
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

#[test]
fn alliance_follows_faction() {
    let store = load();
    for team in ["1", "2"] {
        let alliance = col(&store, &format!("Alliance_{team}"));
        let faction = col(&store, &format!("Faction_{team}"));
        for row in (0..store.row_count()).step_by(7) {
            let want = store.value(faction, row).map(|f| store.faction_alliance()[f as usize] as i64);
            assert_eq!(store.value(alliance, row), want, "Alliance_{team} at row {row}");
        }
    }
}

#[test]
fn id_lookups_match_a_row_walk() {
    let store = load();
    let id = col(&store, "id");
    let map = col(&store, "Map");
    let mut vals: Vec<i64> = (0..store.row_count()).step_by(55_001).map(|row| store.value(id, row).unwrap()).collect();
    vals.extend([-1, 0, i32::MAX as i64 + 7, vals[0] + 1]);
    assert_same(&store, &Ir::InVals { col: id, vals: vals.clone() }, "id in");
    assert_same(&store, &Ir::EqVal { col: id, val: vals[3] }, "id ==");
    assert_same(&store, &Ir::Not { child: Box::new(Ir::InVals { col: id, vals: vals.clone() }) }, "not id in");
    assert_same(
        &store,
        &Ir::And { children: vec![Ir::LtVal { col: map, val: 20 }, Ir::InVals { col: id, vals }] },
        "map and id in",
    );
}

/// Pages a sorted select and compares it against a full sort of (null last, value, row), reversed for DESC with row
/// order kept for ties, which is the order the engine promises.
#[test]
fn sorted_pages_match_a_full_sort() {
    let store = load();
    let id = col(&store, "id");
    let map = col(&store, "Map");
    let where_ir = Ir::Or { children: vec![Ir::LtVal { col: map, val: 6 }, Ir::EqVal { col: col(&store, "Faction_1"), val: 4 }] };
    let hits = ir::eval(&store, &where_ir).into_hits();
    let mut cache = FilterCache::default();
    for name in ["Map", "Faction_1", "Alliance_2", "ZERO_Score_1", "Balance_Differential", "Asymmetry_Score", "Z_Pool"] {
        let c = col(&store, name);
        for dir in ["ASC", "DESC", "DESC:ABS"] {
            let abs = dir.ends_with(":ABS");
            let desc = dir.starts_with("DESC");
            let mut want: Vec<(bool, i64, usize)> = hits
                .rows()
                .map(|row| {
                    let v = store.value(c, row);
                    (v.is_none(), v.map(|x| if abs { x.abs() } else { x }).unwrap_or(0), row)
                })
                .collect();
            want.sort_by(|a, b| {
                let ord = (a.0, a.1).cmp(&(b.0, b.1));
                if desc {
                    ord.reverse().then(a.2.cmp(&b.2))
                } else {
                    ord.then(a.2.cmp(&b.2))
                }
            });
            let page_size = 50;
            let last = (want.len() - 1) / page_size;
            for page in [0, 3, last / 2, last, last + 1] {
                let request = serde_json::json!({
                    "kind": "select",
                    "where": where_ir,
                    "indicators": [],
                    "sort": { "column": { "col": c, "dir": dir } },
                    "pageIndex": page,
                    "pageSize": page_size,
                    "columns": [id],
                });
                let response = query::handle(&store, serde_json::from_value(request).unwrap(), &mut cache).unwrap();
                let response: serde_json::Value = serde_json::from_str(&response).unwrap();
                let got: Vec<i64> = response["rows"].as_array().unwrap().iter().map(|r| r[0].as_i64().unwrap()).collect();
                let expected: Vec<i64> =
                    want.iter().skip(page * page_size).take(page_size).map(|(_, _, row)| store.value(id, *row).unwrap()).collect();
                assert_eq!(got, expected, "{name} {dir} page {page}");
            }
        }
    }
}

#[test]
fn group_counts_match_a_row_walk() {
    let store = load();
    let map = col(&store, "Map");
    let gamemode = col(&store, "Gamemode");
    let f1 = col(&store, "Faction_1");
    let f2 = col(&store, "Faction_2");
    let hits = ir::eval(&store, &Ir::LtVal { col: col(&store, "Asymmetry_Score"), val: 30000 }).into_hits();
    let side = |cols: &[usize], radices: &[i64], row: usize| {
        cols.iter().zip(radices).fold(0i64, |key, (c, r)| key * r + store.value(*c, row).unwrap_or(-1) + 1)
    };
    let steps = [
        StepSpec { cols1: vec![map, gamemode], radices1: vec![300, 30], cols2: None, radices2: None, weights: vec![] },
        StepSpec { cols1: vec![f1], radices1: vec![200], cols2: Some(vec![f2]), radices2: Some(vec![200]), weights: vec![] },
    ];
    for step in &steps {
        let mut want: std::collections::HashMap<i64, u32> = std::collections::HashMap::new();
        for row in hits.rows() {
            let s1 = side(&step.cols1, &step.radices1, row);
            let key = match (&step.cols2, &step.radices2) {
                (Some(cols2), Some(radices2)) => {
                    let s2 = side(cols2, radices2, row);
                    let radix: i64 = radices2.iter().product();
                    s1.min(s2) * radix + s1.max(s2)
                }
                _ => s1,
            };
            *want.entry(key).or_insert(0) += 1;
        }
        let got: std::collections::HashMap<i64, u32> = gen::group_counts(&store, &hits, step).into_iter().collect();
        assert_eq!(got, want, "group counts over {:?}", step.cols1);
    }
}

fn select_count(store: &Store, cache: &mut FilterCache, where_ir: &Ir) -> u64 {
    let request = serde_json::json!({
        "kind": "select", "where": where_ir, "indicators": [], "sort": null, "pageIndex": 0, "pageSize": 1, "columns": [0],
    });
    let response = query::handle(store, serde_json::from_value(request).unwrap(), cache).unwrap();
    serde_json::from_str::<serde_json::Value>(&response).unwrap()["totalCount"].as_u64().unwrap()
}

#[test]
fn cached_conjuncts_do_not_change_the_result() {
    let store = load();
    let score = col(&store, "ZERO_Score_1");
    let pool = Ir::And {
        children: vec![
            Ir::Not { child: Box::new(Ir::InVals { col: col(&store, "Gamemode"), vals: vec![0, 1] }) },
            Ir::Not { child: Box::new(Ir::LtVal { col: score, val: 80000 }) },
        ],
    };
    let user = Ir::Or { children: vec![Ir::EqVal { col: col(&store, "Faction_1"), val: 4 }, Ir::IsNull { col: col(&store, "Z_Pool") }] };
    let both = Ir::And { children: vec![user.clone(), pool.clone(), Ir::Not { child: Box::new(Ir::EqVal { col: col(&store, "Map"), val: 3 }) }] };
    let want = naive(&store, &both).t.iter().map(|w| w.count_ones() as u64).sum::<u64>();

    assert_eq!(select_count(&store, &mut FilterCache::default(), &both), want, "cold cache");
    let mut cache = FilterCache::default();
    select_count(&store, &mut cache, &pool);
    select_count(&store, &mut cache, &user);
    assert_eq!(select_count(&store, &mut cache, &both), want, "conjuncts cached");
}

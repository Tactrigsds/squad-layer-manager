//! The query surface: everything the app asks of the layer db.
//!
//! Requests and responses are JSON. Values stay in their db encoding (enum indices, precision-scaled integers) and the
//! host decodes them with the same LC.fromDbValue it already uses, so the engine never needs to know what a faction
//! or a score means.

use crate::gen::{self, GenSpec, StepSpec};
use crate::ir::{eval, Ir, Tri};
use crate::store::Store;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::rc::Rc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Sort {
    #[serde(rename = "column")]
    Column { col: usize, dir: String },
    /// weighted generation: the pick order, the seed, and the layers other pages of this query already took
    #[serde(rename = "random")]
    Random {
        #[serde(flatten)]
        spec: GenSpec,
        exclude_ids: Vec<i32>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    /// page of layers, plus a bool per indicator condition for each returned row
    Select {
        r#where: Option<Ir>,
        indicators: Vec<Ir>,
        sort: Option<Sort>,
        page_index: usize,
        page_size: usize,
        columns: Vec<usize>,
    },
    /// distinct values of a column among the rows that pass the filter
    Distinct { r#where: Option<Ir>, col: usize },
    /// for each layer id: does it exist, and does it match each filter. Covers layer statuses, existence and
    /// out-of-pool in one shape.
    Matches { filters: Vec<Ir>, ids: Vec<i32> },
    /// every column of one layer
    Info { id: i32, columns: Vec<usize> },
    /// min/max of the given columns over the whole table
    Ranges { columns: Vec<usize> },
    /// how many layers fall in each group of a pick step, over the rows that pass the filter
    GroupCounts { r#where: Option<Ir>, step: StepSpec },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectResponse {
    pub total_count: usize,
    /// row-major, in the requested column order; null stays null
    pub rows: Vec<Vec<Option<i64>>>,
    /// per returned row, one bool per indicator
    pub indicators: Vec<Vec<bool>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchesResponse {
    pub exists: Vec<bool>,
    /// per filter, one bool per requested id
    pub matches: Vec<Vec<bool>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeResponse {
    pub col: usize,
    pub min: Option<i64>,
    pub max: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupCount {
    pub key: i64,
    pub count: u32,
}

pub type FilterCache = HashMap<String, Rc<Tri>>;

/// Evaluates a filter, reusing the bitset if this exact IR has been seen. The layer table never changes under the
/// engine, so a cached filter can't go stale: an edited filter simply lowers to different IR.
fn eval_cached(store: &Store, ir: &Ir, cache: &mut FilterCache) -> Rc<Tri> {
    let key = serde_json::to_string(ir).unwrap_or_default();
    if let Some(hit) = cache.get(&key) {
        return hit.clone();
    }
    let tri = Rc::new(eval(store, ir));
    cache.insert(key, tri.clone());
    tri
}

fn matched(store: &Store, filter: &Option<Ir>, cache: &mut FilterCache) -> Rc<Tri> {
    match filter {
        Some(ir) => eval_cached(store, ir, cache),
        None => Rc::new(Tri {
            t: crate::ir::all_rows(store.row_count()),
            u: vec![0; crate::ir::words_for(store.row_count())],
        }),
    }
}

fn project(store: &Store, row: usize, columns: &[usize]) -> Vec<Option<i64>> {
    columns.iter().map(|c| store.value(store.col(*c), row)).collect()
}

pub fn handle(store: &Store, id_col: usize, request: Request, cache: &mut FilterCache) -> Result<String, String> {
    match request {
        Request::Select { r#where, indicators, sort, page_index, page_size, columns } => {
            let hits = matched(store, &r#where, cache);
            let total_count = hits.count();

            let page: Vec<usize> = match sort {
                // weighted generation picks the page's layers itself: it isn't a sort, it's a draw
                Some(Sort::Random { spec, exclude_ids }) => {
                    let exclude: Vec<u32> = exclude_ids
                        .iter()
                        .filter_map(|id| store.row_of_id(id_col, *id).map(|r| r as u32))
                        .collect();
                    let spec = GenSpec { num_layers: page_size, ..spec };
                    gen::generate(store, &hits, &spec, &exclude).into_iter().map(|r| r as usize).collect()
                }
                Some(Sort::Column { col, dir }) => {
                    let c = store.col(col);
                    let abs = dir.ends_with(":ABS");
                    let desc = dir.starts_with("DESC");
                    let mut keyed: Vec<(bool, i64, usize)> = hits
                        .rows()
                        .map(|row| {
                            let v = store.value(c, row);
                            // SQLite sorts nulls first ascending, so a null sorts below every value; DESC just
                            // reverses that, putting them last
                            (v.is_none(), v.map(|x| if abs { x.abs() } else { x }).unwrap_or(0), row)
                        })
                        .collect();
                    keyed.sort_unstable_by(|a, b| {
                        let ord = (a.0, a.1).cmp(&(b.0, b.1));
                        // ties break on row order in both directions, so paging is stable
                        if desc { ord.reverse().then(a.2.cmp(&b.2)) } else { ord.then(a.2.cmp(&b.2)) }
                    });
                    keyed
                        .into_iter()
                        .skip(page_index * page_size)
                        .take(page_size)
                        .map(|(_, _, row)| row)
                        .collect()
                }
                None => hits.rows().skip(page_index * page_size).take(page_size).collect(),
            };

            let indicator_hits: Vec<Rc<Tri>> = indicators.iter().map(|ir| eval_cached(store, ir, cache)).collect();
            let rows: Vec<Vec<Option<i64>>> = page.iter().map(|row| project(store, *row, &columns)).collect();
            let indicator_rows: Vec<Vec<bool>> =
                page.iter().map(|row| indicator_hits.iter().map(|h| h.contains(*row)).collect()).collect();

            serde_json::to_string(&SelectResponse { total_count, rows, indicators: indicator_rows })
                .map_err(|e| e.to_string())
        }

        Request::Distinct { r#where, col } => {
            let hits = matched(store, &r#where, cache);
            let c = store.col(col);
            let mut seen: Vec<Option<i64>> = Vec::new();
            for row in hits.rows() {
                let v = store.value(c, row);
                if !seen.contains(&v) {
                    seen.push(v);
                }
            }
            serde_json::to_string(&seen).map_err(|e| e.to_string())
        }

        Request::Matches { filters, ids } => {
            let rows: Vec<Option<usize>> = ids.iter().map(|id| store.row_of_id(id_col, *id)).collect();
            let exists: Vec<bool> = rows.iter().map(|r| r.is_some()).collect();
            let matches: Vec<Vec<bool>> = filters
                .iter()
                .map(|ir| {
                    let hits = eval_cached(store, ir, cache);
                    rows.iter().map(|r| r.map(|row| hits.contains(row)).unwrap_or(false)).collect()
                })
                .collect();
            serde_json::to_string(&MatchesResponse { exists, matches }).map_err(|e| e.to_string())
        }

        Request::Info { id, columns } => {
            let row = store.row_of_id(id_col, id);
            let value = row.map(|r| project(store, r, &columns));
            serde_json::to_string(&value).map_err(|e| e.to_string())
        }

        Request::Ranges { columns } => {
            let ranges: Vec<RangeResponse> = columns
                .iter()
                .map(|col| {
                    let r = gen::range(store, *col);
                    RangeResponse { col: *col, min: r.map(|(lo, _)| lo), max: r.map(|(_, hi)| hi) }
                })
                .collect();
            serde_json::to_string(&ranges).map_err(|e| e.to_string())
        }

        Request::GroupCounts { r#where, step } => {
            let hits = matched(store, &r#where, cache);
            let counts = gen::group_counts(store, &hits, &step);
            let mut out: Vec<GroupCount> = counts.into_iter().map(|(key, count)| GroupCount { key, count }).collect();
            out.sort_unstable_by_key(|g| g.key);
            serde_json::to_string(&out).map_err(|e| e.to_string())
        }
    }
}

//! The query surface: everything the app asks of the layer db.
//!
//! Requests and responses are JSON. Values stay in their db encoding (enum indices, precision-scaled integers) and the
//! host decodes them with the same LC.fromDbValue it already uses, so the engine never needs to know what a faction
//! or a score means.

use crate::gen::{self, GenSpec, StepSpec};
use crate::ir::{self, eval, eval_with, Hits, Ir};
use crate::solve::{self, SolveSpec};
use crate::store::{BlockCursor, ColData, Store};
use crate::IntSet;
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
    /// reorder and team-swap a queue to clear repeat-rule violations. Doesn't read the table.
    SolveRepeats(SolveSpec),
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

/// Evaluated filters keyed by their serialized IR, least recently used evicted first. The layer table never changes
/// under the engine, so an entry can't go stale: an edited filter simply lowers to different IR.
#[derive(Default)]
pub struct FilterCache {
    entries: HashMap<String, (Rc<Hits>, u64)>,
    clock: u64,
}

/// A bitset over the 2.75M-row table is 344KB, so this caps the cache near 22MB.
const MAX_CACHED_FILTERS: usize = 64;

impl FilterCache {
    fn get(&mut self, key: &str) -> Option<Rc<Hits>> {
        self.clock += 1;
        let clock = self.clock;
        self.entries.get_mut(key).map(|(hits, used)| {
            *used = clock;
            hits.clone()
        })
    }

    fn insert(&mut self, key: String, hits: Rc<Hits>) {
        if self.entries.len() >= MAX_CACHED_FILTERS && !self.entries.contains_key(&key) {
            let oldest = self.entries.iter().min_by_key(|(_, (_, used))| *used).map(|(k, _)| k.clone());
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
            }
        }
        self.clock += 1;
        self.entries.insert(key, (hits, self.clock));
    }
}

fn cache_key(ir: &Ir) -> String {
    serde_json::to_string(ir).unwrap_or_default()
}

/// Evaluates a filter, reusing the bitset if this exact IR has been seen.
fn eval_cached(store: &Store, ir: &Ir, cache: &mut FilterCache) -> Rc<Hits> {
    let key = cache_key(ir);
    if let Some(hit) = cache.get(&key) {
        return hit;
    }
    let hits = Rc::new(match ir {
        Ir::And { children } => eval_conjunction(store, children, cache),
        _ => eval(store, ir).into_hits(),
    });
    cache.insert(key, hits.clone());
    hits
}

/// A top-level AND. Only TRUE survives a WHERE, so each conjunct narrows the candidate to its own true rows, and a
/// conjunct the cache already holds (a pool filter also asked for as an indicator or a layer status) is read from
/// the cache. That keeps a stable pool from being re-evaluated each time the user's own filter changes.
fn eval_conjunction(store: &Store, children: &[Ir], cache: &mut FilterCache) -> Hits {
    let mut running = ir::all_rows(store.row_count());
    let mut narrowed = false;
    let mut pending: Vec<(String, &Ir)> = Vec::new();
    for child in children {
        let key = cache_key(child);
        match cache.get(&key) {
            Some(hit) => {
                for (r, h) in running.iter_mut().zip(hit.bits.iter()) {
                    *r &= h;
                }
                narrowed = true;
            }
            None => pending.push((key, child)),
        }
    }
    pending.sort_by_key(|(_, child)| ir::cost(store, child));
    for (key, child) in pending {
        if running.iter().all(|w| *w == 0) {
            break;
        }
        let hits = eval_with(store, child, &running).into_hits();
        // only a conjunct evaluated over every row is a complete answer worth caching
        if !narrowed {
            cache.insert(key, Rc::new(hits.clone()));
            narrowed = true;
        }
        running = hits.bits;
    }
    Hits { bits: running }
}

fn matched(store: &Store, filter: &Option<Ir>, cache: &mut FilterCache) -> Rc<Hits> {
    match filter {
        Some(ir) => eval_cached(store, ir, cache),
        None => Rc::new(Hits::all(store.row_count())),
    }
}

/// Packs a sort value into the high `key_bits` of a u64 whose low bits carry a row or block index, so a page can be
/// selected and sorted as plain integers. Nulls sort after every value ascending and before every value descending.
/// Values are i32-derived (a score difference needs 34 bits), so they fit while the index takes at most 29 bits.
#[inline]
fn order_key(value: Option<i64>, abs: bool, desc: bool, key_bits: u32) -> u64 {
    let null = (1u64 << key_bits) - 1;
    let key = match value {
        None => null,
        Some(x) => {
            let x = if abs { x.saturating_abs() } else { x };
            x.saturating_add(1i64 << (key_bits - 1)).clamp(0, null as i64 - 1) as u64
        }
    };
    if desc {
        null - key
    } else {
        key
    }
}

fn index_bits(count: usize) -> u32 {
    (usize::BITS - count.saturating_sub(1).leading_zeros()).max(1)
}

/// Rows [offset, offset + len) of the hits ordered by `col`, ties broken by row order in both directions so paging is
/// stable. Only the page is ever sorted: the rows before it are partitioned off, not ordered.
fn sorted_page(store: &Store, hits: &Hits, total: usize, col: usize, dir: &str, offset: usize, len: usize) -> Vec<usize> {
    let abs = dir.ends_with(":ABS");
    let desc = dir.starts_with("DESC");
    if len == 0 || offset >= total {
        return Vec::new();
    }
    let len = len.min(total - offset);

    // a layer's own column orders whole blocks, and rows keep their order inside a block, so only blocks are sorted
    if let ColData::PerBlock(values) = store.col_data(col) {
        let shift = index_bits(store.block_count());
        let mut blocks: Vec<u64> = (0..store.block_count())
            .filter(|b| {
                let (start, end) = store.block_rows(*b);
                hits.any_in(start, end)
            })
            .map(|b| (order_key(values.get(b), abs, desc, 64 - shift) << shift) | b as u64)
            .collect();
        blocks.sort_unstable();
        let mut skip = offset;
        let mut page = Vec::with_capacity(len);
        for packed in blocks {
            let (start, end) = store.block_rows((packed & ((1u64 << shift) - 1)) as usize);
            let n = hits.count_in(start, end);
            if skip >= n {
                skip -= n;
                continue;
            }
            page.extend(hits.rows_in(start, end).skip(skip).take(len - page.len()));
            skip = 0;
            if page.len() == len {
                break;
            }
        }
        return page;
    }

    // hits come out ascending, so one cursor walk resolves every row's block and pattern row without a lookup each.
    // Reading through `store.value` here would binary-search the block table per row.
    let shift = index_bits(store.row_count());
    let reader = store.reader(col);
    let mut cursor = BlockCursor::new(store);
    let mut keyed: Vec<u64> = Vec::with_capacity(total);
    keyed.extend(hits.rows().map(|row| {
        let (block, pattern_row) = cursor.locate(row);
        (order_key(reader.read(block, pattern_row, row), abs, desc, 64 - shift) << shift) | row as u64
    }));
    let end = (offset + len).min(keyed.len());
    if end < keyed.len() {
        keyed.select_nth_unstable(end);
    }
    let head = &mut keyed[..end];
    if offset > 0 {
        head.select_nth_unstable(offset);
    }
    let page = &mut head[offset..];
    page.sort_unstable();
    page.iter().map(|k| (k & ((1u64 << shift) - 1)) as usize).collect()
}

fn project(store: &Store, row: usize, columns: &[usize]) -> Vec<Option<i64>> {
    columns.iter().map(|c| store.value(*c, row)).collect()
}

pub fn handle(store: &Store, request: Request, cache: &mut FilterCache) -> Result<String, String> {
    match request {
        Request::Select { r#where, indicators, sort, page_index, page_size, columns } => {
            let hits = matched(store, &r#where, cache);
            let total_count = hits.count();

            let page: Vec<usize> = match sort {
                // weighted generation picks the page's layers itself: it isn't a sort, it's a draw
                Some(Sort::Random { spec, exclude_ids }) => {
                    let exclude: Vec<u32> = exclude_ids
                        .iter()
                        .filter_map(|id| store.row_of_id(*id).map(|r| r as u32))
                        .collect();
                    let spec = GenSpec { num_layers: page_size, ..spec };
                    gen::generate(store, &hits, &spec, &exclude).into_iter().map(|r| r as usize).collect()
                }
                Some(Sort::Column { col, dir }) => {
                    sorted_page(store, &hits, total_count, col, &dir, page_index * page_size, page_size)
                }
                None => hits.rows().skip(page_index * page_size).take(page_size).collect(),
            };

            let indicator_hits: Vec<Rc<Hits>> = indicators.iter().map(|ir| eval_cached(store, ir, cache)).collect();
            let rows: Vec<Vec<Option<i64>>> = page.iter().map(|row| project(store, *row, &columns)).collect();
            let indicator_rows: Vec<Vec<bool>> =
                page.iter().map(|row| indicator_hits.iter().map(|h| h.contains(*row)).collect()).collect();

            serde_json::to_string(&SelectResponse { total_count, rows, indicators: indicator_rows })
                .map_err(|e| e.to_string())
        }

        Request::Distinct { r#where, col } => {
            let hits = matched(store, &r#where, cache);
            // membership is a set rather than a scan of `seen`: a column with 928 distinct values over 2.7M rows
            // costs a billion comparisons that way, which is most of what the layer-select filter menu waits on.
            // `seen` still carries the order values were first met in, which is the order the menu shows them in.
            let mut seen: Vec<Option<i64>> = Vec::new();
            let mut met: IntSet<Option<i64>> = IntSet::default();
            // A layer's own column takes one value per block, so the answer is settled by looking at the blocks that
            // hold a hit rather than the hits themselves: 928 lookups instead of hundreds of thousands.
            if let ColData::PerBlock(values) = store.col_data(col) {
                for block in 0..store.block_count() {
                    let (start, end) = store.block_rows(block);
                    if start < end && hits.any_in(start, end) {
                        let v = values.get(block);
                        if met.insert(v) {
                            seen.push(v);
                        }
                    }
                }
            } else if let ColData::PerPattern(values) = store.col_data(col) {
                // A per-team column repeats across every block sharing an availability pattern, and a pool filter is
                // usually made of layer-scope terms, so blocks tend to match whole. A block that does contributes
                // exactly its pattern's distinct values, which are worth computing once per pattern.
                let mut per_pattern: Vec<Option<Vec<Option<i64>>>> = vec![None; store.manifest.pattern_count];
                for block in 0..store.block_count() {
                    let (start, end) = store.block_rows(block);
                    if start == end || !hits.any_in(start, end) {
                        continue;
                    }
                    let pattern = store.block_pattern(block);
                    let (p_start, p_end) = store.pattern_rows(pattern);
                    if hits.all_in(start, end) {
                        let distinct = per_pattern[pattern].get_or_insert_with(|| {
                            let mut out: Vec<Option<i64>> = Vec::new();
                            let mut local: IntSet<Option<i64>> = IntSet::default();
                            for p in p_start..p_end {
                                let v = values.get(p);
                                if local.insert(v) {
                                    out.push(v);
                                }
                            }
                            out
                        });
                        for v in distinct.iter() {
                            if met.insert(*v) {
                                seen.push(*v);
                            }
                        }
                    } else {
                        let mut p = p_start;
                        for row in start..end {
                            if hits.contains(row) {
                                let v = values.get(p);
                                if met.insert(v) {
                                    seen.push(v);
                                }
                            }
                            p += 1;
                        }
                    }
                }
            } else {
                let reader = store.reader(col);
                let mut cursor = BlockCursor::new(store);
                for row in hits.rows() {
                    let (block, pattern_row) = cursor.locate(row);
                    let v = reader.read(block, pattern_row, row);
                    if met.insert(v) {
                        seen.push(v);
                    }
                }
            }
            serde_json::to_string(&seen).map_err(|e| e.to_string())
        }

        Request::Matches { filters, ids } => {
            let rows: Vec<Option<usize>> = ids.iter().map(|id| store.row_of_id(*id)).collect();
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
            let row = store.row_of_id(id);
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
        Request::SolveRepeats(spec) => {
            let res = solve::solve(&spec)?;
            serde_json::to_string(&res).map_err(|e| e.to_string())
        }
    }
}

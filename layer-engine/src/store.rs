//! The factored layer store, and the on-disk artifact preprocess writes.
//!
//! Layout: `SLMC3` magic, a u32 manifest length, the manifest as JSON, then the sections back to back, each padded to
//! a 4-byte boundary so u16/u32/i32 sections can be borrowed straight out of linear memory.
//!
//! Nothing is stored per row. Rows are packed-id order, which groups them into one contiguous block per layer, and a
//! block's rows are the cross product of that layer's faction/unit availability. So a layer's own columns are stored
//! once per block (928 of them), the per-team columns once per distinct availability pattern (314, shared by every
//! block that repeats one), and the score columns once per (layer, faction, unit) side record (8313). See
//! `src/models/layer-artifact.ts` for the writer and the full scope list.
//!
//! Two arrays carry the whole shape:
//!
//!   block_row_start[b]..block_row_start[b + 1]          the rows of block b
//!   pattern_row_start[p] + (row - block_row_start[b])   the pattern row behind `row`, where p = block_pattern[b]
//!
//! Everything else is a lookup off those. `ColData` exists so a scan can ask how a column varies *before* it enters
//! its row loop: a block-scope predicate runs 928 times, a pattern-scope one once per distinct pattern, and only the
//! genuinely per-row scopes pay per row.

use serde::{Deserialize, Serialize};

pub const MAGIC: &[u8; 5] = b"SLMC3";
pub const NULL_U8: u8 = 255;
pub const NULL_U16: u16 = 65535;
pub const NULL_I32: i32 = i32::MIN;

/// A `diff` column's per-row correction, two bits each: 0 leaves the difference alone, 1 adds one, 2 subtracts one.
const DIFF_CORRECTION: [i64; 4] = [0, 1, -1, 0];

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SectionSpec {
    /// "u8", "u16", "u32" or "i32"
    pub kind: String,
    pub offset: usize,
    pub len: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "scope", rename_all = "camelCase")]
pub enum ColumnSpec {
    Id { name: String },
    Block { name: String, section: usize },
    Pattern { name: String, section: usize },
    Alliance { name: String, team: u8 },
    Score { name: String, team: u8, metric: usize },
    Alias { name: String, of: usize },
    Diff { name: String, a: usize, b: usize, correction: Option<usize> },
    Bitmap { name: String, section: usize, nulls: Option<usize> },
    Dict { name: String, codes: usize, dict: usize },
}

impl ColumnSpec {
    pub fn name(&self) -> &str {
        match self {
            ColumnSpec::Id { name }
            | ColumnSpec::Block { name, .. }
            | ColumnSpec::Pattern { name, .. }
            | ColumnSpec::Alliance { name, .. }
            | ColumnSpec::Score { name, .. }
            | ColumnSpec::Alias { name, .. }
            | ColumnSpec::Diff { name, .. }
            | ColumnSpec::Bitmap { name, .. }
            | ColumnSpec::Dict { name, .. } => name,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub row_count: usize,
    pub layers_version: String,
    pub block_count: usize,
    pub pattern_count: usize,
    pub pattern_row_count: usize,
    pub score_count: usize,
    pub score_metrics: usize,
    pub layer_count: usize,
    pub faction_count: usize,
    pub unit_count: usize,
    pub columns: Vec<ColumnSpec>,
    pub sections: Vec<SectionSpec>,
    pub block_row_start: usize,
    pub block_pattern: usize,
    pub pattern_row_start: usize,
    pub faction_alliance: usize,
    pub score_key: usize,
    pub score_layer_start: usize,
    pub score_vals: usize,
}

/// An enum column: one byte per entry until its component list outgrows a byte.
#[derive(Clone, Copy)]
pub enum Enum<'a> {
    U8(&'a [u8]),
    U16(&'a [u16]),
}

impl Enum<'_> {
    #[inline]
    pub fn get(&self, i: usize) -> Option<i64> {
        match self {
            Enum::U8(c) => match c[i] {
                NULL_U8 => None,
                v => Some(v as i64),
            },
            Enum::U16(c) => match c[i] {
                NULL_U16 => None,
                v => Some(v as i64),
            },
        }
    }
}

/// How a column varies, so a scan can hoist the lookup out of its row loop. `PerRow` is the fallback for the scopes
/// whose value depends on the block and the pattern row together.
#[derive(Clone, Copy)]
pub enum ColData<'a> {
    PerBlock(Enum<'a>),
    PerPattern(Enum<'a>),
    PerRow,
}

pub struct Store {
    pub manifest: Manifest,
    bytes: Vec<u8>,
    data_start: usize,
    /// copied out at load rather than borrowed: they are small, and owning them keeps `Store` free of a
    /// self-referential lifetime every caller would otherwise have to thread
    block_row_start: Vec<u32>,
    block_pattern: Vec<u16>,
    pattern_row_start: Vec<u32>,
    faction_alliance: Vec<u8>,
    score_key: Vec<u32>,
    score_layer_start: Vec<u32>,
    /// the columns the id packing and side-record lookups need, resolved once
    layer_col: usize,
    faction_col: [usize; 2],
    unit_col: [usize; 2],
}

impl Store {
    pub fn load(bytes: Vec<u8>) -> Result<Store, String> {
        if bytes.len() < 9 || &bytes[0..5] != MAGIC {
            return Err("not a layer engine artifact (expected SLMC3; rebuild with pnpm preprocess)".into());
        }
        let manifest_len = u32::from_le_bytes([bytes[5], bytes[6], bytes[7], bytes[8]]) as usize;
        let manifest: Manifest = serde_json::from_slice(&bytes[9..9 + manifest_len]).map_err(|e| format!("bad manifest: {e}"))?;
        let header = 9 + manifest_len;
        let data_start = header + (4 - (header % 4)) % 4;
        // sections are borrowed as aligned slices of linear memory rather than copied, so the data has to start
        // 4-aligned. Both allocators we run on hand back 8-aligned buffers; check rather than risk UB if that changes.
        if (bytes.as_ptr() as usize + data_start) % 4 != 0 {
            return Err("layer artifact is not 4-byte aligned in memory".into());
        }

        let find = |name: &str| manifest.columns.iter().position(|c| c.name() == name);
        let layer_col = find("Layer").ok_or("artifact has no Layer column")?;
        let faction_col = [
            find("Faction_1").ok_or("artifact has no Faction_1 column")?,
            find("Faction_2").ok_or("artifact has no Faction_2 column")?,
        ];
        let unit_col = [
            find("Unit_1").ok_or("artifact has no Unit_1 column")?,
            find("Unit_2").ok_or("artifact has no Unit_2 column")?,
        ];

        let mut store = Store {
            manifest,
            bytes,
            data_start,
            block_row_start: Vec::new(),
            block_pattern: Vec::new(),
            pattern_row_start: Vec::new(),
            faction_alliance: Vec::new(),
            score_key: Vec::new(),
            score_layer_start: Vec::new(),
            layer_col,
            faction_col,
            unit_col,
        };
        store.block_row_start = store.u32_section(store.manifest.block_row_start).to_vec();
        store.block_pattern = store.u16_section(store.manifest.block_pattern).to_vec();
        store.pattern_row_start = store.u32_section(store.manifest.pattern_row_start).to_vec();
        store.faction_alliance = store.u8_section(store.manifest.faction_alliance).to_vec();
        store.score_key = store.u32_section(store.manifest.score_key).to_vec();
        store.score_layer_start = store.u32_section(store.manifest.score_layer_start).to_vec();

        if store.block_row_start.len() != store.manifest.block_count + 1 {
            return Err("blockRowStart does not match blockCount".into());
        }
        if *store.block_row_start.last().unwrap() as usize != store.manifest.row_count {
            return Err("blockRowStart does not end at rowCount".into());
        }
        Ok(store)
    }

    // ---------------------------- sections ----------------------------

    fn section_bytes(&self, index: usize) -> (&[u8], &SectionSpec) {
        let spec = &self.manifest.sections[index];
        let width = match spec.kind.as_str() {
            "u8" => 1,
            "u16" => 2,
            _ => 4,
        };
        let start = self.data_start + spec.offset;
        (&self.bytes[start..start + spec.len * width], spec)
    }

    pub fn u8_section(&self, index: usize) -> &[u8] {
        self.section_bytes(index).0
    }

    pub fn u16_section(&self, index: usize) -> &[u16] {
        let (bytes, spec) = self.section_bytes(index);
        debug_assert!(bytes.as_ptr() as usize % 2 == 0);
        unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const u16, spec.len) }
    }

    pub fn u32_section(&self, index: usize) -> &[u32] {
        let (bytes, spec) = self.section_bytes(index);
        debug_assert!(bytes.as_ptr() as usize % 4 == 0);
        unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const u32, spec.len) }
    }

    pub fn i32_section(&self, index: usize) -> &[i32] {
        let (bytes, spec) = self.section_bytes(index);
        debug_assert!(bytes.as_ptr() as usize % 4 == 0);
        unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const i32, spec.len) }
    }

    fn enum_section(&self, index: usize) -> Enum<'_> {
        match self.manifest.sections[index].kind.as_str() {
            "u8" => Enum::U8(self.u8_section(index)),
            _ => Enum::U16(self.u16_section(index)),
        }
    }

    // ---------------------------- structure ----------------------------

    pub fn row_count(&self) -> usize {
        self.manifest.row_count
    }

    pub fn block_count(&self) -> usize {
        self.manifest.block_count
    }

    #[inline]
    pub fn block_rows(&self, block: usize) -> (usize, usize) {
        (self.block_row_start[block] as usize, self.block_row_start[block + 1] as usize)
    }

    #[inline]
    pub fn block_pattern(&self, block: usize) -> usize {
        self.block_pattern[block] as usize
    }

    /// The pattern rows behind a pattern, as a range into every pattern-scope section.
    #[inline]
    pub fn pattern_rows(&self, pattern: usize) -> (usize, usize) {
        (self.pattern_row_start[pattern] as usize, self.pattern_row_start[pattern + 1] as usize)
    }

    /// The block a row falls in. Blocks are contiguous and ascending, so this is a binary search over 928 entries.
    pub fn block_of(&self, row: usize) -> usize {
        let mut lo = 0usize;
        let mut hi = self.manifest.block_count - 1;
        while lo < hi {
            let mid = lo.midpoint(hi + 1);
            if (self.block_row_start[mid] as usize) <= row {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        lo
    }

    #[inline]
    pub fn pattern_row_of(&self, block: usize, row: usize) -> usize {
        self.pattern_row_start[self.block_pattern(block)] as usize + (row - self.block_row_start[block] as usize)
    }

    // ---------------------------- columns ----------------------------

    pub fn column_index(&self, name: &str) -> Option<usize> {
        self.manifest.columns.iter().position(|c| c.name() == name)
    }

    pub fn column_names(&self) -> Vec<String> {
        self.manifest.columns.iter().map(|c| c.name().to_string()).collect()
    }

    /// Strips aliases, so callers never see a column that is only another one's name. The writer only ever aliases
    /// backwards, so this terminates.
    pub fn resolve(&self, col: usize) -> usize {
        let mut col = col;
        while let ColumnSpec::Alias { of, .. } = &self.manifest.columns[col] {
            col = *of;
        }
        col
    }

    /// How the column varies. Ask once per predicate, then run the matching loop.
    pub fn col_data(&self, col: usize) -> ColData<'_> {
        match &self.manifest.columns[self.resolve(col)] {
            ColumnSpec::Block { section, .. } => ColData::PerBlock(self.enum_section(*section)),
            ColumnSpec::Pattern { section, .. } => ColData::PerPattern(self.enum_section(*section)),
            _ => ColData::PerRow,
        }
    }

    /// Reads any column at one row. Used where access is genuinely random (projecting a page, sort keys, Info);
    /// scans go through `col_data` so they never pay this match per row.
    pub fn value(&self, col: usize, row: usize) -> Option<i64> {
        let col = self.resolve(col);
        match &self.manifest.columns[col] {
            ColumnSpec::Alias { .. } => None,
            ColumnSpec::Block { section, .. } => self.enum_section(*section).get(self.block_of(row)),
            ColumnSpec::Pattern { section, .. } => {
                let block = self.block_of(row);
                self.enum_section(*section).get(self.pattern_row_of(block, row))
            }
            ColumnSpec::Alliance { team, .. } => {
                let faction = self.value(self.faction_col[*team as usize - 1], row)?;
                Some(self.faction_alliance[faction as usize] as i64)
            }
            ColumnSpec::Id { .. } => {
                let block = self.block_of(row);
                self.packed_id(block, self.pattern_row_of(block, row))
            }
            ColumnSpec::Score { team, metric, .. } => {
                let block = self.block_of(row);
                let record = self.side_record(block, self.pattern_row_of(block, row), *team)?;
                self.score_value(record, *metric)
            }
            ColumnSpec::Diff { a, b, correction, .. } => {
                let x = self.value(*a, row)?;
                let y = self.value(*b, row)?;
                Some(x - y + self.diff_correction(*correction, row))
            }
            ColumnSpec::Bitmap { section, nulls, .. } => {
                if let Some(nulls) = nulls {
                    if (self.u8_section(*nulls)[row >> 3] >> (row & 7)) & 1 == 1 {
                        return None;
                    }
                }
                Some(((self.u8_section(*section)[row >> 3] >> (row & 7)) & 1) as i64)
            }
            ColumnSpec::Dict { codes, dict, .. } => match self.u16_section(*codes)[row] {
                NULL_U16 => None,
                code => Some(self.i32_section(*dict)[code as usize] as i64),
            },
        }
    }

    #[inline]
    pub fn score_value(&self, record: usize, metric: usize) -> Option<i64> {
        match self.i32_section(self.manifest.score_vals)[record * self.manifest.score_metrics + metric] {
            NULL_I32 => None,
            v => Some(v as i64),
        }
    }

    #[inline]
    fn diff_correction(&self, section: Option<usize>, row: usize) -> i64 {
        match section {
            None => 0,
            Some(section) => DIFF_CORRECTION[((self.u8_section(section)[row >> 2] >> ((row & 3) * 2)) & 3) as usize],
        }
    }

    /// The mixed-radix packing of (Layer, Faction_1, Unit_1, Faction_2, Unit_2) that ids use. Mirrors LC.packId.
    pub fn packed_id(&self, block: usize, pattern_row: usize) -> Option<i64> {
        let layer = self.block_enum(self.layer_col)?.get(block)?;
        let factions = self.manifest.faction_count as i64;
        let units = self.manifest.unit_count as i64;
        let f1 = self.pattern_enum(self.faction_col[0])?.get(pattern_row)?;
        let u1 = self.pattern_enum(self.unit_col[0])?.get(pattern_row)?;
        let f2 = self.pattern_enum(self.faction_col[1])?.get(pattern_row)?;
        let u2 = self.pattern_enum(self.unit_col[1])?.get(pattern_row)?;
        Some((((layer * factions + f1) * units + u1) * factions + f2) * units + u2)
    }

    pub fn block_enum(&self, col: usize) -> Option<Enum<'_>> {
        match &self.manifest.columns[self.resolve(col)] {
            ColumnSpec::Block { section, .. } => Some(self.enum_section(*section)),
            _ => None,
        }
    }

    pub fn pattern_enum(&self, col: usize) -> Option<Enum<'_>> {
        match &self.manifest.columns[self.resolve(col)] {
            ColumnSpec::Pattern { section, .. } => Some(self.enum_section(*section)),
            _ => None,
        }
    }

    /// The side record for one team of one row, or None. Records are sorted and layer-major, so only the block's own
    /// layer range is searched.
    pub fn side_record(&self, block: usize, pattern_row: usize, team: u8) -> Option<usize> {
        let layer = self.block_enum(self.layer_col)?.get(block)?;
        let faction = self.pattern_enum(self.faction_col[team as usize - 1])?.get(pattern_row)?;
        let unit = self.pattern_enum(self.unit_col[team as usize - 1])?.get(pattern_row)?;
        let key = ((layer * self.manifest.faction_count as i64 + faction) * self.manifest.unit_count as i64 + unit) as u32;
        let lo = self.score_layer_start[layer as usize] as usize;
        let hi = self.score_layer_start[layer as usize + 1] as usize;
        self.score_key[lo..hi].binary_search(&key).ok().map(|i| i + lo)
    }

    /// The row holding a packed id, if the table has one. Rows ascend by id, so this binary-searches the row space
    /// and recomputes the id at each step rather than reading a stored column.
    pub fn row_of_id(&self, id: i32) -> Option<usize> {
        let target = id as i64;
        let mut lo = 0usize;
        let mut hi = self.manifest.row_count;
        while lo < hi {
            let mid = lo.midpoint(hi);
            let block = self.block_of(mid);
            let value = self.packed_id(block, self.pattern_row_of(block, mid))?;
            match value.cmp(&target) {
                std::cmp::Ordering::Equal => return Some(mid),
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
            }
        }
        None
    }

    pub fn faction_alliance(&self) -> &[u8] {
        &self.faction_alliance
    }

    /// The side-table metric behind a score column, so callers that only need its value universe can read the 8313
    /// records instead of the row space.
    pub fn score_metric_of(&self, col: usize) -> Option<usize> {
        match &self.manifest.columns[self.resolve(col)] {
            ColumnSpec::Score { metric, .. } => Some(*metric),
            _ => None,
        }
    }

    /// A dictionary column's distinct values, which is its whole value universe.
    pub fn dictionary_of(&self, col: usize) -> Option<&[i32]> {
        match &self.manifest.columns[self.resolve(col)] {
            ColumnSpec::Dict { dict, .. } => Some(self.i32_section(*dict)),
            _ => None,
        }
    }

    pub fn is_bitmap(&self, col: usize) -> bool {
        matches!(&self.manifest.columns[self.resolve(col)], ColumnSpec::Bitmap { .. })
    }
}

/// A column resolved down to the slices it reads, built once per column per query.
///
/// Scans walk the table block by block, so they already know the block and pattern row for free and never pay
/// `block_of`. `Reader::read` takes both, which is what lets every scope share one loop without a per-row match on
/// the column spec.
pub enum Reader<'a> {
    Block(Enum<'a>),
    Pattern(Enum<'a>),
    Alliance { faction: Enum<'a>, alliance: &'a [u8] },
    Id { layer: Enum<'a>, sides: [Enum<'a>; 4], factions: i64, units: i64 },
    Score { layer: Enum<'a>, faction: Enum<'a>, unit: Enum<'a>, keys: &'a [u32], layer_start: &'a [u32], vals: &'a [i32], metrics: usize, metric: usize, factions: i64, units: i64 },
    Diff { a: Box<Reader<'a>>, b: Box<Reader<'a>>, correction: Option<&'a [u8]> },
    Bitmap { bits: &'a [u8], nulls: Option<&'a [u8]> },
    Dict { codes: &'a [u16], dict: &'a [i32] },
    None,
}

impl Reader<'_> {
    #[inline]
    pub fn read(&self, block: usize, pattern_row: usize, row: usize) -> Option<i64> {
        match self {
            Reader::Block(values) => values.get(block),
            Reader::Pattern(values) => values.get(pattern_row),
            Reader::Alliance { faction, alliance } => Some(alliance[faction.get(pattern_row)? as usize] as i64),
            Reader::Id { layer, sides, factions, units } => {
                let l = layer.get(block)?;
                let f1 = sides[0].get(pattern_row)?;
                let u1 = sides[1].get(pattern_row)?;
                let f2 = sides[2].get(pattern_row)?;
                let u2 = sides[3].get(pattern_row)?;
                Some((((l * factions + f1) * units + u1) * factions + f2) * units + u2)
            }
            Reader::Score { layer, faction, unit, keys, layer_start, vals, metrics, metric, factions, units } => {
                let l = layer.get(block)?;
                let key = ((l * factions + faction.get(pattern_row)?) * units + unit.get(pattern_row)?) as u32;
                let lo = layer_start[l as usize] as usize;
                let hi = layer_start[l as usize + 1] as usize;
                let record = lo + keys[lo..hi].binary_search(&key).ok()?;
                match vals[record * metrics + metric] {
                    NULL_I32 => None,
                    v => Some(v as i64),
                }
            }
            Reader::Diff { a, b, correction } => {
                let x = a.read(block, pattern_row, row)?;
                let y = b.read(block, pattern_row, row)?;
                let trit = match correction {
                    None => 0,
                    Some(bits) => ((bits[row >> 2] >> ((row & 3) * 2)) & 3) as usize,
                };
                Some(x - y + DIFF_CORRECTION[trit])
            }
            Reader::Bitmap { bits, nulls } => {
                if let Some(nulls) = nulls {
                    if (nulls[row >> 3] >> (row & 7)) & 1 == 1 {
                        return None;
                    }
                }
                Some(((bits[row >> 3] >> (row & 7)) & 1) as i64)
            }
            Reader::Dict { codes, dict } => match codes[row] {
                NULL_U16 => None,
                code => Some(dict[code as usize] as i64),
            },
            Reader::None => None,
        }
    }
}

impl Store {
    pub fn reader(&self, col: usize) -> Reader<'_> {
        let col = self.resolve(col);
        let factions = self.manifest.faction_count as i64;
        let units = self.manifest.unit_count as i64;
        match &self.manifest.columns[col] {
            ColumnSpec::Alias { .. } => Reader::None,
            ColumnSpec::Block { section, .. } => Reader::Block(self.enum_section(*section)),
            ColumnSpec::Pattern { section, .. } => Reader::Pattern(self.enum_section(*section)),
            ColumnSpec::Alliance { team, .. } => match self.pattern_enum(self.faction_col[*team as usize - 1]) {
                Some(faction) => Reader::Alliance { faction, alliance: &self.faction_alliance },
                None => Reader::None,
            },
            ColumnSpec::Id { .. } => {
                let sides = [
                    self.pattern_enum(self.faction_col[0]),
                    self.pattern_enum(self.unit_col[0]),
                    self.pattern_enum(self.faction_col[1]),
                    self.pattern_enum(self.unit_col[1]),
                ];
                match (self.block_enum(self.layer_col), sides) {
                    (Some(layer), [Some(f1), Some(u1), Some(f2), Some(u2)]) => {
                        Reader::Id { layer, sides: [f1, u1, f2, u2], factions, units }
                    }
                    _ => Reader::None,
                }
            }
            ColumnSpec::Score { team, metric, .. } => {
                let layer = self.block_enum(self.layer_col);
                let faction = self.pattern_enum(self.faction_col[*team as usize - 1]);
                let unit = self.pattern_enum(self.unit_col[*team as usize - 1]);
                match (layer, faction, unit) {
                    (Some(layer), Some(faction), Some(unit)) => Reader::Score {
                        layer,
                        faction,
                        unit,
                        keys: &self.score_key,
                        layer_start: &self.score_layer_start,
                        vals: self.i32_section(self.manifest.score_vals),
                        metrics: self.manifest.score_metrics,
                        metric: *metric,
                        factions,
                        units,
                    },
                    _ => Reader::None,
                }
            }
            ColumnSpec::Diff { a, b, correction, .. } => Reader::Diff {
                a: Box::new(self.reader(*a)),
                b: Box::new(self.reader(*b)),
                correction: correction.map(|s| self.u8_section(s)),
            },
            ColumnSpec::Bitmap { section, nulls, .. } => {
                Reader::Bitmap { bits: self.u8_section(*section), nulls: nulls.map(|s| self.u8_section(s)) }
            }
            ColumnSpec::Dict { codes, dict, .. } => {
                Reader::Dict { codes: self.u16_section(*codes), dict: self.i32_section(*dict) }
            }
        }
    }
}

/// Walks ascending rows without a binary search per row. Every caller here iterates rows in order, so the block only
/// ever moves forward and the pattern row falls out of the block's offset.
pub struct BlockCursor<'a> {
    store: &'a Store,
    block: usize,
    end: usize,
    start: usize,
    pattern_start: usize,
}

impl<'a> BlockCursor<'a> {
    pub fn new(store: &'a Store) -> Self {
        let (start, end) = store.block_rows(0);
        BlockCursor { store, block: 0, start, end, pattern_start: store.pattern_rows(store.block_pattern(0)).0 }
    }

    #[inline]
    pub fn locate(&mut self, row: usize) -> (usize, usize) {
        while row >= self.end && self.block + 1 < self.store.block_count() {
            self.block += 1;
            let (start, end) = self.store.block_rows(self.block);
            self.start = start;
            self.end = end;
            self.pattern_start = self.store.pattern_rows(self.store.block_pattern(self.block)).0;
        }
        (self.block, self.pattern_start + (row - self.start))
    }
}

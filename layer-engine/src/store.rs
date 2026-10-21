//! The factored layer store, and the on-disk artifact preprocess writes.
//!
//! Layout: `SLMC3` magic, a u32 manifest length, the manifest as JSON, then the sections back to back, each padded to
//! a 4-byte boundary so u16/u32/i32 sections can be borrowed straight out of linear memory.
//!
//! Nothing is stored per row. Rows are layer-id order, which groups them into one contiguous block per layer, and a
//! block's rows are the cross product of that layer's faction/unit availability. So a layer's own columns are stored
//! once per block (928 of them), the per-team columns once per distinct availability pattern (314, shared by every
//! block that repeats one), and the score columns once per (layer, faction, unit) side record (8313). See
//! `src/models/layer-artifact.models.ts` for the writer and the full scope list.
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
use std::cell::{OnceCell, RefCell};

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

    /// The raw code at `i`, null included, for tallying into an array of `slots()` counters.
    #[inline]
    pub fn code(&self, i: usize) -> usize {
        match self {
            Enum::U8(c) => c[i] as usize,
            Enum::U16(c) => c[i] as usize,
        }
    }

    pub fn slots(&self) -> usize {
        match self {
            Enum::U8(_) => NULL_U8 as usize + 1,
            Enum::U16(_) => NULL_U16 as usize + 1,
        }
    }

    pub fn decode(&self, code: usize) -> Option<i64> {
        if code == self.slots() - 1 {
            None
        } else {
            Some(code as i64)
        }
    }
}

/// A per-team column's value counts within each availability pattern, in the order values first appear there. A block
/// whose rows all match contributes its pattern's counts whole, without visiting a row.
pub struct PatternCounts {
    /// per pattern, where its entries start; one extra entry closes the last pattern
    pub start: Vec<u32>,
    pub codes: Vec<u32>,
    pub counts: Vec<u32>,
}

/// Per pattern, a list of pattern rows.
pub struct PatternRows {
    /// per pattern, where its rows start; one extra entry closes the last pattern
    start: Vec<u32>,
    rows: Vec<u32>,
}

impl PatternRows {
    fn of(&self, pattern: usize) -> &[u32] {
        &self.rows[self.start[pattern] as usize..self.start[pattern + 1] as usize]
    }
}

impl PatternCounts {
    pub fn of(&self, pattern: usize) -> (&[u32], &[u32]) {
        let range = self.start[pattern] as usize..self.start[pattern + 1] as usize;
        (&self.codes[range.clone()], &self.counts[range])
    }
}

/// An owned enum column, for the ones derived at load rather than read out of the artifact.
enum Codes {
    U8(Vec<u8>),
    U16(Vec<u16>),
}

impl Codes {
    fn as_enum(&self) -> Enum<'_> {
        match self {
            Codes::U8(c) => Enum::U8(c),
            Codes::U16(c) => Enum::U16(c),
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
    /// Alliance_1/2 per pattern row. The artifact derives alliance from faction, so it varies per pattern row like any
    /// per-team column; materializing it lets alliance predicates take the per-pattern scan instead of the per-row one.
    alliance: [Codes; 2],
    /// Per team, the side pair (a distinct faction and unit) of each pattern row, or NULL_U16. With `pair_record`
    /// this turns a score read into two array lookups rather than a binary search over the layer's side records.
    side_pair: [Vec<u16>; 2],
    pair_count: usize,
    /// layer * pair_count + side pair -> the side record's offset from the layer's first record, or NULL_U16
    pair_record: Vec<u16>,
    /// min/max per column, computed on first ask: the table never changes, and a per-row column costs a full walk
    pub(crate) ranges: Vec<OnceCell<Option<(i64, i64)>>>,
    /// per column, built on first ask
    pattern_counts: Vec<OnceCell<PatternCounts>>,
    /// Per column, per block: None until a query needs the whole block, then the block's min/max (None inside when
    /// every value is null). Filled block by block, so no query pays for blocks it never asked about.
    block_ranges: Vec<RefCell<Vec<Option<Option<(i64, i64)>>>>>,
    /// Per team, per pattern, one pattern row for each distinct side pair the pattern holds. A score column takes
    /// one value per side pair within a block, so these rows alone settle a block's score range.
    side_pair_rows: [OnceCell<PatternRows>; 2],
    /// the columns the id and side-record lookups need, resolved once
    layer_col: usize,
    faction_col: [usize; 2],
    unit_col: [usize; 2],
    /// Layer ids are dense: the layer index shifted left by `id_local_bits`, or'd with the row's cell in its layer's
    /// option grid. The host owns the layout (LC.denseIdLayout) and hands every pattern row's cell over through
    /// `set_id_cells`; until it does, no row has an id.
    id_local_bits: u32,
    /// per pattern row, its cell
    pattern_row_cell: Vec<u32>,
    /// per pattern, where its cells start in `cell_pattern_row`; one extra entry closes the last pattern
    pattern_cell_start: Vec<u32>,
    /// per cell, the pattern row filling it as an offset from the pattern's first row, or NO_ROW
    cell_pattern_row: Vec<u32>,
    /// layer index -> block, or NO_BLOCK for a layer with no rows
    layer_block: Vec<u32>,
}

const NO_ROW: u32 = u32::MAX;
const NO_BLOCK: u32 = u32::MAX;
/// a JS engine keeps an integer inline (unboxed) below 2^30 on every platform we run on
const MAX_ID_BITS: u32 = 30;

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
            alliance: [Codes::U8(Vec::new()), Codes::U8(Vec::new())],
            side_pair: [Vec::new(), Vec::new()],
            pair_count: 0,
            pair_record: Vec::new(),
            ranges: Vec::new(),
            pattern_counts: Vec::new(),
            block_ranges: Vec::new(),
            side_pair_rows: [OnceCell::new(), OnceCell::new()],
            layer_col,
            faction_col,
            unit_col,
            id_local_bits: 0,
            pattern_row_cell: Vec::new(),
            pattern_cell_start: Vec::new(),
            cell_pattern_row: Vec::new(),
            layer_block: Vec::new(),
        };
        store.block_row_start = store.u32_section(store.manifest.block_row_start).to_vec();
        store.block_pattern = store.u16_section(store.manifest.block_pattern).to_vec();
        store.pattern_row_start = store.u32_section(store.manifest.pattern_row_start).to_vec();
        store.faction_alliance = store.u8_section(store.manifest.faction_alliance).to_vec();
        store.score_key = store.u32_section(store.manifest.score_key).to_vec();
        store.score_layer_start = store.u32_section(store.manifest.score_layer_start).to_vec();
        store.alliance = [store.derive_alliance(0)?, store.derive_alliance(1)?];
        store.index_side_records()?;
        store.index_layer_blocks()?;
        store.ranges = (0..store.manifest.columns.len()).map(|_| OnceCell::new()).collect();
        store.pattern_counts = (0..store.manifest.columns.len()).map(|_| OnceCell::new()).collect();
        store.block_ranges = (0..store.manifest.columns.len()).map(|_| RefCell::new(Vec::new())).collect();

        if store.block_row_start.len() != store.manifest.block_count + 1 {
            return Err("blockRowStart does not match blockCount".into());
        }
        if *store.block_row_start.last().unwrap() as usize != store.manifest.row_count {
            return Err("blockRowStart does not end at rowCount".into());
        }
        Ok(store)
    }

    fn derive_alliance(&self, team: usize) -> Result<Codes, String> {
        let faction = self.pattern_enum(self.faction_col[team]).ok_or("Faction columns must be pattern scope")?;
        let alliance_of = |p: usize| faction.get(p).and_then(|f| self.faction_alliance.get(f as usize).copied());
        let rows = self.manifest.pattern_row_count;
        // an alliance index of 255 would read back as null in a u8 column
        if self.faction_alliance.contains(&NULL_U8) {
            Ok(Codes::U16((0..rows).map(|p| alliance_of(p).map_or(NULL_U16, |a| a as u16)).collect()))
        } else {
            Ok(Codes::U8((0..rows).map(|p| alliance_of(p).unwrap_or(NULL_U8)).collect()))
        }
    }

    fn index_side_records(&mut self) -> Result<(), String> {
        let units = self.manifest.unit_count;
        let sides = self.manifest.faction_count * units;
        // faction * units + unit -> side pair, numbered in order of first appearance
        let mut pair_of = vec![NULL_U16; sides];
        let mut pairs = 0usize;
        let mut side_pair = [Vec::new(), Vec::new()];
        for (team, out) in side_pair.iter_mut().enumerate() {
            let faction = self.pattern_enum(self.faction_col[team]).ok_or("Faction columns must be pattern scope")?;
            let unit = self.pattern_enum(self.unit_col[team]).ok_or("Unit columns must be pattern scope")?;
            *out = Vec::with_capacity(self.manifest.pattern_row_count);
            for p in 0..self.manifest.pattern_row_count {
                let pair = match (faction.get(p), unit.get(p)) {
                    (Some(f), Some(u)) => {
                        let slot = pair_of.get_mut(f as usize * units + u as usize).ok_or("faction or unit out of range")?;
                        if *slot == NULL_U16 {
                            *slot = u16::try_from(pairs).ok().filter(|p| *p != NULL_U16).ok_or("too many faction/unit pairs")?;
                            pairs += 1;
                        }
                        *slot
                    }
                    _ => NULL_U16,
                };
                out.push(pair);
            }
        }
        let layers = self.score_layer_start.len().saturating_sub(1);
        let mut pair_record = vec![NULL_U16; layers * pairs];
        for layer in 0..layers {
            let lo = self.score_layer_start[layer] as usize;
            let hi = self.score_layer_start[layer + 1] as usize;
            for record in lo..hi {
                let side = (self.score_key[record] as usize).wrapping_sub(layer * sides);
                if let Some(&pair) = pair_of.get(side).filter(|p| **p != NULL_U16) {
                    let offset = u16::try_from(record - lo).map_err(|_| "too many side records for one layer")?;
                    pair_record[layer * pairs + pair as usize] = offset;
                }
            }
        }
        self.side_pair = side_pair;
        self.pair_count = pairs;
        self.pair_record = pair_record;
        Ok(())
    }

    fn index_layer_blocks(&mut self) -> Result<(), String> {
        let layer = self.block_enum(self.layer_col).ok_or("Layer column must be block scope")?;
        let mut layer_block = vec![NO_BLOCK; self.manifest.layer_count];
        for b in 0..self.manifest.block_count {
            let l = layer.get(b).ok_or("a block has no layer")? as usize;
            *layer_block.get_mut(l).ok_or("block layer out of range")? = b as u32;
        }
        self.layer_block = layer_block;
        Ok(())
    }

    /// Takes each pattern row's cell in its layer's option grid, which the host computes from the layer data
    /// (LA.patternRowCells), and indexes them both ways. Checks only that the cells can serve as ids: one per pattern
    /// row, within `local_bits`, and distinct within a pattern.
    pub fn set_id_cells(&mut self, local_bits: u32, cells: Vec<u32>) -> Result<(), String> {
        if cells.len() != self.manifest.pattern_row_count {
            return Err(format!("{} id cells for {} pattern rows", cells.len(), self.manifest.pattern_row_count));
        }
        let layer_bits = usize::BITS - self.manifest.layer_count.saturating_sub(1).leading_zeros();
        if local_bits + layer_bits > MAX_ID_BITS {
            return Err(format!("{local_bits} local bits and {layer_bits} layer bits are over the {MAX_ID_BITS} that keep ids inline in JS"));
        }
        let patterns = self.manifest.pattern_count;
        let mut pattern_cell_start = Vec::with_capacity(patterns + 1);
        let mut cell_pattern_row = Vec::new();
        for p in 0..patterns {
            let rows = self.pattern_row_start[p] as usize..self.pattern_row_start[p + 1] as usize;
            let span = cells[rows.clone()].iter().max().map_or(0, |max| *max as usize + 1);
            if span > 1 << local_bits {
                return Err(format!("pattern {p} has a cell beyond {local_bits} local bits"));
            }
            let first_cell = cell_pattern_row.len();
            pattern_cell_start.push(first_cell as u32);
            cell_pattern_row.resize(first_cell + span, NO_ROW);
            for row in rows.clone() {
                let slot = &mut cell_pattern_row[first_cell + cells[row] as usize];
                if *slot != NO_ROW {
                    return Err(format!("pattern {p} gives cell {} to two rows", cells[row]));
                }
                *slot = (row - rows.start) as u32;
            }
        }
        pattern_cell_start.push(cell_pattern_row.len() as u32);

        self.id_local_bits = local_bits;
        self.pattern_row_cell = cells;
        self.pattern_cell_start = pattern_cell_start;
        self.cell_pattern_row = cell_pattern_row;
        Ok(())
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
            ColumnSpec::Alliance { team, .. } => ColData::PerPattern(self.alliance[*team as usize - 1].as_enum()),
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
                let block = self.block_of(row);
                self.alliance[*team as usize - 1].as_enum().get(self.pattern_row_of(block, row))
            }
            ColumnSpec::Id { .. } => {
                let block = self.block_of(row);
                self.dense_id(block, self.pattern_row_of(block, row))
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

    /// The dense layer id of a row. Mirrors LC.packId.
    pub fn dense_id(&self, block: usize, pattern_row: usize) -> Option<i64> {
        let layer = self.block_enum(self.layer_col)?.get(block)?;
        Some((layer << self.id_local_bits) | *self.pattern_row_cell.get(pattern_row)? as i64)
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

    /// None for a column that isn't per-pattern.
    pub fn pattern_counts(&self, col: usize) -> Option<&PatternCounts> {
        let col = self.resolve(col);
        let ColData::PerPattern(values) = self.col_data(col) else {
            return None;
        };
        Some(self.pattern_counts[col].get_or_init(|| {
            let mut tally = vec![0u32; values.slots()];
            let mut start = Vec::with_capacity(self.manifest.pattern_count + 1);
            let mut codes = Vec::new();
            let mut counts = Vec::new();
            for pattern in 0..self.manifest.pattern_count {
                let first = codes.len();
                start.push(first as u32);
                let (p_start, p_end) = self.pattern_rows(pattern);
                for p in p_start..p_end {
                    let code = values.code(p);
                    if tally[code] == 0 {
                        codes.push(code as u32);
                    }
                    tally[code] += 1;
                }
                for code in &codes[first..] {
                    counts.push(std::mem::take(&mut tally[*code as usize]));
                }
            }
            start.push(codes.len() as u32);
            PatternCounts { start, codes, counts }
        }))
    }

    fn side_pair_rows(&self, team: usize) -> &PatternRows {
        self.side_pair_rows[team].get_or_init(|| {
            let side_pair = &self.side_pair[team];
            let mut seen = vec![false; self.pair_count + 1];
            let mut start = Vec::with_capacity(self.manifest.pattern_count + 1);
            let mut rows = Vec::new();
            for pattern in 0..self.manifest.pattern_count {
                let first = rows.len();
                start.push(first as u32);
                let (p_start, p_end) = self.pattern_rows(pattern);
                for p in p_start..p_end {
                    // NULL_U16 takes the last slot, so a pattern row with no side record still gets read
                    let slot = (side_pair[p] as usize).min(self.pair_count);
                    if !seen[slot] {
                        seen[slot] = true;
                        rows.push(p as u32);
                    }
                }
                for p in &rows[first..] {
                    seen[(side_pair[*p as usize] as usize).min(self.pair_count)] = false;
                }
            }
            start.push(rows.len() as u32);
            PatternRows { start, rows }
        })
    }

    /// The min/max of a column over one whole block, read once and then remembered.
    pub fn block_range(&self, col: usize, reader: &Reader, block: usize) -> Option<(i64, i64)> {
        let col = self.resolve(col);
        let mut cached = self.block_ranges[col].borrow_mut();
        if cached.is_empty() {
            cached.resize(self.block_count(), None);
        }
        *cached[block].get_or_insert_with(|| {
            let mut range: Option<(i64, i64)> = None;
            let mut take = |v: Option<i64>| {
                if let Some(v) = v {
                    range = Some(range.map_or((v, v), |(lo, hi)| (lo.min(v), hi.max(v))));
                }
            };
            let pattern = self.block_pattern(block);
            if let ColumnSpec::Score { team, .. } = &self.manifest.columns[col] {
                // a score read never looks at the row index
                for p in self.side_pair_rows(*team as usize - 1).of(pattern) {
                    take(reader.read(block, *p as usize, 0));
                }
            } else {
                let (start, end) = self.block_rows(block);
                let mut p = self.pattern_rows(pattern).0;
                for row in start..end {
                    take(reader.read(block, p, row));
                    p += 1;
                }
            }
            range
        })
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

    /// The row holding a dense id, if the table has one: the layer's block, then the cell's row within its pattern.
    pub fn row_of_id(&self, id: i32) -> Option<usize> {
        if id < 0 {
            return None;
        }
        let id = id as u32;
        let block = *self.layer_block.get((id >> self.id_local_bits) as usize)?;
        if block == NO_BLOCK {
            return None;
        }
        let p = self.block_pattern[block as usize] as usize;
        let cell = self.pattern_cell_start.get(p)? + (id & ((1u32 << self.id_local_bits) - 1));
        if cell >= *self.pattern_cell_start.get(p + 1)? {
            return None;
        }
        match self.cell_pattern_row[cell as usize] {
            NO_ROW => None,
            offset => Some((self.block_row_start[block as usize] + offset) as usize),
        }
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

    pub fn is_id(&self, col: usize) -> bool {
        matches!(&self.manifest.columns[self.resolve(col)], ColumnSpec::Id { .. })
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
    Id { layer: Enum<'a>, cells: &'a [u32], local_bits: u32 },
    Score { layer: Enum<'a>, side_pair: &'a [u16], pairs: usize, pair_record: &'a [u16], layer_start: &'a [u32], vals: &'a [i32], metrics: usize, metric: usize },
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
            Reader::Id { layer, cells, local_bits } => Some((layer.get(block)? << local_bits) | *cells.get(pattern_row)? as i64),
            Reader::Score { layer, side_pair, pairs, pair_record, layer_start, vals, metrics, metric } => {
                let l = layer.get(block)? as usize;
                let pair = side_pair[pattern_row];
                if pair == NULL_U16 {
                    return None;
                }
                let offset = pair_record[l * pairs + pair as usize];
                if offset == NULL_U16 {
                    return None;
                }
                match vals[(layer_start[l] as usize + offset as usize) * metrics + metric] {
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
        match &self.manifest.columns[col] {
            ColumnSpec::Alias { .. } => Reader::None,
            ColumnSpec::Block { section, .. } => Reader::Block(self.enum_section(*section)),
            ColumnSpec::Pattern { section, .. } => Reader::Pattern(self.enum_section(*section)),
            ColumnSpec::Alliance { team, .. } => Reader::Pattern(self.alliance[*team as usize - 1].as_enum()),
            ColumnSpec::Id { .. } => match self.block_enum(self.layer_col) {
                Some(layer) => Reader::Id { layer, cells: &self.pattern_row_cell, local_bits: self.id_local_bits },
                None => Reader::None,
            },
            ColumnSpec::Score { team, metric, .. } => match self.block_enum(self.layer_col) {
                Some(layer) => Reader::Score {
                    layer,
                    side_pair: &self.side_pair[*team as usize - 1],
                    pairs: self.pair_count,
                    pair_record: &self.pair_record,
                    layer_start: &self.score_layer_start,
                    vals: self.i32_section(self.manifest.score_vals),
                    metrics: self.manifest.score_metrics,
                    metric: *metric,
                },
                None => Reader::None,
            },
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

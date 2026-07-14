//! The columnar layer store, and the on-disk artifact preprocess writes.
//!
//! Layout: `SLMC1` magic, a u32 manifest length, the manifest as JSON, then the column data back to back. Enum
//! columns are one byte per row (the widest, Layer, has 254 values), extra columns are the precision-scaled integers
//! the layer db already stored, and ids are i32. Null is 255 / i32::MIN.
//!
//! Rows are written in packed-id order, which groups them by map and layer. That's load-bearing for query speed: a
//! selective pool filter leaves whole 64-row words empty, and the scan skips them outright.

use serde::{Deserialize, Serialize};

pub const MAGIC: &[u8; 5] = b"SLMC1";
pub const NULL_U8: u8 = 255;
pub const NULL_I32: i32 = i32::MIN;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ColSpec {
    pub name: String,
    /// "u8" for enum columns, "i32" for extra columns and ids
    pub kind: String,
    pub offset: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub row_count: usize,
    pub columns: Vec<ColSpec>,
    /// the layers version the artifact was built from, surfaced so the host can check it against the layer data
    pub layers_version: String,
}

pub struct Store {
    pub manifest: Manifest,
    bytes: Vec<u8>,
    /// where the column data starts; the manifest's offsets are relative to it
    data_start: usize,
    /// index into `columns` for every column name, resolved once at load
    names: Vec<(String, usize)>,
}

#[derive(Clone, Copy)]
pub enum Col<'a> {
    U8(&'a [u8]),
    I32(&'a [i32]),
}

impl Store {
    pub fn load(bytes: Vec<u8>) -> Result<Store, String> {
        if bytes.len() < 9 || &bytes[0..5] != MAGIC {
            return Err("not a layer engine artifact".into());
        }
        let manifest_len = u32::from_le_bytes([bytes[5], bytes[6], bytes[7], bytes[8]]) as usize;
        let manifest: Manifest = serde_json::from_slice(&bytes[9..9 + manifest_len])
            .map_err(|e| format!("bad manifest: {e}"))?;
        let header = 9 + manifest_len;
        let data_start = header + (4 - (header % 4)) % 4;
        // i32 columns are read as a borrowed slice rather than copied, so the data section has to be 4-aligned in
        // memory. Both allocators we run on hand back 8-aligned buffers, but check rather than risk UB if that changes.
        if (bytes.as_ptr() as usize + data_start) % 4 != 0 {
            return Err("layer artifact is not 4-byte aligned in memory".into());
        }
        let names = manifest.columns.iter().enumerate().map(|(i, c)| (c.name.clone(), i)).collect();
        Ok(Store { manifest, bytes, data_start, names })
    }

    pub fn row_count(&self) -> usize {
        self.manifest.row_count
    }

    pub fn column_index(&self, name: &str) -> Option<usize> {
        self.names.iter().find(|(n, _)| n == name).map(|(_, i)| *i)
    }

    pub fn column_names(&self) -> Vec<String> {
        self.manifest.columns.iter().map(|c| c.name.clone()).collect()
    }

    pub fn is_u8(&self, idx: usize) -> bool {
        self.manifest.columns[idx].kind == "u8"
    }

    pub fn col(&self, idx: usize) -> Col<'_> {
        let spec = &self.manifest.columns[idx];
        let rows = self.manifest.row_count;
        let start = self.data_start + spec.offset;
        if spec.kind == "u8" {
            Col::U8(&self.bytes[start..start + rows])
        } else {
            let slice = &self.bytes[start..start + rows * 4];
            // every column starts 4-byte aligned by construction (the writer pads), and the artifact is
            // little-endian on both hosts we target
            debug_assert!(slice.as_ptr() as usize % 4 == 0);
            Col::I32(unsafe { std::slice::from_raw_parts(slice.as_ptr() as *const i32, rows) })
        }
    }

    /// Reads a value as i64 with null flattened out, which is all the comparison paths need.
    #[inline]
    pub fn value(&self, col: Col<'_>, row: usize) -> Option<i64> {
        match col {
            Col::U8(c) => {
                let v = c[row];
                if v == NULL_U8 {
                    None
                } else {
                    Some(v as i64)
                }
            }
            Col::I32(c) => {
                let v = c[row];
                if v == NULL_I32 {
                    None
                } else {
                    Some(v as i64)
                }
            }
        }
    }

    /// Row index for a packed layer id. Ids are written ascending, so this is a binary search.
    pub fn row_of_id(&self, id_col: usize, id: i32) -> Option<usize> {
        match self.col(id_col) {
            Col::I32(ids) => ids.binary_search(&id).ok(),
            Col::U8(_) => None,
        }
    }
}

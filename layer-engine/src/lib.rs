//! The layer query engine.
//!
//! One wasm module serves both hosts: the browser's query worker and the server. It owns the layer table in factored
//! form and answers every query the app makes of it (filtering, sorting, paging, distinct values, layer statuses, and
//! weighted generation), replacing the SQLite layer db.
//!
//! ABI: no wasm-bindgen. The host allocates a buffer with `alloc`, writes bytes into linear memory, and calls in. Both
//! requests and responses are JSON; responses are left in memory and read back via `result_ptr`/`result_len`.

pub mod gen;
pub mod ir;
pub mod query;
pub mod store;

use query::{FilterCache, Request};
use std::cell::RefCell;
use std::hash::Hasher;
use store::Store;

pub struct Engine {
    pub store: Store,
    /// Evaluated filters, keyed by their IR. The queue re-asks "does this layer match this pool filter" on every
    /// change, and the pool filter is the same one every time, so caching the bitset turns those into bit tests.
    cache: RefCell<FilterCache>,
}

impl Engine {
    pub fn load(bytes: Vec<u8>) -> Result<Engine, String> {
        let store = Store::load(bytes)?;
        Ok(Engine { store, cache: RefCell::new(FilterCache::default()) })
    }

    pub fn query(&self, request_json: &str) -> Result<String, String> {
        let request: Request = serde_json::from_str(request_json).map_err(|e| format!("bad request: {e}"))?;
        query::handle(&self.store, request, &mut self.cache.borrow_mut())
    }

    pub fn column_index(&self, name: &str) -> Option<usize> {
        self.store.column_index(name)
    }
}

/// The standard library hashes with SipHash, which buys DoS resistance we have no use for: the keys here are
/// dictionary indices and group keys this crate produced itself. Over 2.7M rows that costs more than the lookup it
/// protects, so integer keys get a multiply-xor hash instead.
#[derive(Default)]
pub struct IntHasher(u64);

pub type IntMap<K, V> = std::collections::HashMap<K, V, std::hash::BuildHasherDefault<IntHasher>>;
pub type IntSet<K> = std::collections::HashSet<K, std::hash::BuildHasherDefault<IntHasher>>;

impl IntHasher {
    #[inline]
    fn mix(&mut self, value: u64) {
        self.0 = (self.0 ^ value).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
}

impl Hasher for IntHasher {
    #[inline]
    fn finish(&self) -> u64 {
        // the table indexes by the low bits, so fold the high ones down into them
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.mix(byte as u64);
        }
    }
    #[inline]
    fn write_u8(&mut self, i: u8) {
        self.mix(i as u64)
    }
    #[inline]
    fn write_u32(&mut self, i: u32) {
        self.mix(i as u64)
    }
    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.mix(i)
    }
    #[inline]
    fn write_i64(&mut self, i: i64) {
        self.mix(i as u64)
    }
    #[inline]
    fn write_usize(&mut self, i: usize) {
        self.mix(i as u64)
    }
}

// ---------------------------- wasm exports ----------------------------

static mut ENGINE: Option<Engine> = None;
static mut RESULT: Vec<u8> = Vec::new();

/// # Safety
/// The host must write exactly `len` bytes into the returned pointer before passing it back.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, len, len));
}

/// Loads the factored artifact. Takes ownership of the buffer, so the host must not free it.
/// Returns the row count, or 0 on failure (the message is left in the result buffer).
#[no_mangle]
pub unsafe extern "C" fn load(ptr: *mut u8, len: usize) -> usize {
    let bytes = Vec::from_raw_parts(ptr, len, len);
    match Engine::load(bytes) {
        Ok(engine) => {
            let rows = engine.store.row_count();
            set_result(format!("{{\"ok\":true,\"rowCount\":{rows}}}").into_bytes());
            ENGINE = Some(engine);
            rows
        }
        Err(err) => {
            set_result(serde_json::to_vec(&serde_json::json!({ "ok": false, "error": err })).unwrap());
            0
        }
    }
}

/// Runs a JSON query. Returns 1 on success, 0 on error; either way the payload is in the result buffer.
#[no_mangle]
pub unsafe extern "C" fn query(ptr: *const u8, len: usize) -> usize {
    let engine = match &*(&raw const ENGINE) {
        Some(engine) => engine,
        None => {
            set_result(br#"{"ok":false,"error":"engine not loaded"}"#.to_vec());
            return 0;
        }
    };
    let request = match std::str::from_utf8(std::slice::from_raw_parts(ptr, len)) {
        Ok(s) => s,
        Err(_) => {
            set_result(br#"{"ok":false,"error":"request is not utf-8"}"#.to_vec());
            return 0;
        }
    };
    match engine.query(request) {
        Ok(json) => {
            set_result(json.into_bytes());
            1
        }
        Err(err) => {
            set_result(serde_json::to_vec(&serde_json::json!({ "ok": false, "error": err })).unwrap());
            0
        }
    }
}

/// Resolves a column name to the index the request format uses. Returns usize::MAX when unknown.
#[no_mangle]
pub unsafe extern "C" fn column_index(ptr: *const u8, len: usize) -> usize {
    let engine = match &*(&raw const ENGINE) {
        Some(engine) => engine,
        None => return usize::MAX,
    };
    let name = match std::str::from_utf8(std::slice::from_raw_parts(ptr, len)) {
        Ok(s) => s,
        Err(_) => return usize::MAX,
    };
    engine.column_index(name).unwrap_or(usize::MAX)
}

#[no_mangle]
pub unsafe extern "C" fn result_ptr() -> *const u8 {
    (*(&raw const RESULT)).as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn result_len() -> usize {
    (*(&raw const RESULT)).len()
}

unsafe fn set_result(bytes: Vec<u8>) {
    RESULT = bytes;
}

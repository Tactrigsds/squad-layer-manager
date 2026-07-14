//! The layer query engine.
//!
//! One wasm module serves both hosts: the browser's query worker and the server. It owns the layer table in columnar
//! form and answers every query the app makes of it (filtering, sorting, paging, distinct values, layer statuses, and
//! weighted generation), replacing the SQLite layer db.
//!
//! ABI: no wasm-bindgen. The host allocates a buffer with `alloc`, writes bytes into linear memory, and calls in. Both
//! requests and responses are JSON; responses are left in memory and read back via `result_ptr`/`result_len`.

pub mod gen;
pub mod ir;
pub mod query;
pub mod store;

use ir::Tri;
use query::Request;
use std::cell::RefCell;
use std::collections::HashMap;
use store::Store;

pub struct Engine {
    pub store: Store,
    id_col: usize,
    /// Evaluated filters, keyed by their IR. The queue re-asks "does this layer match this pool filter" on every
    /// change, and the pool filter is the same one every time, so caching the bitset turns those into bit tests.
    cache: RefCell<HashMap<String, std::rc::Rc<Tri>>>,
}

const MAX_CACHED_FILTERS: usize = 64;

impl Engine {
    pub fn load(bytes: Vec<u8>) -> Result<Engine, String> {
        let store = Store::load(bytes)?;
        let id_col = store.column_index("id").ok_or("artifact has no id column")?;
        Ok(Engine { store, id_col, cache: RefCell::new(HashMap::new()) })
    }

    pub fn query(&self, request_json: &str) -> Result<String, String> {
        let request: Request = serde_json::from_str(request_json).map_err(|e| format!("bad request: {e}"))?;
        let mut cache = self.cache.borrow_mut();
        // a filter's bitset only depends on the layer table, which is immutable for the engine's lifetime, so an
        // entry can never go stale; a changed filter simply lowers to different IR and lands under a different key
        if cache.len() > MAX_CACHED_FILTERS {
            cache.clear();
        }
        query::handle(&self.store, self.id_col, request, &mut cache)
    }

    pub fn column_index(&self, name: &str) -> Option<usize> {
        self.store.column_index(name)
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

/// Loads the columnar artifact. Takes ownership of the buffer, so the host must not free it.
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

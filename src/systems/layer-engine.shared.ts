import type * as LE from '@/models/layer-engine'

// Host side of the layer query engine (layer-engine/). The same wasm module runs in the browser's query worker and in the
// server process, so this wrapper is deliberately free of both DOM and node APIs: callers hand it the two byte
// buffers and it does the rest.

type Exports = {
	memory: WebAssembly.Memory
	alloc: (len: number) => number
	dealloc: (ptr: number, len: number) => void
	load: (ptr: number, len: number) => number
	query: (ptr: number, len: number) => number
	column_index: (ptr: number, len: number) => number
	result_ptr: () => number
	result_len: () => number
}

const UNKNOWN_COLUMN = 0xffffffff

export class LayerEngineError extends Error {}

export class LayerEngine {
	private exports: Exports
	private encoder = new TextEncoder()
	private decoder = new TextDecoder()
	private columnIndexes = new Map<string, number>()
	readonly rowCount: number

	private constructor(exports: Exports, rowCount: number) {
		this.exports = exports
		this.rowCount = rowCount
	}

	// `artifact` is handed to wasm and must not be reused by the caller afterwards: the engine takes ownership of the
	// copy in linear memory, and the layer table is large enough that a second copy is worth avoiding
	static async create(wasm: BufferSource | WebAssembly.Module, artifact: Uint8Array): Promise<LayerEngine> {
		const instance = wasm instanceof WebAssembly.Module
			? await WebAssembly.instantiate(wasm, {})
			: (await WebAssembly.instantiate(wasm, {})).instance
		const exports = instance.exports as unknown as Exports

		const ptr = exports.alloc(artifact.byteLength)
		new Uint8Array(exports.memory.buffer, ptr, artifact.byteLength).set(artifact)
		const rowCount = exports.load(ptr, artifact.byteLength)
		const engine = new LayerEngine(exports, rowCount)
		if (rowCount === 0) {
			const result = engine.readResult() as { ok: false; error: string }
			throw new LayerEngineError(`layer engine failed to load the artifact: ${result.error}`)
		}
		return engine
	}

	columnIndex(name: string): number {
		const cached = this.columnIndexes.get(name)
		if (cached !== undefined) return cached
		const [ptr, len] = this.write(this.encoder.encode(name))
		const index = this.exports.column_index(ptr, len)
		this.exports.dealloc(ptr, len)
		if (index === UNKNOWN_COLUMN) throw new LayerEngineError(`Column "${name}" is not in the layer artifact`)
		this.columnIndexes.set(name, index)
		return index
	}

	query<T>(request: LE.Request): T {
		const [ptr, len] = this.write(this.encoder.encode(JSON.stringify(request)))
		let ok: number
		try {
			ok = this.exports.query(ptr, len)
		} finally {
			this.exports.dealloc(ptr, len)
		}
		const result = this.readResult()
		if (!ok) throw new LayerEngineError(`layer engine query failed: ${(result as { error: string }).error}`)
		return result as T
	}

	private write(bytes: Uint8Array): [number, number] {
		const ptr = this.exports.alloc(bytes.byteLength)
		new Uint8Array(this.exports.memory.buffer, ptr, bytes.byteLength).set(bytes)
		return [ptr, bytes.byteLength]
	}

	private readResult(): unknown {
		const ptr = this.exports.result_ptr()
		const len = this.exports.result_len()
		// a fresh view every time: any allocation can grow wasm memory, which detaches earlier buffers
		return JSON.parse(this.decoder.decode(new Uint8Array(this.exports.memory.buffer, ptr, len)))
	}
}

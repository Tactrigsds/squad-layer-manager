import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as Instance from './instance'

// Where the app's resident memory goes. Two views of the same process:
//
// - The kernel's: /proc/<pid>/smaps, every mapping's resident size grouped by what backs it. This covers everything
//   and attributes only the file-backed part.
// - The app's own (memory-breakdown in src/systems/control-socket.server.ts): the V8 heaps of the main thread and each
//   worker, the layer engine's wasm memory, and array buffers.
//
// `owners` splits the anonymous memory between the app's owners. What none of them covers is native allocation:
// sqlite's page caches, libuv and the allocators' overhead. Wasm memory and the V8 heaps are counted at what they
// have committed, which can exceed what is resident, so `native` is a floor rather than an exact figure.

type HeapStats = { total_physical_size: number; used_heap_size: number; total_heap_size: number; external_memory?: number }

type AppBreakdown = {
	code: string
	memory: NodeJS.MemoryUsage
	heap: HeapStats
	heapSpaces: { space_name: string; space_used_size: number; physical_space_size: number }[]
	workers: { name: string; threadId: number; heap: HeapStats }[]
	layerEngineBytes: number | null
	sqlite: { cacheSize: number; pageSize: number; mmapSize: number }
}

export type MappingGroup =
	| 'anonymous'
	| 'malloc heap'
	| 'node binary'
	| 'shared libraries'
	| 'native addons'
	| 'database file'
	| 'other files'
	| 'kernel'

const MB = 1024 * 1024
const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10

export function readSmaps(pid: number, dbPath: string) {
	const groups = new Map<MappingGroup, { rss: number; anonymous: number }>()
	let group: MappingGroup = 'anonymous'
	const dbBase = path.basename(dbPath)
	for (const line of fs.readFileSync(`/proc/${pid}/smaps`, 'utf8').split('\n')) {
		// a mapping header: address range, perms, offset, device, inode, then the backing path if any
		const header = /^[0-9a-f]+-[0-9a-f]+ \S+ \S+ \S+ \d+\s*(.*)$/.exec(line)
		if (header) {
			group = groupOf(header[1].trim(), dbBase)
			continue
		}
		const field = /^(Rss|Anonymous):\s+(\d+) kB/.exec(line)
		if (!field) continue
		let g = groups.get(group)
		if (!g) groups.set(group, (g = { rss: 0, anonymous: 0 }))
		if (field[1] === 'Rss') g.rss += Number(field[2]) * 1024
		else g.anonymous += Number(field[2]) * 1024
	}
	return groups
}

function groupOf(mapped: string, dbBase: string): MappingGroup {
	if (mapped === '') return 'anonymous'
	if (mapped === '[heap]') return 'malloc heap'
	if (mapped.startsWith('[')) return 'kernel'
	const base = path.basename(mapped)
	if (base.startsWith(dbBase)) return 'database file'
	if (base === 'node' || mapped === process.execPath) return 'node binary'
	if (base.endsWith('.node')) return 'native addons'
	if (/\.so(\.|$)/.test(base)) return 'shared libraries'
	return 'other files'
}

export async function breakdown(inst: Instance.Instance) {
	const app = (await inst.control('memory-breakdown')) as AppBreakdown
	if (app.code !== 'ok') throw new Error(`memory-breakdown failed: ${JSON.stringify(app)}`)
	const smaps = readSmaps(inst.child.pid!, inst.dbPath)
	let rss = 0
	let anonymous = 0
	for (const g of smaps.values()) {
		rss += g.rss
		anonymous += g.anonymous
	}

	const workers = app.workers.map((w) => ({ name: w.name, heapMb: mb(w.heap.total_physical_size), usedMb: mb(w.heap.used_heap_size) }))
	const wasm = app.layerEngineBytes ?? 0
	const owned = {
		mainHeap: app.heap.total_physical_size,
		workerHeaps: app.workers.reduce((n, w) => n + w.heap.total_physical_size, 0),
		layerEngine: wasm,
		arrayBuffers: app.memory.arrayBuffers,
		otherExternal: Math.max(0, app.memory.external - app.memory.arrayBuffers - wasm),
	}
	const ownedTotal = Object.values(owned).reduce((a, b) => a + b, 0)
	return {
		rssMb: mb(rss),
		anonymousMb: mb(anonymous),
		fileBackedMb: mb(rss - anonymous),
		// anonymous memory by owner, in MB
		owners: {
			mainHeap: mb(owned.mainHeap),
			workerHeaps: mb(owned.workerHeaps),
			layerEngine: mb(owned.layerEngine),
			arrayBuffers: mb(owned.arrayBuffers),
			otherExternal: mb(owned.otherExternal),
			native: mb(Math.max(0, anonymous - ownedTotal)),
		},
		// resident memory by what backs it, in MB
		mappings: Object.fromEntries(
			[...smaps].sort((a, b) => b[1].rss - a[1].rss).map(([k, g]) => [k, { rssMb: mb(g.rss), anonymousMb: mb(g.anonymous) }]),
		),
		mainHeapSpaces: Object.fromEntries(
			app.heapSpaces
				.filter((s) => s.physical_space_size > 0)
				.sort((a, b) => b.physical_space_size - a.physical_space_size)
				.map((s) => [s.space_name, { committedMb: mb(s.physical_space_size), usedMb: mb(s.space_used_size) }]),
		),
		mainHeapUsedMb: mb(app.heap.used_heap_size),
		workers,
		sqlite: {
			...app.sqlite,
			// the main connection's cap; each worker's connection keeps its own
			cacheCapMb: mb(app.sqlite.cacheSize < 0 ? -app.sqlite.cacheSize * 1024 : app.sqlite.cacheSize * app.sqlite.pageSize),
		},
	}
}

export type Breakdown = Awaited<ReturnType<typeof breakdown>>

// The main thread's heap by constructor, from a heap snapshot: what fills it, by retained-in-place (self) size.
export function summarizeHeapSnapshot(file: string, top = 40) {
	const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as {
		snapshot: { meta: { node_fields: string[]; node_types: [string[], ...unknown[]] } }
		nodes: number[]
		strings: string[]
	}
	const fields = snap.snapshot.meta.node_fields
	const stride = fields.length
	const typeAt = fields.indexOf('type')
	const nameAt = fields.indexOf('name')
	const sizeAt = fields.indexOf('self_size')
	const types = snap.snapshot.meta.node_types[0]
	const byName = new Map<string, { count: number; bytes: number }>()
	let total = 0
	for (let i = 0; i < snap.nodes.length; i += stride) {
		const type = types[snap.nodes[i + typeAt]]
		const size = snap.nodes[i + sizeAt]
		total += size
		// objects and closures by constructor or function name; everything else by its kind, as strings are
		const key = type === 'object' || type === 'closure' ? `${type}:${snap.strings[snap.nodes[i + nameAt]]}` : type
		let e = byName.get(key)
		if (!e) byName.set(key, (e = { count: 0, bytes: 0 }))
		e.count++
		e.bytes += size
	}
	return {
		totalMb: mb(total),
		top: [...byName]
			.sort((a, b) => b[1].bytes - a[1].bytes)
			.slice(0, top)
			.map(([name, e]) => ({ name, count: e.count, mb: mb(e.bytes) })),
	}
}

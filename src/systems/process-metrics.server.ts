import * as Otel from '@opentelemetry/api'
import * as fs from 'node:fs'
import * as path from 'node:path'

import * as ATTRS from '@/models/otel-attrs.models'
import * as WorkerThreads from '@/server/worker-threads'
import * as LayerEngine from '@/systems/layer-engine.server'

// What the process costs to run, for sizing a deployment: its CPU time and resident memory, and the memory the V8
// heap metrics from the runtime instrumentation leave out, by owner. Unlike the domain gauges in metrics.server.ts,
// two of these read outside the process on each export: the worker threads answer a message, and the cgroup's
// memory.stat is a file read. Both are local and take microseconds.
const meter = Otel.metrics.getMeter('squad-layer-manager')

// setup rather than module scope, so the instruments register against the real meter provider
export function setup() {
	meter
		.createObservableCounter(ATTRS.Process.CPU_TIME, { description: 'CPU time the process has used, across every thread', unit: 's' })
		.addCallback((result) => {
			const usage = process.cpuUsage()
			result.observe(usage.user / 1e6, { [ATTRS.Process.CPU_MODE]: 'user' })
			result.observe(usage.system / 1e6, { [ATTRS.Process.CPU_MODE]: 'system' })
		})

	const rss = meter.createObservableGauge(ATTRS.Process.MEMORY_USAGE, { description: 'Resident memory of the process', unit: 'By' })
	const external = meter.createObservableGauge(ATTRS.Process.EXTERNAL_MEMORY, {
		description: 'Memory V8 tracks outside its heaps, including array buffers and the layer engine',
		unit: 'By',
	})
	const arrayBuffers = meter.createObservableGauge(ATTRS.Process.ARRAY_BUFFER_MEMORY, {
		description: 'Memory held by ArrayBuffers and Buffers',
		unit: 'By',
	})
	meter.addBatchObservableCallback(
		(result) => {
			const usage = process.memoryUsage()
			result.observe(rss, usage.rss)
			result.observe(external, usage.external)
			result.observe(arrayBuffers, usage.arrayBuffers)
		},
		[rss, external, arrayBuffers],
	)

	meter
		.createObservableGauge(ATTRS.Process.LAYER_ENGINE_MEMORY, {
			description: "Size of the layer engine's wasm memory, which holds the layer table",
			unit: 'By',
		})
		.addCallback((result) => {
			const bytes = LayerEngine.peekEngine()?.memoryBytes
			if (bytes !== undefined) result.observe(bytes)
		})

	const workerUsed = meter.createObservableGauge(ATTRS.Process.WORKER_HEAP_USED, {
		description: "Memory in use in a worker thread's V8 heap",
		unit: 'By',
	})
	const workerCommitted = meter.createObservableGauge(ATTRS.Process.WORKER_HEAP_COMMITTED, {
		description: "Memory a worker thread's V8 heap holds from the system",
		unit: 'By',
	})
	meter.addBatchObservableCallback(
		async (result) => {
			for (const w of await WorkerThreads.heapStatistics()) {
				const attrs = { [ATTRS.Process.WORKER_NAME]: w.name }
				result.observe(workerUsed, w.heap.used_heap_size, attrs)
				result.observe(workerCommitted, w.heap.total_physical_size, attrs)
			}
		},
		[workerUsed, workerCommitted],
	)

	const memoryStat = cgroupMemoryStatPath()
	if (memoryStat) {
		meter
			.createObservableGauge(ATTRS.Process.CGROUP_MEMORY, {
				description: "Memory charged to the process's cgroup, by type",
				unit: 'By',
			})
			.addCallback(async (result) => {
				const stat = await fs.promises.readFile(memoryStat, 'utf8').catch(() => null)
				if (!stat) return
				for (const line of stat.split('\n')) {
					const [key, value] = line.split(' ')
					if (key === 'anon' || key === 'file') {
						result.observe(Number(value), { [ATTRS.Process.CGROUP_MEMORY_TYPE]: key satisfies ATTRS.Process.CgroupMemoryType })
					}
				}
			})
	}
}

// The cgroup v2 memory.stat of this process's own cgroup. Inside a container with its own cgroup namespace the path
// is `/`, which is the container's cgroup. Null where there is no cgroup v2, as on macOS.
function cgroupMemoryStatPath(): string | null {
	try {
		const line = fs
			.readFileSync('/proc/self/cgroup', 'utf8')
			.split('\n')
			.find((l) => l.startsWith('0::'))
		if (!line) return null
		const file = path.join('/sys/fs/cgroup', line.slice(3), 'memory.stat')
		return fs.existsSync(file) ? file : null
	} catch {
		return null
	}
}

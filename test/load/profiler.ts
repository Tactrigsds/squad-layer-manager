import * as fs from 'node:fs'
import * as path from 'node:path'
import { WebSocket } from 'ws'

// Profiles the app under load over the Chrome DevTools Protocol, which is the only channel that works
// identically for a server spawned here and one running inside the production container: `--inspect` in
// NODE_OPTIONS, a published port, and nothing test-shaped compiled into the app.
//
// Everything it produces opens in Chrome DevTools as-is -- .cpuprofile and .heapprofile under Performance /
// Memory, .heapsnapshot under Memory. speedscope reads the .cpuprofile too.

type Message = { id: number; result?: unknown; error?: { message: string } }
type Event = { method: string; params: Record<string, unknown> }

export type ProfilerOptions = {
	// where the inspector is listening (`--inspect=<host>:<port>`)
	inspectUrl: string
	outDir: string
	// v8's cpu sampling interval in microseconds. 1000 is v8's own default; drop it for short runs where the
	// hot path is narrow, raise it if the profile itself distorts what it measures.
	cpuSamplingIntervalUs?: number
	// average bytes between heap allocation samples. 32KiB is DevTools' default and is cheap enough to leave on
	// for a whole run.
	heapSamplingIntervalBytes?: number
	// how often to record rss / heap / event-loop delay
	sampleIntervalMs?: number
	// A path prefix in the profile's frame urls to rewrite, so the source maps next to the built bundle resolve.
	// The container calls the app's root /app; on this machine it is the checkout.
	rewriteUrlPrefix?: { from: string; to: string }
}

export type MemorySample = {
	elapsedMs: number
	rssMb: number
	heapUsedMb: number
	heapTotalMb: number
	externalMb: number
	arrayBuffersMb: number
	// event loop delay over the interval since the previous sample, in milliseconds
	eventLoopP50Ms: number
	eventLoopP99Ms: number
	eventLoopMaxMs: number
	activeHandles: number
}

// Installed once in the app's own context. monitorEventLoopDelay is the only honest way to read lag from
// inside: measuring it from here would time the network and this process's own scheduling instead. Reset on
// every read so each sample describes its own interval rather than the run so far.
const SAMPLE_EXPRESSION = `(() => {
	globalThis.__slmLoadProbe ??= (() => {
		const histogram = process.getBuiltinModule('perf_hooks').monitorEventLoopDelay({ resolution: 10 })
		histogram.enable()
		return histogram
	})()
	const histogram = globalThis.__slmLoadProbe
	const memory = process.memoryUsage()
	const sample = {
		rss: memory.rss,
		heapUsed: memory.heapUsed,
		heapTotal: memory.heapTotal,
		external: memory.external,
		arrayBuffers: memory.arrayBuffers,
		eventLoopP50: histogram.percentile(50) / 1e6,
		eventLoopP99: histogram.percentile(99) / 1e6,
		eventLoopMax: histogram.max / 1e6,
		activeHandles: process._getActiveHandles?.().length ?? 0,
	}
	histogram.reset()
	return JSON.stringify(sample)
})()`

const MB = 1024 * 1024

export class Profiler {
	#socket: WebSocket | null = null
	#nextId = 1
	#pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
	#eventHandlers = new Map<string, (params: Record<string, unknown>) => void>()
	#sampleTimer: NodeJS.Timeout | null = null
	#startedAt = 0
	#opts: Required<Omit<ProfilerOptions, 'rewriteUrlPrefix'>> & Pick<ProfilerOptions, 'rewriteUrlPrefix'>

	readonly samples: MemorySample[] = []
	readonly snapshots: string[] = []

	constructor(opts: ProfilerOptions) {
		this.#opts = {
			cpuSamplingIntervalUs: 1000,
			heapSamplingIntervalBytes: 32 * 1024,
			sampleIntervalMs: 2_000,
			...opts,
		}
	}

	async connect(opts?: { timeoutMs?: number }): Promise<void> {
		const wsUrl = await this.#resolveDebuggerUrl(opts?.timeoutMs ?? 30_000)
		const socket = new WebSocket(wsUrl, { maxPayload: 1024 * 1024 * 1024 })
		await new Promise<void>((resolve, reject) => {
			socket.once('open', () => resolve())
			socket.once('error', reject)
		})
		socket.on('message', (raw) => this.#onMessage(String(raw)))
		this.#socket = socket
		// enabled on connect rather than in start(), so a snapshot can be taken before the collectors begin
		await this.#send('Profiler.enable')
		await this.#send('HeapProfiler.enable')
		await this.#send('Runtime.enable')
	}

	// The inspector publishes its session id on an http endpoint on the same port, so this both discovers the
	// url and doubles as the readiness probe for an app that is still booting.
	async #resolveDebuggerUrl(timeoutMs: number): Promise<string> {
		const deadline = Date.now() + timeoutMs
		let lastError = 'no response'
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`${this.#opts.inspectUrl}/json/list`)
				const targets = (await res.json()) as { webSocketDebuggerUrl?: string }[]
				const url = targets.find((t) => t.webSocketDebuggerUrl)?.webSocketDebuggerUrl
				if (url) return url
				lastError = 'the inspector listed no debuggable target'
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err)
			}
			await new Promise((resolve) => setTimeout(resolve, 250))
		}
		throw new Error(`could not reach the inspector at ${this.#opts.inspectUrl} after ${timeoutMs}ms: ${lastError}`)
	}

	#onMessage(raw: string) {
		const message = JSON.parse(raw) as Message & Partial<Event>
		if (message.method) {
			this.#eventHandlers.get(message.method)?.(message.params ?? {})
			return
		}
		const pending = this.#pending.get(message.id)
		if (!pending) return
		this.#pending.delete(message.id)
		if (message.error) pending.reject(new Error(`${message.error.message}`))
		else pending.resolve(message.result)
	}

	#send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const socket = this.#socket
		if (!socket) throw new Error('the profiler is not connected')
		const id = this.#nextId++
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
			socket.send(JSON.stringify({ id, method, params }))
		})
	}

	// Starts everything that runs for the whole load: the cpu profile, the allocation sampler, and the
	// rss/event-loop poll. Each is independent, so a run still gets the others if one is unavailable.
	//
	// Call this after any opening heap snapshot, not before. Walking the heap touches every page it reads and
	// glibc does not hand them back, so a snapshot leaves rss hundreds of megabytes higher than it found it
	// (the Dockerfile runs the image on jemalloc for exactly this reason). Sampling from after the snapshot is
	// what makes "rss grew over the run" mean the run rather than the measurement.
	async start(): Promise<void> {
		this.#startedAt = Date.now()
		await this.#send('Profiler.setSamplingInterval', { interval: this.#opts.cpuSamplingIntervalUs })
		await this.#send('Profiler.start')
		await this.#send('HeapProfiler.startSampling', { samplingInterval: this.#opts.heapSamplingIntervalBytes })

		this.#sampleTimer = setInterval(() => void this.sample(), this.#opts.sampleIntervalMs)
		await this.sample()
	}

	async sample(): Promise<MemorySample | null> {
		try {
			const res = await this.#send<{ result: { value?: string }; exceptionDetails?: unknown }>('Runtime.evaluate', {
				expression: SAMPLE_EXPRESSION,
				returnByValue: true,
			})
			if (!res.result?.value) return null
			const raw = JSON.parse(res.result.value) as Record<string, number>
			const sample: MemorySample = {
				elapsedMs: Date.now() - this.#startedAt,
				rssMb: raw.rss / MB,
				heapUsedMb: raw.heapUsed / MB,
				heapTotalMb: raw.heapTotal / MB,
				externalMb: raw.external / MB,
				arrayBuffersMb: raw.arrayBuffers / MB,
				eventLoopP50Ms: raw.eventLoopP50,
				eventLoopP99Ms: raw.eventLoopP99,
				eventLoopMaxMs: raw.eventLoopMax,
				activeHandles: raw.activeHandles,
			}
			this.samples.push(sample)
			return sample
		} catch {
			return null
		}
	}

	// A full snapshot is the only artifact that says what is retaining memory, and the only one that costs
	// something to take: it walks the whole heap, and the pages it touches stay resident afterwards (which is
	// why the image runs on jemalloc -- see the Dockerfile). Take them at the boundaries of a run, not through it.
	async takeHeapSnapshot(label: string): Promise<string> {
		const file = path.join(this.#opts.outDir, `${label}.heapsnapshot`)
		const chunks: string[] = []
		this.#eventHandlers.set('HeapProfiler.addHeapSnapshotChunk', (params) => chunks.push(params.chunk as string))
		try {
			await this.#send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false })
		} finally {
			this.#eventHandlers.delete('HeapProfiler.addHeapSnapshotChunk')
		}
		fs.writeFileSync(file, chunks.join(''))
		this.snapshots.push(file)
		return file
	}

	// Stops the run-long collectors and writes what they produced. Returns the files, in the order they were
	// written, for the run summary.
	async stop(): Promise<string[]> {
		if (this.#sampleTimer) clearInterval(this.#sampleTimer)
		this.#sampleTimer = null
		await this.sample()
		const written: string[] = []

		const cpu = await this.#send<{ profile: unknown }>('Profiler.stop')
		const cpuFile = path.join(this.#opts.outDir, 'server.cpuprofile')
		fs.writeFileSync(cpuFile, JSON.stringify(this.#rewriteUrls(cpu.profile)))
		written.push(cpuFile)

		const heap = await this.#send<{ profile: unknown }>('HeapProfiler.stopSampling')
		const heapFile = path.join(this.#opts.outDir, 'server.heapprofile')
		fs.writeFileSync(heapFile, JSON.stringify(this.#rewriteUrls(heap.profile)))
		written.push(heapFile)

		written.push(this.#writeSamplesCsv())
		return written
	}

	// A frame's url is where DevTools goes looking for the source map beside the bundle. From the container
	// those read /app/dist-server/..., which is nothing on this machine, so they are rewritten to the checkout
	// that built them.
	#rewriteUrls<T>(profile: T): T {
		const rewrite = this.#opts.rewriteUrlPrefix
		if (!rewrite) return profile
		const from = `"url":"${rewrite.from}`
		const to = `"url":"${rewrite.to}`
		return JSON.parse(JSON.stringify(profile).split(from).join(to)) as T
	}

	#writeSamplesCsv(): string {
		const file = path.join(this.#opts.outDir, 'server-memory.csv')
		const columns: (keyof MemorySample)[] = [
			'elapsedMs',
			'rssMb',
			'heapUsedMb',
			'heapTotalMb',
			'externalMb',
			'arrayBuffersMb',
			'eventLoopP50Ms',
			'eventLoopP99Ms',
			'eventLoopMaxMs',
			'activeHandles',
		]
		const rows = this.samples.map((sample) => columns.map((column) => round(sample[column])).join(','))
		fs.writeFileSync(file, [columns.join(','), ...rows].join('\n') + '\n')
		return file
	}

	close() {
		if (this.#sampleTimer) clearInterval(this.#sampleTimer)
		this.#sampleTimer = null
		this.#socket?.close()
		this.#socket = null
	}
}

function round(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

// What the memory samples say about the run, for the summary. Growth is measured from the first sample after
// the warmup rather than from boot, so a run does not read as leaking because the app finished starting.
export function summarizeMemory(samples: MemorySample[], fromElapsedMs = 0) {
	const window = samples.filter((sample) => sample.elapsedMs >= fromElapsedMs)
	if (window.length === 0) return null
	const first = window[0]
	const last = window[window.length - 1]
	return {
		rssStartMb: +first.rssMb.toFixed(1),
		rssEndMb: +last.rssMb.toFixed(1),
		rssPeakMb: +Math.max(...window.map((s) => s.rssMb)).toFixed(1),
		heapUsedStartMb: +first.heapUsedMb.toFixed(1),
		heapUsedEndMb: +last.heapUsedMb.toFixed(1),
		heapUsedPeakMb: +Math.max(...window.map((s) => s.heapUsedMb)).toFixed(1),
		heapGrowthMb: +(last.heapUsedMb - first.heapUsedMb).toFixed(1),
		eventLoopP99MaxMs: +Math.max(...window.map((s) => s.eventLoopP99Ms)).toFixed(1),
		eventLoopMaxMs: +Math.max(...window.map((s) => s.eventLoopMaxMs)).toFixed(1),
		activeHandlesStart: first.activeHandles,
		activeHandlesEnd: last.activeHandles,
	}
}

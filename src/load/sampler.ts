import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as Instance from './instance'
import * as Stats from './stats'

// Reads the app's own figures over its control socket (runtime-stats in src/systems/control-socket.server.ts) and,
// when it runs in a scope, its cgroup's. Each sample covers the interval since the last one.

export type Sample = {
	at: number
	cpuCores: number
	rssMb: number
	heapUsedMb: number
	externalMb: number
	eventLoopDelayP99Ms: number | null
	eventLoopDelayMaxMs: number | null
	eventLoopUtilization: number
	// how far behind the newest log line the app has taken up, per server
	ingestLagMs: (number | null)[]
	cgroup: { anonMb: number; fileMb: number; currentMb: number; throttledMs: number; oomKills: number } | null
}

export class Sampler {
	samples: Sample[] = []
	#inst: Instance.Instance
	#timer: NodeJS.Timeout | null = null
	#lastCpu: { at: number; usec: number } | null = null
	#lastThrottledUsec = 0

	constructor(inst: Instance.Instance) {
		this.#inst = inst
	}

	async start(intervalMs: number) {
		// the first call only arms the app's event loop delay histogram
		await this.#read()
		this.#timer = setInterval(() => void this.#sample(), intervalMs)
	}

	stop() {
		if (this.#timer) clearInterval(this.#timer)
	}

	async #read() {
		return (await this.#inst.control('runtime-stats', { serverIds: this.#inst.serverIds })) as {
			code: string
			eventLoopDelayMs: { p99: number | null; max: number | null }
			eventLoopUtilization: number
			memory: NodeJS.MemoryUsage
			cpuUsage: NodeJS.CpuUsage
			servers: { serverId: string; lastLogEventTime: number | null }[]
		}
	}

	async #sample() {
		const res = await this.#read().catch(() => null)
		if (!res || res.code !== 'ok') return
		const now = Date.now()
		const usec = res.cpuUsage.user + res.cpuUsage.system
		const cpuCores = this.#lastCpu ? (usec - this.#lastCpu.usec) / 1000 / (now - this.#lastCpu.at) : 0
		this.#lastCpu = { at: now, usec }
		const mb = (b: number) => b / 1024 / 1024
		this.samples.push({
			at: now,
			cpuCores,
			rssMb: mb(res.memory.rss),
			heapUsedMb: mb(res.memory.heapUsed),
			externalMb: mb(res.memory.external + res.memory.arrayBuffers),
			eventLoopDelayP99Ms: res.eventLoopDelayMs.p99,
			eventLoopDelayMaxMs: res.eventLoopDelayMs.max,
			eventLoopUtilization: res.eventLoopUtilization,
			ingestLagMs: res.servers.map((s) => (s.lastLogEventTime === null ? null : now - s.lastLogEventTime)),
			cgroup: this.#cgroup(),
		})
	}

	#cgroup(): Sample['cgroup'] {
		const dir = this.#inst.cgroupDir
		if (!dir) return null
		try {
			const kv = (file: string) =>
				new Map(
					fs
						.readFileSync(path.join(dir, file), 'utf8')
						.trim()
						.split('\n')
						.map((l) => {
							const [k, v] = l.split(' ')
							return [k, Number(v)] as const
						}),
				)
			const mem = kv('memory.stat')
			const cpu = kv('cpu.stat')
			const throttled = cpu.get('throttled_usec') ?? 0
			const throttledMs = (throttled - this.#lastThrottledUsec) / 1000
			this.#lastThrottledUsec = throttled
			const mb = (b: number) => b / 1024 / 1024
			return {
				anonMb: mb(mem.get('anon') ?? 0),
				fileMb: mb(mem.get('file') ?? 0),
				currentMb: mb(Number(fs.readFileSync(path.join(dir, 'memory.current'), 'utf8'))),
				throttledMs,
				oomKills: kv('memory.events').get('oom_kill') ?? 0,
			}
		} catch {
			// the scope is gone once the app exits
			return null
		}
	}

	// Steady state and peaks reported apart, as the issue asks. Samples from the warmup are left out by the caller.
	summary(since: number) {
		const s = this.samples.filter((x) => x.at >= since)
		const pick = (f: (x: Sample) => number | null | undefined) => s.map(f).filter((v): v is number => typeof v === 'number')
		return {
			samples: s.length,
			cpuCores: Stats.summarize(pick((x) => x.cpuCores)),
			rssMb: Stats.summarize(pick((x) => x.rssMb)),
			heapUsedMb: Stats.summarize(pick((x) => x.heapUsedMb)),
			externalMb: Stats.summarize(pick((x) => x.externalMb)),
			eventLoopDelayP99Ms: Stats.summarize(pick((x) => x.eventLoopDelayP99Ms)),
			eventLoopDelayMaxMs: Stats.summarize(pick((x) => x.eventLoopDelayMaxMs)),
			eventLoopUtilization: Stats.summarize(pick((x) => x.eventLoopUtilization)),
			ingestLagMs: Stats.summarize(s.flatMap((x) => x.ingestLagMs.filter((v): v is number => v !== null))),
			cgroupAnonMb: Stats.summarize(pick((x) => x.cgroup?.anonMb)),
			cgroupFileMb: Stats.summarize(pick((x) => x.cgroup?.fileMb)),
			throttledMsPerSample: Stats.summarize(pick((x) => x.cgroup?.throttledMs)),
			oomKills: s.at(-1)?.cgroup?.oomKills ?? 0,
		}
	}
}

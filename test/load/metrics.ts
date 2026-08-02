// What every actor reports back: how long each kind of action took, and which ones failed. Latency here is
// wall-clock as the actor experienced it, which for a browser includes render and for an in-game action
// includes the whole log/rcon round trip back into the app.

export type ActionStats = {
	action: string
	count: number
	errors: number
	p50Ms: number
	p95Ms: number
	p99Ms: number
	maxMs: number
	meanMs: number
}

export class Recorder {
	#durations = new Map<string, number[]>()
	#errors = new Map<string, number>()
	// kept rather than counted, because the first failure of a kind is usually the whole explanation
	readonly failures: { action: string; message: string }[] = []

	record(action: string, ms: number) {
		let bucket = this.#durations.get(action)
		if (!bucket) this.#durations.set(action, (bucket = []))
		bucket.push(ms)
	}

	fail(action: string, err: unknown) {
		this.#errors.set(action, (this.#errors.get(action) ?? 0) + 1)
		if (this.failures.length < 200) {
			this.failures.push({ action, message: err instanceof Error ? err.message : String(err) })
		}
	}

	// Times the action and swallows what it throws: one failed action is data, not a reason to stop generating
	// load. Returns undefined when it failed, so a caller that needs the value can tell.
	async time<T>(action: string, fn: () => Promise<T> | T): Promise<T | undefined> {
		const started = performance.now()
		try {
			const result = await fn()
			this.record(action, performance.now() - started)
			return result
		} catch (err) {
			this.record(action, performance.now() - started)
			this.fail(action, err)
			return undefined
		}
	}

	merge(other: Recorder) {
		for (const [action, durations] of other.#durations) {
			const bucket = this.#durations.get(action)
			if (bucket) bucket.push(...durations)
			else this.#durations.set(action, [...durations])
		}
		for (const [action, count] of other.#errors) {
			this.#errors.set(action, (this.#errors.get(action) ?? 0) + count)
		}
		this.failures.push(...other.failures.slice(0, Math.max(0, 200 - this.failures.length)))
	}

	summary(): ActionStats[] {
		return [...this.#durations.entries()]
			.map(([action, durations]) => {
				const sorted = [...durations].sort((a, b) => a - b)
				return {
					action,
					count: sorted.length,
					errors: this.#errors.get(action) ?? 0,
					p50Ms: percentile(sorted, 50),
					p95Ms: percentile(sorted, 95),
					p99Ms: percentile(sorted, 99),
					maxMs: +sorted[sorted.length - 1].toFixed(1),
					meanMs: +(sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(1),
				}
			})
			.sort((a, b) => b.p99Ms - a.p99Ms)
	}
}

function percentile(sorted: number[], p: number): number {
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
	return +sorted[index].toFixed(1)
}

// A seeded generator, so two runs of the same scenario apply the same mix of actions in the same order and a
// difference between their profiles is the code rather than the dice. mulberry32.
export function rng(seed: number) {
	let state = seed >>> 0
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
	return {
		next,
		int: (maxExclusive: number) => Math.floor(next() * maxExclusive),
		pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
		// true with the given probability
		chance: (probability: number) => next() < probability,
		// a jittered delay around `ms`, so actors do not fall into lockstep and produce a sawtooth
		jitter: (ms: number, spread = 0.5) => Math.round(ms * (1 - spread + next() * spread * 2)),
	}
}

export type Rng = ReturnType<typeof rng>

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve()
		const timer = setTimeout(finish, ms)
		signal?.addEventListener('abort', finish, { once: true })
		function finish() {
			clearTimeout(timer)
			signal?.removeEventListener('abort', finish)
			resolve()
		}
	})
}

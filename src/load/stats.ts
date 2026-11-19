// Latency samples by name, kept whole: a run records thousands, not millions.
export class Recorder {
	#samples = new Map<string, number[]>()
	#errors = new Map<string, number>()

	record(name: string, ms: number) {
		let s = this.#samples.get(name)
		if (!s) this.#samples.set(name, (s = []))
		s.push(ms)
	}

	error(name: string) {
		this.#errors.set(name, (this.#errors.get(name) ?? 0) + 1)
	}

	async time<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
		const start = performance.now()
		try {
			const res = await fn()
			this.record(name, performance.now() - start)
			return res
		} catch {
			this.error(name)
			return undefined
		}
	}

	summary() {
		const names = new Set([...this.#samples.keys(), ...this.#errors.keys()])
		return Object.fromEntries(
			[...names].sort().map((name) => [name, { ...summarize(this.#samples.get(name) ?? []), errors: this.#errors.get(name) ?? 0 }]),
		)
	}
}

export function summarize(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b)
	const q = (p: number) => (sorted.length === 0 ? null : round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]))
	return { count: sorted.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted.length ? round(sorted.at(-1)!) : null }
}

// three significant figures, so a fraction of a core survives and a latency does not carry noise digits
function round(v: number) {
	return v === 0 ? 0 : Number(v.toPrecision(3))
}

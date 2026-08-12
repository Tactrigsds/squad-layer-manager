// Two-generation exponential-bucket histogram: constant-memory quantile estimates over a rolling window of
// one-sided values (latencies, sizes). Bucket 0 holds values <= min; bucket i holds (min*growth^(i-1), min*growth^i].
// Quantiles resolve to a bucket's upper edge, so estimates err high. The rolling window is two half-windows:
// flip() retires the older generation, so a sample ages out fully after two flips.

export type ExpHistogram = {
	edges: Float64Array
	curr: Uint32Array
	prev: Uint32Array
	currCount: number
	prevCount: number
}

export function create(opts: { min: number; max: number; growth: number }): ExpHistogram {
	const bucketCount = Math.ceil(Math.log(opts.max / opts.min) / Math.log(opts.growth)) + 1
	const edges = new Float64Array(bucketCount)
	for (let i = 0; i < bucketCount; i++) edges[i] = opts.min * opts.growth ** i
	return {
		edges,
		curr: new Uint32Array(bucketCount),
		prev: new Uint32Array(bucketCount),
		currCount: 0,
		prevCount: 0,
	}
}

export function record(h: ExpHistogram, value: number) {
	const edges = h.edges
	const last = edges.length - 1
	let idx: number
	if (value <= edges[0]) {
		idx = 0
	} else if (value > edges[last]) {
		idx = last
	} else {
		idx = Math.ceil(Math.log(value / edges[0]) / Math.log(edges[1] / edges[0]))
		// float error in the log can land one bucket off; nudge to the bucket whose edges actually bound the value
		while (idx > 0 && edges[idx - 1] >= value) idx--
		while (idx < last && edges[idx] < value) idx++
	}
	h.curr[idx]++
	h.currCount++
}

export function count(h: ExpHistogram): number {
	return h.currCount + h.prevCount
}

// upper edge of the bucket containing the q-th quantile sample, over both generations. null when empty.
export function quantile(h: ExpHistogram, q: number): number | null {
	const total = count(h)
	if (total === 0) return null
	const target = Math.max(1, Math.ceil(q * total))
	let cumulative = 0
	for (let i = 0; i < h.edges.length; i++) {
		cumulative += h.curr[i] + h.prev[i]
		if (cumulative >= target) return h.edges[i]
	}
	return h.edges[h.edges.length - 1]
}

// retire the older generation: prev drops off, curr becomes prev, a fresh curr starts
export function flip(h: ExpHistogram) {
	const retired = h.prev
	h.prev = h.curr
	h.prevCount = h.currCount
	retired.fill(0)
	h.curr = retired
	h.currCount = 0
}

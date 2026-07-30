// Geometry for the charts in src/components/charts. Everything here is pure: the components own the DOM and the
// interaction state, this owns where things land.

// What a chart is drawn from. The components take these rather than defining their own props types, so a selector
// can build a whole chart's data without importing a .tsx.
export type Series = { key: string; label: string; color: string }
export type Row = { key: string; label: string; values: number[] }
// one series' contribution to one row, i.e. what a hover resolves to
export type Datum = { rowIndex: number; seriesIndex: number; value: number }

export type Segment = {
	seriesIndex: number
	value: number
	// value-space bounds, i.e. the running total before this segment and after it
	start: number
	end: number
}

// The axis a value-space chart is drawn against: a domain of [0, max] and the ticks labelling it.
export type Axis = {
	max: number
	ticks: number[]
}

const NICE_STEPS = [1, 2, 2.5, 5, 10]

// The smallest 1/2/2.5/5 * 10^k step no finer than `rough`.
function niceStep(rough: number, integer: boolean) {
	if (rough <= 0) return 1
	const magnitude = 10 ** Math.floor(Math.log10(rough))
	for (const step of NICE_STEPS) {
		const candidate = step * magnitude
		if (candidate >= rough && (!integer || Number.isInteger(candidate))) return candidate
	}
	return 10 * magnitude
}

// An axis covering [0, dataMax], extended up to the next round step so the last tick is the domain's top.
export function axis(dataMax: number, targetTicks = 4, opts?: { integer?: boolean }): Axis {
	const integer = opts?.integer ?? false
	if (!(dataMax > 0)) return { max: integer ? 1 : 0, ticks: integer ? [0, 1] : [0] }
	const step = niceStep(dataMax / Math.max(1, targetTicks), integer)
	const max = Math.ceil(dataMax / step) * step
	const ticks: number[] = []
	// accumulating by addition drifts on fractional steps, so each tick is computed from its index
	for (let i = 0; i * step <= max + step / 1000; i++) ticks.push(round(i * step))
	return { max, ticks }
}

function round(v: number) {
	return Math.round(v * 1e6) / 1e6
}

// Stacks one row of series values left to right, dropping the empty ones so nothing renders a zero-width rect.
export function stack(values: readonly number[]): Segment[] {
	const segments: Segment[] = []
	let start = 0
	for (let seriesIndex = 0; seriesIndex < values.length; seriesIndex++) {
		const value = values[seriesIndex]
		if (!(value > 0)) continue
		segments.push({ seriesIndex, value, start, end: start + value })
		start += value
	}
	return segments
}

export function total(values: readonly number[]) {
	let sum = 0
	for (const v of values) sum += v
	return sum
}

// Maps a value onto a pixel offset within `extent`. A zero-width domain would divide by zero, so it collapses to 0.
export function project(value: number, max: number, extent: number) {
	if (max <= 0) return 0
	return (value / max) * extent
}

// Rough advance width of a run of text, for deciding whether an in-bar label fits. Deliberately an estimate: a
// canvas measurement per segment per frame costs more than the occasional label we hide that would have fit.
const AVG_GLYPH_RATIO = 0.58
export function estimateTextWidth(text: string, fontSize: number) {
	return text.length * fontSize * AVG_GLYPH_RATIO
}

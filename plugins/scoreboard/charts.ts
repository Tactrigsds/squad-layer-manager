import { FONT_FAMILIES } from 'slm/server/svg-raster'

// Step-line charts drawn as SVG text, for rasterizing into a discord embed. Laid out for discord's dark theme at a
// fixed size: the embed scales the image to its own width.

export type Point = { x: number; y: number }
export type Series = { label: string; color: string; points: Point[] }

const WIDTH = 640
const HEIGHT = 300
const PAD = { top: 44, right: 44, bottom: 30, left: 44 }
const BACKGROUND = '#2b2d31'
const GRID = '#3f4147'
const AXIS_TEXT = '#b5bac1'
const TITLE_TEXT = '#f2f3f5'
const NICE_STEPS = [1, 2, 2.5, 5, 10]

/**
 * `x` is ms since the match started, and `xMax` the match's length. `fitY` fits the y axis to the data instead of
 * starting it at zero.
 */
export function lineChart(opts: { title: string; series: Series[]; xMax: number; fitY?: boolean }): string {
	const plotW = WIDTH - PAD.left - PAD.right
	const plotH = HEIGHT - PAD.top - PAD.bottom
	let minY = Infinity
	let maxY = -Infinity
	for (const series of opts.series) {
		for (const point of series.points) {
			if (point.y < minY) minY = point.y
			if (point.y > maxY) maxY = point.y
		}
	}
	if (minY === Infinity) {
		minY = 0
		maxY = 1
	}
	const yAxis = integerAxis(opts.fitY ? minY : 0, opts.fitY ? maxY : Math.max(maxY, 1), 5)
	const xMax = Math.max(opts.xMax, 60_000)
	const xPx = (x: number) => PAD.left + (Math.min(Math.max(x, 0), xMax) / xMax) * plotW
	const yPx = (y: number) => PAD.top + plotH - ((y - yAxis.min) / (yAxis.max - yAxis.min)) * plotH

	const parts: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
		`<rect width="${WIDTH}" height="${HEIGHT}" rx="6" fill="${BACKGROUND}"/>`,
		`<text x="${PAD.left}" y="26" font-family="${FONT_FAMILIES.semibold}" font-size="16" fill="${TITLE_TEXT}">${escape(opts.title)}</text>`,
	]

	let legendX = WIDTH - PAD.right
	for (const series of opts.series.toReversed()) {
		const text = escape(series.label)
		const width = estimateTextWidth(series.label, 13)
		parts.push(
			`<text x="${legendX}" y="26" text-anchor="end" font-family="${FONT_FAMILIES.regular}" font-size="13" fill="${AXIS_TEXT}">${text}</text>`,
		)
		legendX -= width + 8
		parts.push(`<rect x="${legendX - 10}" y="17" width="10" height="10" rx="2" fill="${series.color}"/>`)
		legendX -= 24
	}

	for (const tick of yAxis.ticks) {
		const y = Math.round(yPx(tick)) + 0.5
		parts.push(`<line x1="${PAD.left}" x2="${PAD.left + plotW}" y1="${y}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`)
		parts.push(
			`<text x="${PAD.left - 6}" y="${y + 4}" text-anchor="end" font-family="${FONT_FAMILIES.regular}" font-size="11" fill="${AXIS_TEXT}">${tick}</text>`,
		)
	}

	const minutes = xMax / 60_000
	const xStep = niceStep(minutes / 6)
	for (let m = 0; m <= minutes + 1e-9; m += xStep) {
		const x = xPx(m * 60_000)
		const anchor = m === 0 ? 'start' : x > PAD.left + plotW - 16 ? 'end' : 'middle'
		parts.push(
			`<text x="${x}" y="${HEIGHT - 10}" text-anchor="${anchor}" font-family="${FONT_FAMILIES.regular}" font-size="11" fill="${AXIS_TEXT}">${m}m</text>`,
		)
	}

	const finals: { y: number; value: number; color: string }[] = []
	for (const series of opts.series) {
		if (series.points.length === 0) continue
		let d = `M${xPx(series.points[0].x)} ${yPx(series.points[0].y)}`
		for (let i = 1; i < series.points.length; i++) d += `H${xPx(series.points[i].x)}V${yPx(series.points[i].y)}`
		d += `H${xPx(xMax)}`
		parts.push(`<path d="${d}" fill="none" stroke="${series.color}" stroke-width="2.5" stroke-linejoin="round"/>`)
		const last = series.points[series.points.length - 1].y
		finals.push({ y: yPx(last), value: last, color: series.color })
	}

	const labelYs = spread(
		finals.map((f) => f.y),
		14,
		PAD.top,
		PAD.top + plotH,
	)
	finals.forEach((final, i) => {
		parts.push(`<circle cx="${PAD.left + plotW}" cy="${final.y}" r="3.5" fill="${final.color}"/>`)
		parts.push(
			`<text x="${PAD.left + plotW + 8}" y="${labelYs[i] + 4}" font-family="${FONT_FAMILIES.semibold}" font-size="12" fill="${TITLE_TEXT}">${final.value}</text>`,
		)
	})

	parts.push('</svg>')
	return parts.join('')
}

function integerAxis(min: number, max: number, targetTicks: number): { min: number; max: number; ticks: number[] } {
	if (!(max > min)) {
		min = Math.floor(min) - 1
		max = Math.ceil(max) + 1
	}
	const step = Math.max(1, niceStep((max - min) / targetTicks))
	const lo = Math.floor(min / step) * step
	const hi = Math.ceil(max / step) * step
	const ticks: number[] = []
	for (let v = lo; v <= hi; v += step) ticks.push(v)
	return { min: lo, max: hi, ticks }
}

function niceStep(rough: number): number {
	if (!(rough > 0)) return 1
	const magnitude = 10 ** Math.floor(Math.log10(rough))
	for (const step of NICE_STEPS) {
		const candidate = step * magnitude
		if (candidate >= rough && Number.isInteger(candidate)) return candidate
	}
	return 10 * magnitude
}

// Moves label centres apart so none are closer than `gap`, keeping them within [min, max] and in input order.
function spread(ys: number[], gap: number, min: number, max: number): number[] {
	const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y)
	for (let k = 1; k < order.length; k++) {
		if (order[k].y - order[k - 1].y < gap) order[k].y = order[k - 1].y + gap
	}
	const overflow = order.length > 0 ? order[order.length - 1].y - max : 0
	if (overflow > 0) for (const label of order) label.y -= overflow
	const out = new Array<number>(ys.length)
	for (const label of order) out[label.i] = Math.max(min, label.y)
	return out
}

// Barlow averages a little over half its size per character.
function estimateTextWidth(text: string, fontSize: number): number {
	return text.length * fontSize * 0.55
}

function escape(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

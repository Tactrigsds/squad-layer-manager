import zlib from 'node:zlib'

import type * as Color from '@/lib/color'

// Enough of a rasteriser to turn the SLM mark into the .ico and .png the browser asks for. It handles the
// absolute M/L/Q/C/Z subset the mark is drawn with (see lib/logo.ts) and nothing else, which is why it is a
// few dozen lines rather than a dependency.

export type Fill = { d: string; translate?: { x: number; y: number }; color: Color.Rgb }

/** Vertical samples per pixel row. Horizontal coverage is exact, so this alone sets the anti-aliasing quality. */
const SUB_ROWS = 8
/** Curves are flattened until each segment is under this many device pixels. */
const FLATNESS = 0.4

/** Paints the fills in order onto a transparent square and returns straight-alpha RGBA. */
export function draw(fills: Fill[], opts: { size: number; viewBox: number }): Uint8Array {
	const { size } = opts
	const scale = size / opts.viewBox
	const premul = new Float32Array(size * size * 3)
	const alpha = new Float32Array(size * size)

	for (const fill of fills) {
		const polygons = flatten(fill.d, scale, fill.translate ?? { x: 0, y: 0 })
		const coverage = rasterize(polygons, size)
		const [r, g, b] = [fill.color.r / 255, fill.color.g / 255, fill.color.b / 255]
		for (let i = 0; i < coverage.length; i++) {
			const a = Math.min(1, coverage[i])
			if (a === 0) continue
			const keep = 1 - a
			premul[i * 3] = r * a + premul[i * 3] * keep
			premul[i * 3 + 1] = g * a + premul[i * 3 + 1] * keep
			premul[i * 3 + 2] = b * a + premul[i * 3 + 2] * keep
			alpha[i] = a + alpha[i] * keep
		}
	}

	const rgba = new Uint8Array(size * size * 4)
	for (let i = 0; i < alpha.length; i++) {
		const a = alpha[i]
		if (a === 0) continue
		for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(Math.min(1, premul[i * 3 + c] / a) * 255)
		rgba[i * 4 + 3] = Math.round(a * 255)
	}
	return rgba
}

type Point = { x: number; y: number }

function flatten(d: string, scale: number, offset: Point): Point[][] {
	const tokens = d.match(/[MLQCZ]|-?\d*\.?\d+/gi) ?? []
	const polygons: Point[][] = []
	let current: Point[] = []
	let cursor: Point = { x: 0, y: 0 }
	let start: Point = { x: 0, y: 0 }
	let i = 0
	const next = (): Point => {
		const x = (Number.parseFloat(tokens[i++]) + offset.x) * scale
		const y = (Number.parseFloat(tokens[i++]) + offset.y) * scale
		return { x, y }
	}
	const close = () => {
		if (current.length > 2) polygons.push(current)
		current = []
	}
	while (i < tokens.length) {
		const command = tokens[i++]
		switch (command) {
			case 'M': {
				close()
				cursor = start = next()
				current = [cursor]
				break
			}
			case 'L': {
				cursor = next()
				current.push(cursor)
				break
			}
			case 'Q': {
				const control = next()
				const end = next()
				for (const p of curve(cursor, [control], end)) current.push(p)
				cursor = end
				break
			}
			case 'C': {
				const c1 = next()
				const c2 = next()
				const end = next()
				for (const p of curve(cursor, [c1, c2], end)) current.push(p)
				cursor = end
				break
			}
			case 'Z': {
				current.push(start)
				close()
				cursor = start
				break
			}
			default:
				throw new Error(`unsupported path command '${command}'`)
		}
	}
	close()
	return polygons
}

function curve(from: Point, controls: Point[], to: Point): Point[] {
	const hull = [from, ...controls, to]
	let length = 0
	for (let i = 1; i < hull.length; i++) length += Math.hypot(hull[i].x - hull[i - 1].x, hull[i].y - hull[i - 1].y)
	const steps = Math.min(64, Math.max(2, Math.ceil(length / FLATNESS)))
	const points: Point[] = []
	for (let s = 1; s <= steps; s++) points.push(deCasteljau(hull, s / steps))
	return points
}

function deCasteljau(hull: Point[], t: number): Point {
	let points = hull
	while (points.length > 1) {
		const next: Point[] = []
		for (let i = 1; i < points.length; i++) {
			next.push({ x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t })
		}
		points = next
	}
	return points[0]
}

/** Non-zero winding scanline fill: exact horizontal spans, SUB_ROWS samples down. */
function rasterize(polygons: Point[][], size: number): Float32Array {
	const coverage = new Float32Array(size * size)
	const edges: { x0: number; y0: number; x1: number; y1: number }[] = []
	for (const polygon of polygons) {
		for (let i = 1; i < polygon.length; i++) {
			if (polygon[i - 1].y !== polygon[i].y) {
				edges.push({ x0: polygon[i - 1].x, y0: polygon[i - 1].y, x1: polygon[i].x, y1: polygon[i].y })
			}
		}
		const [first, last] = [polygon[0], polygon[polygon.length - 1]]
		if (first.y !== last.y) edges.push({ x0: last.x, y0: last.y, x1: first.x, y1: first.y })
	}
	if (edges.length === 0) return coverage

	const weight = 1 / SUB_ROWS
	const crossings: { x: number; winding: number }[] = []
	for (let row = 0; row < size; row++) {
		for (let sub = 0; sub < SUB_ROWS; sub++) {
			const y = row + (sub + 0.5) / SUB_ROWS
			crossings.length = 0
			for (const e of edges) {
				const [lo, hi] = e.y0 < e.y1 ? [e.y0, e.y1] : [e.y1, e.y0]
				if (y < lo || y >= hi) continue
				crossings.push({ x: e.x0 + ((y - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0), winding: e.y1 > e.y0 ? 1 : -1 })
			}
			if (crossings.length < 2) continue
			crossings.sort((a, b) => a.x - b.x)
			let winding = 0
			let spanStart = 0
			for (const crossing of crossings) {
				const was = winding
				winding += crossing.winding
				if (was === 0 && winding !== 0) spanStart = crossing.x
				else if (was !== 0 && winding === 0) addSpan(coverage, row * size, spanStart, crossing.x, size, weight)
			}
		}
	}
	return coverage
}

function addSpan(coverage: Float32Array, rowOffset: number, from: number, to: number, size: number, weight: number) {
	const x0 = Math.max(0, from)
	const x1 = Math.min(size, to)
	if (x1 <= x0) return
	for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
		coverage[rowOffset + px] += (Math.min(x1, px + 1) - Math.max(x0, px)) * weight
	}
}

// -------- PNG / ICO containers --------

export function png(rgba: Uint8Array, size: number): Buffer {
	const stride = size * 4
	const raw = Buffer.alloc((stride + 1) * size)
	for (let row = 0; row < size; row++) {
		raw[row * (stride + 1)] = 0
		Buffer.from(rgba.buffer, rgba.byteOffset + row * stride, stride).copy(raw, row * (stride + 1) + 1)
	}
	const header = Buffer.alloc(13)
	header.writeUInt32BE(size, 0)
	header.writeUInt32BE(size, 4)
	header[8] = 8 // bit depth
	header[9] = 6 // truecolour with alpha
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	])
}

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4)
	length.writeUInt32BE(data.length, 0)
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(body), 0)
	return Buffer.concat([length, body, crc])
}

let crcTable: Uint32Array | undefined
function crc32(data: Buffer): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256)
		for (let n = 0; n < 256; n++) {
			let c = n
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
			crcTable[n] = c
		}
	}
	let crc = 0xffffffff
	for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
	return (crc ^ 0xffffffff) >>> 0
}

/** Wraps PNGs in an .ico. Every size must be 256 or below; 256 is encoded as the byte 0 by the format. */
export function ico(images: { size: number; png: Buffer }[]): Buffer {
	const header = Buffer.alloc(6)
	header.writeUInt16LE(1, 2) // icon, not cursor
	header.writeUInt16LE(images.length, 4)
	const directory = Buffer.alloc(16 * images.length)
	let offset = header.length + directory.length
	images.forEach((image, i) => {
		const entry = i * 16
		directory[entry] = image.size % 256
		directory[entry + 1] = image.size % 256
		directory.writeUInt16LE(1, entry + 4) // colour planes
		directory.writeUInt16LE(32, entry + 6) // bits per pixel
		directory.writeUInt32LE(image.png.length, entry + 8)
		directory.writeUInt32LE(offset, entry + 12)
		offset += image.png.length
	})
	return Buffer.concat([header, directory, ...images.map((image) => image.png)])
}

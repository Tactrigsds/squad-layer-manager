import zlib from 'node:zlib'
import { describe, expect, test } from 'vitest'

import * as Color from '@/lib/color'
import * as Logo from '@/lib/logo'
import * as Raster from '@/lib/raster'

const BLACK = { r: 0, g: 0, b: 0 }
const RED = { r: 255, g: 0, b: 0 }

function pixel(rgba: Uint8Array, size: number, x: number, y: number) {
	const i = (y * size + x) * 4
	return { r: rgba[i], g: rgba[i + 1], b: rgba[i + 2], a: rgba[i + 3] }
}

describe('draw', () => {
	test('fills a square exactly, leaving the rest transparent', () => {
		const rgba = Raster.draw([{ d: 'M2 2L6 2L6 6L2 6Z', color: BLACK }], { size: 8, viewBox: 8 })
		expect(pixel(rgba, 8, 3, 3)).toEqual({ r: 0, g: 0, b: 0, a: 255 })
		expect(pixel(rgba, 8, 0, 0).a).toBe(0)
		expect(pixel(rgba, 8, 6, 6).a).toBe(0)
	})

	test('anti-aliases a half-covered pixel', () => {
		const rgba = Raster.draw([{ d: 'M0 0L0.5 0L0.5 1L0 1Z', color: BLACK }], { size: 1, viewBox: 1 })
		expect(pixel(rgba, 1, 0, 0).a).toBeGreaterThan(120)
		expect(pixel(rgba, 1, 0, 0).a).toBeLessThan(136)
	})

	test('honours the translate and paints later fills over earlier ones', () => {
		const shifted = { d: 'M0 0L2 0L2 2L0 2Z', translate: { x: 2, y: 2 }, color: RED }
		const rgba = Raster.draw([{ d: 'M0 0L4 0L4 4L0 4Z', color: BLACK }, shifted], { size: 4, viewBox: 4 })
		expect(pixel(rgba, 4, 3, 3)).toEqual({ r: 255, g: 0, b: 0, a: 255 })
		expect(pixel(rgba, 4, 0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 })
	})

	test('scales the path before translating it, as the svg transform does', () => {
		// scale(0.5) shrinks the 4-unit square to 2 units, then translate puts it in the bottom-right quadrant
		const fill = { d: 'M0 0L4 0L4 4L0 4Z', translate: { x: 2, y: 2 }, scale: 0.5, color: RED }
		const rgba = Raster.draw([fill], { size: 4, viewBox: 4 })
		expect(pixel(rgba, 4, 3, 3)).toEqual({ r: 255, g: 0, b: 0, a: 255 })
		expect(pixel(rgba, 4, 1, 1).a).toBe(0)
	})

	test('rejects a path command it cannot draw', () => {
		expect(() => Raster.draw([{ d: 'M0 0A1 1 0 0 1 2 2', color: BLACK }], { size: 4, viewBox: 4 })).toThrow()
	})
})

describe('the mark', () => {
	const size = 64
	const fills = (withAccent: boolean, opts?: { bleed?: boolean; contentScale?: number }) =>
		Logo.shapes(withAccent, opts).map((shape) => ({
			d: shape.d,
			translate: shape.translate,
			scale: shape.scale,
			color: shape.role === 'accent' ? { r: 0x22, g: 0xa5, b: 0x4b } : Color.parse(Logo.THEME_FILLS.dark[shape.role])!,
		}))

	test('rounds its corners and fills its centre', () => {
		const rgba = Raster.draw(fills(false), { size, viewBox: Logo.VIEW_BOX })
		expect(pixel(rgba, size, 0, 0).a).toBe(0)
		expect(pixel(rgba, size, size / 2, 4)).toMatchObject({ r: 0xfa, a: 255 })
	})

	test('paints the accent only when there is one', () => {
		const accented = Raster.draw(fills(true), { size, viewBox: Logo.VIEW_BOX })
		const plain = Raster.draw(fills(false), { size, viewBox: Logo.VIEW_BOX })
		// the accent bar spans the middle of the tile at 68.8% of its height (see lib/logo.ts)
		const y = Math.round(size * 0.688)
		expect(pixel(accented, size, size / 2, y)).toEqual({ r: 0x22, g: 0xa5, b: 0x4b, a: 255 })
		expect(pixel(plain, size, size / 2, y)).toMatchObject({ r: 0xfa, g: 0xfa, b: 0xfa })
	})

	test('bleeds to an opaque square when the platform supplies the mask', () => {
		const rgba = Raster.draw(fills(false, { bleed: true }), { size, viewBox: Logo.VIEW_BOX })
		// iOS composites a transparent pixel onto black, so a corner left rounded here shows as a black wedge
		for (const [x, y] of [
			[0, 0],
			[size - 1, 0],
			[0, size - 1],
			[size - 1, size - 1],
		]) {
			expect(pixel(rgba, size, x, y).a).toBe(255)
		}
	})

	test('pulls the letters and accent inside the maskable safe zone', () => {
		const rgba = Raster.draw(fills(true, { bleed: true, contentScale: 0.85 }), { size, viewBox: Logo.VIEW_BOX })
		const centre = size / 2
		let furthest = 0
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const p = pixel(rgba, size, x, y)
				// anything that is not the bare tile is content: the letters, the accent, or an edge between them
				if (p.r > 0xf0 && p.g > 0xf0 && p.b > 0xf0) continue
				furthest = Math.max(furthest, Math.hypot(x + 0.5 - centre, y + 0.5 - centre))
			}
		}
		// android crops a maskable icon to an arbitrary shape and guarantees only the inscribed circle of the
		// middle 80%. Unscaled, the corners of the "SLM" block fall outside it.
		expect(furthest).toBeLessThan(size * 0.4)
	})
})

describe('containers', () => {
	test('png declares its own dimensions and round-trips its pixels', () => {
		const rgba = Raster.draw([{ d: 'M0 0L4 0L4 4L0 4Z', color: RED }], { size: 4, viewBox: 4 })
		const encoded = Raster.png(rgba, 4)
		expect(encoded.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		expect(encoded.subarray(12, 16).toString('ascii')).toBe('IHDR')
		expect(encoded.readUInt32BE(16)).toBe(4)
		expect(encoded.readUInt32BE(20)).toBe(4)
		expect(encoded[24]).toBe(8)
		expect(encoded[25]).toBe(6)

		const idatStart = 8 + 25
		const idatLength = encoded.readUInt32BE(idatStart)
		const inflated = zlib.inflateSync(encoded.subarray(idatStart + 8, idatStart + 8 + idatLength))
		// each row is a filter byte followed by its pixels
		expect(inflated.length).toBe((4 * 4 + 1) * 4)
		expect(inflated.subarray(1, 5)).toEqual(Buffer.from([255, 0, 0, 255]))
	})

	test('ico indexes each image at the offset its bytes actually start', () => {
		const images = [16, 32].map((size) => ({
			size,
			png: Raster.png(Raster.draw([{ d: 'M0 0L4 0L4 4L0 4Z', color: RED }], { size, viewBox: 4 }), size),
		}))
		const encoded = Raster.ico(images)
		expect(encoded.readUInt16LE(0)).toBe(0)
		expect(encoded.readUInt16LE(2)).toBe(1)
		expect(encoded.readUInt16LE(4)).toBe(2)
		for (const [i, image] of images.entries()) {
			const entry = 6 + i * 16
			expect(encoded[entry]).toBe(image.size)
			expect(encoded[entry + 1]).toBe(image.size)
			expect(encoded.readUInt32LE(entry + 8)).toBe(image.png.length)
			const offset = encoded.readUInt32LE(entry + 12)
			expect(encoded.subarray(offset, offset + image.png.length)).toEqual(image.png)
		}
	})

	test('ico encodes a 256px image as the byte 0', () => {
		const png = Raster.png(Raster.draw([{ d: 'M0 0L4 0L4 4L0 4Z', color: RED }], { size: 256, viewBox: 4 }), 256)
		expect(Raster.ico([{ size: 256, png }])[6]).toBe(0)
	})
})

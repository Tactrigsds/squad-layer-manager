import zlib from 'node:zlib'
import { describe, expect, test } from 'vitest'

import * as Raster from '@/lib/raster'

describe('png', () => {
	test('png declares its own dimensions and round-trips its pixels', () => {
		const rgba = new Uint8Array(4 * 4 * 4).map((_, i) => [255, 0, 0, 255][i % 4])
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
})

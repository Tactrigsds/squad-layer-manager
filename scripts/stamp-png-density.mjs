// Records the device scale factor a screenshot was taken at in its PNG pHYs chunk, which the docs site build reads to
// show the image at the size it had on screen (src/scripts/build-docs.ts, imageSize).
//
//   node scripts/stamp-png-density.mjs 2 docs/images/configuring/*.png

import * as fs from 'node:fs'
import * as zlib from 'node:zlib'

const [scaleArg, ...files] = process.argv.slice(2)
const scale = Number(scaleArg)
if (!Number.isInteger(scale) || scale < 1 || files.length === 0) {
	console.error('usage: stamp-png-density.mjs <scale> <file.png>...')
	process.exit(1)
}

// 72 DPI is 2835 pixels per metre
const ppm = 2835 * scale

function chunk(type, data) {
	const out = Buffer.alloc(12 + data.length)
	out.writeUInt32BE(data.length, 0)
	out.write(type, 4, 'ascii')
	data.copy(out, 8)
	out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
	return out
}

for (const file of files) {
	const png = fs.readFileSync(file)
	const parts = [png.subarray(0, 8)]
	let stamped = false
	for (let at = 8; at < png.length;) {
		const len = png.readUInt32BE(at)
		const type = png.toString('ascii', at + 4, at + 8)
		const whole = png.subarray(at, at + 12 + len)
		at += 12 + len
		if (type === 'pHYs') continue
		if (type === 'IDAT' && !stamped) {
			const data = Buffer.alloc(9)
			data.writeUInt32BE(ppm, 0)
			data.writeUInt32BE(ppm, 4)
			data[8] = 1
			parts.push(chunk('pHYs', data))
			stamped = true
		}
		parts.push(whole)
	}
	fs.writeFileSync(file, Buffer.concat(parts))
	console.log(`${file}: ${scale}x`)
}

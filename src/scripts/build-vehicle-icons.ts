import * as fs from 'node:fs'
import * as path from 'node:path'

import * as Raster from '@/lib/raster'

// Turns Squad's vehicle map icon textures into the masks the layer details panel draws. The textures come out of
// the game's containers as DDS:
//
//     cd tools/layer-extractor
//     dotnet run -- --vanilla textures:VehicleMapIcons --out /tmp/squad-icons
//     pnpm build:vehicle-icons /tmp/squad-icons
//
// Each texture is the icon painted white on a flat grey plate, with alpha marking only the outer body. The plate
// is what separates art from background, so coverage comes from normalizing luminance off it, and the result
// ships as a white PNG whose alpha is that coverage. The panel draws it as a CSS mask filled with currentColor,
// so one file serves both themes.

const OUT_DIR = path.join(import.meta.dirname, '../assets/vehicle-icons')

type Decoded = { width: number; height: number; rgb: Uint8Array }

function decodeDds(buf: Buffer): Decoded {
	if (buf.readUInt32LE(0) !== 0x20534444) throw new Error('not a DDS file')
	const height = buf.readUInt32LE(12)
	const width = buf.readUInt32LE(16)
	const flags = buf.readUInt32LE(80)
	const fourCc = buf.toString('ascii', 84, 88)
	const data = buf.subarray(128)
	const rgb = new Uint8Array(width * height * 3)

	if ((flags & 0x4) === 0) {
		// uncompressed BGRA8
		for (let i = 0; i < width * height; i++) {
			rgb[i * 3] = data[i * 4 + 2]
			rgb[i * 3 + 1] = data[i * 4 + 1]
			rgb[i * 3 + 2] = data[i * 4]
		}
		return { width, height, rgb }
	}
	if (fourCc !== 'DXT1' && fourCc !== 'DXT3' && fourCc !== 'DXT5') throw new Error(`unhandled DDS format ${fourCc}`)

	// only the colour half of each block matters: the icon's alpha is its outer body, not its artwork
	const blockBytes = fourCc === 'DXT1' ? 8 : 16
	const colourOffset = fourCc === 'DXT1' ? 0 : 8
	const c = new Uint8Array(12)
	for (let by = 0; by < height; by += 4) {
		for (let bx = 0; bx < width; bx += 4) {
			const block = ((by / 4) * (width / 4) + bx / 4) * blockBytes + colourOffset
			for (const [slot, packed] of [
				[0, data.readUInt16LE(block)],
				[1, data.readUInt16LE(block + 2)],
			] as const) {
				c[slot * 3] = (((packed >> 11) & 0x1f) * 255) / 31
				c[slot * 3 + 1] = (((packed >> 5) & 0x3f) * 255) / 63
				c[slot * 3 + 2] = ((packed & 0x1f) * 255) / 31
			}
			for (let i = 0; i < 3; i++) {
				c[6 + i] = (2 * c[i] + c[3 + i]) / 3
				c[9 + i] = (c[i] + 2 * c[3 + i]) / 3
			}
			const indices = data.readUInt32LE(block + 4)
			for (let py = 0; py < 4; py++) {
				for (let px = 0; px < 4; px++) {
					const x = bx + px,
						y = by + py
					if (x >= width || y >= height) continue
					const slot = ((indices >> ((py * 4 + px) * 2)) & 0x3) * 3
					const out = (y * width + x) * 3
					rgb[out] = c[slot]
					rgb[out + 1] = c[slot + 1]
					rgb[out + 2] = c[slot + 2]
				}
			}
		}
	}
	return { width, height, rgb }
}

/** White, with the icon's coverage in alpha. The plate is the image's most common luminance. */
function mask({ width, height, rgb }: Decoded): Uint8Array {
	const luminance = new Uint8Array(width * height)
	const histogram = new Uint32Array(256)
	for (let i = 0; i < luminance.length; i++) {
		const v = Math.round(0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2])
		luminance[i] = v
		histogram[v]++
	}
	let plate = 0
	for (let v = 1; v < 256; v++) if (histogram[v] > histogram[plate]) plate = v
	if (plate >= 250) throw new Error('no plate to normalize against: the texture is mostly white')

	const rgba = new Uint8Array(width * height * 4)
	for (let i = 0; i < luminance.length; i++) {
		rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 255
		rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(((luminance[i] - plate) * 255) / (255 - plate))))
	}
	return rgba
}

async function main() {
	const srcDir = process.argv[2]
	if (!srcDir) throw new Error('usage: build-vehicle-icons <dir of .dds textures>')

	fs.rmSync(OUT_DIR, { recursive: true, force: true })
	fs.mkdirSync(OUT_DIR, { recursive: true })
	let written = 0
	for (const file of fs
		.readdirSync(srcDir)
		.filter((f) => f.endsWith('.dds'))
		.sort()) {
		const decoded = decodeDds(fs.readFileSync(path.join(srcDir, file)))
		if (decoded.width !== decoded.height) throw new Error(`${file} is ${decoded.width}x${decoded.height}, expected a square`)
		// the T_ prefix is inconsistent across the set, and vehicle records spell it both ways
		const name = path.basename(file, '.dds').replace(/^T_/, '').toLowerCase()
		fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), Raster.png(mask(decoded), decoded.width))
		written++
	}
	console.log(`wrote ${written} icon(s) to ${path.relative(process.cwd(), OUT_DIR)}`)
}

await main()

import zlib from 'node:zlib'

// A PNG encoder for straight-alpha RGBA, enough for the build scripts that emit images.

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

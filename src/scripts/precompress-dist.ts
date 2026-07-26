import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import * as zlib from 'node:zlib'

import * as Paths from '$root/paths'

// Writes the .br/.gz siblings that @fastify/static resolves with `preCompressed` (see systems/fastify.server.ts).
// Doing it here rather than per request means the bytes are compressed once at their best setting instead of on every
// cache miss at whatever setting is cheap enough to do inline. Runs after build:client and build:landing-css, so it
// sees everything that ships, and vite empties dist/ beforehand so there is nothing stale to clean up.

const gzip = promisify(zlib.gzip)
const brotli = promisify(zlib.brotliCompress)

const COMPRESSIBLE = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.map', '.svg', '.txt', '.wasm', '.webmanifest'])
// under this, a sibling saves less than the headers of the request that would fetch it
const MIN_BYTES = 1024
// a sibling that barely beats the original is two more files to stat for nothing
const WORTH_IT_RATIO = 0.95
// source maps are only ever fetched with devtools open, and they are by far the largest thing here: at quality 11 they
// alone cost more build time than the whole rest of dist/, to save bytes nobody is waiting on
const MAP_BROTLI_QUALITY = 5

function filesToCompress(dir: string): string[] {
	const out: string[] = []
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			out.push(...filesToCompress(full))
		} else if (entry.isFile() && COMPRESSIBLE.has(path.extname(entry.name)) && fs.statSync(full).size >= MIN_BYTES) {
			out.push(full)
		}
	}
	return out
}

async function compress(filePath: string) {
	const raw = await fs.promises.readFile(filePath)
	const quality = filePath.endsWith('.map') ? MAP_BROTLI_QUALITY : zlib.constants.BROTLI_MAX_QUALITY
	const [br, gz] = await Promise.all([
		brotli(raw, {
			params: {
				[zlib.constants.BROTLI_PARAM_QUALITY]: quality,
				[zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
			},
		}),
		gzip(raw, { level: zlib.constants.Z_BEST_COMPRESSION }),
	])

	let written = 0
	for (const [suffix, compressed] of [
		['.br', br],
		['.gz', gz],
	] as const) {
		const out = filePath + suffix
		if (compressed.length / raw.length > WORTH_IT_RATIO) {
			await fs.promises.rm(out, { force: true })
			continue
		}
		await fs.promises.writeFile(out, compressed)
		written++
	}
	return { raw: raw.length, br: br.length, gz: gz.length, written }
}

async function main() {
	if (!fs.existsSync(Paths.DIST)) throw new Error(`No ${Paths.DIST} to compress. Run build:client first.`)

	const files = filesToCompress(Paths.DIST)
	const totals = { raw: 0, br: 0, gz: 0, files: 0 }
	const queue = [...files]
	const started = performance.now()

	await Promise.all(
		Array.from({ length: Math.min(os.availableParallelism(), queue.length) }, async () => {
			for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
				const result = await compress(next)
				if (result.written === 0) continue
				totals.raw += result.raw
				totals.br += result.br
				totals.gz += result.gz
				totals.files++
			}
		}),
	)

	const mb = (bytes: number) => (bytes / 1e6).toFixed(1)
	console.log(
		`precompressed ${totals.files} of ${files.length} files in ${((performance.now() - started) / 1000).toFixed(1)}s: ` +
			`${mb(totals.raw)}MB -> ${mb(totals.br)}MB br, ${mb(totals.gz)}MB gz`,
	)
}

await main()

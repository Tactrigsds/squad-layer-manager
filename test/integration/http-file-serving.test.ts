import crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import * as Paths from '$root/paths'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'

import { ADMIN_USER, type AppFixture, createAppFixture } from '../harness/app-fixture'

// The response headers for everything the app serves out of a file. All of it is invisible from the UI and silently
// reversible -- dropping `preCompressed` or letting send compute its own Cache-Control leaves a working app that just
// ships several times the bytes -- so the contract is asserted rather than left to be noticed in a waterfall.

let app: AppFixture
let cookie: string
let base: string

// whatever vite hashed the entry into this build, rather than a hash baked into the test
function hashedEntryAsset(): string {
	const html = fs.readFileSync(path.join(Paths.DIST, 'index.html'), 'utf8')
	const match = html.match(/src="(\/assets\/[^"]+\.js)"/)
	if (!match) throw new Error('no hashed entry script in dist/index.html')
	return match[1]
}

function get(urlPath: string, headers: Record<string, string> = {}) {
	return fetch(`${base}${urlPath}`, { headers: { cookie, ...headers }, redirect: 'manual' })
}

beforeAll(async () => {
	app = await createAppFixture()
	base = `http://127.0.0.1:${app.appPort}`
	const login = await fetch(`${base}/check-auth?login=${ADMIN_USER.username}`, { redirect: 'manual' })
	expect(login.status).toBe(200)
	cookie = login.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.find((c) => c.startsWith('session-id=') && c.length > 'session-id='.length)!
	expect(cookie).toMatch(/^session-id=.+/)
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

describe('static assets', () => {
	it('serves content-hashed bundles as immutable', async () => {
		const res = await get(hashedEntryAsset())
		expect(res.status).toBe(200)
		expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
	})

	it('keeps the spa shell revalidating', async () => {
		const res = await get('/')
		expect(res.status).toBe(200)
		// index.html keeps its name across builds, so caching it immutably would pin clients to an old bundle set
		expect(res.headers.get('cache-control')).toBe('public, max-age=0')
	})

	it('serves the precompressed sibling that is on disk, under the original content type', async () => {
		const asset = hashedEntryAsset()
		for (const [encoding, ext] of [
			['br', '.br'],
			['gzip', '.gz'],
		] as const) {
			const onDisk = fs.existsSync(path.join(Paths.DIST, asset + ext))
			const res = await get(asset, { 'accept-encoding': encoding })
			expect(res.status).toBe(200)
			expect(res.headers.get('content-encoding'), `${asset}${ext} on disk: ${onDisk}`).toBe(onDisk ? encoding : null)
			// the type has to describe the file that was compressed, not the sibling it was served from
			expect(res.headers.get('content-type')).toMatch(/javascript/)
			expect(await res.text()).toContain('function')
		}
	})

	it('serves the raw file when the client accepts no encoding', async () => {
		// fetch always sends an accept-encoding, so identity has to be asked for explicitly
		const res = await get(hashedEntryAsset(), { 'accept-encoding': 'identity' })
		expect(res.status).toBe(200)
		expect(res.headers.get('content-encoding')).toBeNull()
	})

	it('does not route the compressed siblings directly', async () => {
		const asset = hashedEntryAsset()
		if (!fs.existsSync(path.join(Paths.DIST, asset + '.br'))) return
		const res = await get(asset + '.br')
		// the catch-all page route answers instead, which is what an unknown path does
		expect(res.headers.get('content-type')).toMatch(/html/)
	})
})

describe('GET /layers.bin.gz', () => {
	it('is sized, resumable and etagged', async () => {
		const res = await get('/layers.bin.gz')
		expect(res.status).toBe(200)

		const length = Number(res.headers.get('content-length'))
		expect(length).toBeGreaterThan(0)
		expect(res.headers.get('accept-ranges')).toBe('bytes')
		expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/)
		// the client inflates the body itself and stores the result, so the endpoint always serves gzip
		expect(res.headers.get('content-type')).toBe('application/gzip')
		expect((await res.arrayBuffer()).byteLength).toBe(length)
	})

	it('serves a byte range rather than starting over', async () => {
		const full = await get('/layers.bin.gz')
		const total = Number(full.headers.get('content-length'))
		await full.arrayBuffer()

		const res = await get('/layers.bin.gz', { range: 'bytes=0-99' })
		expect(res.status).toBe(206)
		expect(res.headers.get('content-range')).toBe(`bytes 0-99/${total}`)
		expect((await res.arrayBuffer()).byteLength).toBe(100)
	})

	it('etags the bytes it serves, not the ones the engine loaded', async () => {
		// the engine reads the uncompressed table when there is one, to skip a gunzip on boot, while clients always
		// download gzip. An etag taken over the loaded file would never match what the client stored, so every client
		// would re-download the artifact on every page load.
		const pair = LayerArtifacts.resolvePair()
		const res = await get('/layers.bin.gz')
		const body = await res.arrayBuffer()

		const sha256 = (bytes: ArrayBuffer | Uint8Array) =>
			crypto
				.createHash('sha256')
				.update(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
				.digest('hex')
		expect(res.headers.get('etag')).toBe(`"${sha256(body)}"`)

		if (pair.tableCompressedPath) {
			expect(Number(res.headers.get('content-length'))).toBe(fs.statSync(pair.tableCompressedPath).size)
		}
		if (pair.tableLoadPath !== pair.tableCompressedPath) {
			expect(res.headers.get('etag')).not.toBe(`"${sha256(fs.readFileSync(pair.tableLoadPath))}"`)
		}
	})

	it('answers a matching etag with 304', async () => {
		const first = await get('/layers.bin.gz')
		const etag = first.headers.get('etag')!
		await first.arrayBuffer()

		const res = await get('/layers.bin.gz', { 'if-none-match': etag })
		expect(res.status).toBe(304)
	})
})

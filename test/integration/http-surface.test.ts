import crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import * as Paths from '$root/paths'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'

import { ADMIN_USER, type AppFixture, createAppFixture } from '../harness/app-fixture'

// The app's plain-HTTP surface, asserted with raw fetch: the response headers for everything served out of a file,
// and the session endpoints. The file-serving contract is invisible from the UI and silently reversible -- dropping
// `preCompressed` or letting send compute its own Cache-Control leaves a working app that just ships several times
// the bytes -- so it is asserted rather than left to be noticed in a waterfall.

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

// A device that gets no icon reports nothing, so the renditions are asserted rather than left to be spotted on a
// phone: every href the shell links, and every icon the manifest names, has to answer unauthenticated.
describe('the icon renditions', () => {
	function shellIconHrefs(): string[] {
		const html = fs.readFileSync(path.join(Paths.DIST, 'index.html'), 'utf8')
		return [...html.matchAll(/<link\b[^>]*rel="(?:icon|apple-touch-icon|manifest)"[^>]*>/g)].map(
			(tag) => tag[0].match(/href="([^"]+)"/)![1],
		)
	}

	// unauthed, because the visitor who most needs an icon is the one looking at the landing page
	const fetchIcon = (href: string) => fetch(`${base}${href}`, { redirect: 'manual' })

	it('serves every icon the shell links', async () => {
		const hrefs = shellIconHrefs()
		expect(hrefs).toEqual(expect.arrayContaining(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/manifest.webmanifest']))
		for (const href of hrefs) {
			const res = await fetchIcon(href)
			expect(res.status, href).toBe(200)
			expect((await res.arrayBuffer()).byteLength, href).toBeGreaterThan(0)
		}
	})

	it("carries the shell head's icon links onto the landing page", async () => {
		// the landing page rebuilds its head from index.html, and drops any attribute it does not know to copy
		const html = await (await fetch(`${base}/`, { redirect: 'manual' })).text()
		for (const link of shellIconHrefs()) expect(html).toContain(`href="${link}"`)
		expect(html).toContain('sizes="180x180"')
		expect(html).toContain('rel="manifest"')
	})

	it('serves every icon the manifest names, at the size it claims', async () => {
		const manifest = await (await fetchIcon('/manifest.webmanifest')).json()
		expect(manifest.icons.length).toBeGreaterThan(0)
		expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable')).toBe(true)
		for (const icon of manifest.icons as { src: string; sizes: string }[]) {
			const res = await fetchIcon(icon.src)
			expect(res.status, icon.src).toBe(200)
			const png = Buffer.from(await res.arrayBuffer())
			expect(png.subarray(1, 4).toString('ascii'), icon.src).toBe('PNG')
			// IHDR's width and height, which is what the platform actually picks the icon by
			const declared = icon.sizes.split('x').map(Number)
			expect([png.readUInt32BE(16), png.readUInt32BE(20)], icon.src).toEqual(declared)
		}
	})

	it('packs the ico with the sizes the shell advertises', async () => {
		const html = fs.readFileSync(path.join(Paths.DIST, 'index.html'), 'utf8')
		const advertised = html
			.match(/href="\/favicon\.ico" sizes="([^"]+)"/)![1]
			.split(' ')
			.map((size) => Number(size.split('x')[0]))

		const ico = Buffer.from(await (await fetchIcon('/favicon.ico')).arrayBuffer())
		expect(ico.readUInt16LE(2)).toBe(1)
		const packed = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16])
		// a size the shell claims but the ico lacks leaves the browser upscaling another entry
		expect(packed).toEqual(advertised)
	})

	it('revalidates rather than pinning a stale accent, and answers a matching etag with 304', async () => {
		const first = await fetchIcon('/favicon.svg')
		expect(first.headers.get('cache-control')).toBe('no-cache')
		const etag = first.headers.get('etag')!
		await first.arrayBuffer()

		const res = await fetch(`${base}/favicon.svg`, { headers: { 'if-none-match': etag }, redirect: 'manual' })
		expect(res.status).toBe(304)
	})
})

// Regression: POST /logout used to deadlock. Sessions.logout awaited clearInvalidSession, which returns the
// FastifyReply, and a reply is a thenable that only settles once the response is sent -- so the handler blocked
// forever waiting for a send it was itself holding up. The request never got a response.
describe('POST /logout', () => {
	it('responds instead of hanging on the thenable reply', async () => {
		// a session of its own, so logging it out cannot invalidate the cookie the other tests share
		const login = await fetch(`${base}/check-auth?login=${ADMIN_USER.username}`, { redirect: 'manual' })
		expect(login.status).toBe(200)
		const sessionCookie = login.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.find((c) => c.startsWith('session-id=') && c.length > 'session-id='.length)
		expect(sessionCookie).toMatch(/^session-id=.+/)

		// the deadlock never sent a response, so a short timeout is what turns the hang into a failed assertion
		// rather than a stuck test
		const res = await fetch(`${base}/logout`, {
			method: 'POST',
			headers: { cookie: sessionCookie! },
			redirect: 'manual',
			signal: AbortSignal.timeout(5000),
		})
		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe('/')
		// the session cookie is cleared
		expect(res.headers.getSetCookie().some((c) => c.startsWith('session-id=;') || /Max-Age=0/.test(c))).toBe(true)
	})
})

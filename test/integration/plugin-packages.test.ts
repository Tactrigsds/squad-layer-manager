import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { createOrpcClient, firstYield, sessionCookie, type TestOrpcClient } from '../harness/orpc-client'

// The packaged-plugin path end to end: a plugin built into standalone esm, served over http, then
// installed, started, called, upgraded and removed through the same api the settings page uses. What
// it is really testing is that a bundle with no copy of SLM in it can reach `slm/*`, drizzle and its
// own config once the host resolves those for it.
//
// The origin imitates GitHub's release layout, which is the shape a real plugin ships in: assets under
// a tag, and `latest` redirecting to whichever tag that is now. Installing through the redirect is what
// covers relative resolution across a path -- the host resolves the other files against the url it was
// given, before any redirect -- and flipping which tag `latest` points at is what an upgrade is.

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

let app: AppFixture
let client: TestOrpcClient
let origin: http.Server
let manifestUrl: string
let cookie: string
let pkgV1: string
// the tag `/releases/latest/download/` resolves to; flipped to publish the upgrade
let latestTag = 'v1.0.0'
const releases = new Map<string, string>()

// A second release of the same plugin, built by patching the packed bundles rather than a second source
// tree: `plugin:pack` resolves `slm/*` through the repo's tsconfig paths, so a patched copy of the
// fixture cannot live in a temp directory. Every edit asserts it matched, so a change to what the packer
// emits fails here rather than silently producing an upgrade identical to what it replaces.
function packUpgrade(fromDir: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-pkg-v2-'))
	for (const file of fs.readdirSync(fromDir)) fs.copyFileSync(path.join(fromDir, file), path.join(dir, file))
	const patch = (file: string, from: string, to: string) => {
		const before = fs.readFileSync(path.join(dir, file), 'utf8')
		if (!before.includes(from)) throw new Error(`packed ${file} no longer contains ${JSON.stringify(from)}`)
		fs.writeFileSync(path.join(dir, file), before.replaceAll(from, to))
	}
	patch('plugin.json', '"version": "1.0.0"', '"version": "1.1.0"')
	patch('plugin.mjs', 'version: "1.0.0"', 'version: "1.1.0"')
	// what the per-server hook writes, so the row it leaves proves the new server bundle is what ran
	patch('server.mjs', 'text: PluginConfig.get(sctx).greeting', "text: PluginConfig.get(sctx).greeting + '-v2'")
	// the client bundle has to differ too, or its asset url keeps its hash and no reload is ever asked for
	patch('client.mjs', 'hello-plugin-slot', 'hello-plugin-slot-v2')
	return dir
}

beforeAll(async () => {
	pkgV1 = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-pkg-'))
	childProcess.execFileSync('pnpm', ['plugin:pack', 'test/fixtures/plugin-hello', pkgV1], { cwd: REPO_ROOT, stdio: 'pipe' })
	releases.set('v1.0.0', pkgV1)
	releases.set('v1.1.0', packUpgrade(pkgV1))

	origin = http.createServer((req, res) => {
		const url = req.url ?? ''
		const latest = /^\/releases\/latest\/download\/(.+)$/.exec(url)
		if (latest) {
			res.writeHead(302, { location: `/releases/download/${latestTag}/${latest[1]}` }).end()
			return
		}
		const asset = /^\/releases\/download\/([^/]+)\/(.+)$/.exec(url)
		const dir = asset && releases.get(asset[1])
		const file = dir ? path.join(dir, path.basename(asset![2])) : null
		if (!file || !fs.existsSync(file)) return res.writeHead(404).end()
		res.writeHead(200, { 'content-type': 'text/javascript' }).end(fs.readFileSync(file))
	})
	await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
	manifestUrl = `http://127.0.0.1:${(origin.address() as { port: number }).port}/releases/latest/download/plugin.json`

	app = await createAppFixture()
	client = await createOrpcClient(app)
	cookie = await sessionCookie(app)
}, 180_000)

afterAll(async () => {
	await app?.dispose()
	origin?.close()
})

function readRows<T>(query: string, ...params: unknown[]): T[] {
	const db = app.readDb()
	try {
		return db.prepare(query).all(...params) as T[]
	} finally {
		db.close()
	}
}

async function leftoverData() {
	const next = await firstYield((signal) => client.plugins.watchPlugins(undefined, { signal }), { label: 'the plugin list stream' })
	return (next.leftoverData as { pluginId: string }[]).find((e) => e.pluginId === 'hello')
}

async function pluginInfo() {
	const next = await firstYield((signal) => client.plugins.watchPlugins(undefined, { signal }), { label: 'the plugin list stream' })
	return (next.plugins as { id: string }[]).find((i) => i.id === 'hello') as
		| {
				id: string
				version: string
				status: string
				enabled: boolean
				source: string
				sourceUrl: string | null
				clientEntry: string | null
		  }
		| undefined
}

describe('packaged plugins', () => {
	// through the `latest` redirect, so this also covers the two things a release url needs: the redirect
	// itself, and every other file resolving against the url that was pasted rather than where it landed
	it('installs from a url into the plugins folder, stopped', async () => {
		const res = await client.plugins.installFromUrl({ url: manifestUrl })
		expect(res).toMatchObject({ code: 'ok', pluginId: 'hello' })

		const info = await pluginInfo()
		// the moving url is what gets recorded, which is what makes a later refresh an upgrade
		expect(info).toMatchObject({ version: '1.0.0', status: 'inactive', enabled: false, source: 'url', sourceUrl: manifestUrl })
		// the client bundle is served from SLM, not from the origin it came from
		expect(info?.clientEntry).toMatch(/^\/plugin-assets\/hello\/client\.mjs\?v=/)
	})

	it('starts, applies its migration and reaches core through the shimmed imports', async () => {
		const res = await client.plugins.setEnabled({ pluginId: 'hello', enabled: true })
		expect(res).toMatchObject({ code: 'ok', status: 'active' })

		expect(readRows(`SELECT 1 FROM _plugin_migrations WHERE pluginId = 'hello' AND name = '0001_init'`)).toHaveLength(1)
		const row = await app.waitFor(() => readRows<{ text: string; serverId: string }>(`SELECT * FROM p_hello_greetings`)[0], {
			label: 'the row the per-server hook writes',
		})
		expect(row).toMatchObject({ text: 'hello', serverId: app.serverId })
		// AppEvents.emit resolved through slm/systems/app-events inside the bundle
		expect(readRows(`SELECT 1 FROM appEvents WHERE type = 'PLUGIN_EVENT' AND actorPluginId = 'hello'`)).toHaveLength(1)
	})

	it('serves its rpc, its client bundle and the api shims, but not its server bundle', async () => {
		const first = await firstYield(
			(signal) =>
				client.plugins.rpcStream(
					{ pluginId: 'hello', path: ['greetings'], serverId: app.serverId, input: { serverId: app.serverId } },
					{ signal },
				),
			{ label: 'the greetings stream' },
		)
		expect(first).toMatchObject({ code: 'ok' })
		expect((first as { data: { text: string }[] }).data[0].text).toBe('hello')

		const get = (url: string) => fetch(`${app.appUrl}${url}`, { headers: { cookie } })

		// a shim is generated, not a file: it re-exports the running app's own module
		const shim = await get('/plugin-api/slm/plugin')
		expect(shim.status).toBe(200)
		expect(await shim.text()).toContain('as definePlugin')

		// the shared packages a plugin's bundle imports are served the same way, oRPC among them
		const orpcShim = await get('/plugin-api/pkg/@orpc/client')
		expect(orpcShim.status).toBe(200)
		expect(await orpcShim.text()).toContain('as createORPCClient')

		const client_ = await get((await pluginInfo())!.clientEntry!)
		expect(client_.status).toBe(200)
		expect(await client_.text()).toContain('definePluginClient')

		// only the files plugin.json names as browser-facing are reachable
		expect((await get('/plugin-assets/hello/server.mjs')).status).toBe(404)
	})

	it('gives a restarted plugin a fresh module graph', async () => {
		const stats = async () =>
			(await client.plugins.rpcCall({ pluginId: 'hello', path: ['stats'], serverId: app.serverId, input: {} })) as {
				code: string
				data?: { activations: number }
			}
		expect((await stats()).data?.activations).toBe(1)

		await client.plugins.setEnabled({ pluginId: 'hello', enabled: false })
		await client.plugins.setEnabled({ pluginId: 'hello', enabled: true })

		// 2 would mean the second activate() ran against the first run's module scope
		expect((await stats()).data?.activations).toBe(1)
	})

	it('refreshing a moving release url upgrades to whatever it now points at', async () => {
		const before = (await pluginInfo())!
		expect(before.version).toBe('1.0.0')

		latestTag = 'v1.1.0'
		expect(await client.plugins.refresh({ pluginId: 'hello' })).toMatchObject({ code: 'ok' })

		const after = await app.waitFor(
			async () => {
				const info = await pluginInfo()
				return info?.version === '1.1.0' && info.status === 'active' ? info : undefined
			},
			{ label: 'hello active on 1.1.0' },
		)

		// a changed bundle is a new asset url, which is the only thing that makes an open page ask for a reload
		expect(after.clientEntry).not.toBe(before.clientEntry)

		// written by the per-server hook in the new bundle, so the upgraded code is what is running, not
		// just the manifest the settings page reads
		await app.waitFor(() => readRows(`SELECT 1 FROM p_hello_greetings WHERE text = 'hello-v2'`)[0], {
			label: "the upgraded bundle's greeting row",
		})
	})

	it('re-fetches on refresh and removes the directory on uninstall, keeping the data behind', async () => {
		expect(await client.plugins.refresh({ pluginId: 'hello' })).toMatchObject({ code: 'ok' })
		await app.waitFor(async () => ((await pluginInfo())?.status === 'active' ? true : undefined), {
			label: 'hello active again after refresh',
		})

		// data belongs to a plugin that is still there, so it is not anyone's to delete yet
		expect(await client.plugins.purgeData({ pluginId: 'hello' })).toMatchObject({ code: 'err:plugin-present' })

		expect(await client.plugins.uninstall({ pluginId: 'hello' })).toMatchObject({ code: 'ok' })
		expect(await pluginInfo()).toBeUndefined()

		expect(readRows(`SELECT 1 FROM plugins WHERE id = 'hello'`)).toHaveLength(1)
		expect(readRows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'p_hello_greetings'`)).toHaveLength(1)
		expect(await leftoverData()).toMatchObject({ pluginId: 'hello', migrations: 1, tables: [{ name: 'p_hello_greetings' }] })
	})

	it("deletes an uninstalled plugin's settings and tables on request", async () => {
		expect(await client.plugins.purgeData({ pluginId: 'hello' })).toMatchObject({ code: 'ok' })

		expect(readRows(`SELECT 1 FROM plugins WHERE id = 'hello'`)).toHaveLength(0)
		expect(readRows(`SELECT 1 FROM sqlite_master WHERE name LIKE 'p\\_hello\\_%' ESCAPE '\\'`)).toHaveLength(0)
		expect(readRows(`SELECT 1 FROM _plugin_migrations WHERE pluginId = 'hello'`)).toHaveLength(0)
		expect(await leftoverData()).toBeUndefined()

		// the plugin sharing the database keeps everything it owns
		expect(readRows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'p_balance_triggers_events'`)).toHaveLength(1)
		expect(readRows(`SELECT 1 FROM _plugin_migrations WHERE pluginId = 'balance-triggers'`).length).toBeGreaterThan(0)
	})

	// The other way a package arrives: an admin drops a directory in and presses rescan. It is the packed
	// output alone, with no install record beside it, which is what separates it from one SLM fetched.
	it('picks up a directory placed in the folder by hand, with no source to refresh from', async () => {
		const dest = path.join(app.tmpDir, 'plugins', 'hello')
		fs.mkdirSync(dest, { recursive: true })
		for (const file of fs.readdirSync(pkgV1)) fs.copyFileSync(path.join(pkgV1, file), path.join(dest, file))

		expect(await client.plugins.rescan()).toMatchObject({ code: 'ok' })

		const info = await pluginInfo()
		expect(info).toMatchObject({ version: '1.0.0', source: 'directory', sourceUrl: null, status: 'inactive', enabled: false })

		expect(await client.plugins.refresh({ pluginId: 'hello' })).toMatchObject({
			code: 'err:install-failed',
			message: expect.stringContaining('placed by hand'),
		})

		// it is a real installation, not just a listing: it starts and re-applies its migration from scratch,
		// the purge above having taken its table with it
		expect(await client.plugins.setEnabled({ pluginId: 'hello', enabled: true })).toMatchObject({ code: 'ok', status: 'active' })
		expect(readRows(`SELECT 1 FROM _plugin_migrations WHERE pluginId = 'hello' AND name = '0001_init'`)).toHaveLength(1)
	})
})

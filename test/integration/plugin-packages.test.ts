import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { createOrpcClient, firstYield, sessionCookie, type TestOrpcClient } from '../harness/orpc-client'

// The packaged-plugin path end to end: a plugin built into standalone esm, served over http, then
// installed, started, called and removed through the same api the settings page uses. What it is
// really testing is that a bundle with no copy of SLM in it can reach `slm/*`, drizzle and its own
// config once the host resolves those for it.

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

let app: AppFixture
let client: TestOrpcClient
let origin: http.Server
let manifestUrl: string
let cookie: string

beforeAll(async () => {
	const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-pkg-'))
	childProcess.execFileSync('pnpm', ['plugin:pack', 'test/fixtures/plugin-hello', pkgDir], { cwd: REPO_ROOT, stdio: 'pipe' })

	origin = http.createServer((req, res) => {
		const file = path.join(pkgDir, path.basename(req.url ?? ''))
		if (!fs.existsSync(file)) return res.writeHead(404).end()
		res.writeHead(200, { 'content-type': 'text/javascript' }).end(fs.readFileSync(file))
	})
	await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
	manifestUrl = `http://127.0.0.1:${(origin.address() as { port: number }).port}/plugin.json`

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

async function pluginInfo() {
	const infos = await firstYield((signal) => client.plugins.watchPlugins(undefined, { signal }), { label: 'the plugin list stream' })
	return (infos as { id: string }[]).find((i) => i.id === 'hello') as
		| { id: string; status: string; enabled: boolean; source: string; sourceUrl: string | null; clientEntry: string | null }
		| undefined
}

describe('packaged plugins', () => {
	it('installs from a url into the plugins folder, stopped', async () => {
		const res = await client.plugins.installFromUrl({ url: manifestUrl })
		expect(res).toMatchObject({ code: 'ok', pluginId: 'hello' })

		const info = await pluginInfo()
		expect(info).toMatchObject({ status: 'inactive', enabled: false, source: 'url', sourceUrl: manifestUrl })
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
					{ pluginId: 'hello', name: 'greetings', serverId: app.serverId, input: { serverId: app.serverId } },
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

		const client_ = await get((await pluginInfo())!.clientEntry!)
		expect(client_.status).toBe(200)
		expect(await client_.text()).toContain('definePluginClient')

		// only the files plugin.json names as browser-facing are reachable
		expect((await get('/plugin-assets/hello/server.mjs')).status).toBe(404)
	})

	it('re-fetches on refresh and removes the directory on uninstall', async () => {
		expect(await client.plugins.refresh({ pluginId: 'hello' })).toMatchObject({ code: 'ok' })
		await app.waitFor(async () => ((await pluginInfo())?.status === 'active' ? true : undefined), {
			label: 'hello active again after refresh',
		})

		expect(await client.plugins.uninstall({ pluginId: 'hello' })).toMatchObject({ code: 'ok' })
		expect(await pluginInfo()).toBeUndefined()
	})
})

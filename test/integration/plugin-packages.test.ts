import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'

import { ADMIN_USER, type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { LAYERS, role } from '../harness/arrange'
import * as Inspect from '../harness/inspect'
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
const ADMIN_STEAM_ID = '76561198000000001'

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

	// an in-game admin who is also the seeded superuser, so the plugin's command has somebody allowed to run it
	app = await createAppFixture({
		admins: [ADMIN_STEAM_ID],
		adminSteamIds: [ADMIN_STEAM_ID],
		users: [OUTSIDER],
		globalSettings: (settings) => {
			settings.rbac.roles['plugin-rpc-outsider'] = {
				...role(['site:authorized', 'squad-server:view'], { users: [OUTSIDER] }),
				// an action the host has no definition for: only the plugin knows what it means
				pluginGrants: [{ pluginId: 'hello', permission: 'greet', serverIds: [] }],
			}
		},
	})
	client = await createOrpcClient(app)
	cookie = await sessionCookie(app)
}, 180_000)

afterAll(async () => {
	await app?.dispose()
	origin?.close()
})

// signed in, so the host lets their rpc through, and holding nothing beyond that
const OUTSIDER: TestUser = { discordId: 900000000000000077n, username: 'plugin-rpc-outsider' }

function readRows<T>(query: string, ...params: unknown[]): T[] {
	const db = app.readDb()
	try {
		return db.prepare(query).all(...params) as T[]
	} finally {
		db.close()
	}
}

// One of the plugin's own procedures, over the host's generic plugin-rpc route -- the same way the browser
// reaches it. `data` is whatever the procedure returned.
async function call<T>(path: string, input: unknown): Promise<T> {
	const res = (await client.plugins.rpcCall({ pluginId: 'hello', path: [path], serverId: app.serverId, input })) as {
		code: string
		data?: T
	}
	if (res.code !== 'ok') throw new Error(`plugin rpc ${path} failed: ${res.code}`)
	return res.data as T
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
				permissions: { name: string; scope: string; description: string }[]
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

	// Filters are core state a plugin shares with every admin, so the interesting part is not that the row
	// appears: it is that the write went through the host's own path. The FILTER_CHANGED rows are what
	// prove it, since only that path writes them, and they name the plugin rather than a person.
	it('creates, updates and deletes filters, recorded against the plugin', async () => {
		const owner = String(ADMIN_USER.discordId)
		const filterRow = () => readRows<{ name: string; owner: string; filter: string }>(`SELECT * FROM filters WHERE id = 'hello-pool'`)[0]

		expect(await call('makeFilter', { id: 'hello-pool', owner })).toMatchObject({ code: 'ok' })
		expect(filterRow()).toMatchObject({ name: 'Hello pool', owner })
		// FB.and built a real tree through the shim, not a string the plugin happened to send
		expect(JSON.parse(filterRow().filter)).toMatchObject({ type: 'and', children: [{ type: 'eq' }, { type: 'in', neg: true }] })
		// the in-memory index the whole server reads from, which only the mutation stream keeps current
		expect(await call('filterIds', {})).toContain('hello-pool')

		expect(await call('makeFilter', { id: 'hello-pool', owner })).toMatchObject({ code: 'err:already-exists' })

		expect(await call('renameFilter', { id: 'hello-pool', name: 'Hello pool v2' })).toMatchObject({ code: 'ok' })
		expect(filterRow().name).toBe('Hello pool v2')

		expect(await call('dropFilter', { id: 'hello-pool' })).toMatchObject({ code: 'ok' })
		expect(filterRow()).toBeUndefined()

		expect(
			readRows<{ action: string }>(
				`SELECT json_extract(data, '$.json.action') AS action FROM appEvents
				 WHERE type = 'FILTER_CHANGED' AND actorPluginId = 'hello' ORDER BY rowid`,
			).map((r) => r.action),
		).toEqual(['created', 'updated', 'deleted'])
	})

	// Nothing stopped an admin deleting a filter a plugin's config named, which left the plugin failing later
	// with "the pool matched no layers". A Fields.filterId field is a reference like a pool config is.
	it('refuses to delete a filter a running plugin has configured', async () => {
		await call('makeFilter', { id: 'hello-configured', owner: String(ADMIN_USER.discordId) })
		await client.plugins.updateConfig({ pluginId: 'hello', config: { greeting: 'hello', pool: 'hello-configured' } })

		const refused = await app.waitFor(
			async () => {
				const res = await call<{ code: string; references?: { type: string; pluginId?: string; path?: string }[] }>('dropFilter', {
					id: 'hello-configured',
				})
				return res.code === 'err:filter-in-use' ? res : undefined
			},
			{ label: 'the plugin config to reach the reference index' },
		)
		expect(refused.references).toContainEqual({ type: 'plugin-config', pluginId: 'hello', path: 'pool', via: [] })

		// clearing the field releases it, so an admin is never stuck with a filter they cannot remove
		await client.plugins.updateConfig({ pluginId: 'hello', config: { greeting: 'hello', pool: '' } })
		await app.waitFor(
			async () => ((await call<{ code: string }>('dropFilter', { id: 'hello-configured' })).code === 'ok' ? true : undefined),
			{ label: 'the reference to be released' },
		)
	})

	// A permission SLM knows nothing about: the plugin declares it, a role is granted it by id (plain strings,
	// so the grant survives the plugin being stopped and can live in settings that load long before any plugin
	// does), and the check runs through the same matcher core permissions use.
	it('authorizes against an action the plugin declared for itself', async () => {
		const outsiderClient = await createOrpcClient(app, OUTSIDER)
		const call = async (path: string) =>
			(
				(await outsiderClient.plugins.rpcCall({ pluginId: 'hello', path: [path], serverId: app.serverId, input: {} })) as {
					data?: { code: string; greeting?: string }
				}
			).data

		// the role was granted hello:greet and nothing else, so the two procedures answer differently
		expect(await call('greetIfAllowed')).toMatchObject({ code: 'ok', greeting: 'hello' })
		expect(await call('whoAmI')).toMatchObject({ code: 'err:permission-denied' })
	})

	it('reports the actions a running plugin declares', async () => {
		expect((await pluginInfo())?.permissions).toContainEqual({
			name: 'greet',
			scope: 'server',
			description: 'Send the greeting on a server',
		})
	})

	// A plugin's two halves of the same job: it makes a filter, then asks the engine what matches it. The
	// filter is created and dropped here rather than reused from the test above, so neither depends on the
	// other's leftovers.
	it('queries the layer table through a filter it created', async () => {
		await call('makeFilter', { id: 'hello-owi', owner: String(ADMIN_USER.discordId) })

		const matching = await call<{ code: string; total: number; collections: string[] }>('inFilter', { filterId: 'hello-owi' })
		expect(matching.code).toBe('ok')
		expect(matching.total).toBeGreaterThan(0)
		// the filter is `Collection = OWI and Gamemode not in (Seed, Training)`, so the engine applied it
		expect(matching.collections.every((c) => c === 'OWI')).toBe(true)

		// the same filter as a pool: a seed layer fails it, an ordinary one does not, and an id naming no
		// layer is out of pool rather than an error
		const pool = await call<{ code: string; outOfPool: string[] }>('outOfPool', {
			filterId: 'hello-owi',
			layerIds: [LAYERS.gorodokRaas, LAYERS.sumariSeed, 'NOT-A-LAYER:XX:YY'],
		})
		expect(pool.outOfPool).toEqual([LAYERS.sumariSeed, 'NOT-A-LAYER:XX:YY'])

		expect(await call('layersExist', { layerIds: [LAYERS.harjuRaas, 'NOT-A-LAYER:XX:YY'] })).toMatchObject({
			results: [
				{ id: LAYERS.harjuRaas, exists: true },
				{ id: 'NOT-A-LAYER:XX:YY', exists: false },
			],
		})

		const maps = await call<{ code: string; values: string[] }>('mapValues', {})
		expect(maps.values).toContain('Gorodok')

		await call('dropFilter', { id: 'hello-owi' })
	})

	// genVote is a query that draws rather than lists, and the two things worth pinning are that a choice
	// already decided is left alone and that the drawn ones differ on what uniqueConstraints names.
	it('draws vote choices, honouring a preset choice and the uniqueness keys', async () => {
		await call('makeFilter', { id: 'hello-vote', owner: String(ADMIN_USER.discordId) })

		const draw = async (seed: string) =>
			await call<{ code: string; maps: (string | null)[]; unfilledChoices: number[] }>('drawVote', {
				filterId: 'hello-vote',
				seed,
				presetLayerId: LAYERS.harjuRaas,
			})

		const first = await draw('seed-a')
		expect(first.code).toBe('ok')
		expect(first.unfilledChoices).toEqual([])
		// the preset choice is not drawn for, so it comes back with no layer of its own
		expect(first.maps[1]).toBeNull()
		// uniqueConstraints: ['Map'], so the two drawn choices cannot share a map, nor take the preset's
		expect(new Set([first.maps[0], first.maps[2], 'Harju']).size).toBe(3)

		// the seed is what makes a draw reproducible, and a different one is free to differ
		expect((await draw('seed-a')).maps).toEqual(first.maps)

		await call('dropFilter', { id: 'hello-vote' })
	})

	// The queue is core state every admin shares, so the point is not that the list changes: it is that a
	// plugin's edit is an ordinary edit, and that it refuses rather than overwriting when someone is
	// mid-edit. The entries handed back keep their items, which is what preserves tags and notes.
	it('edits the saved queue, and refuses when an admin has unsaved edits open', async () => {
		const before = await call<{ itemId: string; layerId: string }[]>('savedQueue', {})

		expect(await call('prependLayer', { layerId: LAYERS.harjuRaas })).toMatchObject({ code: 'ok' })
		const after = await call<{ itemId: string; layerId: string; source: string; sourcePluginId: string | null }[]>('savedQueue', {})
		expect(after[0].layerId).toBe(LAYERS.harjuRaas)
		// the item says which plugin queued it, rather than blaming whoever the edit was performed as
		expect(after[0].source).toBe('plugin')
		expect(after[0].sourcePluginId).toBe('hello')
		// and the audit log names the plugin too, rather than falling back to 'system' because no user issued it
		expect(
			readRows<{ actorType: string; actor: string }>(
				`SELECT actorType, actorPluginId AS actor FROM appEvents WHERE type = 'QUEUE_UPDATED' ORDER BY rowid DESC LIMIT 1`,
			)[0],
		).toMatchObject({ actorType: 'plugin', actor: 'hello' })
		// everything that was there is still there, with the same item ids: passing an entry through keeps it
		expect(after.slice(1).map((i) => i.itemId)).toEqual(before.map((i) => i.itemId))
		expect(Inspect.savedQueue(app)[0]).toMatchObject({ layerId: LAYERS.harjuRaas })

		expect(await call('dropFirstLayer', {})).toMatchObject({ code: 'ok' })
		expect((await call<{ itemId: string }[]>('savedQueue', {})).map((i) => i.itemId)).toEqual(before.map((i) => i.itemId))

		// an unknown item id cannot silently vanish from the list
		expect(await call('prependLayer', { layerId: 'NOT-A-LAYER:XX:YY' })).toMatchObject({ code: 'ok' })
		await call('dropFirstLayer', {})
	})

	it('sees server events as they land', async () => {
		const speaker = app.emu.world.connectPlayer(makePlayer({ name: ' plugin_event_watcher', teamId: 1 }))
		await app.waitForRosterSync()

		const pending = call<{ type: string } | null>('nextEvent', { type: 'CHAT_MESSAGE', ms: 20_000 })
		// the stream is hot, so anything before the subscription attaches is missed
		await new Promise((resolve) => setTimeout(resolve, 500))
		app.emu.world.chat(speaker, 'ChatAll', 'hello from a test')
		expect(await pending).toMatchObject({ type: 'CHAT_MESSAGE' })
	})

	// endMatch is host-owned precisely so the round end is attributed. A plugin cannot emit MATCH_ENDED
	// itself -- slm/systems/app-events only writes PLUGIN_EVENT -- so the actorPluginId on the row is the
	// whole point of the function existing.
	it('ends a match, attributed to the plugin', async () => {
		expect(await call('endMatch', {})).toMatchObject({ code: 'ok' })
		expect(
			readRows<{ actor: string }>(
				`SELECT actorPluginId AS actor FROM appEvents WHERE type = 'MATCH_ENDED' ORDER BY rowid DESC LIMIT 1`,
			)[0],
		).toMatchObject({ actor: 'hello' })
	})

	// The host owns dispatch (trigger, chat, enabled); the plugin owns authorization, because what a command
	// needs can depend on its arguments. Both halves are checked here.
	it('runs an in-game command it contributed, gated by the plugin', async () => {
		const admin = app.emu.world.connectPlayer(makePlayer({ name: ' plugin_cmd_admin', steam: ADMIN_STEAM_ID, teamId: 1 }))
		const outsider = app.emu.world.connectPlayer(makePlayer({ name: ' plugin_cmd_outsider', teamId: 2 }))
		await app.waitForRosterSync()

		app.emu.world.chat(admin, 'ChatAdmin', '/hello world')
		await app.waitFor(() => Inspect.warnsTo(app, admin).find((w) => w.includes('world')), { label: "the plugin command's reply" })
		expect(Inspect.warnsTo(app, admin).at(-1)).toContain(`hello world on ${app.serverId}`)

		// declared allowedChats is admin-only, so the same words in all-chat are not a command at all
		app.emu.world.chat(admin, 'ChatAll', '/hello nobody-should-see-this')
		// being in admin chat is Squad's admin list, not SLM's roles: the handler's own check is what refuses
		app.emu.world.chat(outsider, 'ChatAdmin', '/hello me')
		await app.waitFor(() => Inspect.warnsTo(app, outsider).length > 0, { label: "the outsider's refusal" })
		expect(Inspect.warnsTo(app, outsider).join('\n')).not.toContain('hello me')
		expect(Inspect.warnsTo(app, outsider).join('\n')).toContain('squad-server:end-match')
		expect(Inspect.warnsTo(app, admin).join('\n')).not.toContain('nobody-should-see-this')
	})

	// The caller identity the host threads onto an rpc ctx, and the check a procedure makes with it. Without
	// both, every plugin procedure is reachable by anyone who can open the dashboard.
	it('authorizes an rpc procedure against the signed-in caller', async () => {
		expect(await call('whoAmI', {})).toMatchObject({ code: 'ok', discordId: String(ADMIN_USER.discordId) })

		// left open, like every other extra client in the suite: the fixture teardown closes the app under it,
		// and closing the socket here rejects whatever orpc still has in flight on it
		const outsiderClient = await createOrpcClient(app, OUTSIDER)
		const res = (await outsiderClient.plugins.rpcCall({
			pluginId: 'hello',
			path: ['whoAmI'],
			serverId: app.serverId,
			input: {},
		})) as { code: string; data?: { code: string } }
		expect(res.data).toMatchObject({ code: 'err:permission-denied' })
	})

	// A dev instance and the test harness both run with discord off, which is the case worth pinning: a
	// plugin gets a result it can branch on rather than an exception on every attempt.
	it('reports discord as disabled rather than throwing', async () => {
		expect(await call('postToDiscord', { channelId: '1', content: 'hi' })).toMatchObject({
			enabled: false,
			res: { code: 'err:disabled' },
		})
		expect(await call('deleteFromDiscord', { channelId: '1', messageId: '2' })).toMatchObject({
			enabled: false,
			res: { code: 'err:disabled' },
		})
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

	// A reload leaves a package whose files have not changed exactly where it is, so the scan that follows
	// meets an id already loaded. That used to be reported as a collision with a builtin, which filed the
	// running plugin as broken and listed it a second time -- from one deploy that shipped identical bytes,
	// or from pressing rescan twice.
	it('survives a rescan that finds nothing changed', async () => {
		const before = (await pluginInfo())!
		expect(before.status).toBe('active')

		for (let i = 0; i < 2; i++) {
			expect(await client.plugins.rescan()).toMatchObject({ code: 'ok' })
		}

		const next = await firstYield((signal) => client.plugins.watchPlugins(undefined, { signal }), { label: 'the plugin list stream' })
		const listed = (next.plugins as { id: string; status: string; error: string | null }[]).filter((p) => p.id === 'hello')
		expect(listed).toHaveLength(1)
		expect(listed[0]).toMatchObject({ status: 'active', error: null })
		expect((next.leftoverData as { pluginId: string }[] | undefined) ?? []).not.toContainEqual(
			expect.objectContaining({ pluginId: 'hello' }),
		)
	})
})

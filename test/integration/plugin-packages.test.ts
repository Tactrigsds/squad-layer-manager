import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'
import * as LL from '@/models/layer-list.models'
import * as SHIM from '@/models/plugin-api-shim.models'
import * as SLL from '@/models/shared-layer-list.models'

import { ADMIN_USER, type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { LAYERS, queue, role } from '../harness/arrange'
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
// the url the plugin is installed from: the release url, carrying a token as a private release would
let installUrl: string
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
	// the same plugin under an id whose table prefix nests with hello's; only plugin.json is read before the refusal
	const overlapping = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-pkg-overlap-'))
	const manifestJson = fs.readFileSync(path.join(pkgV1, 'plugin.json'), 'utf8')
	if (!manifestJson.includes('"id": "hello"')) throw new Error('packed plugin.json no longer spells its id as "id": "hello"')
	fs.writeFileSync(path.join(overlapping, 'plugin.json'), manifestJson.replace('"id": "hello"', '"id": "hello-x"'))
	releases.set('overlapping', overlapping)

	origin = http.createServer((req, res) => {
		const url = (req.url ?? '').split('?')[0]
		// a mirror that hands off to plain http on another host, which an install must not follow
		if (url === '/insecure-mirror/plugin.json') {
			res.writeHead(302, { location: 'http://plugins.example/plugin.json' }).end()
			return
		}
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
	installUrl = `${manifestUrl}?token=release-token`

	// an in-game admin who is also the seeded superuser, so the plugin's command has somebody allowed to run it
	app = await createAppFixture({
		admins: [ADMIN_STEAM_ID],
		adminSteamIds: [ADMIN_STEAM_ID],
		users: [OUTSIDER],
		// seeded, so no queue-item generation is still running when the plugin edits the queue
		layerQueue: queue(LAYERS.gorodokRaas, LAYERS.sumariSeed),
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

// a rotation item as getRotation hands it back
type StoredItem = { layerId: string; source: { type: string }; notes?: { id: string; author?: bigint; text: string }[] }

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
				clientStyles: string | null
				permissions: { name: string; scope: string; description: string }[]
		  }
		| undefined
}

describe('packaged plugins', () => {
	// through the `latest` redirect, so this also covers the two things a release url needs: the redirect
	// itself, and every other file resolving against the url that was pasted rather than where it landed
	it('installs from a url into the plugins folder, stopped', async () => {
		const res = await client.plugins.installFromUrl({ url: installUrl })
		expect(res).toMatchObject({ code: 'ok', pluginId: 'hello' })

		const info = await pluginInfo()
		// the moving url is what gets recorded, which is what makes a later refresh an upgrade. Every signed-in user can
		// read the list, so it shows the url without the token.
		expect(info).toMatchObject({ version: '1.0.0', status: 'inactive', enabled: false, source: 'url', sourceUrl: manifestUrl })
		// the client bundle is served from SLM, not from the origin it came from
		expect(info?.clientEntry).toMatch(/^\/plugin-assets\/hello\/client\.mjs\?v=/)
		expect(info?.clientStyles).toMatch(/^\/plugin-assets\/hello\/client\.css\?v=/)
	})

	it('refuses plain http to another host, at the start or after a redirect', async () => {
		expect(await client.plugins.installFromUrl({ url: 'http://plugins.example/plugin.json' })).toMatchObject({
			code: 'err:install-failed',
			message: expect.stringContaining('https'),
		})
		const mirror = new URL('/insecure-mirror/plugin.json', manifestUrl).href
		expect(await client.plugins.installFromUrl({ url: mirror })).toMatchObject({
			code: 'err:install-failed',
			message: expect.stringContaining('https'),
		})
	})

	// the same release, by its pinned tag rather than `latest`: a different source for an id already installed
	it('refuses to replace an installed plugin with one from another source', async () => {
		const pinned = new URL('/releases/download/v1.0.0/plugin.json', manifestUrl).href
		expect(await client.plugins.installFromUrl({ url: pinned })).toMatchObject({
			code: 'err:id-taken',
			pluginId: 'hello',
			installedFrom: installUrl,
		})
		expect(await pluginInfo()).toMatchObject({ sourceUrl: manifestUrl })
	})

	// hello-x's tables would be prefixed p_hello_x_, which hello's own prefix p_hello_ matches
	it('refuses a plugin whose id would share table names with an installed one', async () => {
		const url = new URL('/releases/download/overlapping/plugin.json', manifestUrl).href
		expect(await client.plugins.installFromUrl({ url })).toMatchObject({
			code: 'err:id-overlaps',
			pluginId: 'hello-x',
			overlapsWith: 'hello',
		})
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
		// a name every object inherits is not a package
		expect((await get('/plugin-api/pkg/constructor')).status).toBe(404)

		const client_ = await get((await pluginInfo())!.clientEntry!)
		expect(client_.status).toBe(200)
		const clientSource = await client_.text()
		expect(clientSource).toContain('definePluginClient')
		// its dependencies are bundled, so every import left is one the host answers
		const imports = [...clientSource.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])
		expect(imports).toContain('react')
		const shared: readonly string[] = SHIM.SHARED_PACKAGES
		expect(imports.filter((s) => s !== './plugin.mjs' && !s.startsWith('slm/') && !shared.includes(s))).toEqual([])

		// the stylesheet carries the utilities the client's sources use, which the app's own does not
		const styles = await get((await pluginInfo())!.clientStyles!)
		expect(styles.status).toBe(200)
		expect(styles.headers.get('content-type')).toContain('text/css')
		expect(await styles.text()).toContain('.italic{')

		// only the files plugin.json names as browser-facing are reachable
		expect((await get('/plugin-assets/hello/server.mjs')).status).toBe(404)
	})

	// Filters are core state a plugin shares with every admin, so the interesting part is not that the row
	// appears: it is that the write went through the host's own path. The FILTER_CHANGED rows are what
	// prove it, since only that path writes them, and they name the plugin rather than a person.
	it('creates, updates and deletes filters, recorded against the plugin', async () => {
		const filterRow = () =>
			readRows<{ name: string; ownerUserId: string | null; ownerPluginId: string | null; filter: string }>(
				`SELECT * FROM filters WHERE id = 'hello-pool'`,
			)[0]

		expect(await call('makeFilter', { id: 'hello-pool' })).toMatchObject({ code: 'ok' })
		expect(filterRow()).toMatchObject({ name: 'Hello pool', ownerUserId: null, ownerPluginId: 'hello' })
		// FB.and built a real tree through the shim, not a string the plugin happened to send
		expect(JSON.parse(filterRow().filter)).toMatchObject({ type: 'and', children: [{ type: 'eq' }, { type: 'in', neg: true }] })
		// the in-memory index the whole server reads from, which only the mutation stream keeps current
		expect(await call('filterIds', {})).toContain('hello-pool')

		expect(await call('makeFilter', { id: 'hello-pool' })).toMatchObject({ code: 'err:already-exists' })

		expect(await call('renameFilter', { id: 'hello-pool', name: 'Hello pool v2' })).toMatchObject({ code: 'ok' })
		expect(filterRow().name).toBe('Hello pool v2')

		const admin = { kind: 'filter', id: 'hello-pool', userId: String(ADMIN_USER.discordId) }
		const role = { kind: 'filter', id: 'hello-pool', roleId: 'hello-mappers' }
		expect(await call('addContributor', admin)).toMatchObject({ code: 'ok' })
		expect(await call('addContributor', admin)).toMatchObject({ code: 'err:already-exists' })
		expect(await call('addContributor', role)).toMatchObject({ code: 'ok' })
		expect(await call('addContributor', { ...admin, userId: '999999999999999999' })).toMatchObject({ code: 'err:unknown-user' })
		expect(await call('addContributor', { ...role, id: 'no-such-filter' })).toMatchObject({ code: 'err:not-found' })
		expect(await call('getContributors', { kind: 'filter', id: 'hello-pool' })).toEqual([
			{ type: 'user', userId: admin.userId },
			{ type: 'role', roleId: 'hello-mappers' },
		])
		expect(await call('makeFilter', { id: 'hello-pool-copy' })).toMatchObject({ code: 'ok' })
		expect(await call('copyContributors', { kind: 'filter', sourceId: 'hello-pool', targetId: 'hello-pool-copy' })).toMatchObject({
			code: 'ok',
		})
		expect(await call('copyContributors', { kind: 'filter', sourceId: 'hello-pool', targetId: 'hello-pool-copy' })).toMatchObject({
			code: 'ok',
		})
		expect(await call('getContributors', { kind: 'filter', id: 'hello-pool-copy' })).toHaveLength(2)
		expect(await call('removeContributor', admin)).toMatchObject({ code: 'ok' })
		expect(await call('removeContributor', admin)).toMatchObject({ code: 'err:not-found' })
		expect(await call('getContributors', { kind: 'filter', id: 'hello-pool' })).toEqual([{ type: 'role', roleId: 'hello-mappers' }])
		// the user and role on hello-pool, the two the copy added, then the removal; the repeated copy added nothing
		expect(
			readRows<{ action: string; filterId: string }>(
				`SELECT json_extract(data, '$.json.action') AS action, json_extract(data, '$.json.filterId') AS filterId FROM appEvents
				 WHERE type = 'FILTER_CONTRIBUTOR_CHANGED' AND actorPluginId = 'hello' ORDER BY rowid`,
			),
		).toEqual([
			{ action: 'added', filterId: 'hello-pool' },
			{ action: 'added', filterId: 'hello-pool' },
			{ action: 'added', filterId: 'hello-pool-copy' },
			{ action: 'added', filterId: 'hello-pool-copy' },
			{ action: 'removed', filterId: 'hello-pool' },
		])

		expect(await call('dropFilter', { id: 'hello-pool-copy' })).toMatchObject({ code: 'ok' })
		expect(await call('dropFilter', { id: 'hello-pool' })).toMatchObject({ code: 'ok' })
		expect(filterRow()).toBeUndefined()

		expect(
			readRows<{ action: string }>(
				`SELECT json_extract(data, '$.json.action') AS action FROM appEvents
				 WHERE type = 'FILTER_CHANGED' AND actorPluginId = 'hello' ORDER BY rowid`,
			).map((r) => r.action),
		).toEqual(['created', 'updated', 'created', 'deleted', 'deleted'])
	})

	// Nothing stopped an admin deleting a filter a plugin's config named, which left the plugin failing later
	// with "the pool matched no layers". A Fields.filterId field is a reference like a pool config is.
	it('refuses to delete a filter a running plugin has configured', async () => {
		await call('makeFilter', { id: 'hello-configured', owner: String(ADMIN_USER.discordId) })
		// a plugin can hand ownership to an admin instead of keeping it
		expect(Inspect.filterOwner(app, 'hello-configured')).toEqual({
			ownerUserId: String(ADMIN_USER.discordId),
			ownerPluginId: null,
		})
		await client.plugins.updateSettings({ pluginId: 'hello', config: { greeting: 'hello', pool: 'hello-configured' } })

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
		await client.plugins.updateSettings({ pluginId: 'hello', config: { greeting: 'hello', pool: '' } })
		await app.waitFor(
			async () => ((await call<{ code: string }>('dropFilter', { id: 'hello-configured' })).code === 'ok' ? true : undefined),
			{ label: 'the reference to be released' },
		)
	})

	// Rotations follow the filters' ownership rules. A rotation the plugin makes names no person, so only blanket
	// write access reaches it by hand, and one the plugin hands to an admin gives that admin the owner's role. The
	// ROTATION_CHANGED rows prove the writes went through the host's path, and the stored items prove the host
	// stripped who wrote them.
	it('creates, clones, updates and deletes rotations, owned by the plugin unless it names an admin', async () => {
		const outsiderClient = await createOrpcClient(app, OUTSIDER)
		const rotationRow = (id: string) =>
			readRows<{ name: string; ownerUserId: string | null; ownerPluginId: string | null; items: string }>(
				`SELECT name, ownerUserId, ownerPluginId, items FROM rotations WHERE id = ?`,
				id,
			)[0]

		expect(await call('makeRotation', { id: 'hello-rot', layerIds: [LAYERS.gorodokRaas, LAYERS.harjuRaas] })).toMatchObject({
			code: 'ok',
		})
		expect(rotationRow('hello-rot')).toMatchObject({ name: 'Hello rotation', ownerUserId: null, ownerPluginId: 'hello' })
		expect(rotationRow('hello-rot').items).not.toContain(String(ADMIN_USER.discordId))
		const stored = await call<{ items: StoredItem[] }>('getRotation', { id: 'hello-rot' })
		expect(stored.items.map((i) => i.layerId)).toEqual([LAYERS.gorodokRaas, LAYERS.harjuRaas])
		expect(stored.items.map((i) => i.source.type)).toEqual(['unknown', 'unknown'])
		expect(stored.items[0].notes).toEqual([{ id: 'hellonot', text: 'from hello' }])
		expect(await call('rotationIds', {})).toContain('hello-rot')
		expect(await call('makeRotation', { id: 'hello-rot', layerIds: [] })).toMatchObject({ code: 'err:already-exists' })

		// a tag is created once and found by its label after that, whatever the case
		const created = await call<{ code: string; tag: { id: string; label: string } }>('ensureTag', {
			kind: 'rotation',
			label: 'Hello Tag',
		})
		expect(created).toMatchObject({ code: 'ok', tag: { label: 'Hello Tag' } })
		expect(await call('ensureTag', { kind: 'rotation', label: 'hello tag' })).toMatchObject({ code: 'ok', tag: { id: created.tag.id } })
		expect(await call('ensureTag', { kind: 'layer', label: 'no:colons' })).toMatchObject({ code: 'err:invalid-label' })

		expect(await outsiderClient.rotations.updateMeta({ rotationId: 'hello-rot', patch: { name: 'Outsider edit' } })).toMatchObject({
			code: 'err:permission-denied',
		})
		expect(await client.rotations.updateMeta({ rotationId: 'hello-rot', patch: { name: 'Admin edit' } })).toMatchObject({ code: 'ok' })

		expect(
			await call('makeRotation', { id: 'hello-rot-handed', owner: String(OUTSIDER.discordId), layerIds: [LAYERS.gorodokRaas] }),
		).toMatchObject({ code: 'ok' })
		expect(rotationRow('hello-rot-handed')).toMatchObject({ ownerUserId: String(OUTSIDER.discordId), ownerPluginId: null })
		expect(await outsiderClient.rotations.updateMeta({ rotationId: 'hello-rot-handed', patch: { name: 'Outsider edit' } })).toMatchObject(
			{ code: 'ok' },
		)
		expect(await outsiderClient.rotations.delete('hello-rot-handed')).toMatchObject({ code: 'ok' })

		expect(await call('cloneRotation', { sourceId: 'hello-rot', id: 'hello-rot-copy' })).toMatchObject({ code: 'ok' })
		expect(rotationRow('hello-rot-copy')).toMatchObject({ name: 'Hello rotation clone', ownerUserId: null, ownerPluginId: 'hello' })
		expect(await outsiderClient.rotations.delete('hello-rot-copy')).toMatchObject({ code: 'err:permission-denied' })

		const contributors = (id: string) =>
			readRows<{ userId: string }>(`SELECT userId FROM rotationUserContributors WHERE rotationId = ?`, id).map((r) => r.userId)
		expect(contributors('hello-rot-copy')).toEqual([])
		expect(await client.rotations.addContributor({ rotationId: 'hello-rot', userId: OUTSIDER.discordId })).toMatchObject({ code: 'ok' })
		expect(await call('copyContributors', { kind: 'rotation', sourceId: 'hello-rot', targetId: 'hello-rot-copy' })).toMatchObject({
			code: 'ok',
		})
		expect(contributors('hello-rot-copy')).toEqual([String(OUTSIDER.discordId)])
		// a repeated copy keeps what the target already has rather than failing on it
		expect(await call('copyContributors', { kind: 'rotation', sourceId: 'hello-rot', targetId: 'hello-rot-copy' })).toMatchObject({
			code: 'ok',
		})
		expect(await call('copyContributors', { kind: 'rotation', sourceId: 'hello-rot', targetId: 'no-such-rot' })).toMatchObject({
			code: 'err:not-found',
		})

		const outsider = { kind: 'rotation', id: 'hello-rot-copy', userId: String(OUTSIDER.discordId) }
		const role = { kind: 'rotation', id: 'hello-rot-copy', roleId: 'hello-mappers' }
		expect(await call('getContributors', { kind: 'rotation', id: 'hello-rot-copy' })).toEqual([{ type: 'user', userId: outsider.userId }])
		expect(await call('addContributor', role)).toMatchObject({ code: 'ok' })
		expect(await call('addContributor', role)).toMatchObject({ code: 'err:already-exists' })
		expect(await call('addContributor', { kind: 'rotation', id: 'hello-rot-copy', userId: '999999999999999999' })).toMatchObject({
			code: 'err:unknown-user',
		})
		expect(await call('addContributor', { ...role, id: 'no-such-rot' })).toMatchObject({ code: 'err:not-found' })
		expect(await call('removeContributor', outsider)).toMatchObject({ code: 'ok' })
		expect(await call('removeContributor', outsider)).toMatchObject({ code: 'err:not-found' })
		expect(await call('getContributors', { kind: 'rotation', id: 'hello-rot-copy' })).toEqual([{ type: 'role', roleId: 'hello-mappers' }])
		expect(
			readRows<{ action: string; contributor: string }>(
				`SELECT json_extract(data, '$.json.action') AS action, json_extract(data, '$.json.contributor.type') AS contributor FROM appEvents
				 WHERE type = 'ROTATION_CONTRIBUTOR_CHANGED' AND actorPluginId = 'hello' ORDER BY rowid`,
			),
		).toEqual([
			{ action: 'added', contributor: 'user' },
			{ action: 'added', contributor: 'role' },
			{ action: 'removed', contributor: 'user' },
		])

		expect(await call('updateRotation', { id: 'hello-rot', name: 'Hello rotation v2', layerIds: [LAYERS.sumariSeed] })).toMatchObject({
			code: 'ok',
		})
		expect(rotationRow('hello-rot').name).toBe('Hello rotation v2')
		const updated = await call<{ items: StoredItem[] }>('getRotation', { id: 'hello-rot' })
		expect(updated.items).toMatchObject([{ layerId: LAYERS.sumariSeed, source: { type: 'unknown' } }])
		expect(updated.items[0].notes?.[0].author).toBeUndefined()

		expect(await call('dropRotation', { id: 'hello-rot-copy' })).toMatchObject({ code: 'ok' })
		expect(rotationRow('hello-rot-copy')).toBeUndefined()
		expect(await call('dropRotation', { id: 'hello-rot-copy' })).toMatchObject({ code: 'err:not-found' })

		expect(
			readRows<{ action: string; rotationId: string }>(
				`SELECT json_extract(data, '$.json.action') AS action, json_extract(data, '$.json.rotationId') AS rotationId FROM appEvents
				 WHERE type = 'ROTATION_CHANGED' AND actorPluginId = 'hello' ORDER BY rowid`,
			),
		).toEqual([
			{ action: 'created', rotationId: 'hello-rot' },
			{ action: 'created', rotationId: 'hello-rot-handed' },
			{ action: 'created', rotationId: 'hello-rot-copy' },
			{ action: 'updated', rotationId: 'hello-rot' },
			{ action: 'deleted', rotationId: 'hello-rot-copy' },
		])
		expect(await call('rotationChanges', {})).toEqual([
			'add:hello-rot:plugin',
			'update:hello-rot:slm-user',
			'add:hello-rot-handed:plugin',
			'update:hello-rot-handed:slm-user',
			'delete:hello-rot-handed:slm-user',
			'add:hello-rot-copy:plugin',
			'update:hello-rot:plugin',
			'delete:hello-rot-copy:plugin',
		])
	})

	// An admin's open draft of the rotation's items holds its own copy of them. A plugin's new items are saved through
	// that draft so its editors see them, and refused while the draft holds edits nobody has saved.
	it("writes a rotation's items through an open draft, and refuses while the draft has unsaved edits", async () => {
		const received: { code: string; state?: SLL.State; ops?: SLL.Operation[] }[] = []
		const ac = new AbortController()
		const watching = (async () => {
			const stream = await client.rotationEdit.watchOps({ rotationId: 'hello-rot' }, { signal: ac.signal })
			for await (const update of stream) received.push(update as (typeof received)[number])
		})().catch(() => {})

		try {
			const init = await app.waitFor(() => received.find((u) => u.code === 'init'), { label: 'the draft' })
			const editWindowSeqId = init.state!.editWindowSeqId
			const userId = ADMIN_USER.discordId
			expect(
				await client.rotationEdit.dispatchOp({
					rotationId: 'hello-rot',
					op: {
						op: 'add',
						opId: SLL.createOpId(),
						userId,
						editWindowSeqId,
						items: [
							{ type: 'single-list-item', itemId: LL.createItemId(), layerId: LAYERS.harjuRaas, source: { type: 'manual', userId } },
						],
						index: { outerIndex: 0, innerIndex: null },
					},
				}),
			).toMatchObject({ code: 'ok' })

			expect(await call('updateRotation', { id: 'hello-rot', layerIds: [LAYERS.gorodokRaas] })).toMatchObject({
				code: 'err:unsaved-edits',
			})
			// a write that leaves the items alone does not touch the draft
			expect(await call('updateRotation', { id: 'hello-rot', name: 'Hello rotation v3' })).toMatchObject({ code: 'ok' })
			expect((await call<{ items: StoredItem[] }>('getRotation', { id: 'hello-rot' })).items.map((i) => i.layerId)).toEqual([
				LAYERS.sumariSeed,
			])

			expect(
				await client.rotationEdit.dispatchOp({
					rotationId: 'hello-rot',
					op: { op: 'reset-to-saved', opId: SLL.createOpId(), userId, editWindowSeqId },
				}),
			).toMatchObject({ code: 'ok' })
			expect(await call('updateRotation', { id: 'hello-rot', layerIds: [LAYERS.gorodokRaas] })).toMatchObject({ code: 'ok' })
			expect((await call<{ items: StoredItem[] }>('getRotation', { id: 'hello-rot' })).items.map((i) => i.layerId)).toEqual([
				LAYERS.gorodokRaas,
			])
			const save = await app.waitFor(() => received.find((u) => u.ops?.some((op) => op.op === 'save' && op.source?.type === 'plugin')), {
				label: "the plugin's save reaching the draft",
			})
			expect(save.ops?.find((op) => op.op === 'add')).toMatchObject({ items: [{ layerId: LAYERS.gorodokRaas }] })
		} finally {
			ac.abort()
			await watching
		}

		expect(await call('dropRotation', { id: 'hello-rot' })).toMatchObject({ code: 'ok' })
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

	// The plugin's counterpart to Add Rotation: one add op at the placement asked for, attributed to the plugin, with
	// the items marked as the rotation's
	it('adds a saved rotation to the queue, as Add Rotation does', async () => {
		expect(await call('makeRotation', { id: 'hello-queue-rot', layerIds: [LAYERS.gorodokRaas] })).toMatchObject({ code: 'ok' })
		const before = Inspect.savedQueue(app).map((i) => i.itemId)

		expect(await call('addRotationToQueue', { id: 'hello-queue-rot', placement: 'end' })).toMatchObject({ code: 'ok' })
		const atEnd = Inspect.savedQueue(app)
		expect(atEnd.slice(0, -1).map((i) => i.itemId)).toEqual(before)
		expect(atEnd.at(-1)).toMatchObject({ layerId: LAYERS.gorodokRaas, source: { type: 'plugin' } })
		expect(atEnd.at(-1)?.tags).toContain('from-rotation:hello-queue-rot')

		expect(await call('addRotationToQueue', { id: 'hello-queue-rot', placement: 'start' })).toMatchObject({ code: 'ok' })
		const atStart = Inspect.savedQueue(app)
		expect(atStart[0]).toMatchObject({ layerId: LAYERS.gorodokRaas, source: { type: 'plugin' } })
		expect(atStart.slice(1, -1).map((i) => i.itemId)).toEqual(before)

		// clearing in the same edit: the two copies added above go, the kept items stay ahead, and the new copy follows
		const added = [atStart[0].itemId, atStart.at(-1)!.itemId]
		expect(await call('addRotationToQueue', { id: 'hello-queue-rot', placement: 'end', keepItemIds: before })).toMatchObject({
			code: 'ok',
		})
		const cleared = Inspect.savedQueue(app)
		expect(cleared.slice(0, -1).map((i) => i.itemId)).toEqual(before)
		expect(cleared.at(-1)).toMatchObject({ layerId: LAYERS.gorodokRaas, source: { type: 'plugin' } })
		expect(added).not.toContain(cleared.at(-1)!.itemId)

		expect(await call('addRotationToQueue', { id: 'no-such-rotation', placement: 'end' })).toMatchObject({ code: 'err:not-found' })
		expect(await call('addRotationToQueue', { id: 'hello-queue-rot', placement: 'end', tags: ['nope:abcdef'] })).toMatchObject({
			code: 'err:unknown-tags',
		})

		expect(await call('keepQueueItems', { itemIds: before })).toMatchObject({ code: 'ok' })
		expect(Inspect.savedQueue(app).map((i) => i.itemId)).toEqual(before)
		expect(await call('dropRotation', { id: 'hello-queue-rot' })).toMatchObject({ code: 'ok' })
	})

	// Jobs the plugin lists in its `jobs` export, run by the host from the packed bundle. The hourly job runs as the
	// plugin starts; one-off runs come due on their own, or an admin runs or cancels them from settings. Only a run
	// an admin started, a job that asks for it, and a final failure are recorded.
	it('runs its scheduled jobs, and lets an admin run or cancel a pending run', async () => {
		const runs = () => call<string[]>('jobRuns', {})
		const jobEvents = (type: string) =>
			readRows<{ jobId: string; key: string; manual: number; actorType: string; serverId: string | null; error: string | null }>(
				`SELECT json_extract(data, '$.json.jobId') AS jobId, json_extract(data, '$.json.key') AS key,
				 json_extract(data, '$.json.manual') AS manual, actorType, serverId, json_extract(data, '$.json.error') AS error
				 FROM appEvents WHERE type = ? ORDER BY rowid`,
				type,
			)

		await app.waitFor(async () => (await runs()).includes('heartbeat:scheduled:false') || null, { label: 'the hourly job ran on start' })
		// it asked for its successes to be recorded; it is not tied to a server
		expect(jobEvents('SCHEDULED_JOB_SUCCESS')).toContainEqual(
			expect.objectContaining({ jobId: 'heartbeat', manual: 0, actorType: 'plugin', serverId: null }),
		)

		expect(await call('scheduleGreet', { name: 'soon', inMs: 200 })).toMatchObject({ code: 'ok' })
		await app.waitFor(async () => (await runs()).some((r) => r.startsWith('greet:') && r.endsWith(':soon:false')) || null, {
			label: 'the one-off run came due',
		})
		// an automatic success of a job that did not ask for it leaves no event
		expect(jobEvents('SCHEDULED_JOB_SUCCESS').filter((e) => e.jobId === 'greet')).toEqual([])

		// scheduling under a key again replaces the run, payload included
		expect(await call('scheduleGreet', { name: 'later', inMs: 3_600_000, key: 'later' })).toMatchObject({ code: 'ok', key: 'later' })
		expect(await call('scheduleGreet', { name: 'moved', inMs: 3_600_000, key: 'later' })).toMatchObject({ code: 'ok', key: 'later' })
		const listed = await client.plugins.listJobs({ pluginId: 'hello' })
		const greet = listed.code === 'ok' ? listed.jobs.find((j) => j.id === 'greet') : undefined
		expect(greet?.pending.map((p) => p.key)).toEqual(['later'])

		// run now, by an admin: recorded against them, in the server's feed
		expect(await client.plugins.runJobNow({ pluginId: 'hello', jobId: 'greet', serverId: app.serverId, key: 'later' })).toMatchObject({
			code: 'ok',
		})
		await app.waitFor(async () => (await runs()).includes('greet:later:moved:true') || null, { label: 'the pending run ran by hand' })
		await app.waitFor(() => jobEvents('SCHEDULED_JOB_SUCCESS').find((e) => e.jobId === 'greet' && e.key === 'later') ?? null, {
			label: 'the run by hand was recorded',
		})
		expect(jobEvents('SCHEDULED_JOB_SUCCESS').find((e) => e.key === 'later')).toMatchObject({
			manual: 1,
			actorType: 'slm-user',
			serverId: app.serverId,
		})

		// a recurring job runs by hand outside its schedule
		expect(await client.plugins.runJobNow({ pluginId: 'hello', jobId: 'heartbeat', serverId: null, key: null })).toMatchObject({
			code: 'ok',
		})
		await app.waitFor(async () => (await runs()).includes('heartbeat:manual:true') || null, { label: 'the recurring job ran by hand' })

		// a run that is running keeps its key until it finishes; scheduling under it again is refused rather than lost
		expect(await call('scheduleGreet', { name: 'hold', inMs: 0, key: 'held' })).toMatchObject({ code: 'ok' })
		await app.waitFor(
			async () => {
				const res = await client.plugins.listJobs({ pluginId: 'hello' })
				const job = res.code === 'ok' ? res.jobs.find((j) => j.id === 'greet') : undefined
				return job?.pending.some((p) => p.key === 'held' && p.state === 'running') || null
			},
			{ label: 'the held run started' },
		)
		expect(await call('scheduleGreet', { name: 'moved', inMs: 3_600_000, key: 'held' })).toMatchObject({ code: 'err:busy' })
		expect(await call('releaseHeld', {})).toMatchObject({ code: 'ok' })
		await app.waitFor(async () => (await runs()).includes('greet:held:hold:false') || null, { label: 'the held run finished' })
		await app.waitFor(
			async () => (await call<{ code: string }>('scheduleGreet', { name: 'again', inMs: 3_600_000, key: 'held' })).code === 'ok' || null,
			{ label: 'the finished run is replaced' },
		)
		expect(await call('cancelGreet', { key: 'held' })).toMatchObject({ code: 'ok' })

		// a blocked run waits, showing its reason, and goes again on the same attempt once its unblock fires
		const gatedRun = async (key: string) => {
			const res = await client.plugins.listJobs({ pluginId: 'hello' })
			const job = res.code === 'ok' ? res.jobs.find((j) => j.id === 'gated') : undefined
			return job?.pending.find((p) => p.key === key)
		}
		expect(await call('scheduleGated', { mode: 'gate', inMs: 0, key: 'gate' })).toMatchObject({ code: 'ok' })
		await app.waitFor(async () => ((await gatedRun('gate'))?.state === 'blocked' ? true : null), { label: 'the gated run blocked' })
		expect(await gatedRun('gate')).toMatchObject({ blockedReason: 'the gate is closed', nextAttemptAt: null, attempt: 0 })
		expect(await call('openGate', {})).toMatchObject({ code: 'ok' })
		await app.waitFor(async () => (await runs()).includes('gated:gate:done') || null, { label: 'the gated run went through' })
		expect((await runs()).filter((r) => r.startsWith('gated:gate:call'))).toEqual([
			'gated:gate:call1:attempt1',
			'gated:gate:call2:attempt1',
		])

		// a duration, and a source that fires as soon as it is subscribed to, both wait at least a second between calls
		expect(await call('scheduleGated', { mode: 'delay', inMs: 0, key: 'delay' })).toMatchObject({ code: 'ok' })
		expect(await call('scheduleGated', { mode: 'eager', inMs: 0, key: 'eager' })).toMatchObject({ code: 'ok' })
		await app.waitFor(async () => ((await runs()).includes('gated:delay:done') && (await runs()).includes('gated:eager:done')) || null, {
			label: 'the delayed and eager runs went through',
			timeoutMs: 15_000,
		})
		const [delayFirst, delaySecond] = await call<number[]>('gatedCallTimes', { key: 'delay' })
		expect(delaySecond - delayFirst).toBeGreaterThanOrEqual(1000)
		const eagerCalls = await call<number[]>('gatedCallTimes', { key: 'eager' })
		expect(eagerCalls).toHaveLength(3)
		expect(eagerCalls[2] - eagerCalls[0]).toBeGreaterThanOrEqual(2000)

		// Run now on a blocked run reports why, and leaves the run waiting; cancelling removes it
		expect(await call('scheduleGated', { mode: 'forever', inMs: 0, key: 'stuck' })).toMatchObject({ code: 'ok' })
		await app.waitFor(async () => ((await gatedRun('stuck'))?.state === 'blocked' ? true : null), { label: 'the stuck run blocked' })
		expect(await client.plugins.runJobNow({ pluginId: 'hello', jobId: 'gated', serverId: app.serverId, key: 'stuck' })).toMatchObject({
			code: 'err:blocked',
			message: 'it never opens',
		})
		expect(await gatedRun('stuck')).toMatchObject({ state: 'blocked', blockedReason: 'it never opens', attempt: 0 })
		expect(await call('cancelGated', { key: 'stuck' })).toMatchObject({ code: 'ok' })
		expect(await gatedRun('stuck')).toBeUndefined()

		// a run still blocked when its window ends fails with the reason it was waiting on
		expect(await call('scheduleGated', { mode: 'forever', inMs: -58_000, key: 'expired' })).toMatchObject({ code: 'ok' })
		const expired = await app.waitFor(() => jobEvents('SCHEDULED_JOB_FAILED').find((e) => e.key === 'expired') ?? null, {
			label: 'the run blocked past its window failed',
			timeoutMs: 15_000,
		})
		expect(expired).toMatchObject({
			jobId: 'gated',
			manual: 0,
			actorType: 'plugin',
			error: 'its catch-up window ended while it waited: it never opens',
		})

		// cancelling a running run aborts its signal; it is recorded as cancelled only if it stops by throwing that abort
		const runRow = (jobId: string, key: string) =>
			readRows<{ state: string; error: string | null }>(
				`SELECT state, error FROM scheduledJobRuns WHERE jobId = ? AND key = ?`,
				jobId,
				key,
			)[0]
		const startStoppable = async (mode: 'throws' | 'finishes' | 'ignores', key: string) => {
			expect(await call('scheduleStoppable', { mode, key })).toMatchObject({ code: 'ok' })
			await app.waitFor(async () => (await runs()).includes(`stoppable:${key}:started`) || null, { label: `the ${mode} run started` })
		}

		// by an admin: the run throws the abort, so it is cancelled, and recorded against the admin
		await startStoppable('throws', 'throws')
		expect(
			await client.plugins.cancelJobRun({ pluginId: 'hello', jobId: 'stoppable', serverId: app.serverId, key: 'throws' }),
		).toMatchObject({ code: 'ok', stopping: true })
		const cancelled = await app.waitFor(() => jobEvents('SCHEDULED_JOB_CANCELLED').find((e) => e.key === 'throws') ?? null, {
			label: 'the cancelled run was recorded',
		})
		expect(cancelled).toMatchObject({ jobId: 'stoppable', manual: 1, actorType: 'slm-user', serverId: app.serverId })
		expect(runRow('stoppable', 'throws')).toMatchObject({ state: 'cancelled' })

		// by the plugin: the run finishes despite the abort, so it succeeded and nothing records a cancel
		await startStoppable('finishes', 'finishes')
		expect(await call('cancelStoppable', { key: 'finishes' })).toMatchObject({ code: 'ok', stopping: true })
		await app.waitFor(() => (runRow('stoppable', 'finishes')?.state === 'succeeded' ? true : null), {
			label: 'the run that finished anyway succeeded',
		})
		expect(jobEvents('SCHEDULED_JOB_CANCELLED').find((e) => e.key === 'finishes')).toBeUndefined()

		// a run that ignores the abort is abandoned once the grace period passes, and fails rather than being cancelled
		await startStoppable('ignores', 'ignores')
		expect(
			await client.plugins.cancelJobRun({ pluginId: 'hello', jobId: 'stoppable', serverId: app.serverId, key: 'ignores' }),
		).toMatchObject({ code: 'ok', stopping: true })
		const abandoned = await app.waitFor(() => jobEvents('SCHEDULED_JOB_FAILED').find((e) => e.key === 'ignores') ?? null, {
			label: 'the run that ignored its abort was abandoned',
			timeoutMs: 30_000,
		})
		expect(abandoned).toMatchObject({ jobId: 'stoppable', error: 'it did not stop within 10s of being cancelled' })
		expect(jobEvents('SCHEDULED_JOB_CANCELLED').find((e) => e.key === 'ignores')).toBeUndefined()

		// a run that outlasts its timeout has its signal aborted, and fails with the timeout once its window is spent
		expect(await call('scheduleTimed', { key: 'slow' })).toMatchObject({ code: 'ok' })
		const timedOut = await app.waitFor(() => jobEvents('SCHEDULED_JOB_FAILED').find((e) => e.jobId === 'timed') ?? null, {
			label: 'the run past its timeout failed',
		})
		expect(timedOut).toMatchObject({ key: 'slow', error: 'it ran longer than its timeout of 300 ms' })

		// cancelling removes a pending run
		expect(await call('scheduleGreet', { name: 'never', inMs: 3_600_000, key: 'gone' })).toMatchObject({ code: 'ok' })
		expect(await call('cancelGreet', { key: 'gone' })).toMatchObject({ code: 'ok' })
		expect(await call('cancelGreet', { key: 'gone' })).toMatchObject({ code: 'err:not-found' })

		// a payload that does not fit is refused when it is scheduled
		expect(await call('scheduleGreet', { name: 42, inMs: 0 })).toMatchObject({ code: 'err:invalid-payload' })

		// a run that throws, with no time left in its window to retry, fails and is recorded against the plugin
		expect(await call('scheduleGreet', { name: 'fail', inMs: 0, key: 'doomed' })).toMatchObject({ code: 'ok' })
		const failed = await app.waitFor(() => jobEvents('SCHEDULED_JOB_FAILED').find((e) => e.key === 'doomed') ?? null, {
			label: 'the failing run was recorded',
		})
		expect(failed).toMatchObject({ jobId: 'greet', manual: 0, actorType: 'plugin', error: 'asked to fail' })
	})

	it("creates and deletes repeat rulesets, and points the plugin's server at one", async () => {
		const own = await call<string | null>('serverRulesetId', {})
		expect(own).not.toBeNull()

		expect(await call('saveRuleset', { id: 'hello-rules', name: 'Hello rules' })).toMatchObject({ code: 'ok' })
		expect(await call('setServerRuleset', { id: 'hello-rules' })).toMatchObject({ code: 'ok' })
		expect(await call('serverRulesetId', {})).toBe('hello-rules')
		expect(
			readRows<{ actorType: string; actor: string }>(
				`SELECT actorType, actorPluginId AS actor FROM appEvents WHERE type = 'SETTINGS_UPDATED' AND serverId IS NOT NULL ORDER BY rowid DESC LIMIT 1`,
			)[0],
		).toMatchObject({ actorType: 'plugin', actor: 'hello' })
		expect(await call('dropRuleset', { id: 'hello-rules' })).toMatchObject({ code: 'err:repeat-ruleset-in-use' })
		expect(await call('setServerRuleset', { id: 'no-such-ruleset' })).toMatchObject({ code: 'err:unknown-repeat-ruleset' })

		expect(await call('setServerRuleset', { id: own })).toMatchObject({ code: 'ok' })
		expect(await call('dropRuleset', { id: 'hello-rules' })).toMatchObject({ code: 'ok' })
		expect(await call('dropRuleset', { id: 'hello-rules' })).toMatchObject({ code: 'err:not-found' })

		const seen = await call<string[][]>('rulesetChanges', {})
		expect(seen.some((ids) => ids.includes('hello-rules'))).toBe(true)
		expect(seen.at(-1)).not.toContain('hello-rules')
	})

	it('reads and writes global and server settings', async () => {
		type Read = { defaultTimeZone: string; installedMods: string[]; hasConnections: boolean; missingServer: null }
		const before = await call<Read>('readSettings', {})
		expect(before.hasConnections).toBe(false)
		expect(before.missingServer).toBeNull()
		const lastSettingsUpdate = () =>
			readRows<{ actor: string; serverId: string | null }>(
				`SELECT actorPluginId AS actor, serverId FROM appEvents WHERE type = 'SETTINGS_UPDATED' ORDER BY rowid DESC LIMIT 1`,
			)[0]

		const mods = [...before.installedMods, 'SuperMod']
		expect(await call('updateServerSettings', { ops: [{ path: ['installedMods'], value: mods }] })).toMatchObject({ code: 'ok' })
		expect((await call<Read>('readSettings', {})).installedMods).toEqual(mods)
		expect(lastSettingsUpdate()).toMatchObject({ actor: 'hello', serverId: expect.any(String) })
		await app.waitFor(async () => ((await call<string[][]>('serverSettingsChanges', {})).at(-1)?.includes('SuperMod') ? true : null), {
			label: 'serverChanges saw the write',
		})

		expect(await call('updateServerSettings', { ops: [{ path: ['installedMods'], value: [] }] })).toMatchObject({
			code: 'err:invalid-settings',
		})
		expect(await call('updateServerSettings', { ops: [{ path: ['connections', 'rcon', 'host'], value: 'x' }] })).toMatchObject({
			code: 'err:invalid-path',
		})
		expect(await call('updateServerSettings', { ops: [{ path: ['__proto__', 'polluted'], value: true }] })).toMatchObject({
			code: 'err:invalid-path',
		})
		expect(
			await call('updateServerSettings', { serverId: 'no-such-server', ops: [{ path: ['installedMods'], value: mods }] }),
		).toMatchObject({ code: 'err:server-not-found' })
		expect(await call('updateServerSettings', { ops: [{ path: ['installedMods'], value: before.installedMods }] })).toMatchObject({
			code: 'ok',
		})

		expect(await call('updateGlobalSettings', { ops: [{ path: ['defaultTimeZone'], value: 'Europe/Berlin' }] })).toMatchObject({
			code: 'ok',
		})
		expect((await call<Read>('readSettings', {})).defaultTimeZone).toBe('Europe/Berlin')
		expect(lastSettingsUpdate()).toMatchObject({ actor: 'hello', serverId: null })
		expect(await call('updateGlobalSettings', { ops: [{ path: ['defaultTimeZone'], value: 'Not/AZone' }] })).toMatchObject({
			code: 'err:invalid-settings',
		})
		expect(await call('updateGlobalSettings', { ops: [{ path: ['defaultTimeZone'], value: before.defaultTimeZone }] })).toMatchObject({
			code: 'ok',
		})
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
	it('ends a match, attributed to the plugin, and has its reminder warned to admins after the roll', async () => {
		const admin = app.emu.world.connectPlayer(makePlayer({ name: ' plugin_reminder_admin', steam: ADMIN_STEAM_ID, teamId: 1 }))
		await app.waitForRosterSync()
		const ended = Inspect.latestMatch(app)

		expect(await call('endMatch', {})).toMatchObject({ code: 'ok' })
		expect(
			readRows<{ actor: string }>(
				`SELECT actorPluginId AS actor FROM appEvents WHERE type = 'MATCH_ENDED' ORDER BY rowid DESC LIMIT 1`,
			)[0],
		).toMatchObject({ actor: 'hello' })

		// rolling before the outcome is recorded can land both in one ingest batch and skip finalization
		await app.waitFor(
			() => readRows<{ outcome: string | null }>(`SELECT outcome FROM matchHistory WHERE id = ?`, ended.id)[0]?.outcome ?? undefined,
			{ label: 'the ended match recording its outcome' },
		)
		app.emu.world.startNewGame()
		// the plugin returns the message; the host is what warns it to the admins on the server that rolled
		await app.waitFor(() => Inspect.warnsTo(app, admin).find((w) => w.includes('[hello] rolled on')), {
			label: "the plugin's post-roll reminder",
			timeoutMs: 30_000,
		})
		expect(Inspect.warnsTo(app, admin).join('\n')).toContain(`[hello] rolled on ${app.serverId}`)
		await app.waitForRosterSync()
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

	it('runs a command under the triggers an admin configured on the plugin', async () => {
		const hi = { triggers: ['/hi'], allowedChats: ['admin' as const], enabled: true, quickReference: false }
		expect(await client.plugins.updateSettings({ pluginId: 'hello', commands: { hello: { ...hi, triggers: ['/help'] } } })).toMatchObject(
			{
				code: 'err:invalid-config',
				message: expect.stringContaining('already used by the "help" command'),
			},
		)
		expect(await client.plugins.updateSettings({ pluginId: 'hello', commands: { hello: hi } })).toMatchObject({ code: 'ok' })
		const [row] = readRows<{ commands: string }>(`SELECT commands FROM plugins WHERE id = 'hello'`)
		expect(JSON.parse(row.commands).json).toEqual({ hello: hi })

		const admin = app.emu.world.connectPlayer(makePlayer({ name: ' plugin_cmd_retuned', steam: ADMIN_STEAM_ID, teamId: 1 }))
		await app.waitForRosterSync()
		app.emu.world.chat(admin, 'ChatAdmin', '/hello declared-trigger')
		app.emu.world.chat(admin, 'ChatAdmin', '/hi configured-trigger')
		await app.waitFor(() => Inspect.warnsTo(app, admin).find((w) => w.includes('configured-trigger')), {
			label: 'the reply to the configured trigger',
		})
		expect(Inspect.warnsTo(app, admin).join('\n')).not.toContain('declared-trigger')

		expect(await client.plugins.updateSettings({ pluginId: 'hello', commands: {} })).toMatchObject({ code: 'ok' })
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

	// The plugin's middleware checks its own access when a procedure is called, so a stream open when the caller loses
	// access has to be called again to be refused. Revokes the outsider's grant, which nothing after this uses.
	it("refuses an open stream once its caller loses the plugin's action", async () => {
		const outsiderClient = await createOrpcClient(app, OUTSIDER)
		const received: { code: string; data?: { code?: string } }[] = []
		const ac = new AbortController()
		const collecting = (async () => {
			const stream = await outsiderClient.plugins.rpcStream(
				{ pluginId: 'hello', path: ['watchGreetingIfAllowed'], serverId: app.serverId, input: {} },
				{ signal: ac.signal },
			)
			for await (const update of stream) received.push(update as (typeof received)[number])
		})().catch(() => {})

		try {
			await app.waitFor(() => received.some((u) => u.data?.code === 'ok') || null, { label: 'the greeting' })

			const current = await firstYield((signal) => client.settings.global.watchSettings(undefined, { signal }), {
				label: 'the global settings',
			})
			if ('code' in current) throw new Error(`could not read the settings: ${current.code}`)
			const rbac = structuredClone(current.rbac)!
			rbac.roles!['plugin-rpc-outsider'].pluginGrants = []
			expect(await client.settings.global.updateSettings({ rbac })).toMatchObject({ code: 'ok' })

			await app.waitFor(() => received.some((u) => u.data?.code === 'err:permission-denied') || null, { label: 'the denial' })
		} finally {
			ac.abort()
			await collecting
		}
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

		expect(await client.plugins.setEnabled({ pluginId: 'hello', enabled: false })).toMatchObject({ code: 'ok', status: 'inactive' })
		const stopped = await firstYield(
			(signal) =>
				client.plugins.rpcStream(
					{ pluginId: 'hello', path: ['greetings'], serverId: app.serverId, input: { serverId: app.serverId } },
					{ signal },
				),
			{ label: 'the greetings stream of a stopped plugin' },
		)
		expect(stopped).toMatchObject({ code: 'err:unknown-rpc' })
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

		// kept, but switched off, so whatever is next installed under this id does not start on its own
		expect(readRows(`SELECT enabled FROM plugins WHERE id = 'hello'`)).toEqual([{ enabled: 0 }])
		expect(readRows(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'p_hello_greetings'`)).toHaveLength(1)
		expect(await leftoverData()).toMatchObject({ pluginId: 'hello', migrations: 1, tables: [{ name: 'p_hello_greetings' }] })
	})

	it("deletes an uninstalled plugin's settings and tables on request", async () => {
		expect(await client.plugins.purgeData({ pluginId: 'hello' })).toMatchObject({ code: 'ok' })

		expect(readRows(`SELECT 1 FROM plugins WHERE id = 'hello'`)).toHaveLength(0)
		expect(readRows(`SELECT 1 FROM sqlite_master WHERE name LIKE 'p\\_hello\\_%' ESCAPE '\\'`)).toHaveLength(0)
		expect(readRows(`SELECT 1 FROM _plugin_migrations WHERE pluginId = 'hello'`)).toHaveLength(0)
		expect(await leftoverData()).toBeUndefined()

		// the plugins sharing the database keep their settings
		expect(readRows(`SELECT 1 FROM plugins WHERE id = 'teamkill-warns'`)).toHaveLength(1)
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

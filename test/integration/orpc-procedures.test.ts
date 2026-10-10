import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { makePlayer } from '@/emulator'
import * as FB from '@/models/filter-builders.models'
import type * as L from '@/models/layer.models'
import type * as SC from '@/models/server-console.models'
import * as SETTINGS from '@/models/settings.models'
import * as SLL from '@/models/shared-layer-list.models'

import { ADMIN_USER, type AppFixture, createAppFixture, TEST_ADMIN_LIST, type TestUser } from '../harness/app-fixture'
import { filter, LAYERS, queueItem, role } from '../harness/arrange'
import { filterOwner, refusals, savedGlobalSettings, savedQueue, settingsUpdatedBlobs } from '../harness/inspect'
import { createOrpcClient, firstYield, sessionCookie, type TestOrpcClient } from '../harness/orpc-client'

// Server-side gates, asserted over oRPC with the protocol the browser speaks. The client hides buttons and
// disables entries, but nothing stops a caller from asking anyway -- these assert the handlers themselves
// refuse. Filter integrity first (deletion of a referenced filter, cyclical references), then the console
// stream's permission check, which is what stands between an ordinary dashboard user and every player's IP,
// steam and eos id.

const DASHBOARD_ONLY: TestUser = { discordId: 900000000000000051n, username: 'test-dashboard-only' }
const CONSOLE_READER: TestUser = { discordId: 900000000000000052n, username: 'test-console-reader' }
// may edit the roles and the admin lists, while holding no more than the dashboard
const ROLE_EDITOR: TestUser = { discordId: 900000000000000053n, username: 'test-role-editor' }
// loses site access mid-session, so nothing else in the file may sign in as them
const EVICTED: TestUser = { discordId: 900000000000000054n, username: 'test-evicted' }

let app: AppFixture
let adminClient: TestOrpcClient
let dashboardOnlyClient: TestOrpcClient
let consoleReaderClient: TestOrpcClient
let roleEditorClient: TestOrpcClient

beforeAll(async () => {
	app = await createAppFixture({
		filters: [
			filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')])),
			filter('raas-harju', 'RAAS on Harju', FB.and([FB.includedIn('raas-only'), FB.eq('Map', 'Harju')])),
			filter('pool-only', 'Pool Only', FB.and([FB.eq('Gamemode', 'AAS')])),
			filter('unused', 'Unused', FB.and([FB.eq('Gamemode', 'Invasion')])),
		],
		serverSettings: (settings) => {
			settings.queue.mainPool.poolFilter = { filterId: 'pool-only', mode: 'include' }
		},
		users: [DASHBOARD_ONLY, CONSOLE_READER, ROLE_EDITOR, EVICTED],
		unreachableServer: true,
		globalSettings: (settings) => {
			// can see the dashboard, pointedly not the console
			settings.rbac.roles['dashboard-only'] = role(['site:authorized', 'squad-server:view'], { users: [DASHBOARD_ONLY] })
			settings.rbac.roles['console-reader'] = role(['site:authorized', 'squad-server:view', 'squad-server:view-console'], {
				users: [CONSOLE_READER],
			})
			settings.rbac.roles['role-editor'] = {
				...role(['site:authorized', 'squad-server:view'], { users: [ROLE_EDITOR] }),
				globalSettingsGrants: ['rbac', 'adminLists'],
			}
			settings.rbac.roles['evicted'] = role(['site:authorized'], { users: [EVICTED] })
			// whoever the test admin list names may install plugins, which the role editor may not
			settings.rbac.roles['list-plugin-managers'] = role(['plugins:manage'], { ingameAdminLists: [TEST_ADMIN_LIST] })
		},
	})
	adminClient = await createOrpcClient(app)
	dashboardOnlyClient = await createOrpcClient(app, DASHBOARD_ONLY)
	consoleReaderClient = await createOrpcClient(app, CONSOLE_READER)
	roleEditorClient = await createOrpcClient(app, ROLE_EDITOR)
}, 120_000)

afterAll(async () => {
	// deliberately not closing the clients: see the teardown note in orpc-client.ts. Disposing the app takes
	// their connections with it.
	await app?.dispose()
})

describe('deleteFilter', () => {
	it('refuses a filter another filter applies', async () => {
		const res = await adminClient.filters.deleteFilter('raas-only')
		expect(res.code).toBe('err:filter-in-use')
		expect(res.code === 'err:filter-in-use' && res.references).toContainEqual({ type: 'filter-entity', filterId: 'raas-harju' })
	})

	it('refuses a filter a pool is configured with', async () => {
		const res = await adminClient.filters.deleteFilter('pool-only')
		expect(res.code).toBe('err:filter-in-use')
		expect(res.code === 'err:filter-in-use' && res.references).toContainEqual({
			type: 'pool-config',
			serverId: app.serverId,
			key: 'poolFilter',
			via: [],
		})
	})

	it('deletes a filter nothing references', async () => {
		expect((await adminClient.filters.deleteFilter('unused')).code).toBe('ok')
	})
})

describe('cyclical references', () => {
	it('refuses an update that would close a loop', async () => {
		const res = await adminClient.filters.updateFilter(['raas-only', { filter: FB.and([FB.includedIn('raas-harju')]) }])
		expect(res.code).toBe('err:cyclical-reference')
		expect(res.code === 'err:cyclical-reference' && res.cycle).toEqual(['raas-only', 'raas-harju', 'raas-only'])
	})

	it('allows an update that only deepens the chain', async () => {
		const res = await adminClient.filters.updateFilter(['raas-only', { filter: FB.and([FB.includedIn('pool-only')]) }])
		expect(res.code).toBe('ok')
	})
})

// The filter-owner role follows the owner column, and a filter SLM owns grants it to nobody.
describe('changeFilterOwner', () => {
	it('lets the new owner edit the filter, and nobody once SLM owns it', async () => {
		expect(await dashboardOnlyClient.filters.updateFilter(['raas-harju', { name: 'Harju RAAS' }])).toMatchObject({
			code: 'err:permission-denied',
		})

		expect(
			await adminClient.filters.changeFilterOwner({
				filterId: 'raas-harju',
				newOwner: { type: 'slm-user', userId: DASHBOARD_ONLY.discordId },
			}),
		).toEqual({ code: 'ok' })
		expect((await dashboardOnlyClient.filters.updateFilter(['raas-harju', { name: 'Harju RAAS' }])).code).toBe('ok')

		expect(await adminClient.filters.changeFilterOwner({ filterId: 'raas-harju', newOwner: { type: 'system' } })).toEqual({ code: 'ok' })
		expect(filterOwner(app, 'raas-harju')).toEqual({
			ownerUserId: null,
			ownerPluginId: null,
		})
		expect(await dashboardOnlyClient.filters.updateFilter(['raas-harju', { name: 'RAAS on Harju' }])).toMatchObject({
			code: 'err:permission-denied',
		})
		expect(await adminClient.filters.changeFilterOwner({ filterId: 'raas-harju', newOwner: { type: 'system' } })).toEqual({
			code: 'err:already-owns-filter',
		})
	})
})

describe('serverConsole.watch', () => {
	it('refuses a user holding squad-server:view but not view-console', async () => {
		const client = dashboardOnlyClient
		const first = await firstYield((signal) => client.serverConsole.watch({ serverId: app.serverId }, { signal }), {
			label: 'the denial',
		})

		// and it denies by refusing to send anything, not by sending the traffic with a flag attached
		expect(first).toEqual({ code: 'err:permission-denied', checkType: 'all', failures: ['squad-server:view-console'] })
	})

	it('streams the traffic to a user who holds view-console', async () => {
		const client = consoleReaderClient
		const first = await firstYield((signal) => client.serverConsole.watch({ serverId: app.serverId }, { signal }), {
			label: 'the console backlog',
		})

		if (first.code !== 'ok') throw new Error(`expected the backlog, got ${first.code}`)
		// the app polls the server on a timer, so a slice that has been up has rcon traffic behind it already
		expect(first.events.length).toBeGreaterThan(0)
		expect(first.events.some((e) => e.type === 'rcon')).toBe(true)
	})

	// The console is opened to find out why a server is down, so it has to keep working across the moment it goes
	// down. A stream that ends with the managed server is not retried by the client, so before the channel outlived
	// the server this left every open console frozen at the teardown and dead thereafter, even once it came back.
	it('keeps streaming across a stop and start of the server', async () => {
		const seen: SC.ConsoleEvent[] = []
		const ac = new AbortController()
		const collecting = (async () => {
			for await (const res of await consoleReaderClient.serverConsole.watch({ serverId: app.serverId }, { signal: ac.signal })) {
				if (res.code === 'ok') seen.push(...res.events)
			}
		})().catch(() => {})

		const slmMessages = () => seen.filter((e) => e.type === 'slm').map((e) => e.message)
		try {
			await app.waitFor(() => seen.length > 0 || null, { label: 'the console backlog to arrive' })

			await adminClient.settings.admin.disableServer({ serverId: app.serverId })
			await app.waitFor(() => slmMessages().some((m) => m.includes('stopped')) || null, { label: 'the stop to reach the console' })

			await adminClient.settings.admin.enableServer({ serverId: app.serverId })
			// the same subscription has to see this. Under the old lifetime it had already ended at the stop above.
			await app.waitFor(() => slmMessages().some((m) => m.includes('Starting server')) || null, {
				label: 'the restart to reach the same subscription',
				timeoutMs: 60_000,
			})
			// every later test here acts on this server, so it is handed back loaded rather than merely starting
			await app.waitFor(
				async () => {
					const loaded = await firstYield((signal) => adminClient.squadServer.watchLoadedServers(undefined, { signal }), {
						label: 'the loaded servers',
					})
					return loaded.includes(app.serverId) || null
				},
				{ label: 'the server to load again', timeoutMs: 90_000 },
			)
		} finally {
			ac.abort()
			await collecting
		}
	}, 180_000)

	it('carries what a player said in game', async () => {
		const client = consoleReaderClient
		const talker = makePlayer({ name: ' integ_talker', teamId: 1 })
		app.emu.world.connectPlayer(talker)
		await app.waitForRosterSync()
		app.emu.world.chat(talker, 'ChatAll', 'said over rcon')

		const seen = await app.waitFor(
			async () => {
				const first = await firstYield((signal) => client.serverConsole.watch({ serverId: app.serverId }, { signal }), {
					label: 'the console backlog',
				})
				if (first.code !== 'ok') return null
				return first.events.find((e) => e.type === 'command' && e.message === 'said over rcon') ?? null
			},
			{ label: 'the chat message to reach the console', timeoutMs: 30_000 },
		)

		expect(seen).toMatchObject({ type: 'command', channel: 'ChatAll', message: 'said over rcon' })
	})
})

// Every procedure declares what it requires, and the base middleware enforces the declaration before the handler runs.
describe('declared access', () => {
	it('refuses a procedure whose handler checks nothing itself', async () => {
		expect(await dashboardOnlyClient.history.searchPlayers({ needle: 'integ' })).toEqual({
			code: 'err:permission-denied',
			checkType: 'all',
			failures: ['history:query'],
		})
	})

	it('records a refused mutation in the audit log', async () => {
		const res = await dashboardOnlyClient.settings.admin.enableServer({ serverId: app.serverId })
		expect(res).toMatchObject({ code: 'err:permission-denied', failures: ['admin:manage-servers'] })
		expect(refusals(app, DASHBOARD_ONLY.discordId)).toContainEqual({
			procedure: 'settings.admin.enableServer',
			failures: ['admin:manage-servers'],
		})
	})
})

// A server whose rcon has never connected has no match in its history. Both of these streams read the current match
// on subscribe, so before they handled its absence each died with a 500 for the whole client and neither retried: no
// filter or repeat indicators on any queue row, and an empty chat feed. Every other fixture seeds a match before a
// client connects, which is what hid it. Both are asserted in one test because the layer status can only answer once
// rcon has exhausted its retries, which takes most of the run time.
describe('a server with no recorded match', () => {
	it('still streams its layer status and its chat events', async () => {
		const serverId = app.unreachableServerId!
		const untilLoaded = async <T>(call: () => Promise<T | null>, label: string) => await app.waitFor(call, { label, timeoutMs: 90_000 })

		const [status, events] = await Promise.all([
			untilLoaded(async () => {
				const res = await firstYield((signal) => adminClient.squadServer.watchLayersStatus({ serverId }, { signal }), {
					label: 'the layers status',
					timeoutMs: 40_000,
				})
				return res.code === 'ok' ? res : null
			}, 'the layers status'),
			untilLoaded(async () => {
				const res = await firstYield((signal) => adminClient.squadServer.watchChatEvents({ serverId }, { signal }), {
					label: 'the chat backlog',
				})
				return Array.isArray(res) ? res : null
			}, 'the chat backlog'),
		])

		expect(status.data.currentLayer).toBeNull()
		expect(status.data.currentMatch).toBeUndefined()
		expect(events.map((e) => e.type)).toContain('SYNCED')
	}, 120_000)
})

// A layer whose mod the server does not have cannot load, so the queue refuses it outright. Unlike the pool, no
// permission lifts it: the admin here holds queue:force-write and is still turned away. Late in the file because
// the accepted case saves a queue.
describe('installedMods', () => {
	const addOp = (layerId: L.LayerId) => ({
		op: 'add' as const,
		opId: SLL.createOpId(),
		editWindowSeqId: 0,
		userId: ADMIN_USER.discordId,
		items: [queueItem(layerId)],
		index: { outerIndex: 0, innerIndex: null },
	})

	it('refuses an add whose layer needs a mod the server does not have', async () => {
		const res = await adminClient.layerQueue.dispatchOp({ serverId: app.serverId, op: addOp(LAYERS.supermodSanxianInvasion) })
		expect(res.code).toBe('err:mods-not-installed')
	})

	it('accepts a vanilla layer, which the default installedMods covers', async () => {
		const added = await adminClient.layerQueue.dispatchOp({ serverId: app.serverId, op: addOp(LAYERS.gorodokAas) })
		expect(added.code).toBe('ok')
		const saved = await adminClient.layerQueue.dispatchOp({
			serverId: app.serverId,
			op: { op: 'save' as const, opId: SLL.createOpId(), editWindowSeqId: 0, userId: ADMIN_USER.discordId },
		})
		expect(saved.code).toBe('ok')
		await app.waitFor(async () => savedQueue(app).find((item) => item.layerId === LAYERS.gorodokAas) ?? null, {
			label: 'the queued layer',
		})
	}, 60_000)
})

// The server applies some ops itself, writing straight to the saved queue. Sent over rpc, one would skip the edit
// window and the checks an add passes, such as the installed-mods check refused above.
describe('server-only queue ops', () => {
	it('refuses one sent by a client, leaving the saved queue alone', async () => {
		const item = queueItem(LAYERS.supermodSanxianInvasion)
		const res = await adminClient.layerQueue.dispatchOp({
			serverId: app.serverId,
			op: {
				op: 'unshift-first-saved-layer',
				opId: SLL.createOpId(),
				layerId: item.layerId,
				itemSource: item.source,
				itemId: item.itemId,
			},
		})
		expect(res.code).toBe('err:invalid-op')
		expect(savedQueue(app).some((saved) => saved.layerId === LAYERS.supermodSanxianInvasion)).toBe(false)
	})
})

// The integration tokens live in the global settings, sealed in the column, and never leave the server once saved: the
// editor gets a placeholder, and sending the placeholder back is not a change. The fixture seeds the battlemetrics token
// as plaintext, so the app's own boot is what sealed it.
describe('integration credentials', () => {
	async function currentSettings() {
		const current = await firstYield((signal) => adminClient.settings.global.watchSettings(undefined, { signal }), {
			label: 'the global settings',
		})
		if ('code' in current) throw new Error(`could not read the settings: ${current.code}`)
		return current
	}

	it('are sealed at rest and streamed to the editor as a placeholder', async () => {
		const stored = savedGlobalSettings(app).integrations.battlemetrics
		expect(stored.token).toMatch(/^enc:v2:/)
		expect(stored.orgId).toBe('stub-org')
		const current = await currentSettings()
		expect(current.integrations!.battlemetrics!.token).toBe(SETTINGS.SECRET_SETTING_MASK)
		expect(current.integrations!.steam!.token).toBe('')
	})

	it('keep the stored token when the placeholder comes back with another change beside it', async () => {
		const current = await currentSettings()
		const before = savedGlobalSettings(app).integrations.battlemetrics.token
		const res = await adminClient.settings.global.updateSettings({
			integrations: { ...current.integrations, battlemetrics: { ...current.integrations!.battlemetrics, orgId: 'other-org' } },
		})
		expect(res.code).toBe('ok')
		expect(res.code === 'ok' && res.changes.map((c) => c.path)).toEqual(['integrations.battlemetrics.orgId'])
		const stored = savedGlobalSettings(app).integrations.battlemetrics
		expect(stored.orgId).toBe('other-org')
		// every save seals afresh, so the ciphertext differs; what the change list says is what did not change
		expect(stored.token).toMatch(/^enc:v2:/)
		expect(stored.token).not.toBe(before)
	})

	it('seal a new token at rest, keep it out of the audit log, and switch the integration off for every client', async () => {
		const current = await currentSettings()
		const rotated = await adminClient.settings.global.updateSettings({
			integrations: { ...current.integrations, battlemetrics: { ...current.integrations!.battlemetrics, token: 'rotated-token' } },
		})
		expect(rotated.code).toBe('ok')
		const stored = savedGlobalSettings(app).integrations.battlemetrics.token
		expect(stored).toMatch(/^enc:v2:/)
		expect(JSON.stringify(savedGlobalSettings(app))).not.toContain('rotated-token')
		for (const blob of settingsUpdatedBlobs(app)) expect(blob).not.toContain('rotated-token')
		expect((await currentSettings()).integrations!.battlemetrics!.token).toBe(SETTINGS.SECRET_SETTING_MASK)

		const config = await firstYield((signal) => adminClient.config.watchConfig(undefined, { signal }), { label: 'the config' })
		expect(config.integrations.battlemetrics).toBe(true)
		const off = await adminClient.settings.global.updateSettings({
			integrations: { ...current.integrations, battlemetrics: { ...current.integrations!.battlemetrics, enabled: false } },
		})
		expect(off.code).toBe('ok')
		await app.waitFor(
			async () => {
				const next = await firstYield((signal) => adminClient.config.watchConfig(undefined, { signal }), { label: 'the config' })
				return !next.integrations.battlemetrics || null
			},
			{ label: 'the integration to read as off' },
		)
		const on = await adminClient.settings.global.updateSettings({
			integrations: { ...current.integrations, battlemetrics: { ...current.integrations!.battlemetrics, enabled: true } },
		})
		expect(on.code).toBe('ok')
	}, 30_000)
})

// A grant over the roles or the admin lists is not a grant of everything: a save may grant nobody a permission its
// author lacks. Each refused save is checked against the stored settings, so a refusal that still wrote fails here.
describe('role settings escalation', () => {
	async function editorSettings() {
		const current = await firstYield((signal) => roleEditorClient.settings.global.watchSettings(undefined, { signal }), {
			label: 'the global settings, as the role editor',
		})
		if ('code' in current) throw new Error(`could not read the settings: ${current.code}`)
		return current
	}

	it('refuses adding a permission its author lacks to their own role', async () => {
		const rbac = structuredClone((await editorSettings()).rbac)!
		rbac.roles!['role-editor'].permissions!.push('plugins:manage')
		expect(await roleEditorClient.settings.global.updateSettings({ rbac })).toMatchObject({ code: 'err:permission-denied' })
		expect(savedGlobalSettings(app).rbac.roles['role-editor'].permissions).not.toContain('plugins:manage')
	})

	it('refuses assigning its author a role that holds more than they do', async () => {
		const rbac = structuredClone((await editorSettings()).rbac)!
		rbac.roles!['list-plugin-managers'].assignments!.discordUserIds!.push(String(ROLE_EDITOR.discordId))
		expect(await roleEditorClient.settings.global.updateSettings({ rbac })).toMatchObject({ code: 'err:permission-denied' })
		expect(savedGlobalSettings(app).rbac.roles['list-plugin-managers'].assignments.discordUserIds).toEqual([])
	})

	it('refuses repointing an admin list that assigns a role holding more than its author does', async () => {
		const adminLists = structuredClone((await editorSettings()).adminLists)!
		adminLists[TEST_ADMIN_LIST]!.source = { type: 'remote', source: 'https://admins.example/Admins.cfg' }
		expect(await roleEditorClient.settings.global.updateSettings({ adminLists })).toMatchObject({ code: 'err:permission-denied' })
		expect(savedGlobalSettings(app).adminLists[TEST_ADMIN_LIST].source.type).toBe('local')
	})

	it('accepts an assignment to a role holding nothing its author lacks, and its removal', async () => {
		const rbac = structuredClone((await editorSettings()).rbac)!
		const assigned = rbac.roles!['dashboard-only'].assignments!.discordUserIds!
		assigned.push(String(ROLE_EDITOR.discordId))
		expect(await roleEditorClient.settings.global.updateSettings({ rbac })).toMatchObject({ code: 'ok' })
		assigned.pop()
		expect(await roleEditorClient.settings.global.updateSettings({ rbac })).toMatchObject({ code: 'ok' })
	})
})

// A stream is checked for as long as it is open, not only when it is opened: losing access mid-stream replaces what it
// sends with the denial, and regaining it ends the stream so the client's resubscription is the one that succeeds.
// Last in the file because it edits the rbac settings, though it puts them back.
describe('revoking access from an open stream', () => {
	async function setDashboardOnlyPerms(permissions: string[]) {
		const current = await firstYield((signal) => adminClient.settings.global.watchSettings(undefined, { signal }), {
			label: 'the global settings',
		})
		if ('code' in current) throw new Error(`could not read the settings: ${current.code}`)
		const rbac = structuredClone(current.rbac)!
		rbac.roles!['dashboard-only'].permissions = permissions
		const res = await adminClient.settings.global.updateSettings({ rbac })
		if (res.code !== 'ok') throw new Error(`could not update the settings: ${res.code}`)
	}

	it('yields the denial on revocation and ends once access is back', async () => {
		const received: { code?: string }[] = []
		const ac = new AbortController()
		let ended = false
		const collecting = (async () => {
			for await (const update of await dashboardOnlyClient.layerQueue.watchOps({ serverId: app.serverId }, { signal: ac.signal })) {
				received.push(update as { code?: string })
			}
			ended = true
		})().catch(() => {})

		try {
			await app.waitFor(() => received.some((u) => u.code === 'init') || null, { label: 'the queue state' })

			await setDashboardOnlyPerms(['site:authorized'])
			await app.waitFor(() => received.some((u) => u.code === 'err:permission-denied') || null, { label: 'the denial' })

			await setDashboardOnlyPerms(['site:authorized', 'squad-server:view'])
			await app.waitFor(() => ended || null, { label: 'the stream to end' })
		} finally {
			ac.abort()
			await collecting
		}
		expect(received.at(-1)).toMatchObject({ code: 'err:permission-denied', failures: [`squad-server:view on ${app.serverId}`] })
	}, 60_000)
})

// A socket is authorized once, at its upgrade. Losing site access has to close the ones a user already holds, rather
// than leave them answering every procedure the user's remaining permissions allow.
describe('losing site access', () => {
	it("closes the user's open websockets", async () => {
		const cookie = await sessionCookie(app, EVICTED)
		const ws = new WebSocket(`${app.appUrl.replace(/^http/, 'ws')}/orpc`, { headers: { cookie } })
		await new Promise<void>((resolve, reject) => {
			ws.once('open', () => resolve())
			ws.once('error', reject)
		})
		const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))

		const current = await firstYield((signal) => adminClient.settings.global.watchSettings(undefined, { signal }), {
			label: 'the global settings',
		})
		if ('code' in current) throw new Error(`could not read the settings: ${current.code}`)
		const rbac = structuredClone(current.rbac)!
		rbac.roles!['evicted'].permissions = []
		expect(await adminClient.settings.global.updateSettings({ rbac })).toMatchObject({ code: 'ok' })

		expect(await closed).toBe(4001)
	})
})

// Anyone who can edit the admin lists can point a local source at a file, so a file outside LOCAL_ADMIN_LISTS_DIR (the
// fixture's own directory) is refused rather than read. Restores the source afterwards.
describe('local admin list sources', () => {
	it('refuses a file outside the allowed directory', async () => {
		const current = await firstYield((signal) => adminClient.settings.global.watchSettings(undefined, { signal }), {
			label: 'the global settings',
		})
		if ('code' in current) throw new Error(`could not read the settings: ${current.code}`)
		const original = structuredClone(current.adminLists)!
		const outside = structuredClone(original)
		outside[TEST_ADMIN_LIST]!.source = { type: 'local', source: '/etc/hostname' }
		expect(await adminClient.settings.global.updateSettings({ adminLists: outside })).toMatchObject({ code: 'ok' })
		try {
			await app.waitFor(() => fs.readFileSync(path.join(app.tmpDir, 'app.log'), 'utf8').includes('LOCAL_ADMIN_LISTS_DIR') || null, {
				label: 'the refusal in the app log',
			})
		} finally {
			expect(await adminClient.settings.global.updateSettings({ adminLists: original })).toMatchObject({ code: 'ok' })
		}
	})
})

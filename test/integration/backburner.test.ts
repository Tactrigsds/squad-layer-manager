import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makePlayer } from '@/emulator'
import * as BB from '@/models/backburner.models'
import * as FB from '@/models/filter-builders.models'
import * as L from '@/models/layer.models'

import { ADMIN_USER, type AppFixture, createAppFixture, type TestUser } from '../harness/app-fixture'
import { cmd, filter, LAYERS, queue, role } from '../harness/arrange'
import { appEventData, appEventTypes, latestMatch, matchSetBy, savedBackburner, savedFilter, savedQueue, warnsTo } from '../harness/inspect'
import { rearrange } from '../harness/rearrange'

// The layer backburner's in-game surface, and the generation it feeds: /reqlayer requests are validated
// against the pool, queued, listed, evicted at the per-user cap, and consumed by autogeneration when the
// map rolls -- which is also where the pool's repeat rules bind, so a second roll proves the just-played
// maps stay out of what generation draws. The pool generates votes, which neither roll may produce: a request
// outranks a vote, and the second roll leaves a single map, too few for a vote. Last, a filter that cannot be
// applied: a request leaves it out when it is a layer request filter and is refused when it applies it itself, and
// generation draws without it and warns the admins.

const ADMIN_STEAM_ID = '76561198000000001'
const REQUESTER_STEAM_ID = '76561198000000002'
const REQUESTER: TestUser = { discordId: 900000000000000002n, username: 'requester', steamIds: [REQUESTER_STEAM_ID] }

let app: AppFixture

function requestedMaps(item: ReturnType<typeof savedBackburner>[number]) {
	return BB.parseTemplateParts(item.filter).maps
}
const admin = makePlayer({ name: ' test_admin_player', steam: ADMIN_STEAM_ID })
const requester = makePlayer({ name: ' test_requester', steam: REQUESTER_STEAM_ID })

beforeAll(async () => {
	app = await createAppFixture({
		layerQueue: queue(LAYERS.gorodokRaas),
		admins: [ADMIN_STEAM_ID],
		adminSteamIds: [ADMIN_STEAM_ID],
		users: [REQUESTER],
		filters: [
			// a filter that matches nothing, so an unsatisfiable request can be made deterministically
			filter('impossible', 'Impossible', FB.and([FB.eq('Map', 'Gorodok'), FB.eq('Map', 'Fallujah')])),
			// generation is pinned to three maps so the repeat-rule assertion at the end is deterministic.
			// The emulator boots on Harju, which lands in the repeat window: no map here may collide with it.
			// Seeding and training layers are out because a repeat rule's lookback stops at one (see
			// isLookbackTerminatingLayerItem), which would leave the next generation unconstrained.
			filter(
				'gen-pool',
				'Generation Pool',
				FB.and([FB.inValues('Map', ['Gorodok', 'Skorpo', 'Fallujah']), FB.notInValues('Gamemode', ['Seed', 'Training'])]),
			),
			// saved before layer ids were canonical text. Nothing references it.
			filter('legacy-ids', 'Legacy ids', legacyIdsFilter(LEGACY_GORODOK, LEGACY_NARVA)),
			// a map the layer data does not have, so the filter cannot be applied
			filter('broken', 'Broken', FB.eq('Map', 'NoSuchMap')),
		],
		globalSettings: (s) => {
			s.rbac.roles['requesters'] = role([], { users: [REQUESTER] }, { maxLayerRequests: 1 })
		},
		repeatRules: [{ label: 'Map', field: 'Map', within: 4, autogen: true, warn: true, indicate: true }],
		serverSettings: (s) => {
			s.queue.mainPool.constrainGeneration = [{ filterId: 'gen-pool', applyAs: 'regular' }]
			s.queue.mainPool.layerRequestFilters = [{ filterId: 'gen-pool', applyAs: 'regular' }]
			s.queue.mainPool.generateVotes = { enabled: true, displayProps: ['map', 'gamemode'] }
		},
	})
	app.emu.world.connectPlayer(admin)
	app.emu.world.connectPlayer(requester)
	await app.waitForRosterSync()
}, 120_000)

afterAll(async () => {
	await app?.dispose()
})

const LEGACY_GORODOK = 'GD-RAAS-V1:USA-CA:RGF-CA'
const LEGACY_NARVA = 'NV-RAAS-V1:USA-CA:RGF-CA'
// an abbreviation no layer data has, which the rewrite must leave as written
const UNREADABLE = 'ZZ-RAAS-V1:USA-CA:RGF-CA'
function legacyIdsFilter(gorodok: string, narva: string) {
	return FB.and([FB.eq('id', gorodok), FB.inValues('id', [narva, UNREADABLE])])
}

describe('stored layer ids', () => {
	it('rewrites the old-format layer ids a filter compares against as canonical text at boot', () => {
		expect(savedFilter(app, 'legacy-ids')).toEqual(legacyIdsFilter(LAYERS.gorodokRaas, LAYERS.narvaRaas))
	})
})

describe('layer backburner via chat', () => {
	it('queues a request, lists it, and removes it again', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqlayer fallu'))
		await app.waitFor(() => savedBackburner(app).length === 1 || null, { label: 'the request persisting', timeoutMs: 20_000 })
		expect(requestedMaps(savedBackburner(app)[0])).toEqual(['Fallujah'])
		// chat requests carry the pool's layer request filters
		expect(BB.parseTemplateParts(savedBackburner(app)[0].filter).filterIds).toEqual(['gen-pool'])
		// the reply goes out after the request is saved
		await app.waitFor(() => warnsTo(app, admin).some((w) => w.includes('Layer request queued: Fallujah')) || null, {
			label: 'the queued reply',
			timeoutMs: 20_000,
		})

		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqs'))
		await app.waitFor(() => warnsTo(app, admin).some((w) => w.includes('1. Fallujah, Generation Pool (yours)')) || null, {
			label: 'the request listing',
			timeoutMs: 20_000,
		})

		app.emu.world.chat(admin, 'ChatAdmin', cmd('unreqlayer'))
		await app.waitFor(() => savedBackburner(app).length === 0 || null, { label: 'the request being removed', timeoutMs: 20_000 })
	})

	it('rejects a request with no solutions in the pool', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqlayer impossible'))
		await app.waitFor(() => warnsTo(app, admin).some((w) => w.includes('No layers in the current pool match')) || null, {
			label: 'the rejection reply',
			timeoutMs: 20_000,
		})
		expect(savedBackburner(app)).toHaveLength(0)
	})

	it('suggests a correction for an unknown token', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqlayer gorodokk'))
		await app.waitFor(() => warnsTo(app, admin).some((w) => w.includes('Unknown request')) || null, {
			label: 'the unknown-token reply',
			timeoutMs: 20_000,
		})
	})

	it('evicts the oldest request when a capped user exceeds their limit', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(requester, 'ChatAll', cmd('reqlayer skorpo'))
		await app.waitFor(() => savedBackburner(app).length === 1 || null, { label: 'the first capped request', timeoutMs: 20_000 })

		app.emu.world.chat(requester, 'ChatAll', cmd('reqlayer fallu'))
		await app.waitFor(() => (savedBackburner(app).length === 1 && requestedMaps(savedBackburner(app)[0]).join() === 'Fallujah') || null, {
			label: 'the oldest request being evicted',
			timeoutMs: 20_000,
		})
		await app.waitFor(() => warnsTo(app, requester).some((w) => w.includes('dropped')) || null, {
			label: 'the eviction reply',
			timeoutMs: 20_000,
		})

		// leave a clean slate for the generation test
		app.emu.world.chat(requester, 'ChatAll', cmd('unreqlayer'))
		await app.waitFor(() => savedBackburner(app).length === 0 || null, { label: 'cleanup', timeoutMs: 20_000 })
	})
})

describe('generation on roll', () => {
	it('folds queued requests into the next generated layer and consumes them', async () => {
		// The gamemode is pinned so the next test's repeat window only has to survive playing a Fallujah RAAS layer.
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqlayer fallu raas'))
		await app.waitFor(() => savedBackburner(app).length === 1 || null, { label: 'the request persisting', timeoutMs: 20_000 })

		// rolling consumes the only queued layer, which forces generation of the next one
		await app.waitForNextLayerSync()
		app.emu.world.endMatch()
		app.emu.world.startNewGame()

		const generated = await app.waitFor(
			() => {
				const q = savedQueue(app)
				return q.length >= 1 && q[0].layerId && q[0].layerId !== LAYERS.gorodokRaas ? q[0] : null
			},
			{ label: 'the generated layer', timeoutMs: 30_000 },
		)
		expect(generated.type).toBe('single-list-item')
		expect(L.toLayer(L.readStoredLayerId(generated.layerId!)).Map).toBe('Fallujah')
		expect(generated.source).toMatchObject({ type: 'layer-request', requesters: [{ steamId: ADMIN_STEAM_ID }] })

		await app.waitFor(() => savedBackburner(app).length === 0 || null, { label: 'the request being consumed', timeoutMs: 20_000 })
		expect(appEventTypes(app)).toContain('LAYER_REQUEST_CONSUMED')
	})

	it('never generates a map the repeat rule excludes', async () => {
		// the previous roll put the requested Fallujah at the head; this one plays it and forces another
		// generation. The repeat window now holds Fallujah (playing), Gorodok and Harju: of the three maps
		// generation may draw from, only Skorpo remains.
		const fallujah = savedQueue(app)[0].layerId!
		await app.waitForNextLayerSync()
		app.emu.world.endMatch()
		app.emu.world.startNewGame()

		const generated = await app.waitFor(
			() => {
				const q = savedQueue(app)
				return q.length >= 1 && q[0].layerId && q[0].layerId !== fallujah ? q[0] : null
			},
			{ label: 'the generated layer', timeoutMs: 30_000 },
		)
		expect(generated.type).toBe('single-list-item')
		expect(L.toLayer(L.readStoredLayerId(generated.layerId!)).Map).toBe('Skorpo')
		// nothing was requested this time, so the item is plainly generated
		expect(generated.source.type).toBe('generated')

		const played = latestMatch(app)
		expect(played.layerId).toBe(fallujah)
		expect(matchSetBy(app, played.id)).toMatchObject({ type: 'layer-request', requesters: [{ steamId: ADMIN_STEAM_ID }] })
	})

	it('names the requester as who set the match, and finds the match by them in history', async () => {
		const login = await fetch(`${app.appUrl}/check-auth?login=${ADMIN_USER.username}`, { redirect: 'manual' })
		const cookie = login.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.find((c) => c.startsWith('session-id=') && c.length > 'session-id='.length)!
		const matchRows = async (filter: string) => {
			const res = await fetch(`${app.appUrl}/history?type=matches&${filter}&contentType=text%2Fcsv`, { headers: { cookie } })
			expect(res.status).toBe(200)
			const [header, ...rows] = (await res.text()).split('\r\n').filter((line) => line !== '')
			expect(header).toBe('Match ID,Time,Server,Layer,Outcome,Ticket diff,Kills,Kill diff,Length,Set by,Events')
			return rows.map((row) => row.split(','))
		}

		// by steam id, and by name, which resolves through the player to their steam id
		for (const ref of [ADMIN_STEAM_ID, 'test_admin_player']) {
			const rows = await matchRows(`setByPlayers=${encodeURIComponent(JSON.stringify([ref]))}`)
			expect(rows, ref).toHaveLength(1)
			expect(rows[0].at(-2), ref).toMatch(/test.admin/)
		}
		// someone who requested nothing that got played
		expect(await matchRows(`setByPlayers=${encodeURIComponent(JSON.stringify([REQUESTER_STEAM_ID]))}`)).toHaveLength(0)
		expect(await matchRows(`setByUsers=${encodeURIComponent(JSON.stringify([REQUESTER.discordId.toString()]))}`)).toHaveLength(0)
	})
})

describe('filters that cannot be applied', () => {
	const GEN_POOL = { filterId: 'gen-pool', applyAs: 'regular' } as const
	const BROKEN = { filterId: 'broken', applyAs: 'regular' } as const

	it('leaves a layer request filter that cannot be applied out of a request, and says so', async () => {
		await rearrange(app, {
			pool: (p) => {
				p.constrainGeneration = [GEN_POOL]
				p.layerRequestFilters = [GEN_POOL, BROKEN]
			},
		})
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqlayer skorpo'))
		await app.waitFor(() => savedBackburner(app).length === 1 || null, { label: 'the request persisting', timeoutMs: 20_000 })
		expect(BB.parseTemplateParts(savedBackburner(app)[0].filter).filterIds).toEqual(['gen-pool'])
		await app.waitFor(() => warnsTo(app, admin).some((w) => w.includes('"Broken" cannot be applied')) || null, {
			label: 'the reply naming the left-out filter',
			timeoutMs: 20_000,
		})

		app.emu.world.chat(admin, 'ChatAdmin', cmd('unreqlayer'))
		await app.waitFor(() => savedBackburner(app).length === 0 || null, { label: 'cleanup', timeoutMs: 20_000 })
	})

	it('refuses a request that applies a filter that cannot be applied', async () => {
		await rearrange(app, {
			pool: (p) => {
				p.constrainGeneration = [GEN_POOL]
				p.layerRequestFilters = [GEN_POOL]
			},
		})
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqlayer broken'))
		await app.waitFor(() => warnsTo(app, admin).some((w) => w.includes('"Broken", which cannot be applied')) || null, {
			label: 'the refusal',
			timeoutMs: 20_000,
		})
		expect(savedBackburner(app)).toHaveLength(0)
	})

	it('generates without a generation filter that cannot be applied, and warns the admins', async () => {
		await rearrange(app, {
			pool: (p) => {
				p.constrainGeneration = [GEN_POOL, BROKEN]
				p.warnFor = [BROKEN]
			},
		})
		type GeneratedWithout = { queueItemId: string; layerIds: string[]; skipped: { filterId?: string }[] }
		const recordedBefore = appEventData<GeneratedWithout>(app, 'LAYER_GENERATED_WITHOUT_FILTERS').length
		await app.waitForNextLayerSync()
		app.emu.rcon.commandLog.length = 0
		app.emu.world.endMatch()
		app.emu.world.startNewGame()

		const recorded = await app.waitFor(
			() => appEventData<GeneratedWithout>(app, 'LAYER_GENERATED_WITHOUT_FILTERS')[recordedBefore] ?? null,
			{ label: 'the generation recorded without the filter', timeoutMs: 30_000 },
		)
		expect(recorded.skipped.map((s) => s.filterId)).toEqual([BROKEN.filterId])
		const generated = await app.waitFor(() => savedQueue(app).find((item) => item.itemId === recorded.queueItemId) ?? null, {
			label: 'the generated layer in the saved queue',
		})
		// drawn from the generation filter that can be applied, not the default layer
		expect(['Gorodok', 'Skorpo', 'Fallujah']).toContain(L.toLayer(L.readStoredLayerId(generated.layerId!)).Map)
		await app.waitFor(() => warnsTo(app, admin).some((w) => w.includes('without the filter "Broken"')) || null, {
			label: 'the warn naming the left-out filter',
			timeoutMs: 20_000,
		})

		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('shownext'))
		await app.waitFor(() => warnsTo(app, admin).some((w) => w.includes('not checked against the filter "Broken"')) || null, {
			label: 'the next-layer warn naming the unchecked filter',
			timeoutMs: 20_000,
		})
	})
})

describe('filters chosen with --filters', () => {
	const GEN_POOL = { filterId: 'gen-pool', applyAs: 'regular' } as const

	it('requests with the filters typed after --filters in place of the layer request filters', async () => {
		await rearrange(app, { pool: (p) => (p.layerRequestFilters = [GEN_POOL]) })
		app.emu.rcon.commandLog.length = 0
		// Narva is outside the layer request filter, so only a request without it can be met
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqlayer narva --filters=!impossible'))
		await app.waitFor(() => savedBackburner(app).length === 1 || null, { label: 'the request persisting', timeoutMs: 20_000 })
		const parts = BB.parseTemplateParts(savedBackburner(app)[0].filter)
		expect(parts.filterIds).toEqual([])
		expect(parts.excludedFilterIds).toEqual(['impossible'])
		await app.waitFor(() => warnsTo(app, admin).some((w) => w.includes('Layer request queued: Narva, not Impossible')) || null, {
			label: 'the queued reply naming the typed filter',
			timeoutMs: 20_000,
		})

		app.emu.world.chat(admin, 'ChatAdmin', cmd('unreqlayer'))
		await app.waitFor(() => savedBackburner(app).length === 0 || null, { label: 'cleanup', timeoutMs: 20_000 })
	})

	it('refuses --filters from a player who cannot edit the queue', async () => {
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(requester, 'ChatAll', cmd('reqlayer skorpo -f none'))
		await app.waitFor(() => warnsTo(app, requester).some((w) => w.includes('Permission denied')) || null, {
			label: 'the permission refusal',
			timeoutMs: 20_000,
		})
		expect(savedBackburner(app)).toHaveLength(0)
	})

	// the mistyped word and both mistyped filter entries are asked about in one prompt, and each pick replaces only
	// what it answers for
	it('asks about every mistyped word and --filters entry in one prompt, and requests with the picks', async () => {
		app.emu.rcon.commandLog.length = 0
		const step = async (n: number) =>
			await app.waitFor(() => warnsTo(app, admin).findLast((w) => w.includes(`(${n}/3)`)) ?? null, {
				label: `question ${n} of 3`,
				timeoutMs: 20_000,
			})
		app.emu.world.chat(admin, 'ChatAdmin', cmd('reqlayer skorpoo -f genpool,!imposible'))

		const first = await step(1)
		expect(first).toContain('Unknown filter "genpool"')
		expect(first).toContain('1) Generation Pool')
		expect(savedBackburner(app)).toHaveLength(0)
		app.emu.world.chat(admin, 'ChatAdmin', '1')

		const second = await step(2)
		expect(second).toContain('Unknown filter "imposible"')
		expect(second).toContain('1) not Impossible')
		app.emu.world.chat(admin, 'ChatAdmin', '1')

		const third = await step(3)
		expect(third).toContain('Unknown request "skorpoo"')
		expect(third).toContain('1) Skorpo')
		app.emu.world.chat(admin, 'ChatAdmin', '1')

		await app.waitFor(() => savedBackburner(app).length === 1 || null, { label: 'the request persisting', timeoutMs: 20_000 })
		const parts = BB.parseTemplateParts(savedBackburner(app)[0].filter)
		expect(parts.maps).toEqual(['Skorpo'])
		expect(parts.filterIds).toEqual(['gen-pool'])
		expect(parts.excludedFilterIds).toEqual(['impossible'])

		app.emu.world.chat(admin, 'ChatAdmin', cmd('unreqlayer'))
		await app.waitFor(() => savedBackburner(app).length === 0 || null, { label: 'cleanup', timeoutMs: 20_000 })
	})

	it('draws a vote with the filters typed after --filters in place of the pool filter', async () => {
		await rearrange(app, {
			layerQueue: queue(LAYERS.gorodokRaas),
			repeatRules: [],
			pool: (p) => (p.poolFilter = { filterId: 'gen-pool', mode: 'include' }),
		})
		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('vote narva yeho'))
		await app.waitFor(() => warnsTo(app, admin).some((w) => /No layers? in the pool match/.test(w)) || null, {
			label: 'the pool filter refusing the maps',
			timeoutMs: 20_000,
		})

		app.emu.world.chat(admin, 'ChatAdmin', cmd('vote narva yeho --filters none'))
		await app.waitFor(() => warnsTo(app, admin).some((w) => w.includes('Vote added first in the queue')) || null, {
			label: 'the vote drawn without the pool filter',
			timeoutMs: 20_000,
		})
		const [head] = savedQueue(app)
		expect(new Set(head.choices!.map((c) => L.toLayer(L.readStoredLayerId(c.layerId)).Map))).toEqual(new Set(['Narva', 'Yehorivka']))

		app.emu.rcon.commandLog.length = 0
		app.emu.world.chat(admin, 'ChatAdmin', cmd('vote narva skorpo -f !gen'))
		await app.waitFor(() => warnsTo(app, admin).some((w) => w.includes('No layer in the pool matches "Skorpo"')) || null, {
			label: 'the inverted filter refusing Skorpo',
			timeoutMs: 20_000,
		})
	})
})

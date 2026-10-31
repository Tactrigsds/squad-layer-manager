import { eq } from 'drizzle-orm'
import * as z from 'zod'

import * as CB from 'slm/models/constraint-builders'
import * as FB from 'slm/models/filter-builders'
import * as GV from 'slm/models/gen-vote'
import * as L from 'slm/models/layer'
import * as RBAC from 'slm/models/rbac'
import type * as ROT from 'slm/models/rotation'
import type * as P from 'slm/plugin'
import { defineTables, type PluginMigration } from 'slm/plugin'
import * as Commands from 'slm/plugin/commands'
import * as PluginConfig from 'slm/plugin/config'
import * as Permissions from 'slm/plugin/permissions'
import * as Rpc from 'slm/plugin/rpc.server'
import * as Schedule from 'slm/plugin/schedule'
import * as Servers from 'slm/plugin/servers'
import * as Db from 'slm/server/db'
import * as AppEventsSys from 'slm/systems/app-events'
import * as Discord from 'slm/systems/discord'
import * as Filters from 'slm/systems/filter-entity'
import * as LayerQueries from 'slm/systems/layer-queries'
import * as LayerQueue from 'slm/systems/layer-queue'
import * as MatchHistory from 'slm/systems/match-history'
import * as Reminders from 'slm/systems/post-roll-reminders'
import * as RepeatRulesets from 'slm/systems/repeat-ruleset'
import * as Rotations from 'slm/systems/rotation'
import * as Settings from 'slm/systems/settings'
import * as SquadServer from 'slm/systems/squad-server'
import * as Tags from 'slm/systems/tags'

import manifest from './plugin.ts'
import * as S from './schema.ts'

// built from the manifest the way schema.ts does, with the unprefixed name spelled out here so a
// later rename cannot reach back and change what this migration did
const greetings = defineTables(manifest).name('greetings')

export const migrations: PluginMigration[] = [
	{
		name: '0001_init',
		up: (db) => {
			db.exec(`CREATE TABLE IF NOT EXISTS ${greetings} (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				serverId TEXT NOT NULL,
				text TEXT NOT NULL,
				matches INTEGER NOT NULL
			)`)
		},
	},
]

// module scope, deliberately: a stop/start loads the bundle under a fresh url, so a restarted plugin
// sees 1 here rather than 2. Without that, activate() would run again against the previous run's state.
let activations = 0

const os = Rpc.os<typeof manifest>()

// Filter CRUD, driven from the test rather than run on activate: the plugin is stopped and started
// several times over the journey, and a filter written at activation would collide with its own last run.
// without an owner, the plugin owns the filter
const FilterInput = z.object({ id: z.string(), owner: z.string().optional() })
const RotationInput = z.object({ id: z.string(), owner: z.string().optional(), layerIds: z.array(L.LayerIdSchema) })

function attributedItem(layerId: L.LayerId, userId: bigint): Rotations.NewItems[number] {
	return {
		type: 'single-list-item',
		layerId,
		source: { type: 'manual', userId },
		notes: [{ id: 'hellonot', author: userId, text: 'from hello' }],
	}
}

// filters and rotations take the same contributor calls
const contributed = { filter: Filters, rotation: Rotations }
const ContributedKind = z.enum(['filter', 'rotation'])
const ContributorInput = z.object({ kind: ContributedKind, id: z.string(), userId: z.string().optional(), roleId: z.string().optional() })

function contributorOf(input: { userId?: string; roleId?: string }): RBAC.Contributor {
	return input.userId !== undefined ? { type: 'user', userId: BigInt(input.userId) } : { type: 'role', roleId: input.roleId! }
}

// every rotation write the plugin saw, as `<type>:<id>:<actor type>`
const rotationChanges: string[] = []
// the ruleset ids after each change to the rulesets
const rulesetChanges: string[][] = []
// installedMods after each change to a server's settings, by server
const serverSettingsChanges = new Map<string, string[][]>()
// what armEvent is waiting for, by event type, until takeEvent collects it
const armed = new Map<string, Promise<{ type: string } | null>>()

// what blocks a run of gatedJob, below
const GatedMode = z.enum(['gate', 'delay', 'forever', 'eager'])
// what a run of stoppableJob, below, does when it is cancelled
const StoppableMode = z.enum(['throws', 'finishes', 'ignores'])

export const router = {
	stats: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async () => ({ activations })),

	// Procedures declare what the caller needs and the host checks it before the handler runs, so these report who
	// they saw only when the caller was allowed. The test tells an allowed call from a refused one by the answer.
	whoAmI: os
		.meta({ access: RBAC.Access.req(({ serverId }) => RBAC.perm('squad-server:end-match', { serverId })) })
		.input(z.object({}))
		.handler(async ({ context }) => ({ code: 'ok' as const, discordId: String(context.user.discordId) })),

	// the same check against an action SLM knows nothing about beyond the id a role was granted
	greetIfAllowed: os
		.meta({ access: RBAC.Access.req(({ serverId }) => perms!.greet(serverId)) })
		.input(z.object({}))
		.handler(async ({ context }) => ({ code: 'ok' as const, greeting: PluginConfig.get(context).greeting })),
	// a stream behind the same action, which has to stop streaming to a caller who loses it
	watchGreetingIfAllowed: os
		.meta({ access: RBAC.Access.req(({ serverId }) => perms!.greet(serverId)) })
		.input(z.object({}))
		.handler(async function* ({ context, signal }) {
			yield { code: 'ok' as const, greeting: PluginConfig.get(context).greeting }
			await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))
		}),
	makeFilter: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(FilterInput)
		.handler(async ({ context, input }) =>
			Filters.create(context, {
				id: input.id,
				name: 'Hello pool',
				description: null,
				filter: FB.and([FB.eq('Collection', 'OWI'), FB.notInValues('Gamemode', ['Seed', 'Training'])]),
				owner: input.owner === undefined ? undefined : { type: 'slm-user', userId: BigInt(input.owner) },
				alertMessage: null,
				emoji: null,
				invertedAlertMessage: null,
				invertedEmoji: null,
			}),
		),
	renameFilter: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ id: z.string(), name: z.string() }))
		.handler(async ({ context, input }) => Filters.update(context, input.id, { name: input.name })),
	dropFilter: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ id: z.string() }))
		.handler(async ({ context, input }) => Filters.remove(context, input.id)),
	filterIds: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async () => Filters.list().map((f) => f.id)),

	// each item names the caller as its source and note author, which the host has to strip
	makeRotation: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(RotationInput)
		.handler(async ({ context, input }) =>
			Rotations.create(context, {
				id: input.id,
				name: 'Hello rotation',
				description: null,
				repeatRulesetId: null,
				tags: [],
				items: input.layerIds.map((layerId) => attributedItem(layerId, context.user.discordId)),
				owner: input.owner === undefined ? undefined : { type: 'slm-user', userId: BigInt(input.owner) },
			}),
		),
	updateRotation: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ id: z.string(), name: z.string().optional(), layerIds: z.array(L.LayerIdSchema).optional() }))
		.handler(async ({ context, input }) =>
			Rotations.update(context, input.id, {
				name: input.name,
				items: input.layerIds?.map((layerId) => attributedItem(layerId, context.user.discordId)),
			}),
		),
	cloneRotation: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ sourceId: z.string(), id: z.string() }))
		.handler(async ({ context, input }) => Rotations.clone(context, { ...input, name: 'Hello rotation clone' })),
	copyContributors: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ kind: ContributedKind, sourceId: z.string(), targetId: z.string() }))
		.handler(async ({ context, input }) => contributed[input.kind].copyContributors(context, input.sourceId, input.targetId)),
	// user ids as strings, to survive the trip back to the test as json
	getContributors: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ kind: ContributedKind, id: z.string() }))
		.handler(async ({ context, input }) =>
			(await contributed[input.kind].getContributors(context, input.id)).map((c) =>
				c.type === 'user' ? { ...c, userId: String(c.userId) } : c,
			),
		),
	addContributor: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(ContributorInput)
		.handler(async ({ context, input }) => contributed[input.kind].addContributor(context, input.id, contributorOf(input))),
	removeContributor: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(ContributorInput)
		.handler(async ({ context, input }) => contributed[input.kind].removeContributor(context, input.id, contributorOf(input))),
	dropRotation: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ id: z.string() }))
		.handler(async ({ context, input }) => Rotations.remove(context, input.id)),
	getRotation: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ id: z.string() }))
		.handler(async ({ context, input }) => (await Rotations.get(context, input.id)) ?? null),
	// every rotation's id, archived ones included, a page of one at a time so that paging is exercised
	rotationIds: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async ({ context }) => {
			const ids: string[] = []
			let cursor: ROT.SearchCursor | undefined
			do {
				const page = await Rotations.search(context, { archived: true, sort: 'name', limit: 1, cursor })
				ids.push(...page.rotations.map((r) => r.id))
				cursor = page.nextCursor ?? undefined
			} while (cursor)
			return ids
		}),
	rotationChanges: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async () => rotationChanges),
	scheduleGreet: os
		.meta({ access: RBAC.Access.PUBLIC })
		// `name` is unknown so a payload that does not fit the job can be sent
		.input(z.object({ name: z.unknown(), inMs: z.number(), key: z.string().optional() }))
		.handler(async ({ context, input }) =>
			Schedule.at(context, greetJob, { at: Date.now() + input.inMs, payload: { name: input.name as string }, key: input.key }),
		),
	cancelGreet: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ key: z.string() }))
		.handler(async ({ context, input }) => Schedule.cancel(context, greetJob, input.key)),
	jobRuns: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async () => jobRuns),
	releaseHeld: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async () => {
			releaseHeld()
			return { code: 'ok' as const }
		}),
	scheduleGated: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ mode: GatedMode, inMs: z.number(), key: z.string() }))
		.handler(async ({ context, input }) =>
			Schedule.at(context, gatedJob, { at: Date.now() + input.inMs, payload: { mode: input.mode }, key: input.key }),
		),
	cancelGated: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ key: z.string() }))
		.handler(async ({ context, input }) => Schedule.cancel(context, gatedJob, input.key)),
	openGate: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async () => {
			gateOpen = true
			openGate()
			return { code: 'ok' as const }
		}),
	scheduleStoppable: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ mode: StoppableMode, key: z.string() }))
		.handler(async ({ context, input }) =>
			Schedule.at(context, stoppableJob, { at: Date.now(), payload: { mode: input.mode }, key: input.key }),
		),
	cancelStoppable: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ key: z.string() }))
		.handler(async ({ context, input }) => Schedule.cancel(context, stoppableJob, input.key)),
	scheduleTimed: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ key: z.string() }))
		.handler(async ({ context, input }) => Schedule.at(context, timedJob, { at: Date.now(), key: input.key })),
	gatedCallTimes: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ key: z.string() }))
		.handler(async ({ input }) => gatedCalls.get(input.key) ?? []),
	addRotationToQueue: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(
			z.object({
				id: z.string(),
				placement: z.enum(['replace', 'start', 'end']),
				tags: z.array(z.string()).optional(),
				// clears every queued item but these in the same edit
				keepItemIds: z.array(z.string()).optional(),
			}),
		)
		.handler(async ({ context, input }) =>
			Rotations.addToQueue(context, input.id, {
				placement: input.placement,
				tags: input.tags,
				clear: input.keepItemIds && ((item) => !input.keepItemIds!.includes(item.itemId)),
			}),
		),
	ensureTag: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ kind: z.enum(['layer', 'rotation']), label: z.string() }))
		.handler(async ({ context, input }) => Tags.ensure(context, input.kind, input.label)),
	// drops every saved queue item but these
	keepQueueItems: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ itemIds: z.array(z.string()) }))
		.handler(async ({ context, input }) =>
			LayerQueue.editSaved(context, (entries) => entries.filter((e) => input.itemIds.includes(e.itemId))),
		),

	serverRulesetId: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async ({ context }) => RepeatRulesets.forServer(context)?.id ?? null),
	saveRuleset: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ id: z.string(), name: z.string() }))
		.handler(async ({ context, input }) =>
			RepeatRulesets.save(context, { ...input, rules: [{ field: 'Map', within: 2, warn: true, indicate: true }] }),
		),
	setServerRuleset: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ id: z.string() }))
		.handler(async ({ context, input }) => RepeatRulesets.setForServer(context, input.id)),
	dropRuleset: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ id: z.string() }))
		.handler(async ({ context, input }) => RepeatRulesets.remove(context, input.id)),
	rulesetChanges: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async () => rulesetChanges),

	readSettings: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async ({ context }) => ({
			defaultTimeZone: Settings.global().defaultTimeZone,
			installedMods: Settings.server(context.serverId)?.installedMods,
			hasConnections: 'connections' in (Settings.server(context.serverId) ?? {}),
			missingServer: Settings.server('no-such-server') ?? null,
		})),
	updateGlobalSettings: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ ops: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), value: z.unknown() })) }))
		.handler(async ({ context, input }) => Settings.updateGlobal(context, input.ops)),
	updateServerSettings: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(
			z.object({
				serverId: z.string().optional(),
				ops: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), value: z.unknown() })),
			}),
		)
		.handler(async ({ context, input }) => Settings.updateServer(context, input.serverId ?? context.serverId, input.ops)),
	serverSettingsChanges: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async ({ context }) => serverSettingsChanges.get(context.serverId) ?? []),

	// the filter the query is constrained by is one the plugin made itself, which is the pairing worth
	// covering: neither half is much use to a plugin without the other
	inFilter: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ filterId: z.string() }))
		.handler(async ({ context, input }) => {
			const res = await LayerQueries.query(context, {
				pageSize: 5,
				sort: null,
				constraints: [CB.filterEntity('pool', input.filterId)],
			})
			return res.code === 'ok' ? { code: 'ok' as const, total: res.totalCount, collections: res.layers.map((l) => l.Collection) } : res
		}),
	outOfPool: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ filterId: z.string(), layerIds: z.array(L.LayerIdSchema) }))
		.handler(async ({ context, input }) =>
			LayerQueries.outOfPool(context, { layerIds: input.layerIds, constraints: [CB.filterEntity('pool', input.filterId)] }),
		),
	layersExist: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ layerIds: z.array(L.LayerIdSchema) }))
		.handler(async ({ context, input }) => LayerQueries.exists(context, input.layerIds)),
	mapValues: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async ({ context }) => LayerQueries.componentValues(context, { column: 'Map' })),
	drawVote: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ filterId: z.string(), seed: z.string(), presetLayerId: L.LayerIdSchema }))
		.handler(async ({ context, input }) => {
			const res = await LayerQueries.genVote(context, {
				seed: input.seed,
				// the middle choice is already decided, so the draw has to leave it alone and route around it
				choices: [GV.initChoice(), { choiceConstraints: {}, layerId: input.presetLayerId }, GV.initChoice()],
				uniqueConstraints: ['Map'],
				constraints: [CB.filterEntity('pool', input.filterId)],
			})
			if (res.code !== 'ok') return res
			return { code: 'ok' as const, maps: res.chosenLayers.map((l) => l?.Map ?? null), unfilledChoices: res.unfilledChoices }
		}),
	// --- the automation surface: the queue, the event stream, ending a match, discord ---

	savedQueue: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async ({ context }) =>
			LayerQueue.getSavedQueue(context).map((item) => ({
				itemId: item.itemId,
				layerId: item.layerId,
				source: item.source.type,
				sourcePluginId: item.source.type === 'plugin' ? item.source.pluginId : null,
			})),
		),

	// prepends a layer and keeps the rest, which is the shape a real caller uses: pass entries through to
	// keep their items, hand back a bare id for a new one
	prependLayer: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ layerId: L.LayerIdSchema }))
		.handler(async ({ context, input }) => LayerQueue.editSaved(context, (entries) => [input.layerId, ...entries])),

	dropFirstLayer: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async ({ context }) => LayerQueue.editSaved(context, (entries) => entries.slice(1))),

	// subscribes before it answers, so whatever the caller does next is seen. The stream is hot: a call that only
	// subscribed on arrival could miss an event sent alongside it. takeEvent collects what was caught.
	armEvent: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ type: z.string(), ms: z.number() }))
		.handler(async ({ context, input }) => {
			armed.set(
				input.type,
				new Promise<{ type: string } | null>((resolve) => {
					const timer = setTimeout(() => {
						sub.unsubscribe()
						resolve(null)
					}, input.ms)
					const sub = SquadServer.events$(context).subscribe((event) => {
						if (event.type !== input.type) return
						clearTimeout(timer)
						sub.unsubscribe()
						resolve({ type: event.type })
					})
				}),
			)
			return { armed: true }
		}),

	// the first event of `type` seen since armEvent, or null once its `ms` passed with none
	takeEvent: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ type: z.string() }))
		.handler(async ({ input }) => {
			const caught = armed.get(input.type)
			if (!caught) throw new Error(`nothing armed for ${input.type}`)
			armed.delete(input.type)
			return await caught
		}),

	endMatch: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({}))
		.handler(async ({ context }) => SquadServer.endMatch(context)),

	postToDiscord: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ channelId: z.string(), content: z.string() }))
		.handler(async ({ input }) => ({ enabled: Discord.isEnabled(), res: await Discord.postMessage(input.channelId, input.content) })),

	deleteFromDiscord: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ channelId: z.string(), messageId: z.string() }))
		.handler(async ({ input }) => ({ enabled: Discord.isEnabled(), res: await Discord.deleteMessage(input.channelId, input.messageId) })),

	greetings: os
		.meta({ access: RBAC.Access.PUBLIC })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context, input }) {
			yield Db.all(context, sql!.select().from(S.greetings).where(eq(S.greetings.serverId, input.serverId)))
		}),
}

// what the jobs below did, for a test to read back: `<job>:<key>:<name>:<manual>`
const jobRuns: string[] = []

// a run asked to hold keeps running until releaseHeld is called
let releaseHeld!: () => void
const held = new Promise<void>((resolve) => (releaseHeld = resolve))

// a one-off job with data of its own; a run asked to fail does, and its window is too short for a retry
export const greetJob = Schedule.job({
	id: 'greet',
	scope: 'server',
	payload: z.object({ name: z.string() }),
	catchUp: '2s',
	run: async (_sctx, run, payload) => {
		if (payload.name === 'fail') throw new Error('asked to fail')
		if (payload.name === 'hold') await held
		jobRuns.push(`greet:${run.key}:${payload.name}:${run.manual}`)
	},
})

// a recurring job not tied to a server. Hourly, so it runs once as the plugin starts and not again during a test.
export const heartbeatJob = Schedule.job({
	id: 'heartbeat',
	scope: 'plugin',
	when: () => ({ every: '1h' }),
	logSuccess: true,
	run: async (_ctx, run) => {
		jobRuns.push(`heartbeat:${run.key.startsWith('manual:') ? 'manual' : 'scheduled'}:${run.manual}`)
	},
})

// A one-off job that is blocked until something lets it through: the gate opening, a moment passing, never, or a
// source that fires as soon as it is subscribed to. It records each call, so a test can see that a blocked run went
// again on the same attempt.
let gateOpen = false
let openGate!: () => void
const gate = new Promise<void>((resolve) => (openGate = resolve))
// when each call of a run happened, by run key
const gatedCalls = new Map<string, number[]>()
const firesAtOnce: Schedule.Subscribable<unknown> = {
	subscribe: (observer) => {
		observer.next?.(undefined)
		return { unsubscribe: () => {} }
	},
}

export const gatedJob = Schedule.job({
	id: 'gated',
	scope: 'server',
	payload: z.object({ mode: GatedMode }),
	catchUp: '1m',
	run: async (_sctx, run, { mode }) => {
		const calls = [...(gatedCalls.get(run.key) ?? []), Date.now()]
		gatedCalls.set(run.key, calls)
		jobRuns.push(`gated:${run.key}:call${calls.length}:attempt${run.attempt}`)
		if (mode === 'gate' && !gateOpen) return Schedule.blocked('the gate is closed', gate)
		if (mode === 'delay' && calls.length === 1) return Schedule.blocked('waiting a moment', 100)
		if (mode === 'forever') return Schedule.blocked('it never opens', new Promise(() => {}))
		if (mode === 'eager' && calls.length < 3) return Schedule.blocked('it fires at once', firesAtOnce)
		jobRuns.push(`gated:${run.key}:done`)
	},
})

const aborted = (signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) resolve()
		else signal.addEventListener('abort', () => resolve(), { once: true })
	})

// A one-off job that runs until it is cancelled, and then throws the abort, finishes anyway, or ignores it.
export const stoppableJob = Schedule.job({
	id: 'stoppable',
	scope: 'server',
	payload: z.object({ mode: StoppableMode }),
	catchUp: '1m',
	run: async (_sctx, run, { mode }) => {
		jobRuns.push(`stoppable:${run.key}:started`)
		if (mode === 'ignores') await new Promise(() => {})
		await aborted(run.signal)
		if (mode === 'throws') throw run.signal.reason
		jobRuns.push(`stoppable:${run.key}:done`)
	},
})

// a one-off job that outlasts its timeout, and stops by throwing the abort when it comes
export const timedJob = Schedule.job({
	id: 'timed',
	scope: 'server',
	timeout: 300,
	catchUp: '2s',
	run: async (_sctx, run) => {
		await aborted(run.signal)
		throw run.signal.reason
	},
})

export const jobs = [greetJob, heartbeatJob, gatedJob, stoppableJob, timedJob]

// an action this plugin defines for itself, so a role can be granted it without SLM knowing what it means.
// Held module-level so the router can ask for it; the builders are the plugin's own, not the host's.
let perms: { greet: (serverId: string) => RBAC.Permission<'plugin:action'> } | undefined
let sql: ReturnType<typeof Db.forModule> | undefined

export async function activate(ctx: P.Ctx<typeof manifest>) {
	activations++
	sql = Db.forModule(ctx.module)
	const SQL = sql
	perms = Permissions.register(ctx, {
		greet: { scope: 'server', description: 'Send the greeting on a server' },
	})
	Rpc.register(ctx, router)
	Rotations.changes(ctx).subscribe((c) => rotationChanges.push(`${c.type}:${c.rotation.id}:${c.actor.type}`))
	RepeatRulesets.changes(ctx).subscribe((rulesets) => rulesetChanges.push(rulesets.map((r) => r.id)))

	// an in-game command, answering with its config and whatever was typed after the trigger, so a test can
	// tell the handler ran with the right ctx and the right arguments
	Commands.register(ctx, {
		name: 'hello',
		description: 'Says hello back.',
		triggers: ['hello'],
		allowedChats: ['admin'],
		usage: '[name]',
		access: RBAC.Access.req(({ serverId }) => RBAC.perm('squad-server:end-match', { serverId })),
		handler: async (sctx, input) => {
			return `${PluginConfig.get(sctx).greeting} ${input.text || 'nobody'} on ${sctx.serverId}`
		},
	})

	// runs once per managed server: writes a row proving the plugin reached its own table, a core
	// system (match history) and its config, all through shimmed slm/* imports
	Servers.setup(ctx, (sctx) => {
		const changes = serverSettingsChanges.get(sctx.serverId) ?? []
		serverSettingsChanges.set(sctx.serverId, changes)
		Settings.serverChanges(sctx, sctx.serverId).subscribe((settings) => changes.push([...settings.installedMods]))
		Reminders.register(sctx, async () => [`[hello] rolled on ${sctx.serverId}`])
		void (async () => {
			const matches = await MatchHistory.getRecentMatches(sctx)
			Db.run(
				sctx,
				SQL.insert(S.greetings).values({ serverId: sctx.serverId, text: PluginConfig.get(sctx).greeting, matches: matches.length }),
			)
			await AppEventsSys.emit(sctx, 'greeted', { serverId: sctx.serverId }, `hello plugin greeted ${sctx.serverId}`)
		})()
	})
}

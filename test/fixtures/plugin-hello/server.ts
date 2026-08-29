import { eq } from 'drizzle-orm'
import * as z from 'zod'

import * as CB from 'slm/models/constraint-builders'
import * as FB from 'slm/models/filter-builders'
import * as GV from 'slm/models/gen-vote'
import * as RBAC from 'slm/models/rbac'
import type * as P from 'slm/plugin'
import { defineTables, type PluginMigration } from 'slm/plugin'
import * as Commands from 'slm/plugin/commands'
import * as PluginConfig from 'slm/plugin/config'
import * as Rpc from 'slm/plugin/rpc.server'
import * as Servers from 'slm/plugin/servers'
import * as AppEventsSys from 'slm/systems/app-events'
import * as Discord from 'slm/systems/discord'
import * as Filters from 'slm/systems/filter-entity'
import * as LayerQueries from 'slm/systems/layer-queries'
import * as LayerQueue from 'slm/systems/layer-queue'
import * as MatchHistory from 'slm/systems/match-history'
import * as Rbac from 'slm/systems/rbac'
import * as SquadServer from 'slm/systems/squad-server'

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
const FilterInput = z.object({ id: z.string(), owner: z.string() })

export const router = {
	stats: os.input(z.object({})).handler(async () => ({ activations })),

	// An rpc procedure is reachable by anyone who may use the site, so one that acts on the server has to
	// authorize the caller itself. Reports who it saw, so the test can tell an allowed call from a refused one.
	whoAmI: os.input(z.object({})).handler(async ({ context }) => {
		const denial = await Rbac.checkCaller(context, RBAC.perm('squad-server:end-match', { serverId: context.serverId }))
		if (denial) return { code: 'err:permission-denied' as const, failures: denial.failures }
		return { code: 'ok' as const, discordId: String(context.user.discordId) }
	}),
	makeFilter: os.input(FilterInput).handler(async ({ context, input }) =>
		Filters.create(context, {
			id: input.id,
			name: 'Hello pool',
			description: null,
			filter: FB.and([FB.eq('Collection', 'OWI'), FB.notInValues('Gamemode', ['Seed', 'Training'])]),
			owner: BigInt(input.owner),
			alertMessage: null,
			emoji: null,
			invertedAlertMessage: null,
			invertedEmoji: null,
		}),
	),
	renameFilter: os
		.input(z.object({ id: z.string(), name: z.string() }))
		.handler(async ({ context, input }) => Filters.update(context, input.id, { name: input.name })),
	dropFilter: os.input(z.object({ id: z.string() })).handler(async ({ context, input }) => Filters.remove(context, input.id)),
	filterIds: os.input(z.object({})).handler(async () => Filters.list().map((f) => f.id)),

	// the filter the query is constrained by is one the plugin made itself, which is the pairing worth
	// covering: neither half is much use to a plugin without the other
	inFilter: os.input(z.object({ filterId: z.string() })).handler(async ({ context, input }) => {
		const res = await LayerQueries.query(context, {
			pageSize: 5,
			sort: null,
			constraints: [CB.filterEntity('pool', input.filterId)],
		})
		return res.code === 'ok' ? { code: 'ok' as const, total: res.totalCount, collections: res.layers.map((l) => l.Collection) } : res
	}),
	outOfPool: os
		.input(z.object({ filterId: z.string(), layerIds: z.array(z.string()) }))
		.handler(async ({ context, input }) =>
			LayerQueries.outOfPool(context, { layerIds: input.layerIds, constraints: [CB.filterEntity('pool', input.filterId)] }),
		),
	layersExist: os
		.input(z.object({ layerIds: z.array(z.string()) }))
		.handler(async ({ context, input }) => LayerQueries.exists(context, input.layerIds)),
	mapValues: os.input(z.object({})).handler(async ({ context }) => LayerQueries.componentValues(context, { column: 'Map' })),
	drawVote: os
		.input(z.object({ filterId: z.string(), seed: z.string(), presetLayerId: z.string() }))
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

	savedQueue: os.input(z.object({})).handler(async ({ context }) =>
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
		.input(z.object({ layerId: z.string() }))
		.handler(async ({ context, input }) => LayerQueue.editSaved(context, (entries) => [input.layerId, ...entries])),

	dropFirstLayer: os.input(z.object({})).handler(async ({ context }) => LayerQueue.editSaved(context, (entries) => entries.slice(1))),

	// resolves with the first event of `type` seen after subscribing, or null once `ms` has passed
	nextEvent: os.input(z.object({ type: z.string(), ms: z.number() })).handler(async ({ context, input }) => {
		return await new Promise<{ type: string } | null>((resolve) => {
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
		})
	}),

	endMatch: os.input(z.object({})).handler(async ({ context }) => SquadServer.endMatch(context)),

	postToDiscord: os
		.input(z.object({ channelId: z.string(), content: z.string() }))
		.handler(async ({ input }) => ({ enabled: Discord.isEnabled(), res: await Discord.postMessage(input.channelId, input.content) })),

	greetings: os.input(z.object({ serverId: z.string() })).handler(async function* ({ context, input }) {
		yield await context.db().select().from(S.greetings).where(eq(S.greetings.serverId, input.serverId))
	}),
}

export async function activate(ctx: P.Ctx<typeof manifest>) {
	activations++
	Rpc.register(ctx, router)

	// an in-game command, answering with its config and whatever was typed after the trigger, so a test can
	// tell the handler ran with the right ctx and the right arguments
	Commands.register(ctx, {
		name: 'hello',
		description: 'Says hello back.',
		triggers: ['hello'],
		allowedChats: ['admin'],
		usage: '[name]',
		handler: async (sctx, input) => {
			const denial = await Rbac.checkPlayer(sctx, input.player, RBAC.perm('squad-server:end-match', { serverId: sctx.serverId }))
			if (denial) return Rbac.describe(sctx, denial)
			return `${PluginConfig.get(sctx).greeting} ${input.text || 'nobody'} on ${sctx.serverId}`
		},
	})

	// runs once per managed server: writes a row proving the plugin reached its own table, a core
	// system (match history) and its config, all through shimmed slm/* imports
	Servers.setup(ctx, (sctx) => {
		void (async () => {
			const matches = await MatchHistory.getRecentMatches(sctx)
			await sctx
				.db()
				.insert(S.greetings)
				.values({ serverId: sctx.serverId, text: PluginConfig.get(sctx).greeting, matches: matches.length })
			await AppEventsSys.emit(sctx, 'greeted', { serverId: sctx.serverId }, `hello plugin greeted ${sctx.serverId}`)
		})()
	})
}

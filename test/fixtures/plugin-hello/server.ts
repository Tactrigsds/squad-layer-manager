import { eq } from 'drizzle-orm'
import * as z from 'zod'

import * as FB from 'slm/models/filter-builders'
import type * as P from 'slm/plugin'
import { defineTables, type PluginMigration } from 'slm/plugin'
import * as PluginConfig from 'slm/plugin/config'
import * as Rpc from 'slm/plugin/rpc.server'
import * as Servers from 'slm/plugin/servers'
import * as AppEventsSys from 'slm/systems/app-events'
import * as Filters from 'slm/systems/filter-entity'
import * as MatchHistory from 'slm/systems/match-history'

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
	greetings: os.input(z.object({ serverId: z.string() })).handler(async function* ({ context, input }) {
		yield await context.db().select().from(S.greetings).where(eq(S.greetings.serverId, input.serverId))
	}),
}

export async function activate(ctx: P.Ctx<typeof manifest>) {
	activations++
	Rpc.register(ctx, router)

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

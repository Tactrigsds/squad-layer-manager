import { eq } from 'drizzle-orm'
import { from } from 'rxjs'
// deliberately outside the api: proves a plugin can reach SLM's own modules, and gets the instance the
// app is running rather than a second copy
import * as SquadServer from 'slm-internal/systems/squad-server.server'
import * as z from 'zod'

import type * as P from 'slm/plugin'
import type { PluginMigration } from 'slm/plugin'
import * as PluginConfig from 'slm/plugin/config'
import * as Rpc from 'slm/plugin/rpc.server'
import * as Servers from 'slm/plugin/servers'
import * as AppEventsSys from 'slm/systems/app-events'
import * as MatchHistory from 'slm/systems/match-history'

import type manifest from './plugin.ts'
import * as S from './schema.ts'

export const migrations: PluginMigration[] = [
	{
		name: '0001_init',
		up: (db) => {
			db.exec(`CREATE TABLE IF NOT EXISTS p_hello_greetings (
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

export async function activate(ctx: P.Ctx<typeof manifest>) {
	activations++

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

	Rpc.handle(ctx, 'stats', z.object({}), async () => ({
		activations,
		// a second copy of the module would report 0 here
		managedServers: SquadServer.globalState.managedServers.size,
	}))

	Rpc.stream(ctx, 'greetings', z.object({ serverId: z.string() }), (sctx, input) =>
		from(sctx.db().select().from(S.greetings).where(eq(S.greetings.serverId, input.serverId))),
	)
}

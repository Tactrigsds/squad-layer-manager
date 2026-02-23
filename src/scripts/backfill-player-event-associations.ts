import * as Schema from '$root/drizzle/schema'
import * as CS from '@/models/context-shared'
import * as Config from '@/server/config.ts'
import * as DB from '@/server/db'
import * as Env from '@/server/env.ts'
import { baseLogger, ensureLoggerSetup } from '@/server/logger.ts'
import * as Cli from '@/systems/cli.server'
import * as E from 'drizzle-orm'

await Cli.ensureCliParsed()
Env.ensureEnvSetup()
ensureLoggerSetup()
await Config.ensureSetup()
await DB.setup()

const log = baseLogger
const ctx = DB.addPooledDb({ ...CS.init(), log })

const events = await ctx.db().select().from(Schema.serverEvents)

log.info(`Processing ${events.length} events`)

type Row = typeof Schema.playerEventAssociations.$inferInsert

const rows: Row[] = []

for (const event of events) {
	const data = (event.data as any)?.json
	if (!data) continue

	if (event.type === 'NEW_GAME' || event.type === 'RESET') {
		for (const player of (data.state?.players ?? [])) {
			const eosId = player?.ids?.eos
			if (eosId) rows.push({ serverEventId: event.id, playerId: eosId, assocType: 'game-participant' })
		}
	} else if (event.type === 'PLAYER_CONNECTED') {
		const eosId = data.player?.ids?.eos
		if (eosId) rows.push({ serverEventId: event.id, playerId: eosId, assocType: 'player' })
	} else if (event.type === 'PLAYER_DIED' || event.type === 'PLAYER_WOUNDED') {
		if (data.victim) rows.push({ serverEventId: event.id, playerId: data.victim, assocType: 'victim' })
		if (data.attacker) rows.push({ serverEventId: event.id, playerId: data.attacker, assocType: 'attacker' })
	} else if (typeof data.player === 'string') {
		rows.push({ serverEventId: event.id, playerId: data.player, assocType: 'player' })
	}
}

log.info(`Inserting ${rows.length} associations`)

for (let i = 0; i < rows.length; i += 500) {
	const batch = rows.slice(i, i + 500)
	await ctx.db().insert(Schema.playerEventAssociations).values(batch).onDuplicateKeyUpdate({ set: { assocType: E.sql`assocType` } })
}

log.info('Done')

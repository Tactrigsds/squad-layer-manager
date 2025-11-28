import * as Schema from '$root/drizzle/schema'
import * as SchemaModels from '$root/drizzle/schema.models'
import { assertNever } from '@/lib/type-guards'
import * as CHAT from '@/models/chat.models'
import * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as Config from '@/server/config.ts'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Env from '@/server/env.ts'
import { baseLogger, ensureLoggerSetup } from '@/server/logger.ts'
import * as Cli from '@/server/systems/cli.ts'
import * as E from 'drizzle-orm/expressions'
import fs from 'node:fs'
import superjson from 'superjson'

await Cli.ensureCliParsed()
Env.ensureEnvSetup()
ensureLoggerSetup()
await Config.ensureSetup()
await DB.setup()

const events = superjson.parse(fs.readFileSync('./prod/backup-events.json', 'utf-8')) as any[]
// console.log(events.slice(0, 5))

const ctx = DB.addPooledDb({ log: baseLogger })

await DB.runTransaction(ctx, async (ctx) => {
	await ctx.db().delete(Schema.serverEvents)

	for (let i = 0; i < events.length; i += 10) {
		const batch = events.slice(i, i + 10)
		await saveEvents(ctx, batch)
	}
})

async function saveEvents(ctx: CS.Log & C.Db, events: CHAT.Event[]) {
	const rows: SchemaModels.NewServerEvent[] = events.map(e => ({
		type: e.type,
		time: e.time,
		matchId: e.matchId,
		data: superjson.serialize(e),
	}))

	try {
		await ctx.db({ redactParams: true }).insert(Schema.serverEvents).values(rows)
	} catch (error) {
		console.error('Error saving events:', error)
	}
}

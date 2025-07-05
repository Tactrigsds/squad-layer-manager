import * as Schema from '$root/drizzle/schema'
import { assertNever } from '@/lib/type-guards'
import * as F from '@/models/filter.models'
import * as Config from '@/server/config.ts'
import * as DB from '@/server/db'
import * as Env from '@/server/env.ts'
import { baseLogger, ensureLoggerSetup } from '@/server/logger.ts'
import * as Cli from '@/server/systems/cli.ts'
import * as E from 'drizzle-orm/expressions'
import superjson from 'superjson'

await Cli.ensureCliParsed()
Env.ensureEnvSetup()
ensureLoggerSetup()
await Config.ensureSetup()
await DB.setup()

const ctx = DB.addPooledDb({ log: baseLogger })

await DB.runTransaction(ctx, async (ctx) => {
	for (const entity of await ctx.db().select().from(Schema.filters)) {
		const updated = transformFilterNode(entity.filter as F.FilterNode)

		await ctx.db().update(Schema.filters).set({ filter: updated }).where(E.eq(Schema.filters.id, entity.id))
	}

	function transformFilterNode(node: F.FilterNode): F.FilterNode {
		if (F.isBlockNode(node)) return { ...node, children: node.children.map(transformFilterNode) }

		switch (node.type) {
			case 'apply-filter':
				return node
			case 'comp':
				if (node.comp.column === 'Level') {
					node.comp.column = 'Map'
				}
				return node
			default:
				assertNever(node)
		}
	}

	for (const server of await ctx.db().select().from(Schema.servers)) {
		const dnrRules = (superjson.deserialize(server.settings as any) as any)?.queue?.generationPool?.doNotRepeatRules ?? []
		let modified = false
		for (const rule of dnrRules) {
			if (rule.field === 'Level') {
				rule.field = 'Map'
				modified = true
			}
		}
		if (!modified) continue
		await ctx.db().update(Schema.servers).set({ settings: superjson.serialize(server.settings) }).where(E.eq(Schema.servers.id, server.id))
	}
})

process.exit(0)

import * as Schema from '$root/drizzle/schema'
import { assertNever } from '@/lib/typeGuards'
import * as M from '@/models'
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
await Config.ensureConfigSetup()
await DB.setupDatabase()

const ctx = DB.addPooledDb({ log: baseLogger })

await DB.runTransaction(ctx, async (ctx) => {
	for (const entity of await ctx.db().select().from(Schema.filters)) {
		const updated = transformFilterNode(entity.filter as M.FilterNode)

		await ctx.db().update(Schema.filters).set({ filter: updated }).where(E.eq(Schema.filters.id, entity.id))
	}

	function transformFilterNode(node: M.FilterNode): M.FilterNode {
		if (M.isBlockNode(node)) return { ...node, children: node.children.map(transformFilterNode) }

		switch (node.type) {
			case 'apply-filter':
				return node
			case 'comp':
				// @ts-expect-error idc
				if (node.comp.column === 'SubFac_1') {
					// @ts-expect-error idc
					node.comp.column = 'Unit_1'
				} // @ts-expect-error idc
				else if (node.comp.column === 'SubFac_2') {
					// @ts-expect-error idc
					node.comp.column = 'Unit_2'
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
			if (rule.field === 'Faction') {
				rule.field = 'Unit'
				modified = true
			}
		}
		if (!modified) continue
		await ctx.db().update(Schema.servers).set({ settings: superjson.serialize(server.settings) }).where(E.eq(Schema.servers.id, server.id))
	}
})

process.exit(0)

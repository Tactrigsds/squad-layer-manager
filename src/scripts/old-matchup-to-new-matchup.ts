import * as Schema from '$root/drizzle/schema'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import * as FB from '@/models/filter-builders'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as Config from '@/server/config.ts'
import * as DB from '@/server/db'
import * as Env from '@/server/env.ts'
import { baseLogger, ensureLoggerSetup } from '@/server/logger.ts'
import * as Cli from '@/systems/cli.server'
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
			case 'allow-matchups':
				return node
			case 'comp': {
				let masks: F.FactionMask[][]
				let mode: F.FactionMaskMode
				const comp = node.comp as any
				console.log(comp.code)
				if (comp.code !== 'has') return node
				const values = comp.values.filter((v: any) => v !== null && v !== undefined)
				if (comp.column === 'FactionMatchup') {
					masks = values.map((v: any) => [{ faction: [v] }])
					mode = values.length > 1 ? 'split' : 'either'
				} else if (comp.column === 'SubFacMatchup') {
					masks = values.map((v: any) => [{ unit: [v] }])
					mode = values.length > 1 ? 'split' : 'either'
				} else {
					masks = values.map((v: string) => {
						const [faction, unitAbbrev] = v.split('-')
						const unit = unitAbbrev ? Obj.revLookup(L.StaticLayerComponents.unitAbbreviations, unitAbbrev) : undefined
						return [{ faction: faction ? [faction] : undefined, unit: unit ? [unit] : undefined }]
					})
					mode = comp.values.length > 1 ? 'split' : 'either'
				}
				const newComp = FB.allowMatchups(mode, masks)
				console.log(JSON.stringify(newComp, null, 2))
				return F.FilterNodeSchema.parse(newComp)
			}
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

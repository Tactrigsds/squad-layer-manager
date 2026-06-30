import * as Schema from '$root/drizzle/schema'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import * as GS from '@/models/global-settings.models'
import * as RBAC from '@/rbac.models'
import * as CS from '@/models/context-shared'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Rbac from '@/systems/rbac.server'
import * as Rx from 'rxjs'
import { z } from 'zod'

const module = initModule('global-settings')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

export let GLOBAL_SETTINGS!: GS.GlobalSettings
export const update$ = new Rx.ReplaySubject<GS.GlobalSettings>(1)

export async function setup(ctx: C.Db) {
	log = module.getLogger()
	const rows = await ctx.db().select().from(Schema.globalSettings)
	if (rows.length === 0) {
		const defaults = GS.GlobalSettingsSchema.parse({})
		await ctx.db().insert(Schema.globalSettings).values(superjsonify(Schema.globalSettings, { id: 1, settings: defaults }))
		GLOBAL_SETTINGS = defaults
		log.info('Created default global settings row')
	} else {
		const raw = unsuperjsonify(Schema.globalSettings, rows[0]) as any
		const parseRes = GS.GlobalSettingsSchema.safeParse(raw.settings)
		if (!parseRes.success) {
			log.warn(parseRes.error, 'Global settings in DB failed validation, using defaults for invalid fields')
			GLOBAL_SETTINGS = GS.GlobalSettingsSchema.parse(raw.settings ?? {})
		} else {
			GLOBAL_SETTINGS = parseRes.data
		}
		log.info('Loaded global settings from DB')
	}
	update$.next(GLOBAL_SETTINGS)
}

async function persistSettings(ctx: C.Db) {
	await ctx.db({ redactParams: true })
		.update(Schema.globalSettings)
		.set(superjsonify(Schema.globalSettings, { settings: GLOBAL_SETTINGS }))
}

export const orpcRouter = {
	watchSettings: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ context: _ctx, signal }) {
		const ctx = DB.addPooledDb(_ctx as any)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-global-settings'))
		if (denyRes) { yield denyRes; return }
		yield* toAsyncGenerator(update$.pipe(withAbortSignal(signal!)))
	}),

	updateSettings: orpcBase
		.meta({ type: 'mutation' })
		.input(z.record(z.string(), z.unknown()))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-global-settings'))
			if (denyRes) return denyRes

			const merged = { ...GLOBAL_SETTINGS, ...input }
			const parseRes = GS.GlobalSettingsSchema.safeParse(merged)
			if (!parseRes.success) {
				return { code: 'err:invalid-settings' as const, message: parseRes.error.message }
			}

			GLOBAL_SETTINGS = parseRes.data
			update$.next(GLOBAL_SETTINGS)
			await persistSettings(ctx)
			log.info('Global settings updated')
			return { code: 'ok' as const }
		}),
}

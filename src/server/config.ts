import * as Paths from '$root/paths'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import { ParsedBigIntSchema } from '@/lib/zod'
import * as LQY from '@/models/layer-queries.models.ts'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base.ts'
import * as Cli from '@/systems/cli.server'
import * as LayerDb from '@/systems/layer-db.server'
import * as fsPromise from 'fs/promises'
import stringifyCompact from 'json-stringify-pretty-compact'
import { parse as parseJsonc } from 'jsonc-parser'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as Rx from 'rxjs'
import { z } from 'zod'
import * as Env from './env.ts'

// deploy-time constants only: the JSONC config file and env vars. Runtime, admin-editable state lives in settings.server.ts.
export const ConfigSchema = z.object({
	'$schema': z.string().optional(),
	homeDiscordGuildId: ParsedBigIntSchema,
	repoUrl: z.url().optional().describe('URL of the repository'),
	issuesUrl: z.url().optional().describe('URL of the issues page'),
	// role/permission configuration now lives in admin-editable global settings (see GlobalSettingsSchema.rbac).
	// these two arrays are the deploy-time bootstrap that always receives every permission, so an admin can never be locked out.
	superUsers: z.array(ParsedBigIntSchema).prefault([]).describe('Discord user ids that are always granted all permissions'),
	superRoles: z.array(ParsedBigIntSchema).prefault([]).describe('Discord role ids whose members are always granted all permissions'),
	layerTable: LQY.LayerTableConfigSchema.prefault({
		orderedColumns: [
			{ name: 'id', visible: false },
			{ name: 'Size' },
			{ name: 'Layer' },
			{ name: 'Map', visible: false },
			{ name: 'Gamemode', visible: false },
			{ name: 'LayerVersion', visible: false },

			{ name: 'Faction_1' },
			{ name: 'Unit_1' },
			{ name: 'Alliance_1', visible: false },

			{ name: 'Faction_2' },
			{ name: 'Unit_2' },
			{ name: 'Alliance_2', visible: false },
		],
		defaultSortBy: { type: 'random' },
	}),
})

type Config = z.infer<typeof ConfigSchema>

export let CONFIG!: Config

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.squadcalc })
export let ENV!: ReturnType<typeof envBuilder>

export async function ensureSetup() {
	if (CONFIG) return

	ENV = envBuilder()
	if (ENV.NODE_ENV === 'development') {
		await generateConfigJsonSchema()
	}

	const raw = await fs.readFile(Cli.options!.config, 'utf-8')

	const rawObj = parseJsonc(raw)
	const parseRes = ConfigSchema.safeParse(rawObj)
	if (!parseRes.success) {
		throw new Error(`Configuration file ${Cli.options!.config} is invalid`, { cause: parseRes.error })
	}
	CONFIG = parseRes.data
}

async function generateConfigJsonSchema() {
	const schemaPath = path.join(Paths.ASSETS, 'config-schema.json')
	const schema = z.toJSONSchema(ConfigSchema, { io: 'input' })
	await fsPromise.writeFile(schemaPath, stringifyCompact(schema))
	console.log('Wrote generated config schema to %s', schemaPath)
}

// ============================== public, static config (never changes for the lifetime of the process) ==============================

export type PublicConfig = {
	isProduction: boolean
	PUBLIC_GIT_BRANCH: string
	PUBLIC_GIT_SHA: string
	PUBLIC_SQUADCALC_URL: string
	repoUrl: string | undefined
	issuesUrl: string | undefined
	layerTable: typeof CONFIG.layerTable
	extraColumnsConfig: typeof LayerDb.LAYER_DB_CONFIG
	layersVersion: string
}

export type PublicConfigForClient = PublicConfig & { wsClientId: string }

const publicConfig$ = new Rx.ReplaySubject<PublicConfig>(1)

// called once from main.ts, after LayerDb.setup() has resolved
export function pushPublicConfig() {
	publicConfig$.next({
		isProduction: ENV.NODE_ENV === 'production',
		PUBLIC_GIT_BRANCH: ENV.PUBLIC_GIT_BRANCH,
		PUBLIC_GIT_SHA: ENV.PUBLIC_GIT_SHA,
		PUBLIC_SQUADCALC_URL: ENV.PUBLIC_SQUADCALC_URL,
		repoUrl: CONFIG.repoUrl,
		issuesUrl: CONFIG.issuesUrl,
		layerTable: CONFIG.layerTable,
		extraColumnsConfig: LayerDb.LAYER_DB_CONFIG,
		layersVersion: LayerDb.layersVersion,
	})
}

const module = initModule('config')
const orpcBase = getOrpcBase(module)

export const router = {
	watchConfig: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ context: ctx, signal }) {
		yield* toAsyncGenerator(
			publicConfig$.pipe(
				Rx.map((base): PublicConfigForClient => ({ ...base, wsClientId: ctx.wsClientId })),
				withAbortSignal(signal!),
			),
		)
	}),
}

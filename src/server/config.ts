import * as Paths from '$root/paths'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import * as Obj from '@/lib/object.ts'
import { ParsedBigIntSchema } from '@/lib/zod'
import * as GS from '@/models/global-settings.models.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import * as RBAC from '@/rbac.models'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base.ts'
import * as Cli from '@/systems/cli.server'
import * as GlobalSettings from '@/systems/global-settings.server'
import * as LayerDb from '@/systems/layer-db.server'
import * as Rx from 'rxjs'
import * as fsPromise from 'fs/promises'
import stringifyCompact from 'json-stringify-pretty-compact'
import { parse as parseJsonc } from 'jsonc-parser'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import * as Env from './env.ts'

export const ConfigSchema = z.object({
	'$schema': z.string().optional(),
	homeDiscordGuildId: ParsedBigIntSchema,
	repoUrl: z.url().optional().describe('URL of the repository'),
	issuesUrl: z.url().optional().describe('URL of the issues page'),
	globalRolePermissions: z
		.record(z.string(), z.array(RBAC.GLOBAL_PERMISSION_TYPE_EXPRESSION))
		.describe('Configures what roles have what permissions. (globally scoped permissions only)'),
	roleAssignments: z.object({
		'discord-role': z.array(z.object({ discordRoleId: ParsedBigIntSchema, roles: z.array(RBAC.UserDefinedRoleIdSchema) })).optional(),
		'discord-user': z.array(z.object({ userId: ParsedBigIntSchema, roles: z.array(RBAC.UserDefinedRoleIdSchema) })).optional(),
		'discord-server-member': z.array(z.object({ roles: z.array(RBAC.UserDefinedRoleIdSchema) })).optional(),
	}),
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
let ENV!: ReturnType<typeof envBuilder>

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

export type ServerEntry = {
	id: string
	displayName: string
	defaultServer: boolean
	enabled: boolean
	navLinks?: { label: string; url: string }[]
}

type PublicConfigBase = {
	layerQueue: { lowQueueWarningThreshold: number; maxQueueSize: number }
	topBarColor: GS.GlobalSettings['topBarColor']
	playerFlagColorHierarchy: GS.GlobalSettings['playerFlagColorHierarchy']
	layerTable: typeof CONFIG.layerTable
	isProduction: boolean
	PUBLIC_GIT_BRANCH: string
	PUBLIC_GIT_SHA: string
	PUBLIC_SQUADCALC_URL: string
	repoUrl: string | undefined
	issuesUrl: string | undefined
	navLinks: GS.GlobalSettings['navLinks']
	extraColumnsConfig: typeof LayerDb.LAYER_DB_CONFIG
	chat: GS.GlobalSettings['chat']
	layersVersion: string
	commands: GS.GlobalSettings['commands']
	commandPrefix: string
	vote: { voteDuration: number; voteDisplayProps: GS.GlobalSettings['vote']['voteDisplayProps'] }
	servers: ServerEntry[]
	playerFlagGroupings: GS.GlobalSettings['playerFlagGroupings']
}

export type PublicConfig = PublicConfigBase & { wsClientId: string }

const publicConfig$ = new Rx.ReplaySubject<PublicConfigBase>(1)

function buildPublicConfigBase(): PublicConfigBase {
	const GS = GlobalSettings.GLOBAL_SETTINGS
	return {
		layerQueue: Obj.selectProps(GS.layerQueue, ['lowQueueWarningThreshold', 'maxQueueSize']),
		topBarColor: GS.topBarColor,
		playerFlagColorHierarchy: GS.playerFlagColorHierarchy,
		layerTable: CONFIG.layerTable,
		isProduction: ENV.NODE_ENV === 'production',
		PUBLIC_GIT_BRANCH: ENV.PUBLIC_GIT_BRANCH,
		PUBLIC_GIT_SHA: ENV.PUBLIC_GIT_SHA,
		PUBLIC_SQUADCALC_URL: ENV.PUBLIC_SQUADCALC_URL,
		repoUrl: CONFIG.repoUrl,
		issuesUrl: CONFIG.issuesUrl,
		navLinks: GS.navLinks,
		extraColumnsConfig: LayerDb.LAYER_DB_CONFIG,
		chat: GS.chat,
		layersVersion: LayerDb.layersVersion,
		commands: GS.commands,
		commandPrefix: GS.commandPrefix,
		vote: {
			voteDuration: GS.vote.voteDuration,
			voteDisplayProps: GS.vote.voteDisplayProps,
		},
		servers: GS.servers.map((server): ServerEntry => ({
			id: server.id,
			displayName: server.displayName,
			defaultServer: server.defaultServer,
			enabled: server.enabled,
			navLinks: server.navLinks,
		})),
		playerFlagGroupings: GS.playerFlagGroupings,
	}
}

export function pushPublicConfig() {
	publicConfig$.next(buildPublicConfigBase())
}

// Called from main.ts after GlobalSettings.setup(); also subscribes to future GlobalSettings changes.
export function setupPublicConfig() {
	pushPublicConfig()
	GlobalSettings.update$.subscribe(() => pushPublicConfig())
}

async function generateConfigJsonSchema() {
	const schemaPath = path.join(Paths.ASSETS, 'config-schema.json')
	const schema = z.toJSONSchema(ConfigSchema, { io: 'input' })
	await fsPromise.writeFile(schemaPath, stringifyCompact(schema))
	console.log('Wrote generated config schema to %s', schemaPath)
}

const module = initModule('config')
const orpcBase = getOrpcBase(module)

export const router = {
	watchPublicConfig: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ context: ctx, signal }) {
		yield* toAsyncGenerator(
			publicConfig$.pipe(
				Rx.map(base => ({ ...base, wsClientId: ctx.wsClientId })),
				withAbortSignal(signal!),
			),
		)
	}),
}

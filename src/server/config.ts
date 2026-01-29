import * as Paths from '$root/paths'
import * as Arr from '@/lib/array'
import * as DH from '@/lib/display-helpers.ts'
import * as Obj from '@/lib/object.ts'
import { BasicStrNoWhitespace, HumanTime, ParsedBigIntSchema } from '@/lib/zod'
import * as BAL from '@/models/balance-triggers.models.ts'
import * as CHAT from '@/models/chat.models.ts'
import * as CMD from '@/models/command.models.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import * as SS from '@/models/server-state.models.ts'
import * as SM from '@/models/squad.models.ts'
import * as RBAC from '@/rbac.models'
import orpcBase from '@/server/orpc-base.ts'
import * as Cli from '@/systems/cli.server'
import * as LayerDb from '@/systems/layer-db.server'
import * as fsPromise from 'fs/promises'
import stringifyCompact from 'json-stringify-pretty-compact'
import { parse as parseJsonc } from 'jsonc-parser'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import * as Env from './env.ts'

export const ConfigSchema = z.object({
	'$schema': z.string(),
	topBarColor: z.string().prefault('green').nullable().describe('this should be set to null for production'),
	warnPrefix: z.string().nullable().prefault('SLM: ').describe('Prefix to use for warnings'),
	postRollAnnouncementsTimeout: HumanTime.prefault('5m').describe('How long to wait before sending post-roll reminders'),
	fogOffDelay: HumanTime.prefault('25s').describe('the delay before fog is automatically turned off'),
	servers: z.array(
		z.object({
			id: z.string().describe('ID of the server'),
			displayName: z.string().describe('Display name of the server'),
			adminListSources: z.array(z.string()).optional().describe(
				'specify which sources to include from adminListSources. by default will include all sources',
			),
			adminIdentifyingPermissions: z.array(SM.PLAYER_PERM).prefault(['canseeadminchat']).describe(
				"what ingame permissions identify an admin for SLM's purposes",
			),
			enabled: z.boolean().prefault(true).describe('Whether the server is enabled'),
			connections: SS.ServerConnectionSchema,
			remindersAndAnnouncementsEnabled: z.boolean().prefault(true).describe('Whether reminders/annoucements for admins are enabled'),
			defaultServer: z.boolean().default(false),
		}),
	).refine((servers) => {
		const defaultServerCount = servers.filter((server) => server.defaultServer).length
		return defaultServerCount <= 1
	}, 'There must be at most one default server'),
	chat: CHAT.ChatConfigSchema.prefault({}),
	layerQueue: z.object({
		lowQueueWarningThreshold: z
			.number()
			.positive()
			.prefault(1)
			.describe('Number of layers in the queue to trigger a low queue size warning'),
		adminQueueReminderInterval: HumanTime.prefault('10m').describe(
			'How often to remind admins to maintain the queue. Low queue warnings happen half as often.',
		),
		maxQueueSize: z.int().min(1).max(100).prefault(20).describe('Maximum number of layers that can be in the queue'),
	}),
	vote: z.object({
		voteDuration: HumanTime.prefault('120s').describe('Duration of a vote'),
		startVoteReminderThreshold: HumanTime.prefault('20m').describe('How far into a match to start reminding admins to start a vote'),
		voteReminderInterval: HumanTime.prefault('30s').describe('How often to remind users to vote'),
		internalVoteReminderInterval: HumanTime.prefault('15s').describe('How often to remind amdins to vote in an internal vote'),
		autoStartVoteDelay: HumanTime.prefault('20m').nullable().describe(
			'Delay before autostarting a vote from the start of the current match. Set to null to disable auto-starting votes',
		),
		voteDisplayProps: z.array(DH.LAYER_DISPLAY_PROP).prefault(['map', 'gamemode']).describe(
			'What parts of a layer setup should be displayed',
		),
		finalVoteReminder: HumanTime.prefault('10s').describe('How far in advance the final vote reminder should be sent'),
		maxNumVoteChoices: z.int().min(1).max(50).prefault(5).describe('Maximum number of choices allowed in a vote'),
	}),
	squadServer: z.object({
		sftpPollInterval: HumanTime.prefault('1s'),
		sftpReconnectInterval: HumanTime.prefault('5s'),
	}),
	steamLinkCodeExpiry: HumanTime.prefault('15m').describe('Duration of a steam account link code'),
	// we have to ues .optional instead of .default here to avoid circular type definitions
	commandPrefix: BasicStrNoWhitespace,
	commands: CMD.AllCommandConfigSchema,
	adminListSources: z.record(z.string(), SM.AdminListSourceSchema),
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
	// TODO write refinement to make sure that all roles referenced in role assignments are defined in globalRolePermissions

	balanceTriggerLevels: z.partialRecord(BAL.TRIGGER_IDS, BAL.TRIGGER_LEVEL)
		.prefault({ '150x2': 'warn' })
		.describe('Configures the trigger warning levels for balance calculations'),

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

	// -------- no duplicate command strings --------
	const allStrings = new Set<string>()
	for (const [cmdName, cmdConfig] of Object.entries(CONFIG.commands)) {
		for (const str of cmdConfig.strings) {
			if (allStrings.has(str)) {
				throw new Error(`Error while parsing configuration: Duplicate command string "${str}" found in command "${cmdName}"`)
			}
			allStrings.add(str)
		}
	}

	// -------- make sure admin sources are referenced correctly, and set defaults --------
	const sourceKeys = Object.keys(CONFIG.adminListSources)
	for (const server of CONFIG.servers) {
		if (!server.adminListSources) {
			server.adminListSources = sourceKeys
		}
		const missingKeys = Arr.missing(server.adminListSources, sourceKeys)
		if (missingKeys.length > 0) {
			throw new Error(
				`Error while parsing configuration: Server "${server.id}" references unknown admin sources: ${missingKeys.join(', ')}`,
			)
		}
	}

	if (ENV.NODE_ENV === 'production') {
		for (const server of CONFIG.servers) {
			if (server.connections.logs.type === 'log-receiver' && server.connections.logs.token === 'dev') {
				throw new Error(`Development token for ${server.id}:log-receiver used in production at server`)
			}
		}
	}
}

export type PublicConfig = ReturnType<typeof getPublicConfig>
export type ServerEntry = {
	id: string
	displayName: string
	defaultServer: boolean
}

// we also include public env variables here and the websocket client id for expediency
export function getPublicConfig(wsClientId: string) {
	return {
		...Obj.selectProps(CONFIG, ['layerQueue', 'vote', 'topBarColor', 'layerTable']),
		isProduction: ENV.NODE_ENV === 'production',
		PUBLIC_GIT_BRANCH: ENV.PUBLIC_GIT_BRANCH,
		PUBLIC_GIT_SHA: ENV.PUBLIC_GIT_SHA,
		PUBLIC_SQUADCALC_URL: ENV.PUBLIC_SQUADCALC_URL,
		repoUrl: CONFIG.repoUrl,
		issuesUrl: CONFIG.issuesUrl,
		extraColumnsConfig: LayerDb.LAYER_DB_CONFIG,
		chat: CONFIG.chat,
		layersVersion: LayerDb.layersVersion,
		commands: CONFIG.commands,
		commandPrefix: CONFIG.commandPrefix,
		vote: {
			voteDuration: CONFIG.vote.voteDuration,
			voteDisplayProps: CONFIG.vote.voteDisplayProps,
		},
		servers: CONFIG.servers.filter(s => s.enabled).map((server): ServerEntry => ({
			id: server.id,
			displayName: server.displayName,
			defaultServer: server.defaultServer,
		})),

		wsClientId,
	}
}

async function generateConfigJsonSchema() {
	const schemaPath = path.join(Paths.ASSETS, 'config-schema.json')
	const schema = z.toJSONSchema(ConfigSchema, { io: 'input' })
	await fsPromise.writeFile(schemaPath, stringifyCompact(schema))
	console.log('Wrote generated config schema to %s', schemaPath)
}

export const router = {
	getPublicConfig: orpcBase.handler(({ context: ctx }) => {
		return getPublicConfig(ctx.wsClientId)
	}),
}

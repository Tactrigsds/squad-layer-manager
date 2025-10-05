import * as DH from '@/lib/display-helpers.ts'
import * as Obj from '@/lib/object.ts'
import { BasicStrNoWhitespace, HumanTime, ParsedBigIntSchema } from '@/lib/zod'
import * as BAL from '@/models/balance-triggers.models.ts'
import * as CMD from '@/models/command.models.ts'
import * as LQY from '@/models/layer-queries.models.ts'
import * as SS from '@/models/server-state.models.ts'
import * as SM from '@/models/squad.models.ts'
import * as RBAC from '@/rbac.models'
import * as Paths from '@/server/paths'
import * as Cli from '@/server/systems/cli.ts'
import * as LayerDb from '@/server/systems/layer-db.server.ts'
import * as fsPromise from 'fs/promises'
import stringifyCompact from 'json-stringify-pretty-compact'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import zodToJsonSchema from 'zod-to-json-schema'
import * as Env from './env.ts'

export const ConfigSchema = z.object({
	topBarColor: z.string().default('green').nullable().describe('this should be set to null for production'),
	warnPrefix: z.string().nullable().default('SLM: ').describe('Prefix to use for warnings'),
	postRollAnnouncementsTimeout: HumanTime.default('5m').describe('How long to wait before sending post-roll reminders'),
	fogOffDelay: HumanTime.default('25s').describe('the delay before fog is automatically turned off'),
	servers: z.array(
		z.object({
			id: z.string().describe('ID of the server'),
			displayName: z.string().describe('Display name of the server'),
			enabled: z.boolean().default(true).describe('Whether the server is enabled'),
			connections: SS.ServerConnectionSchema,
		}),
	).transform(servers => servers.filter(server => server.enabled)),
	layerQueue: z.object({
		lowQueueWarningThreshold: z
			.number()
			.positive()
			.default(1)
			.describe('Number of layers in the queue to trigger a low queue size warning'),
		adminQueueReminderInterval: HumanTime.default('10m').describe(
			'How often to remind admins to maintain the queue. Low queue warnings happen half as often.',
		),
		maxQueueSize: z.number().int().min(1).max(100).default(20).describe('Maximum number of layers that can be in the queue'),
	}),
	vote: z.object({
		voteDuration: HumanTime.default('120s').describe('Duration of a vote'),
		startVoteReminderThreshold: HumanTime.default('20m').describe('How far into a match to start reminding admins to start a vote'),
		voteReminderInterval: HumanTime.default('45s').describe('How often to remind users to vote'),
		autoStartVoteDelay: HumanTime.default('20m').nullable().describe(
			'Delay before autostarting a vote from the start of the current match. Set to null to disable auto-starting votes',
		),
		voteDisplayProps: z.array(DH.LAYER_DISPLAY_PROP).default(['map', 'gamemode']).describe(
			'What parts of a layer setup should be displayed',
		),
		finalVoteReminder: HumanTime.default('10s').describe('How far in advance the final vote reminder should be sent'),
		maxNumVoteChoices: z.number().int().min(1).max(50).default(5).describe('Maximum number of choices allowed in a vote'),
	}),
	squadServer: z.object({
		sftpPollInterval: HumanTime.default('5s'),
		sftpReconnectInterval: HumanTime.default('10s'),
	}),
	steamLinkCodeExpiry: HumanTime.default('15m').describe('Duration of a steam account link code'),
	// we have to ues .optional instead of .default here to avoid circular type definitions
	commandPrefix: BasicStrNoWhitespace,
	commands: CMD.AllCommandConfigSchema,

	adminListSources: z.array(SM.AdminListSourceSchema),
	adminListAdminRole: z.string().describe("The role in the adminlist which identifies an admin for SLM's purposes"),
	homeDiscordGuildId: ParsedBigIntSchema,
	globalRolePermissions: z
		.record(z.array(RBAC.GLOBAL_PERMISSION_TYPE_EXPRESSION))
		.describe('Configures what roles have what permissions. (globally scoped permissions only)'),
	roleAssignments: z.object({
		'discord-role': z.array(z.object({ discordRoleId: ParsedBigIntSchema, roles: z.array(RBAC.RoleSchema) })).optional(),
		'discord-user': z.array(z.object({ userId: ParsedBigIntSchema, roles: z.array(RBAC.RoleSchema) })).optional(),
		'discord-server-member': z.array(z.object({ roles: z.array(RBAC.RoleSchema) })).optional(),
	}),
	// TODO write refinement to make sure that all roles referenced in role assignments are defined in globalRolePermissions

	balanceTriggerLevels: z.record(BAL.TRIGGER_IDS, BAL.TRIGGER_LEVEL)
		.default({ '150x2': 'warn' })
		.describe('Configures the trigger warning levels for balance calculations'),

	layerTable: LQY.LayerTableConfigSchema.default({
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

export let CONFIG!: Config

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.squadcalc })
let ENV!: ReturnType<typeof envBuilder>

export async function ensureSetup() {
	if (CONFIG) return

	ENV = envBuilder()
	if (ENV.NODE_ENV === 'development') {
		await generateConfigJsonSchema()
	}

	const raw = await fs.readFile(Cli.options.config, 'utf-8')
	const rawObj = JSON.parse(raw)
	CONFIG = ConfigSchema.parse(rawObj)

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
}

export type PublicConfig = ReturnType<typeof getPublicConfig>
export type ServerEntry = {
	id: string
	displayName: string
}

// we also include public env variables here for expediency
export function getPublicConfig() {
	return {
		...Obj.selectProps(CONFIG, ['layerQueue', 'vote', 'topBarColor', 'layerTable']),
		isProduction: ENV.NODE_ENV === 'production',
		PUBLIC_GIT_BRANCH: ENV.PUBLIC_GIT_BRANCH,
		PUBLIC_GIT_SHA: ENV.PUBLIC_GIT_SHA,
		PUBLIC_SQUADCALC_URL: ENV.PUBLIC_SQUADCALC_URL,
		extraColumnsConfig: LayerDb.LAYER_DB_CONFIG,
		commands: CONFIG.commands,
		commandPrefix: CONFIG.commandPrefix,
		servers: CONFIG.servers.map((server): ServerEntry => ({
			id: server.id,
			displayName: server.displayName,
		})),
	}
}

async function generateConfigJsonSchema() {
	const schemaPath = path.join(Paths.ASSETS, 'config-schema.json')
	const schema = zodToJsonSchema(ConfigSchema.extend({ ['$schema']: z.string() }))
	await fsPromise.writeFile(schemaPath, stringifyCompact(schema))
	console.log('Wrote generated config schema to %s', schemaPath)
}

export type Config = z.infer<typeof ConfigSchema>

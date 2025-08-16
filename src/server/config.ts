import { selectProps } from '@/lib/object.ts'
import { HumanTime, ParsedBigIntSchema } from '@/lib/zod'
import * as BAL from '@/models/balance-triggers.models.ts'
import * as LQY from '@/models/layer-queries.models.ts'
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

const StrNoWhitespace = z.string().regex(/^\S+$/, {
	message: 'Must not contain whitespace',
})

export type CommandConfig = {
	strings: string[]
	scopes: SM.CommandScope[]
	enabled: boolean
}

function CommandConfigSchema(command: CommandId) {
	return z.object({
		strings: z.array(StrNoWhitespace).default(COMMAND_DEFAULTS[command].strings).describe(
			'Command strings that trigger this command when prefixed with the command prefix',
		),
		scopes: z.array(SM.COMMAND_SCOPES).default(COMMAND_DEFAULTS[command].scopes).describe(COMMAND_DESCRIPTIONS[command]),
		enabled: z.boolean().default(COMMAND_DEFAULTS[command].enabled),
	}).describe(COMMAND_DESCRIPTIONS[command]).default(COMMAND_DEFAULTS[command])
}

export type CommandId = 'help' | 'startVote' | 'abortVote' | 'showNext' | 'enableSlmUpdates' | 'disableSlmUpdates' | 'getSlmUpdatesEnabled'

type CommandConfigs = Record<CommandId, CommandConfig>

export const COMMAND_DESCRIPTIONS: Record<CommandId, string> = {
	help: 'Display help information',
	startVote: 'Start a new vote',
	abortVote: 'Abort the current vote',
	showNext: 'Show the next item in the queue',
	enableSlmUpdates: 'Enable updates from Squad Layer Manager',
	disableSlmUpdates: 'Disable updates from Squad Layer Manager',
	getSlmUpdatesEnabled: 'Get the status of updates from Squad Layer Manager',
}

const COMMAND_DEFAULTS: CommandConfigs = {
	help: {
		scopes: ['admin'],
		strings: ['help', 'h'],
		enabled: true,
	},
	startVote: {
		scopes: ['admin'],
		strings: ['startvote', 'sv'],
		enabled: true,
	},
	abortVote: {
		scopes: ['admin'],
		strings: ['abortvote', 'av'],
		enabled: true,
	},
	showNext: {
		scopes: ['admin'],
		strings: ['shownext', 'sn'],
		enabled: true,
	},
	enableSlmUpdates: {
		scopes: ['admin'],
		strings: ['enable-slm'],
		enabled: true,
	},
	disableSlmUpdates: {
		scopes: ['admin'],
		strings: ['disable-slm'],
		enabled: true,
	},
	getSlmUpdatesEnabled: {
		scopes: ['admin'],
		strings: ['get-slm-status'],
		enabled: true,
	},
}

export const ConfigSchema = z.object({
	serverId: z.string().min(1).max(256),
	serverDisplayName: z.string().min(1).max(256),
	commandPrefix: StrNoWhitespace,
	topBarColor: z.string().default('#033e03').nullable().describe('this should be set to null for production'),
	warnPrefix: z.string().optional().default('SLM: ').describe('Prefix to use for warnings'),
	defaults: z.object({
		voteDuration: HumanTime.default('120s').describe('Duration of a vote'),
	}),
	// we have to ues .optional instead of .default here to avoid circular type definitions
	commands: z.object({
		help: CommandConfigSchema('help'),
		startVote: CommandConfigSchema('startVote'),
		abortVote: CommandConfigSchema('abortVote'),
		showNext: CommandConfigSchema('showNext'),
		enableSlmUpdates: CommandConfigSchema('enableSlmUpdates'),
		disableSlmUpdates: CommandConfigSchema('disableSlmUpdates'),
	}).default(COMMAND_DEFAULTS),
	reminders: z.object({
		lowQueueWarningThreshold: z
			.number()
			.positive()
			.default(2)
			.describe('Number of layers in the queue to trigger a low queue size warning'),
		adminQueueReminderInterval: HumanTime.default('10m').describe(
			'How often to remind admins to maintain the queue. Low queue warnings happen half as often.',
		),
		voteReminderInterval: HumanTime.default('45s').describe('How often to remind users to vote'),
		startVoteReminderThreshold: HumanTime.default('20m').describe('How far into a match to start reminding admins to start a vote'),
		finalVote: HumanTime.default('10s').describe('How far in advance the final vote reminder should be sent'),
		postRollAnnouncementsTimeout: HumanTime.default('5m').describe('How long to wait before sending post-roll reminders'),
	}).default({}),
	maxQueueSize: z.number().int().min(1).max(100).default(20).describe('Maximum number of layers that can be in the queue'),
	maxNumVoteChoices: z.number().int().min(1).max(50).default(5).describe('Maximum number of choices allowed in a vote'),
	fogOffDelay: HumanTime.default('25s').describe('the delay before fog is automatically turned off'),

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
		defaultSortBy: { type: 'column', sortBy: 'Layer', sortDirection: 'ASC' },
	}),
})

export let CONFIG!: Config

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })
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

// we also include public env variables here for expediency
export function getPublicConfig() {
	return {
		...selectProps(CONFIG, ['maxQueueSize', 'defaults', 'maxQueueSize', 'topBarColor', 'layerTable']),
		isProduction: ENV.NODE_ENV === 'production',
		PUBLIC_GIT_BRANCH: ENV.PUBLIC_GIT_BRANCH,
		PUBLIC_GIT_SHA: ENV.PUBLIC_GIT_SHA,
		extraColumnsConfig: LayerDb.LAYER_DB_CONFIG,
	}
}

async function generateConfigJsonSchema() {
	const schemaPath = path.join(Paths.ASSETS, 'config-schema.json')
	const schema = zodToJsonSchema(ConfigSchema.extend({ ['$schema']: z.string() }))
	await fsPromise.writeFile(schemaPath, stringifyCompact(schema))
	console.log('Wrote generated config schema to %s', schemaPath)
}

export type Config = z.infer<typeof ConfigSchema>

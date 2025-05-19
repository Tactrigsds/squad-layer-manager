import { selectProps } from '@/lib/object.ts'
import * as SM from '@/lib/rcon/squad-models.ts'
import { HumanTime, ParsedBigIntSchema, PercentageSchema } from '@/lib/zod'
import * as RBAC from '@/rbac.models'
import * as Paths from '@/server/paths'
import * as Cli from '@/server/systems/cli.ts'
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

const CommandConfigSchema = z.object({
	strings: z.array(StrNoWhitespace).describe('Command strings that trigger this command when prefixed with the command prefix'),
	scopes: z.array(SM.COMMAND_SCOPES).describe('Chats in which this command is available'),
	enabled: z.boolean().default(true),
})
export type CommandConfig = z.infer<typeof CommandConfigSchema>

export const ConfigSchema = z.object({
	serverId: z.string().min(1).max(256),
	serverDisplayName: z.string().min(1).max(256),
	commandPrefix: StrNoWhitespace,
	defaults: z.object({
		voteDuration: HumanTime.default('120s').describe('Duration of a vote'),
		minValidVotePercentage: PercentageSchema.describe('Minimum threshold for a vote tally to be valid'),
	}),
	commands: z.object({
		help: CommandConfigSchema.describe('Show help text'),
		startVote: CommandConfigSchema.describe('Start a vote for the next layer'),
		abortVote: CommandConfigSchema.describe('Abort the current vote'),
		showNext: CommandConfigSchema.describe('Show the next layer or configured vote'),
	}),
	reminders: z.object({
		lowQueueWarningThreshold: z
			.number()
			.positive()
			.default(2)
			.describe('Number of layers in the queue to trigger a low queue size warning'),
		adminQueueReminderInterval: HumanTime.default('25s').describe(
			'How often to remind admins to maintain the queue. Low queue warnings happen half as often.',
		),
		voteReminderInterval: HumanTime.default('15s').describe('How often to remind users to vote'),
		startVoteReminderThreshold: HumanTime.default('25m').describe('How far into a match to start reminding admins to start a vote'),
		finalVote: HumanTime.default('10s').describe('How far in advance the final vote reminder should be sent'),
		postRollAnnouncementsTimeout: HumanTime.default('5m').describe('How long to wait before sending post-roll reminders'),
	}).default({}),
	maxQueueSize: z.number().int().min(1).max(100).default(20).describe('Maximum number of layers that can be in the queue'),
	maxNumVoteChoices: z.number().int().min(1).max(50).default(5).describe('Maximum number of choices allowed in a vote'),

	adminListSources: z.array(SM.AdminListSourceSchema),
	adminListAdminRole: z.string().describe('The role in the adminlist which identifies an admin'),
	homeDiscordGuildId: ParsedBigIntSchema,
	globalRolePermissions: z
		.record(z.array(z.union([RBAC.GLOBAL_PERMISSION_TYPE, z.literal('*').describe('include all permissions')])))
		.describe('Configures what roles have what permissions. (globally scoped permissions only)'),
	roleAssignments: z.object({
		'discord-role': z.array(z.object({ discordRoleId: ParsedBigIntSchema, roles: z.array(RBAC.RoleSchema) })).optional(),
		'discord-user': z.array(z.object({ userId: ParsedBigIntSchema, roles: z.array(RBAC.RoleSchema) })).optional(),
		'discord-server-member': z.array(z.object({ roles: z.array(RBAC.RoleSchema) })).optional(),
	}),
	// TODO write refinement to make sure that all roles referenced in role assignments are defined in globalRolePermissions
})

export let CONFIG!: Config

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general })
let ENV!: ReturnType<typeof envBuilder>

export async function ensureConfigSetup() {
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

export function getPublicConfig() {
	return { ...selectProps(CONFIG, ['maxQueueSize', 'defaults', 'maxQueueSize']), isProduction: ENV.NODE_ENV === 'production' }
}

export async function generateConfigJsonSchema() {
	const schemaPath = path.join(Paths.ASSETS, 'config-schema.json')
	const schema = zodToJsonSchema(ConfigSchema.extend({ ['$schema']: z.string() }))
	await fsPromise.writeFile(schemaPath, stringifyCompact(schema))
	console.log('Wrote generated config schema to %s', schemaPath)
}

export type Config = z.infer<typeof ConfigSchema>

import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import * as SM from '@/lib/rcon/squad-models.ts'
import * as Paths from '@/server/paths.ts'
import { ParsedBigIntSchema, PercentageSchema } from '@/lib/zod'
import * as RBAC from '../rbac.models'

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
		voteDurationSeconds: z.number().positive().default(60).describe('Duration of a vote in seconds'),
		minValidVotePercentage: PercentageSchema.describe('Minimum threshold for a vote tally to be valid'),
	}),
	commands: z.object({
		help: CommandConfigSchema.describe('Show help text'),
		startVote: CommandConfigSchema.describe('Start a vote for the next layer'),
		abortVote: CommandConfigSchema.describe('Abort the current vote'),
		showNext: CommandConfigSchema.describe('Show the next layer or configured vote'),
	}),

	lowQueueWarningThresholdSeconds: z
		.number()
		.positive()
		.default(3)
		.describe('Number of layers in the queue to trigger a low queue size warning'),
	remindVoteThresholdSeconds: z.number().positive().default(15).describe('Seconds remaining to remind users to vote'),
	maxQueueSize: z.number().int().min(1).max(100).default(20).describe('Maximum number of layers that can be in the queue'),
	maxNumVoteChoices: z.number().int().min(1).max(50).default(5).describe('Maximum number of choices allowed in a vote'),

	matchHistoryUrl: z.string().url().optional(),
	adminListSources: z.array(SM.AdminListSourceSchema),
	homeDiscordGuildId: ParsedBigIntSchema,
	globalRolePermissions: z
		.record(z.array(z.union([RBAC.GLOBAL_PERMISSION_TYPE, z.literal('*').describe('include all permissions')])))
		.describe('Configures what roles have what permissions. (globally scoped permissions only)'),
	roleAssignments: z.object({
		'discord-role': z.array(z.object({ discordRoleId: ParsedBigIntSchema, roles: z.array(RBAC.RoleSchema) })).optional(),
		'discord-user': z.array(z.object({ userId: z.bigint(), roles: z.array(RBAC.RoleSchema) })).optional(),
		'discord-server-member': z.array(z.object({ roles: z.array(RBAC.RoleSchema) })).optional(),
	}),
	// TODO write refinement to make sure that all roles referenced in role assignments are defined in globalRolePermissions
})

export let CONFIG!: Config

export async function setupConfig() {
	const raw = await fs.readFile(path.join(Paths.PROJECT_ROOT, 'config.json'), 'utf-8')
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

export type Config = z.infer<typeof ConfigSchema>

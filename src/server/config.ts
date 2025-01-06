import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import * as SM from '@/lib/rcon/squad-models.ts'
import * as Paths from '@/server/paths.ts'

const strNoWhitespace = z.string().regex(/^\S+$/, {
	message: 'Must not contain whitespace',
})

const CommandConfigSchema = z.object({
	strings: z.array(strNoWhitespace),
	allowedChats: z.array(SM.CHAT_CHANNEL.default('admin')),
})

export const ConfigSchema = z.object({
	serverId: z.string().min(1).max(256),
	serverDisplayName: z.string().min(1).max(256),
	commandPrefix: strNoWhitespace,
	defaults: z.object({
		voteDurationSeconds: z.number().positive().default(60).describe('Duration of a vote in seconds'),
		minValidVotes: z.number().positive().describe('Minimum threshold for a vote tally to be valid'),
	}),
	commands: z.object({
		startVote: CommandConfigSchema,
		showNext: CommandConfigSchema,
	}),
	adminListSources: z.array(SM.AdminListSourceSchema),
	authorizedDiscordRoles: z
		.array(
			z.object({
				serverId: z.string().regex(/^\d+$/, {
					message: 'Must be a valid Discord server ID',
				}),
				roleId: z
					.string()
					.regex(/^\d+$/, {
						message: 'Must be a valid Discord role ID',
					})
					.optional(),
			})
		)
		.min(1),
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

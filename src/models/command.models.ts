import { BasicStrNoWhitespace } from '@/lib/zod'
import * as Messages from '@/messages'
import * as SM from '@/models/squad.models.ts'
import { z } from 'zod'

export const COMMAND_SCOPES = z.enum(['admin', 'public'])
export type CommandScope = z.infer<typeof COMMAND_SCOPES>

export const CHAT_SCOPE_MAPPINGS = {
	[COMMAND_SCOPES.Values.admin]: ['ChatAdmin'],
	[COMMAND_SCOPES.Values.public]: ['ChatTeam', 'ChatSquad', 'ChatAll'],
}
export type CommandConfig = {
	strings: string[]
	scopes: CommandScope[]
	enabled: boolean
}

export type CommandConfigs = { [k in CommandId]: CommandConfig }

export function CommandConfigSchema(commandId: CommandId) {
	const defaultConfig = COMMAND_DEFAULTS[commandId]
	return z.object({
		strings: z.array(BasicStrNoWhitespace).default(defaultConfig.strings).describe(
			'Command strings that trigger this command when prefixed with the command prefix',
		),
		scopes: z.array(COMMAND_SCOPES).default(defaultConfig.scopes).describe('Scopes in which this command is available'),
		enabled: z.boolean().default(defaultConfig.enabled),
	}).describe(Messages.GENERAL.command.descriptions[commandId]).default(defaultConfig)
}
export const COMMAND_IDS = z.enum([
	'help',
	'startVote',
	'abortVote',
	'showNext',
	'enableSlmUpdates',
	'disableSlmUpdates',
	'getSlmUpdatesEnabled',
])
export type CommandId = z.infer<typeof COMMAND_IDS>

// description is not configurable, rest of properties are
export const COMMAND_DEFAULTS: CommandConfigs = {
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

// ------- Helpers --------
//
export function matchCommandText(configs: CommandConfigs, cmdText: string) {
	for (const [cmd, config] of Object.entries(configs)) {
		if (config.strings.includes(cmdText)) {
			return cmd as CommandId
		}
	}
	return null
}

export function chatInScope(scopes: CommandScope[], msgChat: SM.ChatChannel) {
	for (const scope of scopes) {
		if (CHAT_SCOPE_MAPPINGS[scope].includes(msgChat)) {
			return true
		}
	}
	return false
}

export function getScopesForChat(chat: SM.ChatChannel): CommandScope[] {
	const matches: CommandScope[] = []
	for (const [scope, chats] of Object.entries(CHAT_SCOPE_MAPPINGS)) {
		if (chats.includes(chat)) {
			matches.push(scope as CommandScope)
		}
	}
	return matches
}

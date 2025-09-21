import * as Obj from '@/lib/object'
import { BasicStrNoWhitespace } from '@/lib/zod'
import * as Messages from '@/messages'
import * as SM from '@/models/squad.models.ts'

import StringComparison from 'string-comparison'
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
export type ArgDefinition<Name extends string = string> = {
	name: Name
	// default false
	optional?: boolean
} | Name

export function CommandConfigSchema(commandId: CommandId) {
	const defaultConfig = COMMAND_DEFAULTS[commandId]
	return z.object({
		strings: z.array(BasicStrNoWhitespace).default(defaultConfig.strings).describe(
			'Command strings that trigger this command when prefixed with the command prefix',
		),
		scopes: z.array(COMMAND_SCOPES).default(defaultConfig.scopes).describe('Scopes in which this command is available'),
		enabled: z.boolean().default(defaultConfig.enabled),
	}).describe(Messages.GENERAL.command.descriptions[commandId as keyof typeof Messages.GENERAL.command.descriptions]).default(defaultConfig)
}

export function declareCommand<Id extends string, Args extends [ArgDefinition, ...ArgDefinition[]] | undefined>(
	id: Id,
	opts: { args: Args; defaults: CommandConfig },
) {
	return {
		[id]: {
			id,
			defaults: opts.defaults,
			args: opts.args,
		},
	} as const
}

export const COMMAND_DECLARATIONS = {
	...declareCommand('help', {
		args: undefined,
		defaults: {
			scopes: ['admin'],
			strings: ['help', 'h'],
			enabled: true,
		},
	}),
	...declareCommand('startVote', {
		args: undefined,
		defaults: {
			scopes: ['admin'],
			strings: ['startvote', 'sv'],
			enabled: true,
		},
	}),
	...declareCommand('abortVote', {
		args: undefined,
		defaults: {
			scopes: ['admin'],
			strings: ['abortvote', 'av'],
			enabled: true,
		},
	}),
	...declareCommand('showNext', {
		args: undefined,
		defaults: {
			scopes: ['admin'],
			strings: ['shownext', 'sn'],
			enabled: true,
		},
	}),
	...declareCommand('enableSlmUpdates', {
		args: undefined,
		defaults: {
			scopes: ['admin'],
			strings: ['enable-slm'],
			enabled: true,
		},
	}),
	...declareCommand('disableSlmUpdates', {
		args: undefined,
		defaults: {
			scopes: ['admin'],
			strings: ['disable-slm'],
			enabled: true,
		},
	}),
	...declareCommand('getSlmUpdatesEnabled', {
		args: undefined,
		defaults: {
			scopes: ['admin'],
			strings: ['get-slm-status'],
			enabled: true,
		},
	}),
	...declareCommand('linkSteamAccount', {
		args: ['code'],
		defaults: {
			scopes: ['admin'],
			strings: ['link-steam-account'],
			enabled: true,
		},
	}),
} as const

export type CommandId = ([typeof COMMAND_DECLARATIONS])[number]['id']
export type CommandDeclaration<Id extends CommandId> = (typeof COMMAND_DECLARATIONS)[Id]

// description is not configurable, rest of properties are
export const COMMAND_DEFAULTS: CommandConfigs = Object.fromEntries(
	Object.entries(COMMAND_DECLARATIONS).map(([id, declaration]) => [id, declaration.defaults]),
) as CommandConfigs

export const COMMAND_IDS = z.enum([
	'help',
	'startVote',
	'abortVote',
	'showNext',
	'enableSlmUpdates',
	'disableSlmUpdates',
	'getSlmUpdatesEnabled',
	'linkSteamAccount',
])

export const AllCommandConfigSchema = z.object(
	Object.fromEntries(Object.keys(COMMAND_DECLARATIONS).map(id => [id, CommandConfigSchema(id as CommandId)])) as Record<
		CommandId,
		ReturnType<typeof CommandConfigSchema>
	>,
).default(COMMAND_DEFAULTS)

// ------- Helpers --------
//

export function parseCommand(msg: SM.ChatMessage, configs: CommandConfigs, commandPrefix: string) {
	const words = msg.message.split(/\s+/)
	const cmdText = words[0].slice(1)
	// const args = words.slice(1)
	const cmd = matchCommandText(configs, cmdText)
	if (!cmd) {
		const allCommandStrings = Obj.objValues(configs)
			.filter((c) => chatInScope(c.scopes, msg.chat))
			.flatMap((c) => c.strings)
			.map((s) => commandPrefix + s)
		const sortedMatches = StringComparison.diceCoefficient.sortMatch(words[0], allCommandStrings)
		if (sortedMatches.length === 0) {
			return { code: 'err:unknown-command' as const, msg: `Unknown command "${words[0]}"` }
		}
		const matched = sortedMatches[sortedMatches.length - 1].member
		return {
			code: 'err:unknown-command' as const,
			msg: `Unknown command "${words[0]}". Did you mean ${matched}?`,
		}
	}
	const args = extractArgs(cmd, words)
	return { code: 'ok' as const, cmd, args }
}

function extractArgs(id: CommandId, words: string[]) {
	const config = COMMAND_DECLARATIONS[id]
	if (!config?.args) {
		return {}
	}
	const result: Record<string, string> = {}
	words.slice(1).forEach((word, index) => {
		if (config.args && config.args[index]) {
			result[config.args[index] as string] = word
		}
	})
	return result
}

function matchCommandText(configs: CommandConfigs, cmdText: string) {
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

export function buildCommand(id: CommandId, argObj: Record<string, string>, configs: CommandConfigs) {
	const declaration = COMMAND_DECLARATIONS[id]
	if (!declaration?.args) {
		return configs[id].strings[0]
	}
	const config = configs[id]
	let unrealConsoleCommand: string
	if (config.scopes.includes('admin')) unrealConsoleCommand = 'ChatToAdmin'
	else if (config.scopes.includes('public')) unrealConsoleCommand = 'ChatToAll'
	else throw new Error(`Invalid scope for command ${id}`)
	return `${unrealConsoleCommand} ${config.strings[0]} ${declaration.args.map((arg) => argObj[arg as string] || '').join(' ')}`
}
